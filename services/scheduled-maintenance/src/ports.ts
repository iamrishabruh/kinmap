import type { DeviceId, Freshness, UserId } from '@family/contracts';

import type {
  CurrentLocationRow,
  DeviceEndpointRef,
  HistoryKey,
  HistoryRow,
  InvitationRow,
  JobName,
  LiveSessionRow,
  PushEndpointSummary,
  QueueDepth,
} from './jobs.js';

/**
 * Every side effect a maintenance job performs, behind an interface.
 *
 * The runner depends only on these, so the whole schedule can be exercised in a
 * unit test with no table, no queue and no credentials — the same discipline
 * the deletion worker applies to its pipeline.
 */

/** An opaque DynamoDB `LastEvaluatedKey`. */
export type ScanCursor = Record<string, unknown>;

export type Page<T> = {
  readonly items: readonly T[];
  /** Null once the scan has reached the end of the table. */
  readonly cursor: ScanCursor | null;
};

export type ScanInput = { readonly limit: number; readonly cursor: ScanCursor | null };

export interface LiveSessionStore {
  /** Only sessions that are still open; a closed one has nothing to expire. */
  scanOpen(input: ScanInput): Promise<Page<LiveSessionRow>>;
  /**
   * Returns false when the row was no longer open — a user who stopped the
   * session first wins, and their choice is not overwritten.
   */
  expire(input: { sessionId: string; now: Date }): Promise<boolean>;
}

export interface InvitationStore {
  scanOpen(input: ScanInput): Promise<Page<InvitationRow>>;
  /** False when the invitation was accepted or revoked in the meantime. */
  expire(input: { tokenHash: string; now: Date }): Promise<boolean>;
}

export interface CurrentLocationStore {
  scan(input: ScanInput): Promise<Page<CurrentLocationRow>>;
  /**
   * Conditional on the capture time we judged, so a fresh upload landing
   * mid-run is never overwritten with a stale verdict. False when it lost.
   */
  markStale(input: {
    userId: UserId;
    deviceId: DeviceId;
    capturedAt: string | null;
    now: Date;
  }): Promise<boolean>;
}

export interface HistoryStore {
  scan(input: ScanInput): Promise<Page<HistoryRow>>;
  /** Returns the number of rows actually removed. */
  deleteRows(keys: readonly HistoryKey[]): Promise<number>;
}

export interface DeviceStore {
  scan(input: ScanInput): Promise<Page<DeviceEndpointRef>>;
  clearPushEndpoint(input: { userId: UserId; deviceId: DeviceId }): Promise<boolean>;
}

export interface PushEndpointRegistry {
  listEndpoints(input: { platformApplicationArn: string }): Promise<PushEndpointSummary[]>;
  deleteEndpoint(input: { endpointArn: string }): Promise<void>;
}

export interface QueueDepthReader {
  /** Null when the queue cannot be read; one bad queue must not fail the job. */
  read(queueUrl: string): Promise<QueueDepth | null>;
}

/**
 * Metric emission.
 *
 * Every signal here is a count or an age keyed by an enum or a queue name.
 * There is deliberately no method that accepts a user id or a position, so this
 * service cannot emit a per-person telemetry dimension (spec §20).
 */
export interface MaintenanceMetrics {
  freshness(band: Freshness, count: number): void;
  queueDepth(depth: QueueDepth): void;
  jobCompleted(job: JobName, outcome: { changed: number; durationMs: number }): void;
  jobFailed(job: JobName): void;
  backlog(job: JobName, remaining: number): void;
}

/**
 * Paces destructive writes so a large sweep cannot consume a table's whole
 * write capacity and take live traffic down with it.
 */
export interface RateLimiter {
  acquire(units: number): Promise<void>;
}
