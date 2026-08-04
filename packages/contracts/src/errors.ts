import { z } from 'zod';

/**
 * One error envelope for every endpoint (spec §21). Error messages are
 * user-safe and must never embed coordinates, invitation tokens, or emails.
 */
export const ErrorCodeSchema = z.enum([
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
  'RATE_LIMITED',
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
  'AGE_REQUIREMENT_NOT_MET',
  'UPSTREAM_UNAVAILABLE',
  'INTERNAL_ERROR',
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ApiErrorSchema = z.object({
  error: z.object({
    code: ErrorCodeSchema,
    /** Safe to display. Never contains sensitive values. */
    message: z.string(),
    /** Field-level detail for VALIDATION_FAILED only. */
    fields: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
    /** Echoed so a user can quote it to support without leaking data. */
    requestId: z.string(),
    /** Present on RATE_LIMITED. */
    retryAfterSeconds: z.number().int().positive().optional(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

export const ERROR_STATUS: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401,
  SESSION_EXPIRED: 401,
  FORBIDDEN: 403,
  NOT_A_FAMILY_MEMBER: 403,
  SHARING_DISABLED_BY_TARGET: 403,
  DEVICE_NOT_REGISTERED: 403,
  DEVICE_REVOKED: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  VALIDATION_FAILED: 422,
  RATE_LIMITED: 429,
  PAYLOAD_TOO_LARGE: 413,
  ENTITLEMENT_REQUIRED: 402,
  PLAN_LIMIT_EXCEEDED: 402,
  INVITATION_INVALID: 400,
  INVITATION_EXPIRED: 410,
  INVITATION_ALREADY_USED: 410,
  INVITATION_REVOKED: 410,
  LIVE_SESSION_LIMIT: 409,
  LIVE_SESSION_EXPIRED: 410,
  HISTORY_RANGE_INVALID: 422,
  ACCOUNT_PENDING_DELETION: 423,
  TERMS_ACCEPTANCE_REQUIRED: 428,
  // 403 rather than 428: a precondition the caller could satisfy by retrying
  // would invite retrying with a different date, and the refusal is final.
  AGE_REQUIREMENT_NOT_MET: 403,
  UPSTREAM_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
};

export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly fields?: Array<{ path: string; message: string }>,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'AppError';
  }

  get status(): number {
    // ERROR_STATUS is total over ErrorCode, but noUncheckedIndexedAccess widens
    // the lookup; fall back to 500 rather than leaking `undefined` into a header.
    return ERROR_STATUS[this.code] ?? 500;
  }
}

/**
 * Authorization failures are deliberately indistinguishable to the caller:
 * a stalker must not be able to probe whether a user exists, is in a family,
 * or has merely paused sharing (spec §34).
 */
export function opaqueAuthorizationError(requestId: string): AppError {
  void requestId;
  return new AppError('FORBIDDEN', 'You do not have access to this resource.');
}
