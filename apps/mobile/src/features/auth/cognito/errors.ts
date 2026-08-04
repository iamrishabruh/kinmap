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
 */
export function cognitoError(type: string, status: number): AppError {
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
    // A trigger threw. Its message is attacker-influencable and may contain
    // anything at all, so none of it is shown.
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
