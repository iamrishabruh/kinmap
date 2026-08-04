/**
 * `expo-crypto`, backed by the Web Crypto API.
 *
 * Deliberately NOT a stub: the SHA-256 here is real, so every hash the SRP and
 * PKCE tests take is the hash the device would take. A fake digest would let a
 * transposed byte order pass.
 */

export enum CryptoDigestAlgorithm {
  SHA1 = 'SHA-1',
  SHA256 = 'SHA-256',
  SHA384 = 'SHA-384',
  SHA512 = 'SHA-512',
  MD2 = 'MD2',
  MD4 = 'MD4',
  MD5 = 'MD5',
}

export enum CryptoEncoding {
  HEX = 'hex',
  BASE64 = 'base64',
}

function subtleAlgorithm(algorithm: CryptoDigestAlgorithm): string {
  return algorithm === CryptoDigestAlgorithm.SHA1 ||
    algorithm === CryptoDigestAlgorithm.SHA384 ||
    algorithm === CryptoDigestAlgorithm.SHA512
    ? algorithm
    : 'SHA-256';
}

export async function digest(
  algorithm: CryptoDigestAlgorithm,
  data: BufferSource,
): Promise<ArrayBuffer> {
  return crypto.subtle.digest(subtleAlgorithm(algorithm), data);
}

export async function digestStringAsync(
  algorithm: CryptoDigestAlgorithm,
  data: string,
  options?: { encoding: CryptoEncoding },
): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest(subtleAlgorithm(algorithm), new TextEncoder().encode(data)),
  );
  if (options?.encoding === CryptoEncoding.BASE64) {
    return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''));
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function getRandomBytes(byteCount: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(byteCount));
}

export async function getRandomBytesAsync(byteCount: number): Promise<Uint8Array> {
  return getRandomBytes(byteCount);
}

export function getRandomValues<T extends ArrayBufferView>(typedArray: T): T {
  const view = new Uint8Array(
    typedArray.buffer as ArrayBuffer,
    typedArray.byteOffset,
    typedArray.byteLength,
  );
  crypto.getRandomValues(view);
  return typedArray;
}

export function randomUUID(): string {
  return crypto.randomUUID();
}
