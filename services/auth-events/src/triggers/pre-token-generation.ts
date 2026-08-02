import type { AuthEventsConfig } from '../env.js';
import type { PreTokenGenerationEvent } from '../events.js';

/**
 * Pre token generation.
 *
 * **No authorization decision is ever carried in a token.** Family membership,
 * role, sharing status and visibility are read from DynamoDB on every sensitive
 * request (spec §18/§34), because a JWT is a cached snapshot: a member removed
 * from a family, or someone who has just paused sharing, has to lose access
 * immediately — not whenever an access token happens to expire.
 *
 * So the claims added here are deliberately inert. They tell the client which
 * environment minted the token and which profile shape to expect, and nothing
 * else. Two further points make the rule hard to break by accident:
 *
 *  - the pool declares no custom attributes, so there is nowhere to stash a
 *    role even if somebody tried;
 *  - the V1 trigger can only modify the *identity* token, while the API
 *    verifies the *access* token — an authorization claim added here would not
 *    even reach the code that authorises.
 *
 * The suppression list is the other half: optional OIDC profile claims that the
 * product never uses are dropped so a token is not carrying a phone number or a
 * postal address around a mobile device's storage.
 */

export const ADDED_CLAIM_KEYS = ['app_env', 'profile_schema_version'] as const;

export const SUPPRESSED_CLAIMS: readonly string[] = [
  'phone_number',
  'phone_number_verified',
  'address',
  'birthdate',
  'gender',
  'zoneinfo',
  'website',
  'profile',
  'picture',
  'middle_name',
  'nickname',
  'preferred_username',
];

/** Bumped when the profile projection the client parses changes shape. */
export const PROFILE_SCHEMA_VERSION = '1';

export function handlePreTokenGeneration(
  event: PreTokenGenerationEvent,
  config: AuthEventsConfig,
): PreTokenGenerationEvent {
  return {
    ...event,
    response: {
      ...event.response,
      claimsOverrideDetails: {
        claimsToAddOrOverride: {
          app_env: config.env,
          profile_schema_version: PROFILE_SCHEMA_VERSION,
        },
        claimsToSuppress: [...SUPPRESSED_CLAIMS],
        // Groups are not used for authorization either, so nothing is
        // overridden here — an empty override would silently drop any group the
        // pool does assign.
      },
    },
  };
}
