import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import {
  assertValidCoordinates,
  decodeCoordinates,
  encodeCoordinates,
} from './coordinate-codec.js';
import {
  DataKeyCache,
  DEFAULT_DATA_KEY_TTL_MS,
  DEFAULT_MAX_CACHED_DATA_KEYS,
  type DataKeyCacheEntry,
  type DataKeyCacheStats,
} from './data-key-cache.js';
import {
  buildEncryptionContext,
  canonicalizeEncryptionContext,
  type EncryptionContext,
} from './encryption-context.js';
import { CoordinateCryptoError } from './errors.js';
import { DataKeyProviderError, type DataKeyMaterial, type DataKeyProvider } from './kms.js';
import {
  AUTH_TAG_BYTES,
  COORDINATE_ENCRYPTION_ALGORITHM,
  COORDINATE_SCHEMA_VERSION,
  EncryptedCoordinateRecordSchema,
  IV_BYTES,
  KeyContextSchema,
  NODE_CIPHER_ALGORITHM,
  SUPPORTED_COORDINATE_SCHEMA_VERSIONS,
  type Coordinates,
  type EncryptedCoordinateRecord,
  type KeyContext,
} from './types.js';

/**
 * Envelope encryption for coordinates (spec §20).
 *
 * encrypt: KMS mints a data key for the family's encryption context -> the key
 * is cached in memory under a TTL -> AES-256-GCM seals the 16-byte coordinate
 * payload with the canonical context as additional authenticated data. Only the
 * wrapped key is persisted.
 *
 * decrypt: the wrapped key is unwrapped under the *caller-supplied* context. A
 * caller that supplies a different family or user cannot unwrap the key, and
 * even if it could, the GCM tag would not verify.
 *
 * Nothing in this class logs, and no method embeds a coordinate, a payload, or
 * key material in an error.
 */

export type EncryptionServiceOptions = {
  keyProvider: DataKeyProvider;
  /** Overrides for the two internal caches; sizes/TTLs otherwise use the defaults. */
  dataKeyTtlMs?: number;
  maxCachedDataKeys?: number;
  /** Injected for tests; defaults to `Date.now`. */
  now?: () => number;
  /** Supply pre-built caches when a container wants to share them across services. */
  encryptionKeyCache?: DataKeyCache;
  decryptionKeyCache?: DataKeyCache;
};

export type EncryptionServiceStats = {
  encryptionKeyCache: DataKeyCacheStats;
  decryptionKeyCache: DataKeyCacheStats;
};

export class EncryptionService {
  private readonly keyProvider: DataKeyProvider;
  /** Keyed by canonical encryption context: one live data key per family/user. */
  private readonly encryptionKeyCache: DataKeyCache;
  /** Keyed by context + wrapped key: historical rows may hold rotated keys. */
  private readonly decryptionKeyCache: DataKeyCache;

  constructor(options: EncryptionServiceOptions) {
    this.keyProvider = options.keyProvider;
    const ttlMs = options.dataKeyTtlMs ?? DEFAULT_DATA_KEY_TTL_MS;
    const maxEntries = options.maxCachedDataKeys ?? DEFAULT_MAX_CACHED_DATA_KEYS;
    const now = options.now ?? Date.now;
    this.encryptionKeyCache =
      options.encryptionKeyCache ?? new DataKeyCache({ ttlMs, maxEntries, now });
    this.decryptionKeyCache =
      options.decryptionKeyCache ?? new DataKeyCache({ ttlMs, maxEntries, now });
  }

  get stats(): EncryptionServiceStats {
    return {
      encryptionKeyCache: this.encryptionKeyCache.stats,
      decryptionKeyCache: this.decryptionKeyCache.stats,
    };
  }

  /** Drops and zeroises every cached data key. */
  clearKeyCache(): void {
    this.encryptionKeyCache.clear();
    this.decryptionKeyCache.clear();
  }

  async encryptCoordinates(
    coordinates: Coordinates,
    keyContext: KeyContext,
  ): Promise<EncryptedCoordinateRecord> {
    const context = this.resolveContext(keyContext);
    assertValidCoordinates(coordinates);

    const cacheKey = context.canonical;
    const entry = await this.dataKeyForEncryption(cacheKey, context.encryptionContext);

    const payload = encodeCoordinates(coordinates);
    const iv = randomBytes(IV_BYTES);
    try {
      const cipher = createCipheriv(NODE_CIPHER_ALGORITHM, entry.plaintextKey, iv);
      cipher.setAAD(Buffer.from(context.canonical, 'utf8'));
      const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
      const authTag = cipher.getAuthTag();

      return {
        ciphertext: ciphertext.toString('base64'),
        iv: iv.toString('base64'),
        authTag: authTag.toString('base64'),
        encryptedDataKey: entry.encryptedDataKey.toString('base64'),
        keyId: entry.keyId,
        algorithm: COORDINATE_ENCRYPTION_ALGORITHM,
        schemaVersion: COORDINATE_SCHEMA_VERSION,
      };
    } catch (error) {
      throw toCryptoError(error, 'INTEGRITY_CHECK_FAILED');
    } finally {
      // The plaintext coordinate payload must not outlive this call.
      payload.fill(0);
    }
  }

  async decryptCoordinates(
    record: EncryptedCoordinateRecord,
    keyContext: KeyContext,
  ): Promise<Coordinates> {
    const context = this.resolveContext(keyContext);

    const parsed = EncryptedCoordinateRecordSchema.safeParse(record);
    if (!parsed.success) {
      throw new CoordinateCryptoError('MALFORMED_RECORD');
    }
    const sealed = parsed.data;
    if (sealed.algorithm !== COORDINATE_ENCRYPTION_ALGORITHM) {
      throw new CoordinateCryptoError('UNSUPPORTED_ALGORITHM');
    }
    if (!SUPPORTED_COORDINATE_SCHEMA_VERSIONS.includes(sealed.schemaVersion)) {
      throw new CoordinateCryptoError('UNSUPPORTED_SCHEMA_VERSION');
    }

    const iv = decodeBase64(sealed.iv, IV_BYTES);
    const authTag = decodeBase64(sealed.authTag, AUTH_TAG_BYTES);
    const ciphertext = decodeBase64(sealed.ciphertext);
    const encryptedDataKey = decodeBase64(sealed.encryptedDataKey);

    const cacheKey = `${context.canonical}|${sealed.encryptedDataKey}`;
    const entry = await this.dataKeyForDecryption(
      cacheKey,
      encryptedDataKey,
      context.encryptionContext,
    );

    let payload: Buffer;
    try {
      const decipher = createDecipheriv(NODE_CIPHER_ALGORITHM, entry.plaintextKey, iv);
      decipher.setAAD(Buffer.from(context.canonical, 'utf8'));
      decipher.setAuthTag(authTag);
      payload = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch (error) {
      // A failed tag check means tampering, a truncated row, or a context that
      // does not match. All three are the same answer: unreadable.
      throw toCryptoError(error, 'INTEGRITY_CHECK_FAILED');
    }

    try {
      return decodeCoordinates(payload);
    } finally {
      payload.fill(0);
    }
  }

  private resolveContext(keyContext: KeyContext): {
    encryptionContext: EncryptionContext;
    canonical: string;
  } {
    const parsed = KeyContextSchema.safeParse(keyContext);
    if (!parsed.success) {
      throw new CoordinateCryptoError('INVALID_KEY_CONTEXT');
    }
    const encryptionContext = buildEncryptionContext(parsed.data);
    return {
      encryptionContext,
      canonical: canonicalizeEncryptionContext(encryptionContext),
    };
  }

  private async dataKeyForEncryption(
    cacheKey: string,
    encryptionContext: EncryptionContext,
  ): Promise<DataKeyCacheEntry> {
    const cached = this.encryptionKeyCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    let material: DataKeyMaterial;
    try {
      material = await this.keyProvider.generateDataKey({ encryptionContext });
    } catch (error) {
      throw toCryptoError(error, 'DATA_KEY_UNAVAILABLE');
    }

    try {
      this.encryptionKeyCache.set(cacheKey, material);
    } finally {
      // The cache holds its own copy; drop ours immediately.
      material.plaintextKey.fill(0);
    }

    const stored = this.encryptionKeyCache.get(cacheKey);
    if (stored === undefined) {
      throw new CoordinateCryptoError('DATA_KEY_UNAVAILABLE');
    }
    return stored;
  }

  private async dataKeyForDecryption(
    cacheKey: string,
    encryptedDataKey: Buffer,
    encryptionContext: EncryptionContext,
  ): Promise<DataKeyCacheEntry> {
    const cached = this.decryptionKeyCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    let material: DataKeyMaterial;
    try {
      material = await this.keyProvider.decryptDataKey({ encryptedDataKey, encryptionContext });
    } catch (error) {
      throw toCryptoError(error, 'DATA_KEY_UNAVAILABLE');
    }

    try {
      this.decryptionKeyCache.set(cacheKey, material);
    } finally {
      material.plaintextKey.fill(0);
    }

    const stored = this.decryptionKeyCache.get(cacheKey);
    if (stored === undefined) {
      throw new CoordinateCryptoError('DATA_KEY_UNAVAILABLE');
    }
    return stored;
  }
}

/**
 * Strict base64 decode. `Buffer.from(_, 'base64')` silently ignores junk, which
 * would let a mangled row decode to something plausible; re-encoding proves the
 * input was canonical.
 */
function decodeBase64(value: string, expectedBytes?: number): Buffer {
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length === 0 || decoded.toString('base64') !== value) {
    throw new CoordinateCryptoError('MALFORMED_RECORD');
  }
  if (expectedBytes !== undefined && decoded.length !== expectedBytes) {
    throw new CoordinateCryptoError('MALFORMED_RECORD');
  }
  return decoded;
}

/**
 * Normalises anything thrown below this layer into a value-free
 * {@link CoordinateCryptoError}. Provider errors are mapped by reason, never
 * wrapped as a `cause`, so no upstream message can ever ride out to a caller.
 */
function toCryptoError(
  error: unknown,
  fallback: 'INTEGRITY_CHECK_FAILED' | 'DATA_KEY_UNAVAILABLE',
): CoordinateCryptoError {
  if (error instanceof CoordinateCryptoError) {
    return error;
  }
  if (error instanceof DataKeyProviderError) {
    return new CoordinateCryptoError(
      error.failure === 'INVALID_CIPHERTEXT'
        ? 'ENCRYPTION_CONTEXT_MISMATCH'
        : 'DATA_KEY_UNAVAILABLE',
    );
  }
  return new CoordinateCryptoError(fallback);
}
