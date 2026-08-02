import { AppError, ERROR_STATUS, type ApiError, type ErrorCode } from '@family/contracts';
import type { Logger } from '@family/observability';

import type { HttpResponse } from '../types.js';

/**
 * The single exit for every failure.
 *
 * Three rules:
 *
 *  1. One envelope. Every error, from a malformed body to a dependency outage,
 *     leaves as `ApiError` from `@family/contracts`, so a client has exactly one
 *     shape to parse.
 *  2. Unknown errors never speak. Anything that is not an `AppError` becomes an
 *     `INTERNAL_ERROR` with a fixed sentence; the original message could carry a
 *     table name, a key, or a fragment of somebody's data.
 *  3. The request id is always echoed, so a user can quote it to support
 *     without either of them having to describe what they were looking at.
 */

export const RESPONSE_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'application/json; charset=utf-8',
  // Every response in this API is user-specific. Nothing may be cached by an
  // intermediary, and a location product cannot afford a shared cache to be
  // wrong about whose answer it is holding.
  'cache-control': 'no-store',
};

export function toApiError(error: unknown, requestId: string): ApiError {
  if (error instanceof AppError) {
    return {
      error: {
        code: error.code,
        message: error.message,
        ...(error.fields === undefined ? {} : { fields: error.fields }),
        requestId,
        ...(error.retryAfterSeconds === undefined
          ? {}
          : { retryAfterSeconds: error.retryAfterSeconds }),
      },
    };
  }
  return {
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Something went wrong. Please try again.',
      requestId,
    },
  };
}

export function statusFor(code: ErrorCode): number {
  return ERROR_STATUS[code] ?? 500;
}

/**
 * Serialises the envelope and records the failure.
 *
 * Client errors are logged at `warn` with their code only; server errors are
 * logged at `error` with the thrown value, which the observability layer
 * redacts on the way out.
 */
export function toErrorResponse(error: unknown, requestId: string, logger: Logger): HttpResponse {
  const payload = toApiError(error, requestId);
  const status = statusFor(payload.error.code);

  if (status >= 500) {
    logger.error('request_failed', { code: payload.error.code, status, err: error });
  } else {
    logger.warn('request_rejected', { code: payload.error.code, status });
  }

  const headers: Record<string, string> = { ...RESPONSE_HEADERS, 'x-request-id': requestId };
  if (payload.error.retryAfterSeconds !== undefined) {
    headers['retry-after'] = String(payload.error.retryAfterSeconds);
  }

  return { statusCode: status, headers, body: JSON.stringify(payload) };
}

/** Builds a success response with the same standard headers. */
export function toSuccessResponse(input: {
  statusCode: number;
  body: unknown;
  requestId: string;
  headers?: Readonly<Record<string, string>>;
}): HttpResponse {
  return {
    statusCode: input.statusCode,
    headers: { ...RESPONSE_HEADERS, 'x-request-id': input.requestId, ...(input.headers ?? {}) },
    body: input.body === undefined ? '' : JSON.stringify(input.body),
  };
}
