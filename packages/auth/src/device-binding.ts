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
 * THE CLAIM IS NOT MINTED, AND THAT IS NOW A DECISION RATHER THAN A GAP. The
 * user pool declares no custom attributes and the pre-token-generation trigger
 * adds only `app_env` and `profile_schema_version`, so `custom:device_id` is
 * absent from every token the deployed pool issues, and the header is what makes
 * the device-requiring paths reachable at all.
 *
 * It stays that way because minting it cannot be done reliably. Three facts
 * compose badly:
 *
 *  1. A Cognito custom attribute is one value per USER, not per session. A
 *     person with a phone and a tablet has one attribute, so it cannot express
 *     which device is holding this token. The value would have to come from the
 *     request, not from the profile.
 *  2. The V1 trigger can only alter the IDENTITY token, and the API verifies the
 *     ACCESS token. Reaching the access token needs the V2 trigger, which the
 *     PLUS feature plan does provide — so this part is merely work.
 *  3. The only per-request channel into the trigger is `clientMetadata`, and
 *     Cognito does not pass it on `REFRESH_TOKEN_AUTH`. Every refreshed access
 *     token — which is most of them, for the life of a session — would carry no
 *     claim.
 *
 * So the claim would be present on the tokens minted at sign-in and absent on
 * every token minted after the first refresh. The header fallback would have to
 * stay for the refresh path, meaning the surface the claim was meant to close
 * stays open, and the codebase gains a second binding path that is right some of
 * the time. A check that holds only until the first token refresh is worse than
 * one honest path, because it reads as stronger than it is.
 *
 * What actually carries the weight is the registry lookup below the assertion:
 * the device must exist, belong to the authenticated user, and be ACTIVE, and
 * revoking a device takes effect on the very next request because it is a read,
 * not a claim. That is the property worth having, and it does not depend on
 * where the id was asserted. Revisit only if Cognito starts passing client
 * metadata through the refresh flow.
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
