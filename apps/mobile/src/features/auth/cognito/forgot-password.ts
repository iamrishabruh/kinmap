import { z } from 'zod';

import { AppError, type ErrorCode } from '@family/contracts';

import { cognitoConfig } from './config';
import { callCognito } from './idp-client';

/**
 * Password recovery against the Cognito user pool.
 *
 * Two calls — `ForgotPassword` emails a code, `ConfirmForgotPassword` spends it
 * — and one piece of in-memory state that carries the address between the two
 * screens. `AccountRecovery.EMAIL_ONLY` is set on the pool in
 * `identity-stack.ts`, so there is no SMS route here and there must never be
 * one: a SIM swap is a way into somebody's location history, which is exactly
 * this product's threat model.
 *
 * ---------------------------------------------------------------------------
 * THE ANSWER IS THE SAME EITHER WAY
 * ---------------------------------------------------------------------------
 * `requestPasswordReset` resolves identically whether or not the address has an
 * account. Not "usually", not "for the common failures" — identically, which is
 * why every Cognito rejection below is swallowed rather than mapped.
 *
 * `PreventUserExistenceErrors` is enabled on the pool, so Cognito already
 * simulates a code delivery for an unknown address. This function does not lean
 * on that alone, because the failures that survive it are precisely the ones
 * that answer "does this address have an account here": `InvalidParameterException`
 * for a real account with no verified email, and a `UserLambdaValidationException`
 * from the CustomMessage trigger, which only fires for an account that exists.
 * For a location product, confirming that a given person uses the app is
 * confirming where to look for them.
 *
 * Two failures are still surfaced, and both are facts about the caller rather
 * than about the account:
 *
 *   RATE_LIMITED         — you have asked too often. True regardless of who you
 *                          asked about.
 *   UPSTREAM_UNAVAILABLE — the request never reached Cognito at all. Reporting
 *                          "check your email" to somebody in a tunnel would be
 *                          a lie, and a lie is not a privacy control.
 *
 * The cost is real and accepted: a misconfigured pool looks, from this screen,
 * exactly like a code that was sent. The screen therefore always offers a
 * resend and a way back out, and never claims more than "if that address has an
 * account, a code is on its way".
 *
 * NOTHING HERE LOGS. Same rule as `idp-client.ts`: every argument on the way in
 * is either an address, a code or a password.
 */

/** Cognito confirmation codes are six digits. */
export const PASSWORD_RESET_CODE_LENGTH = 6;

/**
 * What a screen may know about a reset in flight.
 *
 * Deliberately does not carry the address. The full address is typed on
 * `forgot-password` and from that point on it lives only in the module-private
 * `pending` below: not in a route param, not in navigation state, not in a
 * store that a debug view can render. `reset-password` needs to know that a
 * reset is in progress and how long the code is — nothing else.
 */
export type PendingPasswordReset = {
  readonly codeLength: number;
};

type PendingReset = PendingPasswordReset & {
  /** Never exported. `resend` and `confirm` read it; no screen can. */
  readonly email: string;
};

/**
 * Memory only, and cleared on a cold start.
 *
 * Persisting it would mean writing an address to disk to save one screen of
 * typing, and would leave a "somebody was resetting the password for this
 * account" marker on the device. Losing it costs the user one tap on "start
 * again"; keeping it costs somebody their privacy in the case where the phone
 * is the thing that has been taken.
 */
let pending: PendingReset | null = null;

/** Whether a reset is in flight on this device. Never the address. */
export function pendingPasswordReset(): PendingPasswordReset | null {
  return pending === null ? null : { codeLength: pending.codeLength };
}

export function clearPendingPasswordReset(): void {
  pending = null;
}

/** Failures that say something about the caller, not about the account. */
const CALLER_FACTS: readonly ErrorCode[] = ['RATE_LIMITED', 'UPSTREAM_UNAVAILABLE'];

function isCallerFact(error: unknown): boolean {
  return error instanceof AppError && CALLER_FACTS.includes(error.code);
}

/**
 * `CodeDeliveryDetails` comes back on this response and is deliberately not
 * read. It is the one field that differs between a real delivery and Cognito's
 * simulated one, so surfacing it — even masked — would put the account-existence
 * answer back into the copy the user reads.
 */
const ForgotPasswordResponseSchema = z.object({});

async function sendResetCode(email: string): Promise<void> {
  try {
    await callCognito(
      'ForgotPassword',
      { ClientId: cognitoConfig().clientId, Username: email },
      ForgotPasswordResponseSchema,
    );
  } catch (error) {
    if (isCallerFact(error)) throw error;
    // Swallowed on purpose. See the file header: every remaining failure either
    // proves the account exists or is indistinguishable from one that does.
  }
}

/**
 * Asks Cognito to email a recovery code.
 *
 * Resolves the same way for an address with an account and an address without
 * one. The caller must not add a branch that could tell them apart.
 */
export async function requestPasswordReset(input: {
  readonly email: string;
}): Promise<PendingPasswordReset> {
  const email = input.email.trim();
  await sendResetCode(email);
  pending = { email, codeLength: PASSWORD_RESET_CODE_LENGTH };
  return { codeLength: PASSWORD_RESET_CODE_LENGTH };
}

function noResetInProgress(): AppError {
  return new AppError(
    'VALIDATION_FAILED',
    'That password reset is no longer in progress. Start again and we will send a new code.',
  );
}

/**
 * Sends another code to the address already being reset.
 *
 * Exists so the reset screen can offer a resend without ever holding the
 * address it would have to send it to.
 */
export async function resendPasswordReset(): Promise<PendingPasswordReset> {
  const current = pending;
  if (current === null) throw noResetInProgress();
  await sendResetCode(current.email);
  return { codeLength: current.codeLength };
}

const ConfirmForgotPasswordResponseSchema = z.object({});

/**
 * Spends the emailed code and sets the new password.
 *
 * ONE ANSWER FOR EVERY REJECTION, for the same reason `confirmSignUp` has one:
 * this runs before anybody is authenticated, so a message that separates "wrong
 * code" from "no such account" from "that password is too weak" hands an
 * unauthenticated caller the account-existence answer. The wording names both
 * fields the user can act on rather than pretending the code is always the
 * problem — `passwordRequirements` below is what keeps a policy failure from
 * reaching here in the first place.
 *
 * A rate limit is still surfaced separately: it is a fact about the caller.
 * So is a request that never reached Cognito.
 */
export async function confirmPasswordReset(input: {
  readonly code: string;
  readonly newPassword: string;
}): Promise<void> {
  const current = pending;
  if (current === null) throw noResetInProgress();

  try {
    await callCognito(
      'ConfirmForgotPassword',
      {
        ClientId: cognitoConfig().clientId,
        Username: current.email,
        ConfirmationCode: input.code.trim(),
        Password: input.newPassword,
      },
      ConfirmForgotPasswordResponseSchema,
    );
  } catch (error) {
    if (isCallerFact(error)) throw error;
    throw new AppError(
      'VALIDATION_FAILED',
      'We could not reset your password. Check the code and the new password, then try again. ' +
        'If the code has expired, request a new one.',
    );
  }

  // Single use. The code has been spent and the address has no further job to
  // do on this device.
  pending = null;
}

// ---------------------------------------------------------------------------
// Password policy
//
// Mirrors `passwordPolicy` on the user pool in `identity-stack.ts`: 12
// characters, one of each class. It is checked here BEFORE the request goes out
// because a server-side rejection has to be collapsed into the same opaque
// answer as a wrong code (see above), and "we cannot tell you what was wrong"
// is a miserable thing to say to somebody locked out of a safety product.
//
// The requirements are shown up front, never revealed one at a time after a
// failed attempt.
// ---------------------------------------------------------------------------

export const PASSWORD_MIN_LENGTH = 12;

/** The symbol set Cognito documents for its password policy. */
const SYMBOLS = /[\^$*.[\]{}()?"!@#%&/\\,><':;|_~`+=-]/u;

export type PasswordRequirement = {
  readonly id: string;
  readonly label: string;
  readonly met: boolean;
};

/**
 * The pool's rules, each one separately answered.
 *
 * Returned as data rather than a boolean so the screen can render the list with
 * its state in text — a green tick alone tells a screen-reader user and a
 * colour-blind user nothing.
 */
export function passwordRequirements(password: string): readonly PasswordRequirement[] {
  return [
    {
      id: 'length',
      label: `At least ${PASSWORD_MIN_LENGTH} characters`,
      met: password.length >= PASSWORD_MIN_LENGTH,
    },
    { id: 'lowercase', label: 'A lower-case letter', met: /\p{Ll}/u.test(password) },
    { id: 'uppercase', label: 'An upper-case letter', met: /\p{Lu}/u.test(password) },
    { id: 'digit', label: 'A number', met: /\d/u.test(password) },
    { id: 'symbol', label: 'A symbol, such as ! ? @ or #', met: SYMBOLS.test(password) },
    { id: 'edges', label: 'No space at the start or end', met: password.trim() === password },
  ];
}

export function meetsPasswordPolicy(password: string): boolean {
  return passwordRequirements(password).every((requirement) => requirement.met);
}
