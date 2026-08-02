import type { Logger } from '@family/observability';

import type { AuthEventsConfig } from '../env.js';
import type { PostConfirmationEvent } from '../events.js';
import { buildUserProfile } from '../profile.js';
import type { UserProfileRepository } from '../users-repository.js';

/**
 * Post confirmation: create the application profile.
 *
 * The write is transactional and idempotent — see `users-repository.ts` for why
 * the email claim is part of the same transaction and how a cancelled
 * transaction is read. Cognito retries this trigger, so "already exists" is a
 * success, not an error.
 *
 * Federated accounts note: Cognito does not invoke PostConfirmation for users
 * created through an external provider, so an Apple or Google sign-in does not
 * pass through here. Those profiles are created by the linking flow that owns
 * provider account linking; this trigger stays responsible for native sign-ups.
 */

export type PostConfirmationDeps = {
  readonly config: AuthEventsConfig;
  readonly users: UserProfileRepository;
  readonly logger: Logger;
  readonly now: () => Date;
};

export async function handlePostConfirmation(
  event: PostConfirmationEvent,
  deps: PostConfirmationDeps,
): Promise<PostConfirmationEvent> {
  const profile = buildUserProfile({
    attributes: event.request.userAttributes,
    userName: event.userName,
    // The pool id is environment-scoped, so the fallback still separates
    // environments; a dedicated secret should be configured in production.
    emailHashSecret: deps.config.emailHashSecret ?? event.userPoolId,
    // Pre sign-up already refused anything that was not the current version, so
    // recording the server's own versions is accurate rather than trusting the
    // client's echo of them.
    termsVersion: deps.config.termsVersion,
    privacyPolicyVersion: deps.config.privacyPolicyVersion,
    now: deps.now(),
  });

  const outcome = await deps.users.createProfile(profile);

  // Ids and flags only. No address, no name, no hash — a log line says that an
  // account was created, not who it belongs to.
  deps.logger.info('profile_provisioned', {
    outcome,
    triggerSource: event.triggerSource,
    identityProvider: profile.identityProvider,
    hasEmail: profile.email !== null,
    isPrivateRelayEmail: profile.isPrivateRelayEmail,
    displayNameIsPlaceholder: profile.displayNameIsPlaceholder,
  });

  // Cognito requires the event back, unchanged: this trigger has no response.
  return event;
}
