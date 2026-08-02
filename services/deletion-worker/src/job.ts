import { createHmac } from 'node:crypto';

import type { UserId } from '@family/contracts';

/**
 * The deletion job state machine (spec §22).
 *
 * Account deletion is a promise with a deadline, executed across many
 * invocations against a dozen tables and an identity provider. Three properties
 * have to hold, and all three are decided here rather than in the AWS plumbing:
 *
 *  ORDER — sharing is revoked FIRST. Everything after it takes time, and for
 *  every second of that time the account must already be invisible to the
 *  family. Identity deletion is near-LAST, because once Cognito no longer has
 *  the user we can no longer prove whose rows we are deleting.
 *
 *  RESUMABILITY — the job carries the step it is on and a cursor within that
 *  step. A Lambda timeout, a throttle or a deploy mid-run resumes exactly where
 *  it stopped; it never restarts, and it never skips.
 *
 *  IDEMPOTENCE — every step is a delete, which is naturally repeatable, and a
 *  step already in `completedSteps` is skipped outright. Re-running a finished
 *  job is a no-op rather than an error.
 */

export const DELETION_STEPS = [
  /** Invisible to the family before anything else happens. */
  'REVOKE_SHARING',
  /** Transfers OWNER or dissolves a family of one; never orphans a family. */
  'REMOVE_MEMBERSHIPS',
  'REVOKE_DEVICES',
  'DELETE_CURRENT_LOCATIONS',
  /** Day partition by day partition, with a cursor. */
  'DELETE_LOCATION_HISTORY',
  'DELETE_SAVED_PLACES',
  'DELETE_NOTIFICATION_PREFERENCES',
  'DELETE_LIVE_SESSIONS',
  'DELETE_GEOFENCE_STATE',
  /** Cognito AdminDeleteUser: after this the subject can no longer sign in. */
  'DELETE_IDENTITY',
  'WRITE_TOMBSTONE',
  'CONFIRM',
  'COMPLETED',
] as const;

export type DeletionStep = (typeof DELETION_STEPS)[number];

export const TERMINAL_STEP: DeletionStep = 'COMPLETED';

export type DeletionJobStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';

export type DeletionJob = {
  readonly jobId: string;
  readonly userId: UserId;
  readonly status: DeletionJobStatus;
  readonly step: DeletionStep;
  /** Progress within the current step; interpreted only by that step. */
  readonly cursor: string | null;
  readonly requestedAt: string;
  readonly scheduledFor: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly attempts: number;
  readonly completedSteps: readonly DeletionStep[];
  readonly updatedAt: string;
  /** Fixed reason code; never a message that could carry personal data. */
  readonly lastErrorCode: string | null;
};

export function stepIndex(step: DeletionStep): number {
  const index = DELETION_STEPS.indexOf(step);
  return index === -1 ? 0 : index;
}

export function nextStep(step: DeletionStep): DeletionStep {
  const index = stepIndex(step);
  return DELETION_STEPS[index + 1] ?? TERMINAL_STEP;
}

export function isComplete(job: Pick<DeletionJob, 'step'>): boolean {
  return job.step === TERMINAL_STEP;
}

/** A step already recorded as done is never redone, even after a resume. */
export function isStepDone(job: DeletionJob, step: DeletionStep): boolean {
  return job.completedSteps.includes(step) || stepIndex(job.step) > stepIndex(step);
}

/** Records progress inside the current step without leaving it. */
export function withCursor(job: DeletionJob, cursor: string | null, now: Date): DeletionJob {
  return { ...job, cursor, status: 'RUNNING', updatedAt: now.toISOString() };
}

/** Completes the current step and moves to the next, resetting the cursor. */
export function completeStep(job: DeletionJob, now: Date): DeletionJob {
  const advanced = nextStep(job.step);
  const completedSteps = job.completedSteps.includes(job.step)
    ? job.completedSteps
    : [...job.completedSteps, job.step];

  return {
    ...job,
    step: advanced,
    cursor: null,
    completedSteps,
    status: advanced === TERMINAL_STEP ? 'COMPLETED' : 'RUNNING',
    completedAt: advanced === TERMINAL_STEP ? now.toISOString() : job.completedAt,
    updatedAt: now.toISOString(),
  };
}

export function markFailed(job: DeletionJob, errorCode: string, now: Date): DeletionJob {
  return {
    ...job,
    status: 'FAILED',
    lastErrorCode: errorCode,
    attempts: job.attempts + 1,
    updatedAt: now.toISOString(),
  };
}

/**
 * Age of an outstanding deletion request, in hours.
 *
 * Emitted as `DeletionJobOldestAgeHours`. A pending deletion is a broken
 * promise to a user, not a backlog item, which is why it is alarmed on rather
 * than merely graphed.
 */
export function deletionJobAgeHours(job: Pick<DeletionJob, 'requestedAt'>, now: Date): number {
  const requested = Date.parse(job.requestedAt);
  if (Number.isNaN(requested)) return 0;
  return Math.max(0, (now.getTime() - requested) / 3_600_000);
}

// ---------------------------------------------------------------------------
// History day partitions
// ---------------------------------------------------------------------------

/** `USER#<userId>#DAY#<yyyy-mm-dd>` — the LocationHistory partition key. */
export function historyPartitionKey(userId: UserId, day: string): string {
  return `USER#${userId}#DAY#${day}`;
}

export function toDayKey(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}

/**
 * Every day partition that could still hold a row, newest first.
 *
 * Newest first because that is the data a user most wants gone, and because a
 * job that is interrupted has then already removed the most recent traces.
 */
export function historyDayPartitions(input: {
  requestedAt: string;
  lookbackDays: number;
  now: Date;
}): string[] {
  const end = Date.parse(input.requestedAt);
  const anchor = Number.isNaN(end) ? input.now.getTime() : Math.max(end, input.now.getTime());
  const days: string[] = [];
  const total = Math.max(1, Math.trunc(input.lookbackDays));

  for (let offset = 0; offset < total; offset += 1) {
    days.push(toDayKey(new Date(anchor - offset * 86_400_000)));
  }
  return days;
}

/**
 * The slice of day partitions to process next, given the cursor left by the
 * previous invocation. The cursor is the last day that was fully deleted.
 */
export function nextHistoryDays(input: {
  days: readonly string[];
  cursor: string | null;
  limit: number;
}): { days: string[]; nextCursor: string | null; done: boolean } {
  const startIndex = input.cursor === null ? 0 : input.days.indexOf(input.cursor) + 1;
  const safeStart = startIndex <= 0 && input.cursor !== null ? input.days.length : startIndex;
  const slice = input.days.slice(safeStart, safeStart + Math.max(1, input.limit));
  const consumedTo = safeStart + slice.length;

  return {
    days: slice,
    nextCursor: slice.at(-1) ?? input.cursor,
    done: consumedTo >= input.days.length,
  };
}

// ---------------------------------------------------------------------------
// Tombstone
// ---------------------------------------------------------------------------

export type Tombstone = {
  /** HMAC of the user id under a server-held pepper. Not reversible. */
  readonly tombstoneId: string;
  readonly deletedAt: string;
  readonly reason: string;
  readonly schemaVersion: number;
};

export const TOMBSTONE_SCHEMA_VERSION = 1;

/**
 * The minimal, non-identifying record that a deletion happened.
 *
 * A plain hash of the user id would still be re-identifiable by anyone who can
 * guess or enumerate user ids, so the identifier is an HMAC under a pepper that
 * lives only in the service's configuration. What remains is enough to prove
 * the deletion ran and nothing else: no id, no email, no family, no device.
 */
export function buildTombstone(input: {
  userId: UserId;
  pepper: string;
  reason: string;
  now: Date;
}): Tombstone {
  return {
    tombstoneId: createHmac('sha256', input.pepper).update(input.userId).digest('hex'),
    deletedAt: input.now.toISOString(),
    reason: input.reason,
    schemaVersion: TOMBSTONE_SCHEMA_VERSION,
  };
}
