import { AppError, LIMITS } from '@family/contracts';

import type { HttpRequest } from '../types.js';

/**
 * Request-body handling.
 *
 * The ceiling is `LIMITS.MAX_BATCH_PAYLOAD_BYTES`, the same platform-wide bound
 * the ingestion endpoint enforces and the same one the WAF size rule is relaxed
 * for. It is measured in *decoded* bytes, because a base64 transport encoding
 * inflates the string by a third and would otherwise let a caller sneak a
 * third more payload past the check.
 */

export const MAX_BODY_BYTES = LIMITS.MAX_BATCH_PAYLOAD_BYTES;

export class PayloadTooLargeError extends AppError {
  constructor() {
    super('PAYLOAD_TOO_LARGE', 'The request body is larger than this endpoint accepts.');
  }
}

/** UTF-8 byte length of a string, not its UTF-16 code-unit length. */
export function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/**
 * Enforces the size ceiling and parses JSON.
 *
 * Returns null for an absent or empty body; the route's schema decides whether
 * that is acceptable. A malformed document is a `VALIDATION_FAILED`, never a
 * 500, and the parser error text is discarded rather than echoed — it can quote
 * the offending input.
 */
export function parseBody(request: HttpRequest, maxBytes: number = MAX_BODY_BYTES): unknown {
  const raw = request.rawBody;
  if (raw === null || raw === '') {
    return null;
  }
  if (byteLength(raw) > maxBytes) {
    throw new PayloadTooLargeError();
  }

  const contentType = request.headers['content-type'] ?? 'application/json';
  if (!contentType.toLowerCase().includes('json')) {
    throw new AppError('VALIDATION_FAILED', 'The request body must be JSON.', [
      { path: 'content-type', message: 'This value is not one of the allowed values.' },
    ]);
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new AppError('VALIDATION_FAILED', 'The request body is not valid JSON.', [
      { path: '(root)', message: 'This value is not in the expected format.' },
    ]);
  }
}
