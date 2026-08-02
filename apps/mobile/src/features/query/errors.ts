import { AppError, ErrorCodeSchema, type ErrorCode } from '@family/contracts';

/**
 * Error helpers.
 *
 * Every message surfaced here is user-safe by construction: the API envelope
 * (`@family/contracts`) guarantees messages never embed coordinates, tokens or
 * emails, and the fallbacks below are static strings. Nothing in this module
 * ever echoes a request body back to the screen.
 */

export function errorCodeOf(error: unknown): ErrorCode | null {
  if (error instanceof AppError) return error.code;
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const parsed = ErrorCodeSchema.safeParse((error as { code: unknown }).code);
    if (parsed.success) return parsed.data;
  }
  return null;
}

const MESSAGES: Partial<Record<ErrorCode, string>> = {
  UNAUTHENTICATED: 'You have been signed out. Sign in again to continue.',
  SESSION_EXPIRED: 'Your session expired. Sign in again to continue.',
  FORBIDDEN: 'You do not have access to this.',
  NOT_A_FAMILY_MEMBER: 'You do not have access to this.',
  SHARING_DISABLED_BY_TARGET: 'This person is not sharing their location right now.',
  DEVICE_NOT_REGISTERED: 'This device is not registered. Sign in again to re-register it.',
  DEVICE_REVOKED: 'This device was signed out remotely.',
  NOT_FOUND: 'That is no longer available.',
  CONFLICT: 'Someone else changed this first. Pull to refresh and try again.',
  VALIDATION_FAILED: 'Some details need fixing before this can be saved.',
  RATE_LIMITED: 'Too many requests. Wait a moment and try again.',
  ENTITLEMENT_REQUIRED: 'This feature is part of a paid plan.',
  PLAN_LIMIT_EXCEEDED: 'Your plan does not allow any more of these.',
  INVITATION_INVALID: 'This invitation link is not valid.',
  INVITATION_EXPIRED: 'This invitation has expired. Ask for a new one.',
  INVITATION_ALREADY_USED: 'This invitation has already been used.',
  INVITATION_REVOKED: 'This invitation was cancelled.',
  LIVE_SESSION_LIMIT: 'There is already a live session for this person.',
  LIVE_SESSION_EXPIRED: 'That live session has ended.',
  HISTORY_RANGE_INVALID: 'That date is outside the range your plan keeps.',
  ACCOUNT_PENDING_DELETION: 'This account is being deleted.',
  TERMS_ACCEPTANCE_REQUIRED: 'Accept the updated terms to continue.',
  UPSTREAM_UNAVAILABLE: 'The service is temporarily unavailable. Try again shortly.',
  INTERNAL_ERROR: 'Something went wrong on our side. Try again shortly.',
};

export function userMessageFor(error: unknown): string {
  const code = errorCodeOf(error);
  if (code !== null) {
    const message = MESSAGES[code];
    if (message !== undefined) return message;
  }
  if (error instanceof AppError) return error.message;
  return 'Something went wrong. Check your connection and try again.';
}

/** 4xx conditions a retry cannot fix. */
const NON_RETRYABLE: readonly ErrorCode[] = [
  'UNAUTHENTICATED',
  'SESSION_EXPIRED',
  'FORBIDDEN',
  'NOT_A_FAMILY_MEMBER',
  'SHARING_DISABLED_BY_TARGET',
  'DEVICE_NOT_REGISTERED',
  'DEVICE_REVOKED',
  'NOT_FOUND',
  'CONFLICT',
  'IDEMPOTENCY_KEY_REUSED',
  'VALIDATION_FAILED',
  'PAYLOAD_TOO_LARGE',
  'ENTITLEMENT_REQUIRED',
  'PLAN_LIMIT_EXCEEDED',
  'INVITATION_INVALID',
  'INVITATION_EXPIRED',
  'INVITATION_ALREADY_USED',
  'INVITATION_REVOKED',
  'LIVE_SESSION_LIMIT',
  'LIVE_SESSION_EXPIRED',
  'HISTORY_RANGE_INVALID',
  'ACCOUNT_PENDING_DELETION',
  'TERMS_ACCEPTANCE_REQUIRED',
];

export function isRetryable(error: unknown): boolean {
  const code = errorCodeOf(error);
  if (code === null) return true; // network/transport failure
  return !NON_RETRYABLE.includes(code);
}

export function isEntitlementError(error: unknown): boolean {
  const code = errorCodeOf(error);
  return code === 'ENTITLEMENT_REQUIRED' || code === 'PLAN_LIMIT_EXCEEDED';
}
