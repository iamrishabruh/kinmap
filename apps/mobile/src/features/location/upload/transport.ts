import { type ErrorCode, type LocationEvent } from '@family/contracts';

/**
 * The upload port.
 *
 * The coordinator depends on this interface rather than on a concrete HTTP
 * client so that queue behaviour — batching, backoff, dropping — can be tested
 * against every failure mode without a network, and so that the auth/refresh
 * concern stays in the API client where it belongs.
 */

export type LocationBatchUploadRequest = {
  deviceId: string;
  /** Stable across retries; see upload/idempotency.ts. */
  idempotencyKey: string;
  events: readonly LocationEvent[];
};

/**
 * Why the server refused an individual point. Every reason here is a property
 * of the point itself, so all of them are permanent: retrying cannot change a
 * timestamp that is already too old or an accuracy that was never good enough.
 */
export const EVENT_REJECTION_REASONS = [
  'ACCURACY_TOO_LOW',
  'DUPLICATE',
  'TOO_OLD',
  'FUTURE_TIMESTAMP',
  'IMPLAUSIBLE_SPEED',
  'SCHEMA_INVALID',
  'UNKNOWN',
] as const;

export type EventRejectionReason = (typeof EVENT_REJECTION_REASONS)[number];

export type LocationBatchUploadResponse = {
  acceptedEventIds: string[];
  rejected: Array<{ eventId: string; reason: EventRejectionReason }>;
  /** Server clock, used to detect device clock skew. */
  serverTime: string;
};

export type UploadFailure =
  | { kind: 'NETWORK' }
  | { kind: 'TIMEOUT' }
  | {
      kind: 'HTTP';
      status: number;
      /** Parsed from the error envelope when present. */
      code: ErrorCode | null;
      retryAfterSeconds: number | null;
    };

/** Discriminated result: the transport reports failures, it never throws for them. */
export type UploadResult =
  { ok: true; response: LocationBatchUploadResponse } | { ok: false; failure: UploadFailure };

export interface LocationUploadTransport {
  uploadBatch(request: LocationBatchUploadRequest): Promise<UploadResult>;
}
