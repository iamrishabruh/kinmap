import {
  concatBytes,
  fromBase64,
  timingSafeEqual,
  toBase64,
  utf8Decode,
  utf8Encode,
} from '../internal/bytes';

import { hkdfSha256, hmacCounterKeystream, hmacSha256, randomBytes } from './digest';

/**
 * Authenticated encryption for the sensitive columns of the local SQLite
 * database (spec §11).
 *
 * WHY NOT AES-GCM
 * ---------------
 * The Expo/Hermes JS runtime exposes no AES primitive: there is no
 * `crypto.subtle`, no `node:crypto`, and `expo-crypto` provides only digests
 * and randomness. The realistic options were (a) ship a hand-written AES
 * implementation in JS, or (b) compose an AEAD from the audited native SHA-256
 * we already have. (b) is chosen: less novel code, and the expensive primitive
 * stays native.
 *
 * CONSTRUCTION — `HMAC-SHA256-CTR-ETM-v1`
 * ---------------------------------------
 *   nonce      = 16 random bytes, fresh per record
 *   enc || mac = HKDF-SHA256(masterKey, salt = nonce, info = version || label, 64)
 *   ciphertext = plaintext XOR HMAC-CTR(enc)
 *   tag        = HMAC-SHA256(mac, version || label || nonce || ciphertext)
 *
 * Encrypt-then-MAC, with the field label bound into both the key derivation and
 * the tag, so a ciphertext written for `location.point` can never be replayed
 * into `family.metadata`. Because the sub-keys are derived from a per-record
 * nonce, the counter stream is never reused across records.
 *
 * The algorithm name is stored in the envelope so that moving to AES-GCM later
 * (once a native module provides it) is a detectable, migratable change rather
 * than a silent one.
 */

export const FIELD_CIPHER_ALGORITHM = 'HMAC-SHA256-CTR-ETM-v1';

const NONCE_BYTES = 16;
const TAG_BYTES = 32;
const ENCRYPTION_SUBKEY_BYTES = 32;
const MAC_SUBKEY_BYTES = 32;
const ENVELOPE_PREFIX = 'v1';
const ENVELOPE_PART_COUNT = 4;

export type FieldCipher = {
  readonly algorithm: string;
  /** @returns an opaque `v1.<nonce>.<ciphertext>.<tag>` envelope. */
  seal(label: string, plaintext: string): Promise<string>;
  /** @throws Error when the envelope is malformed or fails authentication. */
  open(label: string, envelope: string): Promise<string>;
};

async function deriveSubKeys(
  masterKey: Uint8Array,
  label: string,
  nonce: Uint8Array,
): Promise<{ encryptionKey: Uint8Array; macKey: Uint8Array }> {
  const info = utf8Encode(`${ENVELOPE_PREFIX}|${label}`);
  const material = await hkdfSha256(
    masterKey,
    nonce,
    info,
    ENCRYPTION_SUBKEY_BYTES + MAC_SUBKEY_BYTES,
  );
  return {
    encryptionKey: material.subarray(0, ENCRYPTION_SUBKEY_BYTES),
    macKey: material.subarray(ENCRYPTION_SUBKEY_BYTES),
  };
}

function xorInPlace(data: Uint8Array, keystream: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length);
  for (let index = 0; index < data.length; index += 1) {
    out[index] = (data[index] ?? 0) ^ (keystream[index] ?? 0);
  }
  return out;
}

export function createFieldCipher(masterKey: Uint8Array): FieldCipher {
  if (masterKey.length < 32) {
    throw new Error('Local storage master key must be at least 32 bytes.');
  }

  const authenticatedData = (
    label: string,
    nonce: Uint8Array,
    ciphertext: Uint8Array,
  ): Uint8Array => concatBytes(utf8Encode(`${ENVELOPE_PREFIX}|${label}|`), nonce, ciphertext);

  return {
    algorithm: FIELD_CIPHER_ALGORITHM,

    async seal(label, plaintext) {
      const nonce = randomBytes(NONCE_BYTES);
      const { encryptionKey, macKey } = await deriveSubKeys(masterKey, label, nonce);
      const plaintextBytes = utf8Encode(plaintext);
      const keystream = await hmacCounterKeystream(encryptionKey, plaintextBytes.length);
      const ciphertext = xorInPlace(plaintextBytes, keystream);
      const tag = await hmacSha256(macKey, authenticatedData(label, nonce, ciphertext));
      return [ENVELOPE_PREFIX, toBase64(nonce), toBase64(ciphertext), toBase64(tag)].join('.');
    },

    async open(label, envelope) {
      const parts = envelope.split('.');
      if (parts.length !== ENVELOPE_PART_COUNT || parts[0] !== ENVELOPE_PREFIX) {
        throw new Error('Unrecognised local-storage envelope.');
      }
      const nonce = fromBase64(parts[1] ?? '');
      const ciphertext = fromBase64(parts[2] ?? '');
      const tag = fromBase64(parts[3] ?? '');
      if (nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES) {
        throw new Error('Unrecognised local-storage envelope.');
      }
      const { encryptionKey, macKey } = await deriveSubKeys(masterKey, label, nonce);
      const expectedTag = await hmacSha256(macKey, authenticatedData(label, nonce, ciphertext));
      if (!timingSafeEqual(expectedTag, tag)) {
        // Authentication is checked before any decryption so a forged record
        // can never produce plaintext, not even transiently.
        throw new Error('Local-storage record failed authentication.');
      }
      const keystream = await hmacCounterKeystream(encryptionKey, ciphertext.length);
      return utf8Decode(xorInPlace(ciphertext, keystream));
    },
  };
}
