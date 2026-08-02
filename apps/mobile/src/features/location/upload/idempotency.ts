import { sha256 } from '../crypto/digest';
import { toHex, utf8Encode } from '../internal/bytes';

/**
 * Batch idempotency keys (spec §21).
 *
 * The key is *derived*, not random, so that a retry of the same batch presents
 * the same key. That is what makes an upload that succeeded server-side but
 * failed to reach us — a dropped response, a killed background task — safe to
 * repeat: the server recognises the key and returns the original result instead
 * of storing the points twice.
 *
 * Event ids are sorted so that a re-read of the queue in a different row order
 * still produces the same key.
 *
 * The digest also means the key carries no timestamp and no coordinate: it is
 * an opaque 64-character hex token, safe to log and to put in a header.
 */

const KEY_VERSION = 'v1';

export async function deriveBatchIdempotencyKey(
  deviceId: string,
  eventIds: readonly string[],
): Promise<string> {
  const sorted = [...eventIds].sort();
  const material = `${KEY_VERSION}|${deviceId}|${sorted.join(',')}`;
  return toHex(await sha256(utf8Encode(material)));
}

/** Mutation keys use the same derivation so an offline queue replays safely. */
export async function deriveMutationIdempotencyKey(
  deviceId: string,
  kind: string,
  mutationId: string,
): Promise<string> {
  const material = `${KEY_VERSION}|${deviceId}|${kind}|${mutationId}`;
  return toHex(await sha256(utf8Encode(material)));
}
