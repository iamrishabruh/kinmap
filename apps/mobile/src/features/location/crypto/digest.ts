import * as Crypto from 'expo-crypto';

import { concatBytes, uint32BE } from '../internal/bytes';

/**
 * SHA-256 based primitives built on the one hash the Expo runtime actually
 * exposes.
 *
 * `expo-crypto` gives us `digest` (native SHA-256) and a CSPRNG. It does not
 * give us HMAC, HKDF or a block cipher, so those are constructed here from
 * SHA-256 exactly as specified in RFC 2104 and RFC 5869. Building on the native
 * digest keeps the expensive part in native code while the composition stays
 * auditable in TypeScript.
 */

const SHA256_BLOCK_BYTES = 64;
export const SHA256_OUTPUT_BYTES = 32;

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  // TypeScript 6 parameterises typed arrays by their backing buffer, and
  // BufferSource does not accept a SharedArrayBuffer-backed view. Copying into
  // a fresh ArrayBuffer-backed array satisfies that without an unsafe cast.
  const digested = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, new Uint8Array(data));
  return new Uint8Array(digested);
}

/** RFC 2104 HMAC-SHA256. */
export async function hmacSha256(key: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
  const normalisedKey = key.length > SHA256_BLOCK_BYTES ? await sha256(key) : key;
  const paddedKey = new Uint8Array(SHA256_BLOCK_BYTES);
  paddedKey.set(normalisedKey);

  const innerPad = new Uint8Array(SHA256_BLOCK_BYTES);
  const outerPad = new Uint8Array(SHA256_BLOCK_BYTES);
  for (let index = 0; index < SHA256_BLOCK_BYTES; index += 1) {
    const keyByte = paddedKey[index] ?? 0;
    innerPad[index] = keyByte ^ 0x36;
    outerPad[index] = keyByte ^ 0x5c;
  }

  const inner = await sha256(concatBytes(innerPad, message));
  return sha256(concatBytes(outerPad, inner));
}

/** RFC 5869 HKDF-Extract. */
export async function hkdfExtract(salt: Uint8Array, keyMaterial: Uint8Array): Promise<Uint8Array> {
  return hmacSha256(salt, keyMaterial);
}

/** RFC 5869 HKDF-Expand. */
export async function hkdfExpand(
  pseudoRandomKey: Uint8Array,
  info: Uint8Array,
  lengthBytes: number,
): Promise<Uint8Array> {
  const blocks = Math.ceil(lengthBytes / SHA256_OUTPUT_BYTES);
  if (blocks > 255) {
    throw new Error('HKDF output length exceeds one hash function.');
  }
  const output = new Uint8Array(blocks * SHA256_OUTPUT_BYTES);
  // Annotated so the loop can reassign a digest result, whose buffer type is
  // the wider ArrayBufferLike.
  let previous: Uint8Array = new Uint8Array(0);
  for (let block = 1; block <= blocks; block += 1) {
    previous = await hmacSha256(
      pseudoRandomKey,
      concatBytes(previous, info, Uint8Array.from([block])),
    );
    output.set(previous, (block - 1) * SHA256_OUTPUT_BYTES);
  }
  return output.subarray(0, lengthBytes);
}

export async function hkdfSha256(
  keyMaterial: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  lengthBytes: number,
): Promise<Uint8Array> {
  const pseudoRandomKey = await hkdfExtract(salt, keyMaterial);
  return hkdfExpand(pseudoRandomKey, info, lengthBytes);
}

/**
 * HMAC-SHA256 in counter mode.
 *
 * HMAC with a fixed secret key is a PRF, so `HMAC(k, counter)` is a secure
 * keystream generator. Each record derives a fresh `key` from its own random
 * nonce (see field-cipher.ts), which is what makes counter reuse impossible.
 */
export async function hmacCounterKeystream(
  key: Uint8Array,
  lengthBytes: number,
): Promise<Uint8Array> {
  const output = new Uint8Array(Math.ceil(lengthBytes / SHA256_OUTPUT_BYTES) * SHA256_OUTPUT_BYTES);
  const blocks = output.length / SHA256_OUTPUT_BYTES;
  for (let block = 0; block < blocks; block += 1) {
    const chunk = await hmacSha256(key, uint32BE(block));
    output.set(chunk, block * SHA256_OUTPUT_BYTES);
  }
  return output.subarray(0, lengthBytes);
}

export function randomBytes(count: number): Uint8Array {
  return Crypto.getRandomBytes(count);
}
