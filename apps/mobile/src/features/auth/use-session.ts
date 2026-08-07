import { useMemo } from 'react';

import type { Account } from '@family/schemas';

import { evaluateConsent, type ConsentEvaluation } from '@/features/consent/consent-gate';
import { CURRENT_POLICY_VERSIONS } from '@/features/consent/versions';

import { useSessionStore } from './session-store';
import type { PendingChallenge, SessionStatus } from './types';

/**
 * The read side of the session.
 *
 * Every field is selected individually. Returning a fresh object from a Zustand
 * selector re-renders on every store write regardless of what changed, and this
 * hook sits at the root of the tree.
 */

export type Session = {
  status: SessionStatus;
  isRestoring: boolean;
  isAuthenticated: boolean;
  userId: string | null;
  account: Account | null;
  challenge: PendingChallenge | null;
  /** Full evaluation, so screens can name the specific document that changed. */
  consent: ConsentEvaluation;
  /** `null` account means "not loaded yet", which is NOT "no consent needed". */
  accountLoaded: boolean;
  hasFamily: boolean;
  onboardingCompleted: boolean;
};

export function useSession(): Session {
  const status = useSessionStore((state) => state.status);
  const userId = useSessionStore((state) => state.session?.userId ?? null);
  const account = useSessionStore((state) => state.account);
  const challenge = useSessionStore((state) => state.challenge);
  const onboardingCompleted = useSessionStore((state) => state.onboardingCompleted);

  const consent = useMemo(
    () =>
      evaluateConsent(
        account === null
          ? null
          : {
              acceptedTermsVersion: account.acceptedTermsVersion,
              acceptedPrivacyPolicyVersion: account.acceptedPrivacyPolicyVersion,
              ageBand: account.ageBand,
            },
        CURRENT_POLICY_VERSIONS,
      ),
    [account],
  );

  return {
    status,
    isRestoring: status === 'restoring',
    isAuthenticated: status === 'authenticated',
    userId,
    account,
    challenge,
    consent,
    accountLoaded: account !== null,
    hasFamily: (account?.familyIds.length ?? 0) > 0,
    onboardingCompleted,
  };
}

/** Convenience for screens that only need to know whether to render at all. */
export function useIsAuthenticated(): boolean {
  return useSessionStore((state) => state.status === 'authenticated');
}

/** The reason for the most recent sign-out, so it can be explained once. */
export function useLastSignOutReason() {
  const reason = useSessionStore((state) => state.lastSignOutReason);
  const clear = useSessionStore((state) => state.clearSignOutReason);
  return { reason, clear };
}
