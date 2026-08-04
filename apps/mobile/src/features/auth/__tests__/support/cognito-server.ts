/**
 * The other end of the handshake.
 *
 * Everything below is written from the SRP-6a / Cognito specification against
 * the Web Crypto API rather than by calling the code under test, so a test that
 * passes means two independent implementations agree on the transcript. If
 * `srp.ts` got the sign-byte padding, the HKDF info string, the salt
 * normalisation or the order of the signed message wrong, the shared secret
 * here would differ and the signature would not verify.
 *
 * No Node built-ins are used: the mobile package's `tsc` run covers these files
 * and its lib set is DOM + ESNext, so `crypto.subtle`, `btoa` and `atob` are
 * what is available — and they are a genuinely different implementation from
 * the native digest the app calls, which is the point.
 */

const N_HEX =
  'FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD1' +
  '29024E088A67CC74020BBEA63B139B22514A08798E3404DD' +
  'EF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245' +
  'E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED' +
  'EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3D' +
  'C2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F' +
  '83655D23DCA3AD961C62F356208552BB9ED529077096966D' +
  '670C354E4ABC9804F1746C08CA18217C32905E462E36CE3B' +
  'E39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9' +
  'DE2BCBF6955817183995497CEA956AE515D2261898FA0510' +
  '15728E5A8AAAC42DAD33170D04507A33A85521ABDF1CBA64' +
  'ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7' +
  'ABF5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6B' +
  'F12FFA06D98A0864D87602733EC86A64521F2B18177B200C' +
  'BBE117577A615D6C770988C0BAD946E208E24FA074E5AB31' +
  '43DB5BFCE0FD108E4B82D120A93AD2CAFFFFFFFFFFFFFFFF';

const N = BigInt(`0x${N_HEX}`);
const G = 2n;

// ---------------------------------------------------------------------------
// Encodings (independent of the app's own)
// ---------------------------------------------------------------------------

export function textBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let index = 0; index < out.length; index += 1) {
    out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
}

export function bytesHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function bytesBase64(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''));
}

export function bytesBase64Url(bytes: Uint8Array): string {
  return bytesBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64Bytes(value: string): Uint8Array {
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    out[index] = binary.charCodeAt(index);
  }
  return out;
}

function join(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
}

export async function hmacSha256(key: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
  const imported = await crypto.subtle.importKey(
    'raw',
    key as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', imported, message as BufferSource));
}

function padHex(value: bigint): string {
  let hex = value.toString(16);
  if (hex.length % 2 !== 0) hex = `0${hex}`;
  return /^[89a-f]/i.test(hex) ? `00${hex}` : hex;
}

async function hexHash(hex: string): Promise<string> {
  return bytesHex(await sha256(hexBytes(hex)));
}

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  let value = ((base % modulus) + modulus) % modulus;
  let remaining = exponent;
  while (remaining > 0n) {
    if ((remaining & 1n) === 1n) result = (result * value) % modulus;
    value = (value * value) % modulus;
    remaining >>= 1n;
  }
  return result;
}

async function multiplier(): Promise<bigint> {
  return BigInt(`0x${await hexHash(`${padHex(N)}${padHex(G)}`)}`);
}

// ---------------------------------------------------------------------------
// The pool
// ---------------------------------------------------------------------------

export type PoolAccount = {
  /** `USER_ID_FOR_SRP`: the pool's identifier for the account. */
  readonly userIdForSrp: string;
  readonly password: string;
  readonly salt: bigint;
  /** The server's private exponent. Fixed so the transcript is reproducible. */
  readonly serverSecret: bigint;
};

export type PasswordVerifierChallenge = {
  readonly SALT: string;
  readonly SRP_B: string;
  readonly SECRET_BLOCK: string;
  readonly USER_ID_FOR_SRP: string;
  readonly USERNAME: string;
};

export const SECRET_BLOCK = bytesBase64(textBytes('cognito-challenge-state'));

async function verifier(account: PoolAccount, poolName: string): Promise<bigint> {
  const credentialHash = bytesHex(
    await sha256(textBytes(`${poolName}${account.userIdForSrp}:${account.password}`)),
  );
  const exponent = BigInt(`0x${await hexHash(`${padHex(account.salt)}${credentialHash}`)}`);
  return modPow(G, exponent, N);
}

async function serverPublicValue(account: PoolAccount, poolName: string): Promise<bigint> {
  const k = await multiplier();
  return (k * (await verifier(account, poolName)) + modPow(G, account.serverSecret, N)) % N;
}

export async function challengeFor(
  account: PoolAccount,
  poolName: string,
): Promise<PasswordVerifierChallenge> {
  return {
    SALT: account.salt.toString(16),
    SRP_B: (await serverPublicValue(account, poolName)).toString(16),
    SECRET_BLOCK,
    USER_ID_FOR_SRP: account.userIdForSrp,
    USERNAME: account.userIdForSrp,
  };
}

/** Recomputes the password claim the pool expects, exactly as Cognito would. */
export async function expectedSignature(
  account: PoolAccount,
  poolName: string,
  srpA: string,
  timestamp: string,
  secretBlock: string = SECRET_BLOCK,
): Promise<string> {
  const largeA = BigInt(`0x${srpA}`);
  const v = await verifier(account, poolName);
  const serverB = await serverPublicValue(account, poolName);
  const scrambler = BigInt(`0x${await hexHash(`${padHex(largeA)}${padHex(serverB)}`)}`);
  const sharedSecret = modPow(largeA * modPow(v, scrambler, N), account.serverSecret, N);

  const prk = await hmacSha256(hexBytes(padHex(scrambler)), hexBytes(padHex(sharedSecret)));
  const key = (
    await hmacSha256(prk, join(textBytes('Caldera Derived Key'), Uint8Array.from([1])))
  ).subarray(0, 16);

  const signed = await hmacSha256(
    key,
    join(
      textBytes(poolName),
      textBytes(account.userIdForSrp),
      base64Bytes(secretBlock),
      textBytes(timestamp),
    ),
  );
  return bytesBase64(signed);
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

function jwtSegment(value: string): string {
  return bytesBase64Url(textBytes(value));
}

/** A structurally valid Cognito access token. The signature is never checked here. */
export function accessToken(options: {
  sub: string;
  expiresAt?: number;
  tokenUse?: string;
}): string {
  const payload = {
    sub: options.sub,
    token_use: options.tokenUse ?? 'access',
    exp: options.expiresAt ?? Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000),
    client_id: 'xxxxxxxxxxxxxxxxxxxxxxxxxx',
  };
  return `${jwtSegment(JSON.stringify({ alg: 'RS256', kid: 'test' }))}.${jwtSegment(
    JSON.stringify(payload),
  )}.c2lnbmF0dXJl`;
}

/** The id token carries the email claim; the client must never store it. */
export function idToken(options: { sub: string; email: string }): string {
  return `${jwtSegment(JSON.stringify({ alg: 'RS256' }))}.${jwtSegment(
    JSON.stringify({
      sub: options.sub,
      email: options.email,
      token_use: 'id',
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  )}.c2lnbmF0dXJl`;
}

export const REFRESH_TOKEN = 'a'.repeat(400);
