import { AppError, type ErrorCode } from '@family/contracts';

/**
 * Internal reason codes for coordinate crypto failures.
 *
 * These describe *key material and record integrity*, never the protected
 * value. No constructor in this module accepts a coordinate, a plaintext
 * payload, or a data key, which is what makes it structurally impossible for a
 * coordinate to reach a log line, a Sentry frame, or an API response (spec §20).
 */
export type CryptoFailureReason =
  | 'INVALID_COORDINATES'
  | 'INVALID_KEY_CONTEXT'
  | 'MALFORMED_RECORD'
  | 'UNSUPPORTED_ALGORITHM'
  | 'UNSUPPORTED_SCHEMA_VERSION'
  | 'ENCRYPTION_CONTEXT_MISMATCH'
  | 'INTEGRITY_CHECK_FAILED'
  | 'DATA_KEY_UNAVAILABLE';

/**
 * Fixed, value-free messages. Nothing here is interpolated, so no caller can
 * accidentally widen an error into a data-leak channel.
 */
export const CRYPTO_FAILURE_MESSAGES: Record<CryptoFailureReason, string> = {
  INVALID_COORDINATES: 'The location payload could not be processed.',
  INVALID_KEY_CONTEXT: 'The encryption key context is not valid.',
  MALFORMED_RECORD: 'The stored location record is not readable.',
  UNSUPPORTED_ALGORITHM: 'The stored location record uses an unsupported algorithm.',
  UNSUPPORTED_SCHEMA_VERSION: 'The stored location record uses an unsupported version.',
  ENCRYPTION_CONTEXT_MISMATCH: 'The stored location record is not readable.',
  INTEGRITY_CHECK_FAILED: 'The stored location record is not readable.',
  DATA_KEY_UNAVAILABLE: 'Encryption is temporarily unavailable. Please try again.',
};

const CRYPTO_FAILURE_CODES: Record<CryptoFailureReason, ErrorCode> = {
  INVALID_COORDINATES: 'VALIDATION_FAILED',
  INVALID_KEY_CONTEXT: 'VALIDATION_FAILED',
  MALFORMED_RECORD: 'INTERNAL_ERROR',
  UNSUPPORTED_ALGORITHM: 'INTERNAL_ERROR',
  UNSUPPORTED_SCHEMA_VERSION: 'INTERNAL_ERROR',
  ENCRYPTION_CONTEXT_MISMATCH: 'INTERNAL_ERROR',
  INTEGRITY_CHECK_FAILED: 'INTERNAL_ERROR',
  DATA_KEY_UNAVAILABLE: 'UPSTREAM_UNAVAILABLE',
};

/**
 * The only error type thrown by this package.
 *
 * Deliberately carries no `cause` chain: an upstream SDK error may be logged by
 * the caller, and re-parenting it here would make the blast radius of a future
 * verbose SDK message unbounded.
 */
export class CoordinateCryptoError extends AppError {
  constructor(readonly reason: CryptoFailureReason) {
    super(CRYPTO_FAILURE_CODES[reason], CRYPTO_FAILURE_MESSAGES[reason]);
    this.name = 'CoordinateCryptoError';
  }
}

export function isCoordinateCryptoError(value: unknown): value is CoordinateCryptoError {
  return value instanceof CoordinateCryptoError;
}
