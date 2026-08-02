import {
  LIMITS,
  LOCATION_PRODUCING_STATES,
  type DeviceId,
  type FamilyId,
  type Freshness,
  type TrackingState,
  type UserId,
} from '@family/contracts';
import { classifyFreshness, isAtLeastAsFresh } from '@family/location-core';

/**
 * Pure decision logic for the scheduled maintenance jobs (spec §14, §19, §22).
 *
 * Nothing here performs I/O or reads a clock: a planner is a function from "the
 * rows I just read" to "the writes I want", so the rules that actually matter —
 * when a live session stops being allowed to watch someone, when an invitation
 * stops being redeemable, when a push endpoint stops belonging to anybody — are
 * testable without a table.
 *
 * Two properties hold for every planner and are asserted in the tests:
 *
 *  IDEMPOTENCE — planning against the state that applying a plan produces
 *  yields an empty plan. Schedules overlap and retry, so "run it twice" is the
 *  normal case rather than the exceptional one.
 *
 *  FAIL-CLOSED — a row that cannot be dated is treated as expired rather than
 *  left running. An undateable live session is a person being watched with no
 *  deadline; that must end, not persist.
 */

// ---------------------------------------------------------------------------
// Job registry
// ---------------------------------------------------------------------------

export const JOB_NAMES = [
  'expire-live-sessions',
  'expire-invitations',
  'mark-stale-users',
  'emit-freshness-metrics',
  'emit-queue-depth-metrics',
  'sweep-expired-history',
  'reconcile-push-endpoints',
] as const;

export type JobName = (typeof JOB_NAMES)[number];

export function isJobName(value: unknown): value is JobName {
  return typeof value === 'string' && (JOB_NAMES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;

/**
 * Epoch milliseconds from either a DynamoDB TTL number or an ISO string.
 *
 * The tables in this product carry both spellings: TTL attributes must be
 * numeric epoch SECONDS, while the API schemas model the same instant as an ISO
 * string. Accepting either keeps a planner correct regardless of which
 * projection it is handed, and misreading seconds as milliseconds (or the
 * reverse) would be a 1000x error in a deadline.
 */
export function parseInstantMs(value: string | number | null | undefined): number | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    // Anything below this threshold cannot be a millisecond timestamp in any
    // era we care about, so it is epoch seconds.
    return value < 100_000_000_000 ? value * 1000 : value;
  }
  if (typeof value !== 'string' || value.length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

export function toDayKey(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}

/** DynamoDB TTL attributes are epoch SECONDS. */
export function toEpochSeconds(now: Date): number {
  return Math.floor(now.getTime() / 1000);
}

// ---------------------------------------------------------------------------
// 1. Expire stale live sessions
// ---------------------------------------------------------------------------

export type LiveSessionRow = {
  readonly sessionId: string;
  readonly targetUserId: UserId;
  readonly status: string;
  /** When the session began. Also the GSI sort key. */
  readonly startedAt: string | null;
  readonly expiresAt: string | number | null;
};

/** Statuses in which a session can still reveal the target's position. */
export const OPEN_LIVE_SESSION_STATUSES: readonly string[] = ['REQUESTED', 'ACTIVE'];

export function isLiveSessionOpen(row: Pick<LiveSessionRow, 'status'>): boolean {
  return OPEN_LIVE_SESSION_STATUSES.includes(row.status);
}

/**
 * The instant a session must stop, in epoch milliseconds.
 *
 * The platform ceiling wins over the stored deadline. A row claiming to run
 * longer than `LIMITS.MAX_LIVE_SESSION_SECONDS` is either a bug or tampering,
 * and either way it must not buy anyone extra minutes of watching another
 * person (spec §12). Returns null when the session cannot be dated at all.
 */
export function liveSessionDeadlineMs(
  row: Pick<LiveSessionRow, 'startedAt' | 'expiresAt'>,
): number | null {
  const startedMs = parseInstantMs(row.startedAt);
  const ceilingMs = startedMs === null ? null : startedMs + LIMITS.MAX_LIVE_SESSION_SECONDS * 1000;
  const storedMs = parseInstantMs(row.expiresAt);

  if (ceilingMs === null) return storedMs;
  if (storedMs === null) return ceilingMs;
  return Math.min(ceilingMs, storedMs);
}

export function isLiveSessionExpired(
  row: Pick<LiveSessionRow, 'status' | 'startedAt' | 'expiresAt'>,
  nowMs: number,
): boolean {
  if (!isLiveSessionOpen(row)) return false;
  const deadline = liveSessionDeadlineMs(row);
  // Undateable: nobody can say when this ends, so it ends now.
  if (deadline === null) return true;
  return deadline <= nowMs;
}

export function selectExpiredLiveSessions(
  rows: readonly LiveSessionRow[],
  nowMs: number,
): LiveSessionRow[] {
  return rows.filter((row) => isLiveSessionExpired(row, nowMs));
}

// ---------------------------------------------------------------------------
// 2. Expire invitations
// ---------------------------------------------------------------------------

export type InvitationRow = {
  /** The Invitations table is keyed by the token hash, never by a raw token. */
  readonly tokenHash: string;
  readonly familyId: FamilyId;
  readonly status: string;
  readonly createdAt: string | null;
  readonly expiresAt: string | number | null;
};

export const OPEN_INVITATION_STATUSES: readonly string[] = ['PENDING'];

export function isInvitationOpen(row: Pick<InvitationRow, 'status'>): boolean {
  return OPEN_INVITATION_STATUSES.includes(row.status);
}

/**
 * When an invitation stops being redeemable, in epoch milliseconds.
 *
 * `LIMITS.INVITATION_TTL_HOURS` caps whatever the row claims. An invitation is
 * a bearer credential to join a family and see where its members are, so its
 * lifetime is not negotiable by the row itself (spec §17).
 */
export function invitationDeadlineMs(
  row: Pick<InvitationRow, 'createdAt' | 'expiresAt'>,
): number | null {
  const createdMs = parseInstantMs(row.createdAt);
  const ceilingMs = createdMs === null ? null : createdMs + LIMITS.INVITATION_TTL_HOURS * 3_600_000;
  const storedMs = parseInstantMs(row.expiresAt);

  if (ceilingMs === null) return storedMs;
  if (storedMs === null) return ceilingMs;
  return Math.min(ceilingMs, storedMs);
}

export function isInvitationExpired(
  row: Pick<InvitationRow, 'status' | 'createdAt' | 'expiresAt'>,
  nowMs: number,
): boolean {
  if (!isInvitationOpen(row)) return false;
  const deadline = invitationDeadlineMs(row);
  if (deadline === null) return true;
  return deadline <= nowMs;
}

export function selectExpiredInvitations(
  rows: readonly InvitationRow[],
  nowMs: number,
): InvitationRow[] {
  return rows.filter((row) => isInvitationExpired(row, nowMs));
}

// ---------------------------------------------------------------------------
// 3. Mark STALE users / 4a. freshness metrics
// ---------------------------------------------------------------------------

/**
 * The projection of a CurrentLocations row this service reads.
 *
 * Deliberately only the key, the capture time and the tracking state. The row
 * also holds a sealed coordinate; nothing here projects it, so a coordinate
 * cannot reach a log line or a metric by accident.
 */
export type CurrentLocationRow = {
  readonly userId: UserId;
  readonly deviceId: DeviceId;
  readonly capturedAt: string | null;
  readonly trackingState: TrackingState;
};

/**
 * States from which STALE is a truthful escalation.
 *
 * DISABLED and PERMISSION_REQUIRED already tell the viewer the real reason
 * there is no fix; overwriting them with STALE would swap an actionable message
 * ("they turned sharing off") for a misleading one ("we lost them"). OFFLINE is
 * included because a device unreachable past the freshness horizon is no longer
 * merely offline.
 */
export const STALE_ELIGIBLE_STATES: readonly TrackingState[] = [
  ...LOCATION_PRODUCING_STATES,
  'OFFLINE',
];

export function isStaleEligible(state: TrackingState): boolean {
  return STALE_ELIGIBLE_STATES.includes(state);
}

/**
 * Whether a row should be flipped to STALE.
 *
 * Anything less trustworthy than RECENT qualifies, which folds in UNKNOWN: a
 * row we cannot date is exactly as unreliable as one we know is an hour old,
 * and treating it as fresh would leave a viewer looking at a confident dot.
 */
export function shouldMarkStale(row: CurrentLocationRow, nowMs: number): boolean {
  if (row.trackingState === 'STALE') return false;
  if (!isStaleEligible(row.trackingState)) return false;
  return !isAtLeastAsFresh(classifyFreshness(row.capturedAt, nowMs), 'RECENT');
}

export type FreshnessHistogram = Record<Freshness, number>;

export function emptyFreshnessHistogram(): FreshnessHistogram {
  return { LIVE: 0, FRESH: 0, RECENT: 0, STALE: 0, UNKNOWN: 0 };
}

export function mergeFreshnessHistograms(
  left: FreshnessHistogram,
  right: FreshnessHistogram,
): FreshnessHistogram {
  return {
    LIVE: left.LIVE + right.LIVE,
    FRESH: left.FRESH + right.FRESH,
    RECENT: left.RECENT + right.RECENT,
    STALE: left.STALE + right.STALE,
    UNKNOWN: left.UNKNOWN + right.UNKNOWN,
  };
}

export type StaleMarkingPlan = {
  readonly mark: readonly CurrentLocationRow[];
  readonly freshness: FreshnessHistogram;
  readonly scanned: number;
};

/**
 * Plans STALE transitions and tallies the freshness histogram in one pass.
 *
 * The histogram is the fleet-health signal behind "is tracking working?". It is
 * a count per band with no per-user dimension, so it reports how many devices
 * have gone quiet without revealing which ones or where they are (spec §20).
 */
export function planStaleMarking(input: {
  rows: readonly CurrentLocationRow[];
  nowMs: number;
}): StaleMarkingPlan {
  const freshness = emptyFreshnessHistogram();
  const mark: CurrentLocationRow[] = [];

  for (const row of input.rows) {
    freshness[classifyFreshness(row.capturedAt, input.nowMs)] += 1;
    if (shouldMarkStale(row, input.nowMs)) mark.push(row);
  }

  return { mark, freshness, scanned: input.rows.length };
}

// ---------------------------------------------------------------------------
// 4b. Queue depth metrics
// ---------------------------------------------------------------------------

/**
 * Queue backlog as reported by `GetQueueAttributes`.
 *
 * Deliberately not the age of the oldest message: SQS exposes that only as a
 * CloudWatch metric it publishes itself, not as a queue attribute, so
 * re-deriving it here would be both impossible and redundant.
 */
export type QueueDepth = {
  readonly queueUrl: string;
  readonly visible: number;
  readonly inFlight: number;
  readonly delayed: number;
};

/**
 * The trailing path segment of a queue URL, used as a metric dimension.
 *
 * Deriving it here keeps the AWS account id out of CloudWatch and pins
 * dimension cardinality to the number of queues.
 */
export function queueNameFromUrl(queueUrl: string): string {
  const withoutQuery = queueUrl.split('?')[0] ?? queueUrl;
  const segments = withoutQuery.split('/').filter((segment) => segment.length > 0);
  const last = segments.at(-1);
  return last === undefined || last.length === 0 ? 'unknown' : last;
}

// ---------------------------------------------------------------------------
// 5. Sweep history past logical retention
// ---------------------------------------------------------------------------

export type HistoryKey = { readonly pk: string; readonly sk: string };

export type HistoryRow = HistoryKey & {
  /** TTL attribute, epoch seconds. Null on rows written before TTL applied. */
  readonly expiresAt: number | null;
};

const HISTORY_PK_PATTERN = /^USER#[^#]+#DAY#(\d{4}-\d{2}-\d{2})$/u;

/** Extracts `yyyy-mm-dd` from `USER#<userId>#DAY#<yyyy-mm-dd>`. */
export function historyDayFromPartitionKey(pk: string): string | null {
  const match = HISTORY_PK_PATTERN.exec(pk);
  return match?.[1] ?? null;
}

/**
 * The oldest day still inside the retention window.
 *
 * A partition on the cutoff day itself is kept and only strictly older days are
 * swept, so a 30-day promise really does keep 30 days.
 */
export function retentionCutoffDay(input: { now: Date; retentionDays: number }): string {
  const days = Math.max(0, Math.trunc(input.retentionDays));
  return toDayKey(new Date(input.now.getTime() - days * MS_PER_DAY));
}

export type HistorySweepPlan = {
  readonly delete: readonly HistoryKey[];
  readonly scanned: number;
  /** Rows kept because their key could not be parsed. Never deleted blind. */
  readonly unparseable: number;
};

/**
 * Selects history rows that logical retention says should already be gone.
 *
 * DynamoDB TTL is best-effort — AWS documents deletion as "typically within 48
 * hours" and explicitly not a guarantee — and rows written before a retention
 * change may carry no TTL at all. Retention is a promise made to a user, so
 * this sweep enforces it directly instead of trusting the reaper.
 *
 * A row whose partition key does not parse is counted and left alone: deleting
 * data we cannot identify is a worse failure than keeping it one more day.
 */
export function planHistorySweep(input: {
  rows: readonly HistoryRow[];
  now: Date;
  retentionDays: number;
}): HistorySweepPlan {
  const cutoffDay = retentionCutoffDay({ now: input.now, retentionDays: input.retentionDays });
  const nowSeconds = toEpochSeconds(input.now);

  const toDelete: HistoryKey[] = [];
  let unparseable = 0;

  for (const row of input.rows) {
    const day = historyDayFromPartitionKey(row.pk);
    const ttlOverdue = row.expiresAt !== null && row.expiresAt <= nowSeconds;

    if (day === null) {
      if (ttlOverdue) toDelete.push({ pk: row.pk, sk: row.sk });
      else unparseable += 1;
      continue;
    }

    if (ttlOverdue || day < cutoffDay) toDelete.push({ pk: row.pk, sk: row.sk });
  }

  return { delete: toDelete, scanned: input.rows.length, unparseable };
}

// ---------------------------------------------------------------------------
// 6. Reconcile orphaned push endpoints
// ---------------------------------------------------------------------------

export type PushEndpointSummary = {
  readonly endpointArn: string;
  readonly enabled: boolean;
};

export type DeviceEndpointRef = {
  readonly userId: UserId;
  readonly deviceId: DeviceId;
  readonly pushEndpointArn: string | null;
  readonly status: string;
  readonly revokedAt: string | null;
};

/** A device keeps its endpoint only while it is genuinely usable. */
export function isDeviceLive(device: Pick<DeviceEndpointRef, 'status' | 'revokedAt'>): boolean {
  return device.revokedAt === null && device.status !== 'REVOKED';
}

export type EndpointReconciliationPlan = {
  /** SNS endpoints no live device claims. Deleted at the provider. */
  readonly deleteEndpoints: readonly string[];
  /** Device rows pointing at an endpoint that is gone or disabled. */
  readonly clearDevices: ReadonlyArray<{ userId: UserId; deviceId: DeviceId }>;
};

/**
 * Reconciles SNS platform endpoints against device rows, in both directions.
 *
 * The two stores drift for ordinary reasons: an app is uninstalled and the
 * provider disables the endpoint, a device row is revoked while the SNS call
 * fails, a deletion job is interrupted between the two writes. The drift is not
 * cosmetic — an endpoint that outlives its device is a live push channel to a
 * phone whose owner believes they revoked it — so orphans are deleted rather
 * than merely counted.
 *
 * An endpoint survives only if it is enabled AND a live device claims it.
 * Judging both directions from one snapshot means a disabled endpoint is
 * deleted and its device reference cleared in the same pass, so re-running
 * against the result proposes nothing.
 */
export function planEndpointReconciliation(input: {
  endpoints: readonly PushEndpointSummary[];
  devices: readonly DeviceEndpointRef[];
}): EndpointReconciliationPlan {
  const claimedArns = new Set<string>();
  for (const device of input.devices) {
    if (isDeviceLive(device) && device.pushEndpointArn !== null) {
      claimedArns.add(device.pushEndpointArn);
    }
  }

  const healthyArns = new Set<string>();
  const deleteEndpoints: string[] = [];
  for (const endpoint of input.endpoints) {
    if (endpoint.enabled && claimedArns.has(endpoint.endpointArn)) {
      healthyArns.add(endpoint.endpointArn);
    } else {
      deleteEndpoints.push(endpoint.endpointArn);
    }
  }

  const clearDevices: Array<{ userId: UserId; deviceId: DeviceId }> = [];
  for (const device of input.devices) {
    if (device.pushEndpointArn === null) continue;
    if (!isDeviceLive(device) || !healthyArns.has(device.pushEndpointArn)) {
      clearDevices.push({ userId: device.userId, deviceId: device.deviceId });
    }
  }

  return { deleteEndpoints, clearDevices };
}

// ---------------------------------------------------------------------------
// Batching and reporting
// ---------------------------------------------------------------------------

/**
 * Caps how much a single run may touch.
 *
 * A job that tried to drain a large backlog in one invocation would spike table
 * capacity and could throttle live traffic; a bounded run simply picks up the
 * rest on the next tick.
 */
export function limitBatch<T>(items: readonly T[], maxItems: number): T[] {
  return items.slice(0, Math.max(0, maxItems));
}

export type JobOutcome = {
  readonly job: JobName;
  readonly examined: number;
  readonly changed: number;
  readonly remaining: number;
  /** True when the scan hit its budget before reaching the end of the table. */
  readonly truncated: boolean;
  readonly durationMs: number;
  /** Sanitised: an error NAME only, never a message that could quote a row. */
  readonly error?: string;
};

export function summarise(outcomes: readonly JobOutcome[]): {
  readonly changed: number;
  readonly failed: number;
  readonly hasBacklog: boolean;
} {
  return {
    changed: outcomes.reduce((sum, outcome) => sum + outcome.changed, 0),
    failed: outcomes.filter((outcome) => outcome.error !== undefined).length,
    hasBacklog: outcomes.some((outcome) => outcome.remaining > 0 || outcome.truncated),
  };
}
