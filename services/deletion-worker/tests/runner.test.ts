import { beforeEach, describe, expect, it } from 'vitest';

import type { DeviceId, FamilyId, UserId } from '@family/contracts';

import type { DeletionJob, Tombstone } from '../src/job.js';
import {
  chooseSuccessor,
  dissolvedFamilies,
  planMembershipRemoval,
  survivingFamilies,
  type MembershipRow,
} from '../src/membership-plan.js';
import type {
  DeletionJobStore,
  DeletionMetricsSink,
  DeletionRateLimiter,
  DeviceRepository,
  DeviceSummary,
  IdentityDeleter,
  JobRescheduler,
  MembershipRepository,
  PushEndpointRegistry,
  SharingRevoker,
  TombstoneWriter,
  UserDataDeleter,
} from '../src/ports.js';
import { createRateLimiter, runDeletionJob, type RunnerDeps } from '../src/runner.js';

const USER_ID = '11111111-1111-4111-8111-111111111111' as UserId;
const SUCCESSOR_ID = '22222222-2222-4222-8222-222222222222' as UserId;
const JUNIOR_ID = '33333333-3333-4333-8333-333333333333' as UserId;
const SHARED_FAMILY = '44444444-4444-4444-8444-444444444444' as FamilyId;
const SOLO_FAMILY = '55555555-5555-4555-8555-555555555555' as FamilyId;
const DEVICE_ID = '66666666-6666-4666-8666-666666666666' as DeviceId;
const NOW = new Date('2026-06-10T12:00:00.000Z');

function member(
  overrides: Partial<MembershipRow> & Pick<MembershipRow, 'familyId' | 'userId'>,
): MembershipRow {
  return {
    role: 'MEMBER',
    status: 'ACTIVE',
    joinedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Membership planning
// ---------------------------------------------------------------------------

describe('planMembershipRemoval', () => {
  it('just removes the row when the subject does not own the family', () => {
    const plan = planMembershipRemoval({
      userId: USER_ID,
      memberships: [member({ familyId: SHARED_FAMILY, userId: USER_ID })],
      otherMembersByFamily: new Map([
        [SHARED_FAMILY, [member({ familyId: SHARED_FAMILY, userId: SUCCESSOR_ID, role: 'OWNER' })]],
      ]),
    });

    expect(plan).toEqual([{ familyId: SHARED_FAMILY, action: 'LEAVE' }]);
  });

  it('transfers ownership rather than orphaning a family', () => {
    const plan = planMembershipRemoval({
      userId: USER_ID,
      memberships: [member({ familyId: SHARED_FAMILY, userId: USER_ID, role: 'OWNER' })],
      otherMembersByFamily: new Map([
        [
          SHARED_FAMILY,
          [
            member({ familyId: SHARED_FAMILY, userId: JUNIOR_ID, role: 'MEMBER' }),
            member({ familyId: SHARED_FAMILY, userId: SUCCESSOR_ID, role: 'ADMIN' }),
          ],
        ],
      ]),
    });

    expect(plan).toEqual([
      { familyId: SHARED_FAMILY, action: 'TRANSFER_OWNERSHIP', successorUserId: SUCCESSOR_ID },
    ]);
  });

  it('dissolves a family the subject owned alone', () => {
    const plan = planMembershipRemoval({
      userId: USER_ID,
      memberships: [member({ familyId: SOLO_FAMILY, userId: USER_ID, role: 'OWNER' })],
      otherMembersByFamily: new Map(),
    });

    expect(plan).toEqual([{ familyId: SOLO_FAMILY, action: 'DISSOLVE' }]);
  });

  it('dissolves rather than handing a family to someone who already left', () => {
    const plan = planMembershipRemoval({
      userId: USER_ID,
      memberships: [member({ familyId: SOLO_FAMILY, userId: USER_ID, role: 'OWNER' })],
      otherMembersByFamily: new Map([
        [SOLO_FAMILY, [member({ familyId: SOLO_FAMILY, userId: SUCCESSOR_ID, status: 'REMOVED' })]],
      ]),
    });

    expect(plan).toEqual([{ familyId: SOLO_FAMILY, action: 'DISSOLVE' }]);
  });

  it('chooses the successor deterministically: rank, then seniority, then id', () => {
    const candidates = [
      member({
        familyId: SHARED_FAMILY,
        userId: JUNIOR_ID,
        role: 'ADMIN',
        joinedAt: '2026-05-01T00:00:00.000Z',
      }),
      member({
        familyId: SHARED_FAMILY,
        userId: SUCCESSOR_ID,
        role: 'ADMIN',
        joinedAt: '2026-01-01T00:00:00.000Z',
      }),
    ];

    expect(chooseSuccessor(candidates)).toBe(SUCCESSOR_ID);
    expect(chooseSuccessor([...candidates].reverse())).toBe(SUCCESSOR_ID);
  });

  it('separates the families that vanish from the ones that survive', () => {
    const plan = planMembershipRemoval({
      userId: USER_ID,
      memberships: [
        member({ familyId: SHARED_FAMILY, userId: USER_ID, role: 'OWNER' }),
        member({ familyId: SOLO_FAMILY, userId: USER_ID, role: 'OWNER' }),
      ],
      otherMembersByFamily: new Map([
        [SHARED_FAMILY, [member({ familyId: SHARED_FAMILY, userId: SUCCESSOR_ID })]],
      ]),
    });

    expect(dissolvedFamilies(plan)).toEqual([SOLO_FAMILY]);
    expect(survivingFamilies(plan)).toEqual([
      { familyId: SHARED_FAMILY, inheritorUserId: SUCCESSOR_ID },
    ]);
  });
});

// ---------------------------------------------------------------------------
// The run itself
// ---------------------------------------------------------------------------

class FakeJobStore implements DeletionJobStore {
  readonly saves: DeletionJob[] = [];
  current: DeletionJob | null = null;

  load(): Promise<DeletionJob | null> {
    return Promise.resolve(this.current);
  }

  save(job: DeletionJob): Promise<void> {
    this.saves.push(job);
    this.current = job;
    return Promise.resolve();
  }
}

class Recorder {
  readonly calls: string[] = [];
  record(name: string): void {
    this.calls.push(name);
  }
}

function buildDeps(options: {
  recorder: Recorder;
  jobs: FakeJobStore;
  memberships?: MembershipRow[];
  otherMembers?: MembershipRow[];
  devices?: DeviceSummary[];
  historyRows?: Record<string, number>;
  failAt?: string;
  maxHistoryDaysPerInvocation?: number;
  historyLookbackDays?: number;
  tombstones?: Tombstone[];
}): RunnerDeps {
  const recorder = options.recorder;
  const tombstones = options.tombstones ?? [];

  const guard = (name: string): void => {
    recorder.record(name);
    if (options.failAt === name) throw new Error('ProvisionedThroughputExceededException');
  };

  const sharing: SharingRevoker = {
    revokeAllSharing: () => {
      guard('revokeAllSharing');
      return Promise.resolve(2);
    },
  };

  const memberships: MembershipRepository = {
    listMemberships: () => Promise.resolve(options.memberships ?? []),
    listFamilyMembers: () => Promise.resolve(options.otherMembers ?? []),
    transferOwnership: () => {
      guard('transferOwnership');
      return Promise.resolve();
    },
    removeMembership: () => {
      guard('removeMembership');
      return Promise.resolve();
    },
    dissolveFamily: () => {
      guard('dissolveFamily');
      return Promise.resolve();
    },
  };

  const devices: DeviceRepository = {
    listDevices: () => Promise.resolve(options.devices ?? []),
    revokeDevice: () => {
      guard('revokeDevice');
      return Promise.resolve();
    },
  };

  const pushEndpoints: PushEndpointRegistry = {
    deleteEndpoint: () => {
      guard('deleteEndpoint');
      return Promise.resolve();
    },
  };

  const data: UserDataDeleter = {
    deleteCurrentLocations: () => {
      guard('deleteCurrentLocations');
      return Promise.resolve(1);
    },
    deleteHistoryDay: (input) => {
      guard('deleteHistoryDay');
      return Promise.resolve(options.historyRows?.[input.day] ?? 0);
    },
    purgeSavedPlaces: () => {
      guard('purgeSavedPlaces');
      return Promise.resolve(3);
    },
    deleteNotificationPreferences: () => {
      guard('deleteNotificationPreferences');
      return Promise.resolve(1);
    },
    deleteLiveSessions: () => {
      guard('deleteLiveSessions');
      return Promise.resolve(0);
    },
    deleteGeofenceState: () => {
      guard('deleteGeofenceState');
      return Promise.resolve(4);
    },
  };

  const identity: IdentityDeleter = {
    deleteUser: () => {
      guard('deleteUser');
      return Promise.resolve();
    },
  };

  const tombstoneWriter: TombstoneWriter = {
    write: (tombstone) => {
      guard('writeTombstone');
      tombstones.push(tombstone);
      return Promise.resolve();
    },
  };

  const rescheduled: Array<{ jobId: string; delaySeconds: number }> = [];
  const rescheduler: JobRescheduler = {
    reschedule: (input) => {
      recorder.record('reschedule');
      rescheduled.push(input);
      return Promise.resolve();
    },
  };

  const rateLimiter: DeletionRateLimiter = { acquire: () => Promise.resolve() };

  const metrics: DeletionMetricsSink = {
    recordJobAgeHours: () => recorder.record('metric:age'),
    recordRowsDeleted: () => undefined,
  };

  return {
    jobs: options.jobs,
    sharing,
    memberships,
    devices,
    pushEndpoints,
    data,
    identity,
    tombstones: tombstoneWriter,
    rescheduler,
    rateLimiter,
    metrics,
    tombstonePepper: 'test-pepper',
    historyLookbackDays: options.historyLookbackDays ?? 2,
    maxHistoryDaysPerInvocation: options.maxHistoryDaysPerInvocation ?? 10,
    rescheduleDelaySeconds: 5,
    now: () => NOW,
  };
}

function pendingJob(overrides: Partial<DeletionJob> = {}): DeletionJob {
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

describe('runDeletionJob', () => {
  let recorder: Recorder;
  let jobs: FakeJobStore;

  beforeEach(() => {
    recorder = new Recorder();
    jobs = new FakeJobStore();
  });

  it('runs every step in order and finishes', async () => {
    const deps = buildDeps({
      recorder,
      jobs,
      memberships: [member({ familyId: SOLO_FAMILY, userId: USER_ID, role: 'OWNER' })],
      devices: [{ deviceId: DEVICE_ID, pushEndpointArn: 'arn:aws:sns:endpoint/x' }],
    });

    const result = await runDeletionJob(pendingJob(), deps);

    expect(result.job.status).toBe('COMPLETED');
    expect(result.rescheduled).toBe(false);
    expect(result.stepsExecuted).toEqual([
      'REVOKE_SHARING',
      'REMOVE_MEMBERSHIPS',
      'REVOKE_DEVICES',
      'DELETE_CURRENT_LOCATIONS',
      'DELETE_LOCATION_HISTORY',
      'DELETE_SAVED_PLACES',
      'DELETE_NOTIFICATION_PREFERENCES',
      'DELETE_LIVE_SESSIONS',
      'DELETE_GEOFENCE_STATE',
      'DELETE_IDENTITY',
      'WRITE_TOMBSTONE',
      'CONFIRM',
    ]);
  });

  it('revokes sharing before it touches anything else', async () => {
    const deps = buildDeps({
      recorder,
      jobs,
      memberships: [member({ familyId: SOLO_FAMILY, userId: USER_ID, role: 'OWNER' })],
    });

    await runDeletionJob(pendingJob(), deps);

    const effects = recorder.calls.filter((call) => !call.startsWith('metric:'));
    expect(effects[0]).toBe('revokeAllSharing');
  });

  it('deletes the push endpoint alongside the device it belonged to', async () => {
    const deps = buildDeps({
      recorder,
      jobs,
      devices: [
        { deviceId: DEVICE_ID, pushEndpointArn: 'arn:aws:sns:endpoint/x' },
        { deviceId: '77777777-7777-4777-8777-777777777777' as DeviceId, pushEndpointArn: null },
      ],
    });

    await runDeletionJob(pendingJob(), deps);

    expect(recorder.calls.filter((call) => call === 'revokeDevice')).toHaveLength(2);
    expect(recorder.calls.filter((call) => call === 'deleteEndpoint')).toHaveLength(1);
  });

  it('transfers ownership before removing the membership row', async () => {
    const deps = buildDeps({
      recorder,
      jobs,
      memberships: [member({ familyId: SHARED_FAMILY, userId: USER_ID, role: 'OWNER' })],
      otherMembers: [member({ familyId: SHARED_FAMILY, userId: SUCCESSOR_ID, role: 'ADMIN' })],
    });

    await runDeletionJob(pendingJob(), deps);

    const transfer = recorder.calls.indexOf('transferOwnership');
    const remove = recorder.calls.indexOf('removeMembership');
    expect(transfer).toBeGreaterThanOrEqual(0);
    expect(transfer).toBeLessThan(remove);
    expect(recorder.calls).not.toContain('dissolveFamily');
  });

  it('dissolves a single-member family instead of transferring it', async () => {
    const deps = buildDeps({
      recorder,
      jobs,
      memberships: [member({ familyId: SOLO_FAMILY, userId: USER_ID, role: 'OWNER' })],
    });

    await runDeletionJob(pendingJob(), deps);

    expect(recorder.calls).toContain('dissolveFamily');
    expect(recorder.calls).not.toContain('transferOwnership');
  });

  it('checkpoints after every history day partition', async () => {
    const deps = buildDeps({ recorder, jobs, historyLookbackDays: 3 });

    await runDeletionJob(pendingJob({ step: 'DELETE_LOCATION_HISTORY' }), deps);

    const cursors = jobs.saves
      .filter((save) => save.step === 'DELETE_LOCATION_HISTORY')
      .map((save) => save.cursor);
    expect(cursors).toContain('2026-06-10');
    expect(cursors).toContain('2026-06-09');
    expect(cursors).toContain('2026-06-08');
  });

  it('stops and reschedules when the per-invocation history budget runs out', async () => {
    const deps = buildDeps({
      recorder,
      jobs,
      historyLookbackDays: 5,
      maxHistoryDaysPerInvocation: 2,
    });

    const result = await runDeletionJob(pendingJob({ step: 'DELETE_LOCATION_HISTORY' }), deps);

    expect(result.rescheduled).toBe(true);
    expect(result.job.step).toBe('DELETE_LOCATION_HISTORY');
    expect(result.job.cursor).toBe('2026-06-09');
    expect(recorder.calls.filter((call) => call === 'deleteHistoryDay')).toHaveLength(2);
  });

  it('resumes from the checkpoint rather than restarting', async () => {
    const deps = buildDeps({
      recorder,
      jobs,
      historyLookbackDays: 5,
      maxHistoryDaysPerInvocation: 2,
    });

    const first = await runDeletionJob(pendingJob({ step: 'DELETE_LOCATION_HISTORY' }), deps);
    recorder.calls.length = 0;

    const second = await runDeletionJob(first.job, deps);

    // Two more days consumed, not five, and none repeated.
    expect(recorder.calls.filter((call) => call === 'deleteHistoryDay')).toHaveLength(2);
    expect(second.job.cursor).toBe('2026-06-07');
  });

  it('resumes a partly finished job without redoing earlier steps', async () => {
    const deps = buildDeps({ recorder, jobs });

    const result = await runDeletionJob(
      pendingJob({
        step: 'DELETE_GEOFENCE_STATE',
        completedSteps: ['REVOKE_SHARING', 'REMOVE_MEMBERSHIPS'],
        startedAt: '2026-06-09T13:00:00.000Z',
        status: 'RUNNING',
      }),
      deps,
    );

    expect(recorder.calls).not.toContain('revokeAllSharing');
    expect(recorder.calls).not.toContain('removeMembership');
    expect(result.job.status).toBe('COMPLETED');
  });

  it('is a no-op when the job has already completed', async () => {
    const deps = buildDeps({ recorder, jobs });

    const result = await runDeletionJob(
      pendingJob({ step: 'COMPLETED', status: 'COMPLETED' }),
      deps,
    );

    expect(result.stepsExecuted).toEqual([]);
    expect(recorder.calls.filter((call) => !call.startsWith('metric:'))).toEqual([]);
  });

  it('reschedules from the failed step rather than abandoning the deletion', async () => {
    const deps = buildDeps({ recorder, jobs, failAt: 'deleteCurrentLocations' });

    const result = await runDeletionJob(pendingJob(), deps);

    expect(result.job.status).toBe('FAILED');
    expect(result.job.step).toBe('DELETE_CURRENT_LOCATIONS');
    expect(result.job.lastErrorCode).toBe('Error');
    expect(result.rescheduled).toBe(true);
    // The steps before the failure stay recorded, so the retry skips them.
    expect(result.job.completedSteps).toContain('REVOKE_SHARING');
  });

  it('writes a non-identifying tombstone at the end', async () => {
    const tombstones: Tombstone[] = [];
    const deps = buildDeps({ recorder, jobs, tombstones });

    await runDeletionJob(pendingJob(), deps);

    expect(tombstones).toHaveLength(1);
    expect(JSON.stringify(tombstones[0])).not.toContain(USER_ID);
  });

  it('emits the deletion-job age on every invocation', async () => {
    const deps = buildDeps({ recorder, jobs });

    await runDeletionJob(pendingJob(), deps);

    expect(recorder.calls.filter((call) => call === 'metric:age')).toHaveLength(1);
  });
});

describe('createRateLimiter', () => {
  it('lets a burst through and then paces the rest', async () => {
    const sleeps: number[] = [];
    let clock = 0;
    const limiter = createRateLimiter({
      ratePerSecond: 2,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      now: () => clock,
    });

    await limiter.acquire(1);
    await limiter.acquire(1);
    expect(sleeps).toEqual([]);

    await limiter.acquire(1);
    expect(sleeps).toHaveLength(1);

    // Time passing refills the bucket.
    clock += 1000;
    await limiter.acquire(1);
    expect(sleeps).toHaveLength(1);
  });
});
