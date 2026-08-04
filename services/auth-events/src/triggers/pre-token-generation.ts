import type { Logger } from '@family/observability';

import type { AuthEventsConfig } from '../env.js';
import type { PreTokenGenerationEvent } from '../events.js';
import { buildUserProfile } from '../profile.js';
import type { UserProfileRepository } from '../users-repository.js';

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

export type PreTokenGenerationDeps = {
  readonly config: AuthEventsConfig;
  readonly users: UserProfileRepository;
  readonly logger: Logger;
  readonly now: () => Date;
};

/**
 * Makes sure a federated account has a profile.
 *
 * Cognito does not invoke PostConfirmation for users created through an external
 * provider, and PostConfirmation is where the Users row is written. Nor can
 * PreSignUp do it: at that point Cognito has not assigned a subject yet, so
 * there is no key to write under. Token generation is the first moment a
 * federated user has both a subject and verified attributes.
 *
 * Deliberately best-effort. A profile that cannot be written must not stop
 * somebody signing in — the write is conditional, so the next token issuance
 * simply tries again, and a transient failure heals itself. What must never
 * happen is that an outage in this write becomes an outage in authentication.
 */
async function ensureFederatedProfile(
  event: PreTokenGenerationEvent,
  deps: PreTokenGenerationDeps,
): Promise<void> {
  const provider = event.request.userAttributes['identities'];
  if (provider === undefined || provider === '') {
    // A native account; PostConfirmation already owns it.
    return;
  }

  try {
    const profile = buildUserProfile({
      attributes: event.request.userAttributes,
      userName: event.userName,
      emailHashSecret: deps.config.emailHashSecret ?? event.userPoolId,
      termsVersion: deps.config.termsVersion,
      privacyPolicyVersion: deps.config.privacyPolicyVersion,
      now: deps.now(),
    });

    const outcome = await deps.users.createProfile(profile);
    if (outcome !== 'ALREADY_EXISTS') {
      // Ids and flags only: that an account exists, never whose it is.
      deps.logger.info('federated_profile_provisioned', {
        outcome,
        identityProvider: profile.identityProvider,
        hasEmail: profile.email !== null,
        isPrivateRelayEmail: profile.isPrivateRelayEmail,
      });
    }
  } catch (error) {
    deps.logger.error('federated_profile_write_failed', {
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
  }
}

export async function handlePreTokenGeneration(
  event: PreTokenGenerationEvent,
  deps: PreTokenGenerationDeps,
): Promise<PreTokenGenerationEvent> {
  await ensureFederatedProfile(event, deps);

  const { config } = deps;
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
