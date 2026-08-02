import type { QueryClient } from '@tanstack/react-query';

import { AppError } from '@family/contracts';

import { purgeOnAccountDeletion } from '../../privacy/cache-purge';
import type { AccountDeletionReason, DeleteAccountResponse } from '../api/contracts';
import { deleteAccount as deleteAccountRequest } from '../api/endpoints';

import {
  isReauthenticationFresh,
  reauthenticate as runReauthentication,
  type ReauthenticationProof,
  type ReauthenticationResult,
} from './reauthentication';

/**
 * The account-deletion flow (spec §16).
 *
 * Four gates, in order, and the destructive call is unreachable without all
 * four:
 *   1. REVIEW        — the user is shown, explicitly, what they are about to
 *                      lose. Not a summary: the actual families, the actual
 *                      counts, and the fact that a store subscription is not
 *                      cancelled by deleting an account.
 *   2. REAUTHENTICATE— they prove they are the account holder, recently.
 *   3. CONFIRM       — they type DELETE. A slip of the thumb cannot do this.
 *   4. SUBMIT        — DELETE /v1/account, then local purge, then sign-out.
 *
 * The reducer is pure and the submit function refuses on its own, rather than
 * relying on the screen to have disabled a button. UI state is not a security
 * boundary; a screen can be re-rendered, deep-linked into, or reached again
 * after a crash restores state.
 */

export type AccountDeletionStep = 'REVIEW' | 'REAUTHENTICATE' | 'CONFIRM' | 'SUBMITTING' | 'DONE';

/** The literal the user must type. Compared case-sensitively, on purpose. */
export const DELETION_CONFIRMATION_PHRASE = 'DELETE';

export type AccountDeletionState = {
  step: AccountDeletionStep;
  /** Set once REVIEW has actually been read to the bottom and acknowledged. */
  consequencesAcknowledged: boolean;
  proof: ReauthenticationProof | null;
  typedConfirmation: string;
  reason: AccountDeletionReason;
  feedback: string;
  /** User-safe message from the last failure, if any. */
  error: string | null;
  result: DeleteAccountResponse | null;
};

export const initialAccountDeletionState: AccountDeletionState = {
  step: 'REVIEW',
  consequencesAcknowledged: false,
  proof: null,
  typedConfirmation: '',
  reason: 'OTHER',
  feedback: '',
  error: null,
  result: null,
};

export type AccountDeletionAction =
  | { type: 'ACKNOWLEDGE_CONSEQUENCES' }
  | { type: 'SET_REASON'; reason: AccountDeletionReason }
  | { type: 'SET_FEEDBACK'; feedback: string }
  | { type: 'BEGIN_REAUTHENTICATION' }
  | { type: 'REAUTHENTICATION_SUCCEEDED'; proof: ReauthenticationProof }
  | { type: 'REAUTHENTICATION_FAILED'; message: string }
  | { type: 'SET_TYPED_CONFIRMATION'; value: string }
  | { type: 'SUBMIT_STARTED' }
  | { type: 'SUBMIT_SUCCEEDED'; result: DeleteAccountResponse }
  | { type: 'SUBMIT_FAILED'; message: string }
  | { type: 'RESET' };

export function accountDeletionReducer(
  state: AccountDeletionState,
  action: AccountDeletionAction,
): AccountDeletionState {
  switch (action.type) {
    case 'ACKNOWLEDGE_CONSEQUENCES':
      return { ...state, consequencesAcknowledged: true, error: null };

    case 'SET_REASON':
      return { ...state, reason: action.reason };

    case 'SET_FEEDBACK':
      return { ...state, feedback: action.feedback };

    case 'BEGIN_REAUTHENTICATION':
      // Cannot skip the review step by deep-linking into reauthentication.
      if (!state.consequencesAcknowledged) return state;
      return { ...state, step: 'REAUTHENTICATE', error: null };

    case 'REAUTHENTICATION_SUCCEEDED':
      return { ...state, step: 'CONFIRM', proof: action.proof, error: null };

    case 'REAUTHENTICATION_FAILED':
      // Drop any earlier proof: a failed attempt must not leave a stale one
      // sitting in state that a later step would happily accept.
      return { ...state, step: 'REVIEW', proof: null, error: action.message };

    case 'SET_TYPED_CONFIRMATION':
      return { ...state, typedConfirmation: action.value, error: null };

    case 'SUBMIT_STARTED':
      return { ...state, step: 'SUBMITTING', error: null };

    case 'SUBMIT_SUCCEEDED':
      return { ...state, step: 'DONE', result: action.result, error: null };

    case 'SUBMIT_FAILED':
      // Back to CONFIRM, keeping the proof if it is still valid; the caller
      // re-checks freshness before any retry reaches the network.
      return { ...state, step: 'CONFIRM', error: action.message };

    case 'RESET':
      return initialAccountDeletionState;

    default:
      return state;
  }
}

/** Why the confirm button is disabled, or null when it is ready. */
export function blockingReason(state: AccountDeletionState, now: Date = new Date()): string | null {
  if (!state.consequencesAcknowledged) {
    return 'Read what happens when your account is deleted, then continue.';
  }
  if (!isReauthenticationFresh(state.proof, now)) {
    return 'Confirm it is you before deleting your account.';
  }
  if (state.typedConfirmation !== DELETION_CONFIRMATION_PHRASE) {
    return `Type ${DELETION_CONFIRMATION_PHRASE} to confirm.`;
  }
  return null;
}

export function canSubmitDeletion(state: AccountDeletionState, now: Date = new Date()): boolean {
  return state.step !== 'SUBMITTING' && blockingReason(state, now) === null;
}

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

export type ReauthenticationDeps = {
  reauthenticate?: (reason: 'DELETE_ACCOUNT') => Promise<ReauthenticationResult>;
};

/** Runs reauthentication and translates every failure into a user-safe message. */
export async function reauthenticateForDeletion(
  deps: ReauthenticationDeps = {},
): Promise<ReauthenticationResult> {
  const run = deps.reauthenticate ?? runReauthentication;
  return run('DELETE_ACCOUNT');
}

export function describeReauthenticationFailure(
  failure: 'CANCELLED' | 'FAILED' | 'UNAVAILABLE',
): string {
  switch (failure) {
    case 'CANCELLED':
      return 'You cancelled. Your account has not been changed.';
    case 'FAILED':
      return 'We could not confirm it was you. Nothing has been deleted — please try again.';
    case 'UNAVAILABLE':
      return 'We cannot confirm it is you on this device right now, so we will not delete your account. Please try again later or contact support.';
    default:
      return 'We could not confirm it was you. Nothing has been deleted.';
  }
}

export type RequestAccountDeletionDeps = {
  queryClient?: QueryClient | null;
  /** Injected in tests. */
  deleteAccount?: typeof deleteAccountRequest;
  purge?: typeof purgeOnAccountDeletion;
  /** Clears the session. Called only after the server has accepted. */
  signOut?: () => Promise<void>;
  now?: () => Date;
};

/**
 * Performs the deletion.
 *
 * THROWS BEFORE TOUCHING THE NETWORK if the state has not passed every gate.
 * This is the load-bearing check: even if a screen somehow renders an enabled
 * button, the request does not leave the device without a fresh reauthentication
 * proof and a typed confirmation.
 */
export async function requestAccountDeletion(
  state: AccountDeletionState,
  deps: RequestAccountDeletionDeps = {},
): Promise<DeleteAccountResponse> {
  const now = deps.now?.() ?? new Date();

  if (!state.consequencesAcknowledged) {
    throw new AppError(
      'FORBIDDEN',
      'Please read what happens when your account is deleted before continuing.',
    );
  }

  if (!isReauthenticationFresh(state.proof, now)) {
    throw new AppError('UNAUTHENTICATED', 'Please confirm it is you before deleting your account.');
  }

  if (state.typedConfirmation !== DELETION_CONFIRMATION_PHRASE) {
    throw new AppError('VALIDATION_FAILED', `Type ${DELETION_CONFIRMATION_PHRASE} to confirm.`);
  }

  const call = deps.deleteAccount ?? deleteAccountRequest;
  const result = await call({
    confirmation: 'DELETE',
    reason: state.reason,
    feedback: state.feedback.trim().length > 0 ? state.feedback.trim() : null,
  });

  // The server has accepted. From here the device must stop being a copy of the
  // account: stop collecting, drop every local cache, then end the session.
  // Neither of these may throw past this point — the account is already gone,
  // and stranding the user in a signed-in shell of a deleted account is worse
  // than a silent cleanup failure.
  const purge = deps.purge ?? purgeOnAccountDeletion;
  try {
    await purge(deps.queryClient ?? null);
  } catch {
    // Reported by the purge itself; nothing further to do here.
  }

  try {
    await deps.signOut?.();
  } catch {
    // Session teardown is best-effort; the tokens are revoked server-side.
  }

  return result;
}
