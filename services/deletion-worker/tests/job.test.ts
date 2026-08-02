import { describe, expect, it } from 'vitest';

import type { UserId } from '@family/contracts';

import {
  buildTombstone,
  completeStep,
  DELETION_STEPS,
  deletionJobAgeHours,
  historyDayPartitions,
  historyPartitionKey,
  isComplete,
  isStepDone,
  markFailed,
  nextHistoryDays,
  nextStep,
  withCursor,
  type DeletionJob,
  type DeletionStep,
} from '../src/job.js';

const USER_ID = '11111111-1111-4111-8111-111111111111' as UserId;
const NOW = new Date('2026-06-10T12:00:00.000Z');

function job(overrides: Partial<DeletionJob> = {}): DeletionJob {
  return {
    jobId: 'job-1',
    userId: USER_ID,
    status: 'PENDING',
    step: 'REVOKE_SHARING',
    cursor: null,
    requestedAt: '2026-06-09T12:00:00.000Z',
    scheduledFor: '2026-06-09T12:00:00.000Z',
    startedAt: null,
    completedAt: null,
    attempts: 0,
    completedSteps: [],
    updatedAt: '2026-06-09T12:00:00.000Z',
    lastErrorCode: null,
    ...overrides,
  };
}

describe('step ordering', () => {
  it('revokes sharing first, so the account is invisible while the rest runs', () => {
    expect(DELETION_STEPS[0]).toBe('REVOKE_SHARING');
  });

  it('deletes the identity only after every row that is keyed by it', () => {
    const identity = DELETION_STEPS.indexOf('DELETE_IDENTITY');
    for (const step of [
      'DELETE_CURRENT_LOCATIONS',
      'DELETE_LOCATION_HISTORY',
      'DELETE_SAVED_PLACES',
      'DELETE_NOTIFICATION_PREFERENCES',
      'DELETE_LIVE_SESSIONS',
      'DELETE_GEOFENCE_STATE',
    ] as const) {
      expect(DELETION_STEPS.indexOf(step)).toBeLessThan(identity);
    }
  });

  it('ends with the tombstone and the confirmation', () => {
    expect(DELETION_STEPS.slice(-3)).toEqual(['WRITE_TOMBSTONE', 'CONFIRM', 'COMPLETED']);
  });

  it('walks the sequence exactly once and then stays put', () => {
    let step: DeletionStep = DELETION_STEPS[0];
    const visited: string[] = [step];
    for (let index = 0; index < DELETION_STEPS.length + 3; index += 1) {
      step = nextStep(step);
      visited.push(step);
    }
    expect(visited.at(-1)).toBe('COMPLETED');
    expect(new Set(visited).size).toBe(DELETION_STEPS.length);
  });
});

describe('checkpointing', () => {
  it('records progress inside a step without leaving it', () => {
    const checkpointed = withCursor(job({ step: 'DELETE_LOCATION_HISTORY' }), '2026-06-01', NOW);

    expect(checkpointed.step).toBe('DELETE_LOCATION_HISTORY');
    expect(checkpointed.cursor).toBe('2026-06-01');
    expect(checkpointed.status).toBe('RUNNING');
  });

  it('advances, resets the cursor and remembers the step is done', () => {
    const advanced = completeStep(job({ step: 'REVOKE_SHARING', cursor: 'x' }), NOW);

    expect(advanced.step).toBe('REMOVE_MEMBERSHIPS');
    expect(advanced.cursor).toBeNull();
    expect(advanced.completedSteps).toEqual(['REVOKE_SHARING']);
  });

  it('never records the same step twice on a resume', () => {
    const once = completeStep(job({ step: 'REVOKE_SHARING' }), NOW);
    const again = completeStep({ ...once, step: 'REVOKE_SHARING' }, NOW);

    expect(again.completedSteps).toEqual(['REVOKE_SHARING']);
  });

  it('marks completion at the terminal step', () => {
    const finished = completeStep(job({ step: 'CONFIRM' }), NOW);

    expect(isComplete(finished)).toBe(true);
    expect(finished.status).toBe('COMPLETED');
    expect(finished.completedAt).toBe(NOW.toISOString());
  });

  it('treats any earlier step as already done', () => {
    const midway = job({ step: 'DELETE_SAVED_PLACES' });

    expect(isStepDone(midway, 'REVOKE_SHARING')).toBe(true);
    expect(isStepDone(midway, 'DELETE_SAVED_PLACES')).toBe(false);
    expect(isStepDone(midway, 'WRITE_TOMBSTONE')).toBe(false);
  });

  it('records a failure as a reason code, never as a message', () => {
    const failed = markFailed(job(), 'ProvisionedThroughputExceededException', NOW);

    expect(failed.status).toBe('FAILED');
    expect(failed.attempts).toBe(1);
    expect(failed.lastErrorCode).toBe('ProvisionedThroughputExceededException');
  });
});

describe('history day partitions', () => {
  it('builds the partition key the table is designed around', () => {
    expect(historyPartitionKey(USER_ID, '2026-06-01')).toBe(`USER#${USER_ID}#DAY#2026-06-01`);
  });

  it('walks backwards from the request, newest first', () => {
    const days = historyDayPartitions({
      requestedAt: '2026-06-10T00:00:00.000Z',
      lookbackDays: 3,
      now: NOW,
    });

    expect(days).toEqual(['2026-06-10', '2026-06-09', '2026-06-08']);
  });

  it('resumes from the cursor and reports when it is finished', () => {
    const days = ['d1', 'd2', 'd3', 'd4', 'd5'];

    const first = nextHistoryDays({ days, cursor: null, limit: 2 });
    expect(first.days).toEqual(['d1', 'd2']);
    expect(first.nextCursor).toBe('d2');
    expect(first.done).toBe(false);

    const second = nextHistoryDays({ days, cursor: 'd2', limit: 2 });
    expect(second.days).toEqual(['d3', 'd4']);
    expect(second.done).toBe(false);

    const third = nextHistoryDays({ days, cursor: 'd4', limit: 2 });
    expect(third.days).toEqual(['d5']);
    expect(third.done).toBe(true);
  });

  it('does not restart from the beginning when the cursor is unrecognised', () => {
    const days = ['d1', 'd2', 'd3'];
    const slice = nextHistoryDays({ days, cursor: 'not-a-day', limit: 2 });

    expect(slice.days).toEqual([]);
    expect(slice.done).toBe(true);
  });
});

describe('deletion job age', () => {
  it('measures from the request, which is what the promise was made against', () => {
    expect(deletionJobAgeHours({ requestedAt: '2026-06-10T00:00:00.000Z' }, NOW)).toBe(12);
  });

  it('is zero rather than negative for an unparseable or future request', () => {
    expect(deletionJobAgeHours({ requestedAt: 'nonsense' }, NOW)).toBe(0);
    expect(deletionJobAgeHours({ requestedAt: '2026-07-01T00:00:00.000Z' }, NOW)).toBe(0);
  });
});

describe('tombstone', () => {
  it('is non-identifying: no user id, no email, nothing reversible', () => {
    const tombstone = buildTombstone({
      userId: USER_ID,
      pepper: 'server-only-pepper',
      reason: 'ACCOUNT_DELETION_REQUESTED',
      now: NOW,
    });

    const serialized = JSON.stringify(tombstone);
    expect(serialized).not.toContain(USER_ID);
    expect(Object.keys(tombstone).sort()).toEqual([
      'deletedAt',
      'reason',
      'schemaVersion',
      'tombstoneId',
    ]);
  });

  it('is stable for the same user and pepper, so a retry writes one row', () => {
    const first = buildTombstone({ userId: USER_ID, pepper: 'p', reason: 'r', now: NOW });
    const second = buildTombstone({ userId: USER_ID, pepper: 'p', reason: 'r', now: NOW });

    expect(first.tombstoneId).toBe(second.tombstoneId);
  });

  it('is not a plain hash: a different pepper yields a different identifier', () => {
    const withPepper = buildTombstone({ userId: USER_ID, pepper: 'p1', reason: 'r', now: NOW });
    const withOther = buildTombstone({ userId: USER_ID, pepper: 'p2', reason: 'r', now: NOW });

    expect(withPepper.tombstoneId).not.toBe(withOther.tombstoneId);
  });
});
