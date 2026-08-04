import { ApiErrorSchema, AppError, type ErrorCode } from '@family/contracts';

/**
 * Maps an HTTP response onto the one error type the rest of the codebase
 * understands. Nothing from the response body is copied into the error unless
 * the body parsed as the shared `ApiError` envelope, which is contractually
 * free of coordinates, tokens and emails (spec §21).
 */

/**
 * Fallback when the server produced a status without a parseable envelope —
 * a load balancer 502, a WAF block, a truncated body.
 */
const STATUS_FALLBACK_CODE: Record<number, ErrorCode> = {
  400: 'VALIDATION_FAILED',
  401: 'UNAUTHENTICATED',
  402: 'ENTITLEMENT_REQUIRED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'VALIDATION_FAILED',
  408: 'UPSTREAM_UNAVAILABLE',
  409: 'CONFLICT',
  410: 'NOT_FOUND',
  413: 'PAYLOAD_TOO_LARGE',
  422: 'VALIDATION_FAILED',
  423: 'ACCOUNT_PENDING_DELETION',
  428: 'TERMS_ACCEPTANCE_REQUIRED',
  429: 'RATE_LIMITED',
  500: 'INTERNAL_ERROR',
  501: 'INTERNAL_ERROR',
  502: 'UPSTREAM_UNAVAILABLE',
  503: 'UPSTREAM_UNAVAILABLE',
  504: 'UPSTREAM_UNAVAILABLE',
};

/** User-safe copy used when the server did not supply a message. */
export const SAFE_ERROR_MESSAGES: Record<ErrorCode, string> = {
  UNAUTHENTICATED: 'Please sign in again.',
  SESSION_EXPIRED: 'Your session expired. Please sign in again.',
  FORBIDDEN: 'You do not have access to this resource.',
  NOT_A_FAMILY_MEMBER: 'You do not have access to this resource.',
  SHARING_DISABLED_BY_TARGET: 'You do not have access to this resource.',
  DEVICE_NOT_REGISTERED: 'This device is not registered.',
  DEVICE_REVOKED: 'This device is no longer allowed to share location.',
  NOT_FOUND: 'We could not find what you were looking for.',
  CONFLICT: 'That change conflicts with a more recent one. Please try again.',
  IDEMPOTENCY_KEY_REUSED: 'That request was already submitted.',
  VALIDATION_FAILED: 'Some of the information provided is not valid.',
  RATE_LIMITED: 'Too many requests. Please wait a moment and try again.',
  PAYLOAD_TOO_LARGE: 'That request was too large.',
  ENTITLEMENT_REQUIRED: 'This feature requires an upgraded plan.',
  PLAN_LIMIT_EXCEEDED: 'You have reached the limit for your plan.',
  INVITATION_INVALID: 'That invitation link is not valid.',
  INVITATION_EXPIRED: 'That invitation has expired.',
  INVITATION_ALREADY_USED: 'That invitation has already been used.',
  INVITATION_REVOKED: 'That invitation was revoked.',
  LIVE_SESSION_LIMIT: 'A live session is already running.',
  LIVE_SESSION_EXPIRED: 'That live session has ended.',
  HISTORY_RANGE_INVALID: 'Choose a shorter date range.',
  ACCOUNT_PENDING_DELETION: 'This account is being deleted.',
  TERMS_ACCEPTANCE_REQUIRED: 'Please accept the updated terms to continue.',
  // Does not name the threshold, and does not suggest trying again. Both would
  // turn the age screen into a puzzle with a published answer.
  AGE_REQUIREMENT_NOT_MET: 'Kinmap cannot create an account for you.',
  UPSTREAM_UNAVAILABLE: 'We could not reach the server. Please try again.',
  INTERNAL_ERROR: 'Something went wrong on our end. Please try again.',
};

export function errorCodeForStatus(status: number): ErrorCode {
  const mapped = STATUS_FALLBACK_CODE[status];
  if (mapped) return mapped;
  return status >= 500 ? 'UPSTREAM_UNAVAILABLE' : 'INTERNAL_ERROR';
}

/** Builds an AppError from a code alone, using the safe message table. */
export function appErrorFromCode(code: ErrorCode, retryAfterSeconds?: number): AppError {
  return new AppError(code, SAFE_ERROR_MESSAGES[code], undefined, retryAfterSeconds);
}

/**
 * Reads and maps a non-2xx response.
 *
 * Reading the body can itself fail (aborted stream, non-UTF8 payload); that
 * degrades to a status-derived error rather than masking the real failure.
 */
export async function mapErrorResponse(response: Response): Promise<AppError> {
  const fallbackCode = errorCodeForStatus(response.status);

  let raw: string;
  try {
    raw = await response.text();
  } catch {
    return appErrorFromCode(fallbackCode);
  }

  if (raw.length === 0) return appErrorFromCode(fallbackCode);

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    // Deliberately does NOT include `raw`: an unstructured body from an edge
    // proxy is untrusted text that could echo a query string back at us.
    return appErrorFromCode(fallbackCode);
  }

  const parsed = ApiErrorSchema.safeParse(payload);
  if (!parsed.success) return appErrorFromCode(fallbackCode);

  const { code, message, fields, retryAfterSeconds } = parsed.data.error;
  return new AppError(code, message, fields, retryAfterSeconds);
}

/** True when the failure is worth another attempt. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/**
 * Distinguishes "the caller cancelled" from "our deadline fired". Only the
 * latter is retryable, and only the former should propagate as an AbortError.
 */
export function isAbortError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const name = (error as { name?: unknown }).name;
  return name === 'AbortError' || name === 'TimeoutError';
}
