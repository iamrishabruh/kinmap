/**
 * Identifier generation for request correlation and idempotency.
 *
 * `crypto.randomUUID` exists on Node 24 and on Hermes with the React Native
 * polyfill, but not on every JSC build we still support, so there is a
 * fallback. It uses `crypto.getRandomValues` when available and only degrades
 * to `Math.random` as a last resort — acceptable because these values need to
 * be unique, not unguessable: an Idempotency-Key is scoped to an authenticated
 * caller and never grants access on its own.
 */

type CryptoLike = {
  randomUUID?: () => string;
  getRandomValues?: <T extends Uint8Array>(array: T) => T;
};

function getCrypto(): CryptoLike | undefined {
  return (globalThis as { crypto?: CryptoLike }).crypto;
}

const HEX = '0123456789abcdef';

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  const cryptoLike = getCrypto();
  if (typeof cryptoLike?.getRandomValues === 'function') {
    cryptoLike.getRandomValues(bytes);
    return bytes;
  }
  for (let index = 0; index < length; index += 1) {
    bytes[index] = Math.floor(Math.random() * 256);
  }
  return bytes;
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) {
    out += HEX[(byte >> 4) & 0x0f] ?? '0';
    out += HEX[byte & 0x0f] ?? '0';
  }
  return out;
}

/** RFC 4122 version 4 UUID. */
export function randomUuid(): string {
  const cryptoLike = getCrypto();
  if (typeof cryptoLike?.randomUUID === 'function') {
    return cryptoLike.randomUUID();
  }

  const bytes = randomBytes(16);
  // Version 4, variant 10xx.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex = toHex(bytes);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

/** Correlates client logs, server logs and the `requestId` echoed in errors. */
export function generateRequestId(): string {
  return `req_${randomUuid()}`;
}

/**
 * Stable for the lifetime of one logical mutation, including every retry, so
 * the server can collapse duplicates (spec §21, IDEMPOTENCY_KEY_REUSED).
 */
export function generateIdempotencyKey(): string {
  return randomUuid();
}
