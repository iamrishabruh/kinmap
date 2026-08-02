import { type UploadErrorCode } from '../errors';

import { type UploadFailure } from './transport';

/**
 * Turns a transport failure into a queue decision.
 *
 * The point of this table is that "retry" is the *narrow* case. A queue that
 * retries everything eventually retries forever: it burns battery and radio on
 * a batch the server will never accept, and it keeps a coordinate on the device
 * long after it should have been discarded (spec §11).
 *
 * So the default for anything the server has definitively refused is DROP, and
 * RETRY is reserved for failures that are genuinely transient.
 */

export type UploadAction =
  /** Server already has these points; remove them without re-sending. */
  | 'ACCEPT'
  /** Transient: schedule with backoff. */
  | 'RETRY'
  /** Permanent: remove the events from the queue. */
  | 'DROP'
  /** Batch too large: halve it and try again immediately. */
  | 'SPLIT'
  /** Needs the user: stop uploading and surface it. Queue is preserved. */
  | 'STOP_USER_ACTION'
  /** Consent has ended: stop and destroy everything queued. */
  | 'STOP_AND_PURGE';

export type UploadDisposition = {
  action: UploadAction;
  errorCode: UploadErrorCode;
  retryAfterSeconds: number | null;
};

export function classifyUploadFailure(
  failure: UploadFailure,
  batchSize: number,
): UploadDisposition {
  if (failure.kind === 'NETWORK') {
    return { action: 'RETRY', errorCode: 'NETWORK_UNAVAILABLE', retryAfterSeconds: null };
  }
  if (failure.kind === 'TIMEOUT') {
    return { action: 'RETRY', errorCode: 'REQUEST_TIMEOUT', retryAfterSeconds: null };
  }

  const { status, code, retryAfterSeconds } = failure;

  // Error code takes precedence over status: the envelope is more specific and
  // is what the API contract actually guarantees (spec §21).
  switch (code) {
    case 'IDEMPOTENCY_KEY_REUSED':
      // The batch landed on a previous attempt whose response we never saw.
      return { action: 'ACCEPT', errorCode: 'ALREADY_ACCEPTED', retryAfterSeconds: null };
    case 'DEVICE_REVOKED':
    case 'DEVICE_NOT_REGISTERED':
      return { action: 'STOP_AND_PURGE', errorCode: 'DEVICE_REVOKED', retryAfterSeconds: null };
    case 'ACCOUNT_PENDING_DELETION':
      return {
        action: 'STOP_AND_PURGE',
        errorCode: 'ACCOUNT_PENDING_DELETION',
        retryAfterSeconds: null,
      };
    case 'UNAUTHENTICATED':
    case 'SESSION_EXPIRED':
      return { action: 'STOP_USER_ACTION', errorCode: 'AUTH_REQUIRED', retryAfterSeconds: null };
    case 'TERMS_ACCEPTANCE_REQUIRED':
      return {
        action: 'STOP_USER_ACTION',
        errorCode: 'TERMS_ACCEPTANCE_REQUIRED',
        retryAfterSeconds: null,
      };
    case 'SHARING_DISABLED_BY_TARGET':
      // The server believes this user is not sharing. Trust the server: keeping
      // the points would mean holding location the user has turned off.
      return { action: 'STOP_AND_PURGE', errorCode: 'REJECTED_FORBIDDEN', retryAfterSeconds: null };
    case 'VALIDATION_FAILED':
      return { action: 'DROP', errorCode: 'REJECTED_INVALID', retryAfterSeconds: null };
    case 'PAYLOAD_TOO_LARGE':
      return {
        action: batchSize > 1 ? 'SPLIT' : 'DROP',
        errorCode: 'PAYLOAD_TOO_LARGE',
        retryAfterSeconds: null,
      };
    case 'RATE_LIMITED':
      return { action: 'RETRY', errorCode: 'RATE_LIMITED', retryAfterSeconds };
    case 'UPSTREAM_UNAVAILABLE':
    case 'INTERNAL_ERROR':
      return { action: 'RETRY', errorCode: 'SERVER_UNAVAILABLE', retryAfterSeconds };
    default:
      break;
  }

  if (status === 401) {
    return { action: 'STOP_USER_ACTION', errorCode: 'AUTH_REQUIRED', retryAfterSeconds: null };
  }
  if (status === 403) {
    return { action: 'DROP', errorCode: 'REJECTED_FORBIDDEN', retryAfterSeconds: null };
  }
  if (status === 413) {
    return {
      action: batchSize > 1 ? 'SPLIT' : 'DROP',
      errorCode: 'PAYLOAD_TOO_LARGE',
      retryAfterSeconds: null,
    };
  }
  if (status === 429 || status === 408 || status === 425) {
    return {
      action: 'RETRY',
      errorCode: status === 429 ? 'RATE_LIMITED' : 'REQUEST_TIMEOUT',
      retryAfterSeconds,
    };
  }
  if (status >= 500) {
    return { action: 'RETRY', errorCode: 'SERVER_UNAVAILABLE', retryAfterSeconds };
  }
  if (status >= 400) {
    // Any other 4xx is the client's fault and will not fix itself.
    return { action: 'DROP', errorCode: 'REJECTED_INVALID', retryAfterSeconds: null };
  }

  return { action: 'RETRY', errorCode: 'UNKNOWN', retryAfterSeconds };
}
