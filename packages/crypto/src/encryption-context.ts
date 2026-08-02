import { timingSafeEqual } from 'node:crypto';

import { COORDINATE_SCHEMA_VERSION, type KeyContext } from './types.js';

/**
 * Encryption-context binding (spec §20).
 *
 * The context is supplied to KMS on both GenerateDataKey and Decrypt *and* used
 * as the AES-GCM additional authenticated data. Two independent layers must
 * therefore agree before a coordinate can be recovered, so a ciphertext row
 * copied into another family's partition is undecryptable rather than merely
 * misattributed.
 */

/** Distinguishes coordinate keys from any other future use of the same CMK. */
export const ENCRYPTION_PURPOSE = 'family-location:coordinate';

export type EncryptionContext = Readonly<Record<string, string>>;

export function buildEncryptionContext(keyContext: KeyContext): EncryptionContext {
  const context: Record<string, string> = {
    purpose: ENCRYPTION_PURPOSE,
    familyId: keyContext.familyId,
    schemaVersion: String(COORDINATE_SCHEMA_VERSION),
  };
  if (keyContext.userId !== undefined) {
    context.userId = keyContext.userId;
  }
  return context;
}

/**
 * Deterministic serialisation used as GCM additional authenticated data and as
 * the data-key cache key. Sorting makes the encoding independent of insertion
 * order; percent-encoding makes `&`/`=` in a value unambiguous.
 */
export function canonicalizeEncryptionContext(context: EncryptionContext): string {
  return Object.keys(context)
    .sort()
    .map((key) => {
      const value = context[key];
      return `${encodeURIComponent(key)}=${encodeURIComponent(value ?? '')}`;
    })
    .join('&');
}

export function canonicalKeyContext(keyContext: KeyContext): string {
  return canonicalizeEncryptionContext(buildEncryptionContext(keyContext));
}

/** Constant-time comparison so context checks cannot be timed out of the service. */
export function encryptionContextsMatch(a: EncryptionContext, b: EncryptionContext): boolean {
  const left = Buffer.from(canonicalizeEncryptionContext(a), 'utf8');
  const right = Buffer.from(canonicalizeEncryptionContext(b), 'utf8');
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}
