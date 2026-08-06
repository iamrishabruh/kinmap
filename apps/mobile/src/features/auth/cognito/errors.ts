import { AppError } from '@family/contracts';

/**
 * Cognito failures, translated.
 *
 * ONE RULE ABOVE ALL: the message Cognito sent is never surfaced and never
 * logged. Its `message` field routinely contains the username, and for a
 * location product an error string that confirms "this address has an account"
 * is the same disclosure as answering "does this person use the app". Every
 * mapping below therefore returns a fixed string chosen here.
 *
 * The second rule follows from the first. `PreventUserExistenceErrors` is
 * enabled on the pool, so Cognito already answers an unknown address and a
 * wrong password identically — it even mints a decoy salt and `SRP_B` so the
 * handshake takes the same shape. The client must not undo that by splitting
 * those cases apart again, so every credential-shaped failure, including the
 * ones the pool would only return with that setting off, collapses to the same
 * `AppError`. `UserNotConfirmedException` and `PasswordResetRequiredException`
 * are in that list deliberately: both are real states, but both answer
 * "does this address have an account", and the route out of them — password
 * recovery — works without the app having to say so.
 */

/** Fixed, user-safe strings. An attacker learns nothing from which one appears. */
export const COGNITO_ERROR_MESSAGES = {
  CREDENTIALS: 'That email address and password do not match an account.',
  MFA_CODE: 'That code is not right. Check your authenticator app and try again.',
  MFA_CODE_EXPIRED: 'That code has expired. Enter the current one from your authenticator app.',
  CHALLENGE_EXPIRED: 'That sign-in took too long. Please start again.',
  SESSION_OVER: 'Your session has expired. Please sign in again.',
  UNAVAILABLE: 'We could not reach Family Location. Check your connection and try again.',
  INTERNAL: 'Something went wrong on our side. Please try again.',
} as const;

/** Cognito's `__type` may be bare or namespaced (`com.amazon.coral.service#…`). */
export function cognitoErrorType(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const hash = raw.lastIndexOf('#');
  return hash >= 0 ? raw.slice(hash + 1) : raw;
}

/**
 * Every failure that must be indistinguishable from every other failure of the
 * credential flow.
 */
const CREDENTIAL_FAILURES = new Set([
  'NotAuthorizedException',
  'UserNotFoundException',
  'UserNotConfirmedException',
  'PasswordResetRequiredException',
  'InvalidPasswordException',
  'InvalidUserPoolConfigurationException',
]);

/** Answering an MFA challenge. Existence is already proven, so these are specific. */
const MFA_FAILURES = new Set(['CodeMismatchException', 'SoftwareTokenMFANotFoundException']);

const RATE_LIMIT_FAILURES = new Set([
  'TooManyRequestsException',
  'TooManyFailedAttemptsException',
  'LimitExceededException',
  'RequestLimitExceeded',
  'ThrottlingException',
]);

/**
 * Retry hint for a throttled caller. Cognito does not send `Retry-After` on the
 * identity-provider API, so this is the client's own backoff rather than a
 * server instruction — long enough to be worth obeying, short enough that
 * someone locked out of a safety product is not left waiting.
 */
const THROTTLE_BACKOFF_SECONDS = 30;

/**
 * Maps a Cognito service error to the app's envelope.
 *
 * @param type   the value of `__type` from the response body.
 * @param status the HTTP status, used only when `__type` is missing.
 * @param triggerMessage
 *   The response `message`, passed ONLY so that the two sentences this
 *   platform's own PreSignUp trigger throws can be recognised. It is matched
 *   against fixed literals and never surfaced, never logged, and never
 *   interpolated into anything returned from here — the file's rule holds. It
 *   exists because without it every trigger refusal arrived as INTERNAL_ERROR,
 *   so an out-of-date build and a genuine server fault were indistinguishable,
 *   and the age gate's own refusal could never be recognised by the screen
 *   that is supposed to stop offering a retry.
 */
export function cognitoError(type: string, status: number, triggerMessage = ''): AppError {
  const name = cognitoErrorType(type);

  if (CREDENTIAL_FAILURES.has(name)) {
    // UNAUTHENTICATED rather than VALIDATION_FAILED: the transport's refresh
    // cycle keys off this code, and a wrong password is genuinely "not
    // authenticated" rather than a malformed request.
    return new AppError('UNAUTHENTICATED', COGNITO_ERROR_MESSAGES.CREDENTIALS);
  }

  if (MFA_FAILURES.has(name)) {
    return new AppError('VALIDATION_FAILED', COGNITO_ERROR_MESSAGES.MFA_CODE);
  }

  if (name === 'ExpiredCodeException') {
    return new AppError('VALIDATION_FAILED', COGNITO_ERROR_MESSAGES.MFA_CODE_EXPIRED);
  }

  if (RATE_LIMIT_FAILURES.has(name)) {
    return new AppError(
      'RATE_LIMITED',
      COGNITO_ERROR_MESSAGES.UNAVAILABLE,
      undefined,
      THROTTLE_BACKOFF_SECONDS,
    );
  }

  if (name === 'InvalidParameterException') {
    // Cognito's parameter complaints quote the offending value back, so the
    // one thing this cannot do is repeat them.
    return new AppError('VALIDATION_FAILED', COGNITO_ERROR_MESSAGES.CREDENTIALS);
  }

  if (name === 'ResourceNotFoundException' || name === 'ForbiddenException') {
    // The pool or client id in this build does not exist, or WAF rejected the
    // call. Both are our problem, not something the user can act on.
    return new AppError('INTERNAL_ERROR', COGNITO_ERROR_MESSAGES.INTERNAL);
  }

  if (
    name === 'UserLambdaValidationException' ||
    name === 'InvalidLambdaResponseException' ||
    name === 'UnexpectedLambdaException'
  ) {
    // A trigger threw, and Cognito wraps its message as
    // `PreSignUp failed with error <message>.`
    //
    // The message is still not shown — it is attacker-influencable and may
    // contain anything. But two of the sentences the PreSignUp trigger throws
    // are OUR OWN literals, and recognising them is the difference between
    // telling somebody what to do and blaming the server for it.
    //
    // Everything that is not one of those two remains INTERNAL_ERROR, and the
    // matched text is never echoed — only used to pick which of our own fixed
    // messages to show.
    const detail = triggerMessage;

    if (detail.includes('must be accepted before creating an account')) {
      // The versions in this binary are not the ones the pool now requires.
      // That is a build that has fallen behind, not a fault the user caused —
      // this exact case shipped once, showing "Something went wrong on our
      // end" when the app said 2026-05-01 and the trigger said 2026-01-01.
      return new AppError(
        'TERMS_ACCEPTANCE_REQUIRED',
        'This version of Kinmap is out of date. Please update the app and try again.',
      );
    }

    if (detail.includes('not available to everyone who tries to sign up')) {
      // The age gate. Surfaced with its own code so the sign-up screen can
      // stop offering a retry — without this the branch that does so could
      // never fire, because every trigger error arrived as INTERNAL_ERROR.
      return new AppError('AGE_REQUIREMENT_NOT_MET', 'Kinmap cannot create an account for you.');
    }

    return new AppError('INTERNAL_ERROR', COGNITO_ERROR_MESSAGES.INTERNAL);
  }

  if (status === 429) {
    return new AppError(
      'RATE_LIMITED',
      COGNITO_ERROR_MESSAGES.UNAVAILABLE,
      undefined,
      THROTTLE_BACKOFF_SECONDS,
    );
  }

  if (status >= 500) {
    return new AppError('UPSTREAM_UNAVAILABLE', COGNITO_ERROR_MESSAGES.UNAVAILABLE);
  }

  return new AppError('INTERNAL_ERROR', COGNITO_ERROR_MESSAGES.INTERNAL);
}

/** A request that never reached Cognito: airplane mode, DNS, TLS, timeout. */
export function cognitoTransportError(): AppError {
  return new AppError('UPSTREAM_UNAVAILABLE', COGNITO_ERROR_MESSAGES.UNAVAILABLE);
}
