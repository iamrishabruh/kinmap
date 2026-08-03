import { DeviceIdSchema, type DeviceId } from '@family/contracts';

/**
 * Resolving which device a request came from.
 *
 * The authorization checker requires a registered, ACTIVE device for every
 * operation that reaches a family member's data (spec §18, step 3), so a stolen
 * access token alone is not enough. This module answers the narrower question of
 * where that device id comes from.
 *
 * Two sources, in priority order:
 *
 *  1. `custom:device_id` on the access token, written at sign-in. This is the
 *     stronger form — the binding is inside a signature the client cannot forge
 *     — and it is what this codebase was designed around.
 *  2. The `x-device-id` request header.
 *
 * The header is not a weakening of the check, and it matters that this is clear.
 * Whichever source it comes from, the id is only ever an *assertion*: the
 * checker then loads that device from the registry and denies the request unless
 * it belongs to the authenticated user and is ACTIVE. A caller asserting a
 * device id they do not own gets REQUESTER_DEVICE_NOT_REGISTERED. The token
 * establishes identity; this only selects which of that identity's registered
 * devices is claiming to be in hand.
 *
 * The fallback exists because the claim is not currently minted. The user pool
 * declares no custom attributes and the pre-token-generation trigger adds only
 * `app_env` and `profile_schema_version`, so `custom:device_id` is absent from
 * every token the deployed pool issues. Services that read only the claim
 * therefore resolve `null` and deny every device-requiring operation — which is
 * every read of another person's location. Until the claim is minted, the header
 * is the only thing that makes those paths reachable at all.
 */

const DEVICE_ID_HEADER = 'x-device-id';

/** The access-token claim that carries the binding when the pool mints it. */
export const DEVICE_ID_CLAIM = 'custom:device_id';

/** Null is accepted because an API Gateway v2 event may omit headers entirely. */
export type HeaderSource = Readonly<Record<string, string | undefined>> | null;

function parse(candidate: unknown): DeviceId | null {
  if (typeof candidate !== 'string') {
    return null;
  }
  const parsed = DeviceIdSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/**
 * Reads the device id from token claims, then from headers.
 *
 * Header lookup is case-insensitive: API Gateway lower-cases header names in the
 * v2 payload format, but a direct invocation or a test may not.
 */
export function resolveDeviceId(input: {
  readonly claims?: Readonly<Record<string, unknown>> | undefined;
  readonly headers?: HeaderSource | undefined;
}): DeviceId | null {
  const fromClaim = parse(input.claims?.[DEVICE_ID_CLAIM]);
  if (fromClaim !== null) {
    return fromClaim;
  }

  const headers = input.headers;
  if (headers === undefined || headers === null) {
    return null;
  }
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === DEVICE_ID_HEADER) {
      return parse(value);
    }
  }
  return null;
}
