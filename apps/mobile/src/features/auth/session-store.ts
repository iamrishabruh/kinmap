import { create } from 'zustand';

import type { Account } from '@family/schemas';

import type { ConsentRecord } from '@/features/consent/consent-gate';

import type { PendingChallenge, SessionStatus, SignOutReason, StoredSession } from './types';

/**
 * In-memory session state.
 *
 * Zustand rather than Context because the refresh path has to read and write
 * the current tokens from outside React — an HTTP interceptor is not a hook —
 * and `useSessionStore.getState()` gives that without a module-level mutable
 * singleton that React would then be out of sync with.
 *
 * NOTHING in this store is persisted by Zustand. Tokens go to the keychain via
 * `secure-token-storage`; everything else is rebuilt on launch. There is no
 * `persist` middleware here and there must not be one: it would put access
 * tokens and family membership into plaintext storage.
 */

export type SessionState = {
  status: SessionStatus;
  session: StoredSession | null;
  challenge: PendingChallenge | null;
  /**
   * Server-authoritative account snapshot. `null` means "not fetched yet",
   * which is NOT the same as "no consent on file" — the guard treats unknown
   * consent as blocking until the account load resolves.
   */
  account: Account | null;
  /** Device-local; see `onboarding-progress.ts`. */
  onboardingCompleted: boolean;
  /** Surfaced on the sign-in screen so an expiry is explained, not mysterious. */
  lastSignOutReason: SignOutReason | null;

  beginRestore: () => void;
  restoreFinished: (session: StoredSession | null) => void;
  setSession: (session: StoredSession) => void;
  setChallenge: (challenge: PendingChallenge) => void;
  clearChallenge: () => void;
  setAccount: (account: Account | null) => void;
  setOnboardingCompleted: (completed: boolean) => void;
  clearSignOutReason: () => void;
  reset: (reason: SignOutReason) => void;
};

const INITIAL = {
  status: 'restoring' as SessionStatus,
  session: null,
  challenge: null,
  account: null,
  onboardingCompleted: false,
  lastSignOutReason: null,
};

export const useSessionStore = create<SessionState>((set) => ({
  ...INITIAL,

  beginRestore: () => set({ status: 'restoring' }),

  restoreFinished: (session) =>
    set(
      session === null
        ? { status: 'unauthenticated', session: null }
        : { status: 'authenticated', session },
    ),

  /**
   * Establishing a session always clears any outstanding challenge: the
   * challenge is what produced this session, and leaving it set would pin the
   * guard to a screen the user has already completed.
   */
  setSession: (session) =>
    set({ status: 'authenticated', session, challenge: null, lastSignOutReason: null }),

  setChallenge: (challenge) => set({ status: 'challenge', challenge }),

  /**
   * Abandoning a challenge. This is the only escape from a pinned challenge
   * screen, and it must drop all the way to unauthenticated — a half-completed
   * sign-in is not a session.
   */
  clearChallenge: () => set({ status: 'unauthenticated', challenge: null, session: null }),

  setAccount: (account) => set({ account }),

  setOnboardingCompleted: (completed) => set({ onboardingCompleted: completed }),

  clearSignOutReason: () => set({ lastSignOutReason: null }),

  /**
   * Full teardown. Everything derived from the identity goes at once so no
   * screen can render a previous user's family while the next sign-in is in
   * flight.
   */
  reset: (reason) => set({ ...INITIAL, status: 'unauthenticated', lastSignOutReason: reason }),
}));

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

export function selectConsentRecord(state: SessionState): ConsentRecord | null {
  if (state.account === null) return null;
  return {
    acceptedTermsVersion: state.account.acceptedTermsVersion,
    acceptedPrivacyPolicyVersion: state.account.acceptedPrivacyPolicyVersion,
    ageBand: state.account.ageBand,
  };
}

export function selectHasFamily(state: SessionState): boolean {
  return (state.account?.familyIds.length ?? 0) > 0;
}

export function selectUserId(state: SessionState): string | null {
  return state.session?.userId ?? null;
}

/** Read the live access token from outside React (used by the HTTP layer). */
export function getAccessTokenSnapshot(): string | null {
  return useSessionStore.getState().session?.accessToken ?? null;
}

export function getStoredSessionSnapshot(): StoredSession | null {
  return useSessionStore.getState().session;
}
