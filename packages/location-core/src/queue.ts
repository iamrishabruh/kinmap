import {
  AppError,
  LIMITS,
  type FlushResult,
  type LocationEvent,
  type RetryPolicy,
} from '@family/contracts';

import {
  clampInto,
  clampUnitInterval,
  finiteOr,
  parseIsoMs,
  type NumericRange,
} from './internal.js';

/**
 * Outbound location-event queue policy (spec §11).
 *
 * This module owns *policy* only: ordering, batching, retention, backoff and
 * failure sanitisation. Persistence is injected through `QueueStorage` so the
 * React Native app can back it with an encrypted database (SQLCipher / MMKV +
 * Keychain) and a test can back it with a Map — the policy is identical either
 * way, which is exactly the property we want to be able to test exhaustively.
 *
 * Privacy rules that this module enforces and must never regress:
 *  - No logging of any kind. Queue records embed exact coordinates.
 *  - Upload failures are reduced to a fixed enum before they are ever stored or
 *    returned. Raw error text may contain a request URL, and a request URL may
 *    contain a coordinate, so raw error text never leaves `sanitizeFailureReason`.
 */

// ---------------------------------------------------------------------------
// Records and storage
// ---------------------------------------------------------------------------

export type QueuedEvent = {
  /** Contains exact coordinates. Never log, never serialise into an error. */
  readonly event: LocationEvent;
  readonly queuedAtMs: number;
  readonly attemptCount: number;
  readonly lastAttemptAtMs: number | null;
  readonly lastFailureReason: UploadFailureReason | null;
};

export type QueueMeta = {
  /** Monotonic per-device sequence source. */
  readonly nextSequenceNumber: number;
  /** Earliest time a flush may be attempted; the backoff gate. */
  readonly nextAttemptAtMs: number | null;
  readonly consecutiveFailures: number;
  readonly lastAttemptAtMs: number | null;
  readonly lastFailureReason: UploadFailureReason | null;
  /** Set after PAYLOAD_TOO_LARGE so the next batch is smaller. */
  readonly batchSizeHint: number | null;
};

export const DEFAULT_QUEUE_META: QueueMeta = {
  nextSequenceNumber: 0,
  nextAttemptAtMs: null,
  consecutiveFailures: 0,
  lastAttemptAtMs: null,
  lastFailureReason: null,
  batchSizeHint: null,
};

/**
 * The narrow persistence seam. Implementations are free to encrypt at rest,
 * batch writes, or run on a background thread; the policy above assumes only
 * that these six operations are atomic with respect to each other.
 */
export interface QueueStorage {
  /** Up to `limit` records, in any order. */
  list(limit: number): Promise<readonly QueuedEvent[]>;
  /** Insert or replace by `event.eventId`. */
  put(records: readonly QueuedEvent[]): Promise<void>;
  remove(eventIds: readonly string[]): Promise<void>;
  count(): Promise<number>;
  readMeta(): Promise<QueueMeta | null>;
  writeMeta(meta: QueueMeta): Promise<void>;
}

// ---------------------------------------------------------------------------
// Failure sanitisation
// ---------------------------------------------------------------------------

export const UPLOAD_FAILURE_REASONS = [
  'NETWORK_UNAVAILABLE',
  'TIMEOUT',
  'RATE_LIMITED',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'PAYLOAD_TOO_LARGE',
  'VALIDATION_FAILED',
  'ALREADY_ACCEPTED',
  'SERVER_ERROR',
  'UNKNOWN',
] as const;

export type UploadFailureReason = (typeof UPLOAD_FAILURE_REASONS)[number];

const ERROR_CODE_REASONS: Readonly<Record<string, UploadFailureReason>> = {
  // Contract error codes (packages/contracts/src/errors.ts).
  RATE_LIMITED: 'RATE_LIMITED',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  SESSION_EXPIRED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_A_FAMILY_MEMBER: 'FORBIDDEN',
  SHARING_DISABLED_BY_TARGET: 'FORBIDDEN',
  DEVICE_NOT_REGISTERED: 'FORBIDDEN',
  DEVICE_REVOKED: 'FORBIDDEN',
  ACCOUNT_PENDING_DELETION: 'FORBIDDEN',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  IDEMPOTENCY_KEY_REUSED: 'ALREADY_ACCEPTED',
  CONFLICT: 'ALREADY_ACCEPTED',
  UPSTREAM_UNAVAILABLE: 'SERVER_ERROR',
  INTERNAL_ERROR: 'SERVER_ERROR',
  // Platform / libc socket errors surfaced by fetch on both platforms.
  ECONNREFUSED: 'NETWORK_UNAVAILABLE',
  ECONNRESET: 'NETWORK_UNAVAILABLE',
  ENOTFOUND: 'NETWORK_UNAVAILABLE',
  ENETUNREACH: 'NETWORK_UNAVAILABLE',
  ENETDOWN: 'NETWORK_UNAVAILABLE',
  EHOSTUNREACH: 'NETWORK_UNAVAILABLE',
  EAI_AGAIN: 'NETWORK_UNAVAILABLE',
  ETIMEDOUT: 'TIMEOUT',
  ESOCKETTIMEDOUT: 'TIMEOUT',
};

function reasonFromHttpStatus(status: number): UploadFailureReason {
  if (status === 401) return 'UNAUTHENTICATED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 408) return 'TIMEOUT';
  if (status === 409) return 'ALREADY_ACCEPTED';
  if (status === 413) return 'PAYLOAD_TOO_LARGE';
  if (status === 422) return 'VALIDATION_FAILED';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'SERVER_ERROR';
  if (status >= 400) return 'VALIDATION_FAILED';
  return 'UNKNOWN';
}

/**
 * Reduce an arbitrary thrown value to one of a fixed set of reasons.
 *
 * This function deliberately never reads `.message`, `.stack`, `.url`, or any
 * response body. Those can and do carry request URLs, and a location upload's
 * URL or body carries coordinates (spec §11, §20). Only structural, enumerable
 * signals — an error code, an HTTP status, an error class name — are consulted,
 * and the result is always a member of `UPLOAD_FAILURE_REASONS`.
 */
export function sanitizeFailureReason(input: unknown): UploadFailureReason {
  if (input instanceof AppError) {
    return ERROR_CODE_REASONS[input.code] ?? 'UNKNOWN';
  }
  if (typeof input === 'string') {
    return ERROR_CODE_REASONS[input] ?? 'UNKNOWN';
  }
  if (typeof input === 'object' && input !== null) {
    const candidate = input as {
      readonly code?: unknown;
      readonly status?: unknown;
      readonly statusCode?: unknown;
      readonly name?: unknown;
    };
    if (typeof candidate.code === 'string') {
      const mapped = ERROR_CODE_REASONS[candidate.code];
      if (mapped !== undefined) return mapped;
    }
    const status =
      typeof candidate.status === 'number'
        ? candidate.status
        : typeof candidate.statusCode === 'number'
          ? candidate.statusCode
          : null;
    if (status !== null && Number.isFinite(status)) return reasonFromHttpStatus(status);
    if (candidate.name === 'AbortError' || candidate.name === 'TimeoutError') return 'TIMEOUT';
    // `fetch` reports every transport failure as a bare TypeError.
    if (candidate.name === 'TypeError') return 'NETWORK_UNAVAILABLE';
  }
  return 'UNKNOWN';
}

export type RetryDisposition = 'RETRY' | 'SHRINK_BATCH' | 'DROP_BATCH';

/**
 * What to do with the batch that just failed.
 *
 * DROP_BATCH covers the poison-pill cases: retrying forever would pin the head
 * of the queue and starve every later event.
 */
export function retryDisposition(reason: UploadFailureReason): RetryDisposition {
  switch (reason) {
    case 'PAYLOAD_TOO_LARGE':
      return 'SHRINK_BATCH';
    case 'VALIDATION_FAILED':
    case 'FORBIDDEN':
    case 'ALREADY_ACCEPTED':
      return 'DROP_BATCH';
    case 'NETWORK_UNAVAILABLE':
    case 'TIMEOUT':
    case 'RATE_LIMITED':
    case 'UNAUTHENTICATED':
    case 'SERVER_ERROR':
    case 'UNKNOWN':
      return 'RETRY';
    default:
      return 'RETRY';
  }
}

// ---------------------------------------------------------------------------
// Backoff
// ---------------------------------------------------------------------------

export const RETRY_GUARDRAILS: Readonly<Record<keyof RetryPolicy, NumericRange>> = {
  baseDelayMs: { min: 250, max: 60_000 },
  maxDelayMs: { min: 1_000, max: 3_600_000 },
  multiplier: { min: 1.1, max: 10 },
  jitterRatio: { min: 0, max: 1 },
  maxAttempts: { min: 1, max: LIMITS.MAX_UPLOAD_ATTEMPTS },
};

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  baseDelayMs: 1_000,
  maxDelayMs: 15 * 60_000,
  multiplier: 2,
  jitterRatio: 0.25,
  maxAttempts: LIMITS.MAX_UPLOAD_ATTEMPTS,
};

/** Clamp an untrusted retry policy into guardrails and internal consistency. */
export function clampRetryPolicy(policy: Partial<RetryPolicy> | null | undefined): RetryPolicy {
  const source = policy ?? DEFAULT_RETRY_POLICY;
  const baseDelayMs = clampInto(
    finiteOr(source.baseDelayMs, DEFAULT_RETRY_POLICY.baseDelayMs),
    RETRY_GUARDRAILS.baseDelayMs,
  );
  const maxDelayMs = Math.max(
    baseDelayMs,
    clampInto(
      finiteOr(source.maxDelayMs, DEFAULT_RETRY_POLICY.maxDelayMs),
      RETRY_GUARDRAILS.maxDelayMs,
    ),
  );
  return {
    baseDelayMs,
    maxDelayMs,
    multiplier: clampInto(
      finiteOr(source.multiplier, DEFAULT_RETRY_POLICY.multiplier),
      RETRY_GUARDRAILS.multiplier,
    ),
    jitterRatio: clampInto(
      finiteOr(source.jitterRatio, DEFAULT_RETRY_POLICY.jitterRatio),
      RETRY_GUARDRAILS.jitterRatio,
    ),
    maxAttempts: Math.min(
      LIMITS.MAX_UPLOAD_ATTEMPTS,
      Math.round(
        clampInto(
          finiteOr(source.maxAttempts, DEFAULT_RETRY_POLICY.maxAttempts),
          RETRY_GUARDRAILS.maxAttempts,
        ),
      ),
    ),
  };
}

/**
 * Exponential backoff with symmetric proportional jitter, bounded by
 * `maxDelayMs`.
 *
 * The jitter is not cosmetic: every device in a family wakes on the same push
 * and a synchronised retry storm after an outage is how a small backend gets
 * knocked over twice. Jitter is applied after the ceiling is enforced, and the
 * final value is re-clamped, so the bound holds for every possible random draw
 * including a hostile or broken RNG.
 */
export function backoffDelayMs(
  attempt: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  random: () => number = Math.random,
): number {
  const safe = clampRetryPolicy(policy);
  const n = Math.max(1, Math.floor(finiteOr(attempt, 1)));
  const growth = Math.pow(safe.multiplier, n - 1);
  const raw = Math.min(safe.baseDelayMs * growth, safe.maxDelayMs);
  const draw = clampUnitInterval(random());
  const jitter = raw * safe.jitterRatio * (draw * 2 - 1);
  return Math.round(Math.min(safe.maxDelayMs, Math.max(0, raw + jitter)));
}

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const U64_MASK = 0xffffffffffffffffn;

/** FNV-1a 64. Chosen because it needs no crypto polyfill under Hermes. */
function fnv1a64Hex(input: string): string {
  let hash = FNV_OFFSET_BASIS;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= BigInt(input.charCodeAt(index));
    hash = (hash * FNV_PRIME) & U64_MASK;
  }
  return hash.toString(16).padStart(16, '0');
}

/**
 * A stable key for a batch, so that a retry of the *same* batch is deduplicated
 * server-side rather than double-counted.
 *
 * Derived only from identifiers and sequence numbers — never from coordinates,
 * because the key travels in a request header and headers get logged.
 */
export function deriveIdempotencyKey(deviceId: string, events: readonly LocationEvent[]): string {
  const first = events[0];
  const last = events[events.length - 1];
  const firstSeq = first?.sequenceNumber ?? -1;
  const lastSeq = last?.sequenceNumber ?? -1;
  let material = `${deviceId}|${events.length}`;
  for (const event of events) {
    material += `|${event.eventId}:${event.sequenceNumber}`;
  }
  return `${deviceId}:${firstSeq}-${lastSeq}:${events.length}:${fnv1a64Hex(material)}`;
}

// ---------------------------------------------------------------------------
// Ordering, batching, retention
// ---------------------------------------------------------------------------

function compareQueued(a: QueuedEvent, b: QueuedEvent): number {
  if (a.event.deviceId !== b.event.deviceId) {
    return a.event.deviceId < b.event.deviceId ? -1 : 1;
  }
  if (a.event.sequenceNumber !== b.event.sequenceNumber) {
    return a.event.sequenceNumber - b.event.sequenceNumber;
  }
  if (a.event.capturedAt !== b.event.capturedAt) {
    return a.event.capturedAt < b.event.capturedAt ? -1 : 1;
  }
  if (a.event.eventId === b.event.eventId) return 0;
  return a.event.eventId < b.event.eventId ? -1 : 1;
}

/**
 * Total order: grouped by device, ascending `sequenceNumber` within a device,
 * with deterministic tiebreakers so two devices never disagree about ordering.
 */
export function orderQueue(records: readonly QueuedEvent[]): QueuedEvent[] {
  return [...records].sort(compareQueued);
}

export type BatchSelection = {
  readonly deviceId: string;
  readonly records: readonly QueuedEvent[];
  readonly events: readonly LocationEvent[];
  readonly idempotencyKey: string;
};

/**
 * Take the next batch. A batch never mixes devices: the ingestion contract is
 * per-device-sequenced, so interleaving would make gap detection impossible on
 * the server. The device with the oldest queued record goes first, which keeps
 * a chatty device from starving a quiet one.
 */
export function selectBatch(
  records: readonly QueuedEvent[],
  maxBatchSize: number = LIMITS.MAX_EVENTS_PER_BATCH,
): BatchSelection | null {
  if (records.length === 0) return null;
  const size = Math.max(
    1,
    Math.min(
      Math.floor(finiteOr(maxBatchSize, LIMITS.MAX_EVENTS_PER_BATCH)),
      LIMITS.MAX_EVENTS_PER_BATCH,
    ),
  );
  const ordered = orderQueue(records);

  let head: QueuedEvent | undefined;
  for (const record of ordered) {
    if (head === undefined || record.queuedAtMs < head.queuedAtMs) head = record;
  }
  if (head === undefined) return null;

  const deviceId = head.event.deviceId;
  const batch = ordered.filter((record) => record.event.deviceId === deviceId).slice(0, size);
  const events = batch.map((record) => record.event);
  return {
    deviceId,
    records: batch,
    events,
    idempotencyKey: deriveIdempotencyKey(deviceId, events),
  };
}

export type DropReason = 'AGE_EXCEEDED' | 'CAPACITY_EXCEEDED' | 'MAX_ATTEMPTS_EXCEEDED';

export type DroppedRecord = { readonly eventId: string; readonly reason: DropReason };

export type PruneResult = {
  readonly keep: readonly QueuedEvent[];
  readonly dropped: readonly DroppedRecord[];
};

export type RetentionOptions = {
  readonly maxEvents?: number;
  readonly maxAgeHours?: number;
  readonly maxAttempts?: number;
};

/**
 * Apply the retention caps.
 *
 * Order matters: attempts, then age, then capacity. Age is measured from
 * `capturedAt` (falling back to enqueue time) because the ingestion endpoint
 * rejects anything older than `MAX_QUEUE_AGE_HOURS` anyway — holding it would
 * only burn the retry budget.
 *
 * When over capacity the *oldest* records are dropped. For a location product a
 * current position is worth more than a stale one, so an overflowing queue must
 * degrade into a recent tail rather than an ancient head.
 */
export function pruneForRetention(
  records: readonly QueuedEvent[],
  nowMs: number,
  options: RetentionOptions = {},
): PruneResult {
  // Options may tighten the platform caps but never widen them.
  const maxEvents = Math.min(
    LIMITS.MAX_QUEUED_EVENTS,
    Math.max(0, Math.floor(finiteOr(options.maxEvents, LIMITS.MAX_QUEUED_EVENTS))),
  );
  const maxAgeHours = Math.min(
    LIMITS.MAX_QUEUE_AGE_HOURS,
    Math.max(0, finiteOr(options.maxAgeHours, LIMITS.MAX_QUEUE_AGE_HOURS)),
  );
  const maxAttempts = Math.min(
    LIMITS.MAX_UPLOAD_ATTEMPTS,
    Math.max(1, Math.floor(finiteOr(options.maxAttempts, LIMITS.MAX_UPLOAD_ATTEMPTS))),
  );
  const maxAgeMs = maxAgeHours * 3_600_000;

  const dropped: DroppedRecord[] = [];
  const survivors: QueuedEvent[] = [];

  for (const record of records) {
    if (record.attemptCount >= maxAttempts) {
      dropped.push({ eventId: record.event.eventId, reason: 'MAX_ATTEMPTS_EXCEEDED' });
      continue;
    }
    if (nowMs - recordAgeOrigin(record) > maxAgeMs) {
      dropped.push({ eventId: record.event.eventId, reason: 'AGE_EXCEEDED' });
      continue;
    }
    survivors.push(record);
  }

  if (survivors.length > maxEvents) {
    const byAge = [...survivors].sort((a, b) => recordAgeOrigin(a) - recordAgeOrigin(b));
    const overflow = survivors.length - maxEvents;
    const evicted = new Set<string>();
    for (let index = 0; index < overflow; index += 1) {
      const victim = byAge[index];
      if (victim === undefined) break;
      evicted.add(victim.event.eventId);
      dropped.push({ eventId: victim.event.eventId, reason: 'CAPACITY_EXCEEDED' });
    }
    return {
      keep: survivors.filter((record) => !evicted.has(record.event.eventId)),
      dropped,
    };
  }

  return { keep: survivors, dropped };
}

function recordAgeOrigin(record: QueuedEvent): number {
  return parseIsoMs(record.event.capturedAt) ?? record.queuedAtMs;
}

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

export type UploadContext = {
  readonly deviceId: string;
  readonly idempotencyKey: string;
};

export type UploadOutcome =
  | {
      readonly ok: true;
      /**
       * Event ids the server confirmed. Omit to confirm the whole batch.
       * Ids outside the submitted batch are ignored, so a buggy or hostile
       * response cannot delete unrelated queued events.
       */
      readonly acceptedEventIds?: readonly string[];
    }
  | {
      readonly ok: false;
      readonly error: unknown;
      readonly retryAfterSeconds?: number;
    };

export type UploadFn = (
  events: readonly LocationEvent[],
  context: UploadContext,
) => Promise<UploadOutcome>;

export type EnqueueRejection = 'INVALID_SEQUENCE' | 'INVALID_TIMESTAMP' | 'DEVICE_MISMATCH';

export type EnqueueResult = {
  readonly queued: boolean;
  readonly rejectedReason: EnqueueRejection | null;
  readonly droppedEventIds: readonly string[];
  readonly pendingCount: number;
};

export type OutboundQueueOptions = {
  /** When set, events from any other device are refused. */
  readonly deviceId?: string;
  readonly maxEvents?: number;
  readonly maxAgeHours?: number;
  readonly maxAttempts?: number;
  readonly maxBatchSize?: number;
  readonly minUploadIntervalSeconds?: number;
  readonly retry?: RetryPolicy;
  /** Injectable for deterministic tests. */
  readonly random?: () => number;
};

export class OutboundQueue {
  readonly #storage: QueueStorage;
  readonly #deviceId: string | null;
  readonly #maxEvents: number;
  readonly #maxAgeHours: number;
  readonly #maxAttempts: number;
  readonly #maxBatchSize: number;
  readonly #minUploadIntervalMs: number;
  readonly #retry: RetryPolicy;
  readonly #random: () => number;

  constructor(storage: QueueStorage, options: OutboundQueueOptions = {}) {
    this.#storage = storage;
    this.#deviceId = options.deviceId ?? null;
    this.#maxEvents = Math.min(
      LIMITS.MAX_QUEUED_EVENTS,
      Math.max(1, Math.floor(finiteOr(options.maxEvents, LIMITS.MAX_QUEUED_EVENTS))),
    );
    this.#maxAgeHours = Math.min(
      LIMITS.MAX_QUEUE_AGE_HOURS,
      Math.max(0, finiteOr(options.maxAgeHours, LIMITS.MAX_QUEUE_AGE_HOURS)),
    );
    this.#maxAttempts = Math.min(
      LIMITS.MAX_UPLOAD_ATTEMPTS,
      Math.max(1, Math.floor(finiteOr(options.maxAttempts, LIMITS.MAX_UPLOAD_ATTEMPTS))),
    );
    this.#maxBatchSize = Math.min(
      LIMITS.MAX_EVENTS_PER_BATCH,
      Math.max(1, Math.floor(finiteOr(options.maxBatchSize, LIMITS.MAX_EVENTS_PER_BATCH))),
    );
    this.#minUploadIntervalMs =
      Math.max(
        LIMITS.MIN_UPLOAD_INTERVAL_SECONDS,
        finiteOr(options.minUploadIntervalSeconds, LIMITS.MIN_UPLOAD_INTERVAL_SECONDS),
      ) * 1000;
    this.#retry = clampRetryPolicy(options.retry);
    this.#random = options.random ?? Math.random;
  }

  get retryPolicy(): RetryPolicy {
    return this.#retry;
  }

  /** Reserve the next per-device sequence number, persisting the advance. */
  async reserveSequenceNumber(): Promise<number> {
    const meta = await this.#meta();
    const next = Math.max(0, Math.floor(finiteOr(meta.nextSequenceNumber, 0)));
    await this.#storage.writeMeta({ ...meta, nextSequenceNumber: next + 1 });
    return next;
  }

  async enqueue(event: LocationEvent, nowMs: number): Promise<EnqueueResult> {
    if (this.#deviceId !== null && event.deviceId !== this.#deviceId) {
      return await this.#rejected('DEVICE_MISMATCH');
    }
    if (!Number.isInteger(event.sequenceNumber) || event.sequenceNumber < 0) {
      return await this.#rejected('INVALID_SEQUENCE');
    }
    if (parseIsoMs(event.capturedAt) === null) {
      return await this.#rejected('INVALID_TIMESTAMP');
    }

    await this.#storage.put([
      {
        event,
        queuedAtMs: nowMs,
        attemptCount: 0,
        lastAttemptAtMs: null,
        lastFailureReason: null,
      },
    ]);

    const meta = await this.#meta();
    const advanced = Math.max(meta.nextSequenceNumber, event.sequenceNumber + 1);
    if (advanced !== meta.nextSequenceNumber) {
      await this.#storage.writeMeta({ ...meta, nextSequenceNumber: advanced });
    }

    let droppedEventIds: readonly string[] = [];
    if ((await this.#storage.count()) > this.#maxEvents) {
      droppedEventIds = (await this.#prune(nowMs)).droppedEventIds;
    }

    return {
      queued: true,
      rejectedReason: null,
      droppedEventIds,
      pendingCount: await this.#storage.count(),
    };
  }

  /** Pending count and the age origin of the oldest record, for device health. */
  async pending(): Promise<{ count: number; oldestQueuedAtMs: number | null }> {
    const records = await this.#storage.list(this.#maxEvents + 1);
    let oldest: number | null = null;
    for (const record of records) {
      if (oldest === null || record.queuedAtMs < oldest) oldest = record.queuedAtMs;
    }
    return { count: await this.#storage.count(), oldestQueuedAtMs: oldest };
  }

  /** Earliest time a flush will do anything, or null when unthrottled. */
  async nextAttemptAtMs(): Promise<number | null> {
    return (await this.#meta()).nextAttemptAtMs;
  }

  /**
   * Attempt one batch upload.
   *
   * Returns the shared `FlushResult` contract; `lastError` is always either null
   * or a member of `UPLOAD_FAILURE_REASONS`, never raw error text.
   */
  async flush(upload: UploadFn, nowMs: number): Promise<FlushResult> {
    const attemptedAt = new Date(nowMs).toISOString();
    const meta = await this.#meta();

    if (meta.nextAttemptAtMs !== null && nowMs < meta.nextAttemptAtMs) {
      return {
        uploadedCount: 0,
        remainingCount: await this.#storage.count(),
        lastError: meta.lastFailureReason,
        attemptedAt,
      };
    }

    const { keep } = await this.#prune(nowMs);
    const batchSize =
      meta.batchSizeHint === null
        ? this.#maxBatchSize
        : Math.max(1, Math.min(this.#maxBatchSize, Math.floor(meta.batchSizeHint)));
    const selection = selectBatch(keep, batchSize);

    if (selection === null) {
      await this.#storage.writeMeta({
        ...meta,
        nextAttemptAtMs: null,
        consecutiveFailures: 0,
        lastFailureReason: null,
        batchSizeHint: null,
      });
      return {
        uploadedCount: 0,
        remainingCount: await this.#storage.count(),
        lastError: null,
        attemptedAt,
      };
    }

    let outcome: UploadOutcome;
    try {
      outcome = await upload(selection.events, {
        deviceId: selection.deviceId,
        idempotencyKey: selection.idempotencyKey,
      });
    } catch (thrown) {
      // The thrown value is never inspected beyond `sanitizeFailureReason`.
      outcome = { ok: false, error: thrown };
    }

    return outcome.ok
      ? await this.#onSuccess(meta, selection, outcome, nowMs, attemptedAt)
      : await this.#onFailure(meta, selection, outcome, nowMs, attemptedAt);
  }

  // -- internals ------------------------------------------------------------

  async #meta(): Promise<QueueMeta> {
    return (await this.#storage.readMeta()) ?? DEFAULT_QUEUE_META;
  }

  async #rejected(reason: EnqueueRejection): Promise<EnqueueResult> {
    return {
      queued: false,
      rejectedReason: reason,
      droppedEventIds: [],
      pendingCount: await this.#storage.count(),
    };
  }

  async #prune(
    nowMs: number,
  ): Promise<{ keep: readonly QueuedEvent[]; droppedEventIds: readonly string[] }> {
    const records = await this.#storage.list(this.#maxEvents + 1);
    const result = pruneForRetention(records, nowMs, {
      maxEvents: this.#maxEvents,
      maxAgeHours: this.#maxAgeHours,
      maxAttempts: this.#maxAttempts,
    });
    const droppedEventIds = result.dropped.map((entry) => entry.eventId);
    if (droppedEventIds.length > 0) await this.#storage.remove(droppedEventIds);
    return { keep: result.keep, droppedEventIds };
  }

  /**
   * Bump the attempt counter on records that were sent but not confirmed, and
   * give up on any that have exhausted `MAX_UPLOAD_ATTEMPTS`.
   */
  async #retain(
    records: readonly QueuedEvent[],
    nowMs: number,
    reason: UploadFailureReason | null,
  ): Promise<void> {
    const bumped = records.map((record) => ({
      ...record,
      attemptCount: record.attemptCount + 1,
      lastAttemptAtMs: nowMs,
      lastFailureReason: reason,
    }));
    const exhausted = bumped.filter((record) => record.attemptCount >= this.#maxAttempts);
    const retained = bumped.filter((record) => record.attemptCount < this.#maxAttempts);
    if (exhausted.length > 0) {
      await this.#storage.remove(exhausted.map((record) => record.event.eventId));
    }
    if (retained.length > 0) await this.#storage.put(retained);
  }

  async #onSuccess(
    meta: QueueMeta,
    selection: BatchSelection,
    outcome: Extract<UploadOutcome, { ok: true }>,
    nowMs: number,
    attemptedAt: string,
  ): Promise<FlushResult> {
    const batchIds = new Set(selection.records.map((record) => record.event.eventId));
    const confirmed =
      outcome.acceptedEventIds === undefined
        ? [...batchIds]
        : outcome.acceptedEventIds.filter((id) => batchIds.has(id));
    const confirmedIds = new Set(confirmed);

    if (confirmed.length > 0) await this.#storage.remove(confirmed);

    const unconfirmed = selection.records.filter(
      (record) => !confirmedIds.has(record.event.eventId),
    );
    if (unconfirmed.length > 0) await this.#retain(unconfirmed, nowMs, null);

    await this.#storage.writeMeta({
      ...meta,
      consecutiveFailures: 0,
      lastAttemptAtMs: nowMs,
      lastFailureReason: null,
      batchSizeHint: null,
      nextAttemptAtMs: nowMs + this.#minUploadIntervalMs,
    });

    return {
      uploadedCount: confirmed.length,
      remainingCount: await this.#storage.count(),
      lastError: null,
      attemptedAt,
    };
  }

  async #onFailure(
    meta: QueueMeta,
    selection: BatchSelection,
    outcome: Extract<UploadOutcome, { ok: false }>,
    nowMs: number,
    attemptedAt: string,
  ): Promise<FlushResult> {
    const reason = sanitizeFailureReason(outcome.error);
    const disposition = retryDisposition(reason);

    // Both dispositions below assign every one of these, so they are declared
    // without an initialiser rather than seeded with a value that is always
    // overwritten.
    let consecutiveFailures: number;
    let batchSizeHint = meta.batchSizeHint;
    let nextAttemptAtMs: number;

    if (disposition === 'DROP_BATCH') {
      await this.#storage.remove(selection.records.map((record) => record.event.eventId));
      consecutiveFailures = 0;
      batchSizeHint = null;
      nextAttemptAtMs = nowMs + this.#minUploadIntervalMs;
    } else {
      if (disposition === 'SHRINK_BATCH') {
        batchSizeHint = Math.max(1, Math.floor(selection.records.length / 2));
      }
      consecutiveFailures = meta.consecutiveFailures + 1;
      await this.#retain(selection.records, nowMs, reason);
      const serverHintMs =
        outcome.retryAfterSeconds !== undefined && Number.isFinite(outcome.retryAfterSeconds)
          ? Math.max(0, outcome.retryAfterSeconds) * 1000
          : 0;
      const backoff = backoffDelayMs(consecutiveFailures, this.#retry, this.#random);
      nextAttemptAtMs = nowMs + Math.max(backoff, serverHintMs, this.#minUploadIntervalMs);
    }

    await this.#storage.writeMeta({
      ...meta,
      consecutiveFailures,
      batchSizeHint,
      lastAttemptAtMs: nowMs,
      lastFailureReason: reason,
      nextAttemptAtMs,
    });

    return {
      uploadedCount: 0,
      remainingCount: await this.#storage.count(),
      lastError: reason,
      attemptedAt,
    };
  }
}

// ---------------------------------------------------------------------------
// Reference storage
// ---------------------------------------------------------------------------

/**
 * Volatile reference implementation. Suitable for tests and as the fallback
 * when the encrypted store cannot be opened — losing queued points is strictly
 * better than writing coordinates to unencrypted storage.
 */
export class InMemoryQueueStorage implements QueueStorage {
  readonly #records = new Map<string, QueuedEvent>();
  #meta: QueueMeta | null = null;

  async list(limit: number): Promise<readonly QueuedEvent[]> {
    const bounded = Math.max(0, Math.floor(finiteOr(limit, 0)));
    return orderQueue([...this.#records.values()]).slice(0, bounded);
  }

  async put(records: readonly QueuedEvent[]): Promise<void> {
    for (const record of records) this.#records.set(record.event.eventId, record);
  }

  async remove(eventIds: readonly string[]): Promise<void> {
    for (const id of eventIds) this.#records.delete(id);
  }

  async count(): Promise<number> {
    return this.#records.size;
  }

  async readMeta(): Promise<QueueMeta | null> {
    return this.#meta;
  }

  async writeMeta(meta: QueueMeta): Promise<void> {
    this.#meta = meta;
  }
}
