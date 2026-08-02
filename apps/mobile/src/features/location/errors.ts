/**
 * Feature-local failure vocabulary.
 *
 * Every value here is a fixed enum member rather than free text. Messages that
 * originate from the network, the OS, or SQLite are never propagated verbatim:
 * they can embed a request URL, a serialised event body, or a coordinate, and
 * this feature's errors end up in persisted engine state and on screen
 * (spec §11, §20).
 */

export const LOCATION_FEATURE_ERROR_CODES = [
  'STORAGE_UNAVAILABLE',
  'STORAGE_CORRUPT',
  'ENCRYPTION_KEY_UNAVAILABLE',
  'DECRYPTION_FAILED',
  'NATIVE_ENGINE_UNAVAILABLE',
  'NATIVE_ENGINE_CALL_FAILED',
  'CONFIG_REJECTED',
  'CONSENT_REQUIRED',
  'PERMISSION_REQUIRED',
  'NOT_INITIALIZED',
] as const;

export type LocationFeatureErrorCode = (typeof LOCATION_FEATURE_ERROR_CODES)[number];

export class LocationFeatureError extends Error {
  constructor(
    readonly code: LocationFeatureErrorCode,
    /** Optional short, non-sensitive discriminator such as a method name. */
    readonly detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'LocationFeatureError';
  }
}

/**
 * Upload outcomes that are safe to persist in `engine_state.last_upload_error`
 * and to render in the device-health UI.
 */
export const UPLOAD_ERROR_CODES = [
  'NETWORK_UNAVAILABLE',
  'REQUEST_TIMEOUT',
  'RATE_LIMITED',
  'SERVER_UNAVAILABLE',
  'AUTH_REQUIRED',
  'DEVICE_REVOKED',
  'ACCOUNT_PENDING_DELETION',
  'TERMS_ACCEPTANCE_REQUIRED',
  'PAYLOAD_TOO_LARGE',
  'REJECTED_INVALID',
  'REJECTED_FORBIDDEN',
  'REJECTED_BY_SERVER',
  'ALREADY_ACCEPTED',
  'ATTEMPTS_EXHAUSTED',
  'EXPIRED_IN_QUEUE',
  'QUEUE_OVERFLOW',
  'UNKNOWN',
] as const;

export type UploadErrorCode = (typeof UPLOAD_ERROR_CODES)[number];

const UPLOAD_ERROR_CODE_SET = new Set<string>(UPLOAD_ERROR_CODES);

export function isUploadErrorCode(value: string | null | undefined): value is UploadErrorCode {
  return typeof value === 'string' && UPLOAD_ERROR_CODE_SET.has(value);
}

/**
 * Collapses an unknown thrown value to a fixed code.
 *
 * `error.message` is deliberately never read — see the file header. A thrown
 * value we do not recognise is reported as UNKNOWN rather than being described.
 */
export function toUploadErrorCode(error: unknown): UploadErrorCode {
  if (error instanceof LocationFeatureError && error.code === 'NATIVE_ENGINE_UNAVAILABLE') {
    return 'UNKNOWN';
  }
  if (error instanceof TypeError) {
    // `fetch` surfaces connectivity failures as a TypeError on both platforms.
    return 'NETWORK_UNAVAILABLE';
  }
  return 'UNKNOWN';
}
