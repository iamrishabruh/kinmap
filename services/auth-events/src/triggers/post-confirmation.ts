import { AgeBandSchema, BirthDateSchema, ageBandFor, type AgeBand } from '@family/contracts';
import type { Logger } from '@family/observability';

import type { AuthEventsConfig } from '../env.js';
import type { ClientMetadata, PostConfirmationEvent } from '../events.js';
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
 * pass through here. `pre-token-generation.ts` provisions those, at the first
 * moment a federated user has a subject; this trigger owns native sign-ups.
 */

/** Accepted spellings, matching `pre-signup.ts`. */
const BIRTH_DATE_KEYS = ['birthDate', 'birth_date', 'birthdate'] as const;

/**
 * The age band for a native sign-up, derived from the date on the confirmation.
 *
 * WHY THE DATE HAS TO BE SENT TWICE. PreSignUp is where the age gate is applied,
 * and it receives the date in `validationData`. It is also the one trigger that
 * cannot persist anything: Cognito has not assigned a subject yet, so there is
 * no key to write a profile under. PostConfirmation has the subject and no
 * validation data — Cognito does not carry it forward between triggers. So the
 * client sends the date again as `ClientMetadata` on `ConfirmSignUp`, which
 * PostConfirmation does receive, and the band is derived here.
 *
 * That is not a weaker gate than PreSignUp's. Both inputs are client-supplied
 * and neither is trusted: this one is re-validated and re-banded server-side,
 * and an absent or under-age value produces a null band rather than an admitted
 * account — which the client then has to resolve on the acceptance screen before
 * anything is reachable. The refusal that stops an under-13 account being
 * created at all still happens in PreSignUp, where it belongs.
 *
 * The date is banded and discarded, exactly as in PreSignUp. Nothing persists it.
 */
export function ageBandFromConfirmation(
  clientMetadata: ClientMetadata | null | undefined,
  now: Date,
): AgeBand | null {
  if (clientMetadata === null || clientMetadata === undefined) {
    return null;
  }

  for (const key of BIRTH_DATE_KEYS) {
    const value = clientMetadata[key];
    if (value === undefined || value.trim() === '') {
      continue;
    }
    const parsed = BirthDateSchema.safeParse(value.trim());
    if (!parsed.success) {
      return null;
    }
    const band = ageBandFor(parsed.data, now);
    // UNDER_13 is never stored. PreSignUp refuses that account outright, so
    // reaching here with one means the two disagreed — record nothing rather
    // than persist a band the platform has no lawful basis to serve.
    return band === AgeBandSchema.enum.UNDER_13 ? null : band;
  }

  return null;
}

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
  const now = deps.now();
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
    ageBand: ageBandFromConfirmation(event.request.clientMetadata, now),
    now,
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
    // The band, which is a category, not the date, which is an identifier.
    ageBandRecorded: profile.ageBand !== null,
  });

  // Cognito requires the event back, unchanged: this trigger has no response.
  return event;
}
