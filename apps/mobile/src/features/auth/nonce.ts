import * as Crypto from 'expo-crypto';

/**
 * Nonce generation for OAuth identity-token flows.
 *
 * The raw nonce is what the server compares against; the SHA-256 digest is what
 * gets handed to the provider. The pair binds a returned identity token to the
 * exact sign-in attempt that asked for it, so a token captured from another
 * session cannot be replayed into ours.
 */

export type NoncePair = {
  /** Sent to our API. 32 hex chars — inside `min(8).max(128)`. */
  raw: string;
  /** Handed to the identity provider; appears as the token's `nonce` claim. */
  hashed: string;
};

export async function createNoncePair(): Promise<NoncePair> {
  const bytes = await Crypto.getRandomBytesAsync(16);
  const raw = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  const hashed = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, raw, {
    encoding: Crypto.CryptoEncoding.HEX,
  });
  return { raw, hashed };
}
