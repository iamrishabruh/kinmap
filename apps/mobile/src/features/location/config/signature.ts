import { hmacSha256 } from '../crypto/digest';
import { type DeviceConfigSigningKey, loadDeviceConfigSigningKey } from '../crypto/key-store';
import { fromBase64, timingSafeEqual, utf8Encode } from '../internal/bytes';
import { canonicalJson } from '../internal/canonical-json';

import { type RemoteConfigSignature } from './remote-config-schema';

/**
 * Signature verification for remote configuration.
 *
 * The signing key is per-device: the backend mints it during device
 * registration and returns it once, over TLS, and the client stores it in the
 * platform keystore. A single secret compiled into the binary would be
 * extractable from any handset and would let whoever extracted it forge
 * configuration for the entire install base.
 *
 * The verifier is an interface so that moving to public-key signatures (Ed25519
 * via a native module) is a swap at the composition root rather than a rewrite
 * of the config client.
 */

export interface RemoteConfigVerifier {
  readonly algorithm: RemoteConfigSignature['algorithm'];
  readonly keyId: string;
  verify(input: { canonicalPayload: string; signature: RemoteConfigSignature }): Promise<boolean>;
}

/** Rejects a signature whose clock is implausibly far from ours (replay window). */
export const MAX_SIGNATURE_AGE_SECONDS = 7 * 24 * 3600;

export function createHmacSha256Verifier(key: DeviceConfigSigningKey): RemoteConfigVerifier {
  return {
    algorithm: 'HMAC-SHA256',
    keyId: key.keyId,

    async verify({ canonicalPayload, signature }) {
      if (signature.algorithm !== 'HMAC-SHA256') {
        return false;
      }
      if (signature.keyId !== key.keyId) {
        return false;
      }
      let provided: Uint8Array;
      try {
        provided = fromBase64(signature.value);
      } catch {
        return false;
      }
      const expected = await hmacSha256(key.key, utf8Encode(canonicalPayload));
      return timingSafeEqual(expected, provided);
    },
  };
}

/**
 * Builds the verifier for this device, or null when no key has been
 * provisioned yet.
 *
 * Null means "cannot verify", and the config client treats that as "do not
 * apply remote configuration at all". Unverified config is never applied, not
 * even on first launch.
 */
export async function createDeviceVerifier(): Promise<RemoteConfigVerifier | null> {
  const key = await loadDeviceConfigSigningKey();
  return key ? createHmacSha256Verifier(key) : null;
}

/** The exact bytes that are signed. Both sides must agree on this function. */
export function canonicalPayloadFor(config: unknown): string {
  return canonicalJson(config);
}
