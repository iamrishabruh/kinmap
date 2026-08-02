import { describe, expect, it } from 'vitest';

import type { Freshness } from '@family/contracts';

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
} from '../src/jobs.js';
import { JOB_NAMES } from '../src/jobs.js';
import type {
  CurrentLocationStore,
  DeviceStore,
  HistoryStore,
  InvitationStore,
  LiveSessionStore,
  MaintenanceMetrics,
  Page,
  PushEndpointRegistry,
  QueueDepthReader,
  RateLimiter,
  ScanInput,
} from '../src/ports.js';
import { allJobs, createRateLimiter, runJob, runJobs, type RunnerDeps } from '../src/runner.js';

/**
 * Orchestration tests. Every port is a fake, so these assert the properties the
 * schedule depends on — independence, idempotence, boundedness and the refusal
 * to act on a partial view — without a table, a queue or a credential.
 */

const NOW = new Date('2026-06-01T12:00:00.000Z');
const at = (offsetMs: number): string => new Date(NOW.getTime() + offsetMs).toISOString();

const userId = '00000000-0000-4000-8000-000000000001';
const deviceId = '00000000-0000-4000-8000-000000000002';
const familyId = '00000000-0000-4000-8000-000000000003';
const ENDPOINT = 'arn:aws:sns:us-east-1:000000000000:endpoint/APNS/kinmap/abc';

/** Pages an in-memory array the way a DynamoDB scan pages a table. */
function pager<T>(rows: readonly T[]): (input: ScanInput) => Promise<Page<T>> {
  return async (input) => {
    const raw = input.cursor?.['i'];
    const start = typeof raw === 'number' ? raw : 0;
    const end = Math.min(rows.length, start + input.limit);
    return { items: rows.slice(start, end), cursor: end >= rows.length ? null : { i: end } };
  };
}

type Recorder = {
  liveSessionExpiries: string[];
  invitationExpiries: string[];
  staleMarks: string[];
  historyDeletes: HistoryKey[];
  endpointDeletes: string[];
  deviceClears: string[];
  freshness: Array<{ band: Freshness; count: number }>;
  queueDepths: QueueDepth[];
  failures: JobName[];
  rateLimitUnits: number[];
};

type Fixture = {
  liveSessions?: LiveSessionRow[];
  invitations?: InvitationRow[];
  currentLocations?: CurrentLocationRow[];
  history?: HistoryRow[];
  devices?: DeviceEndpointRef[];
  endpoints?: PushEndpointSummary[];
  queues?: Record<string, QueueDepth | null>;
  maxItemsPerJob?: number;
  dryRun?: boolean;
  /** Makes the named store throw, to prove a failure stays contained. */
  breaks?: 'liveSessions' | 'history' | 'devices';
  /** Simulates losing a conditional write to a concurrent update. */
  loseConditionalWrites?: boolean;
};

function build(fixture: Fixture = {}): { deps: RunnerDeps; recorder: Recorder } {
  const recorder: Recorder = {
    liveSessionExpiries: [],
    invitationExpiries: [],
    staleMarks: [],
    historyDeletes: [],
    endpointDeletes: [],
    deviceClears: [],
    freshness: [],
    queueDepths: [],
    failures: [],
    rateLimitUnits: [],
  };

  const won = fixture.loseConditionalWrites !== true;

  const liveSessions: LiveSessionStore = {
    scanOpen: async (input) => {
      if (fixture.breaks === 'liveSessions')
        throw new Error('ProvisionedThroughputExceededException');
      return pager(fixture.liveSessions ?? [])(input);
    },
    expire: async ({ sessionId }) => {
      recorder.liveSessionExpiries.push(sessionId);
      return won;
    },
  };

  const invitations: InvitationStore = {
    scanOpen: pager(fixture.invitations ?? []),
    expire: async ({ tokenHash }) => {
      recorder.invitationExpiries.push(tokenHash);
      return won;
    },
  };

  const currentLocations: CurrentLocationStore = {
    scan: pager(fixture.currentLocations ?? []),
    markStale: async ({ userId: user, deviceId: device }) => {
      recorder.staleMarks.push(`${user}/${device}`);
      return won;
    },
  };

  const history: HistoryStore = {
    scan: async (input) => {
      if (fixture.breaks === 'history') throw new Error('ThrottlingException');
      return pager(fixture.history ?? [])(input);
    },
    deleteRows: async (keys) => {
      recorder.historyDeletes.push(...keys);
      return keys.length;
    },
  };

  const devices: DeviceStore = {
    scan: async (input) => {
      if (fixture.breaks === 'devices') throw new Error('ThrottlingException');
      return pager(fixture.devices ?? [])(input);
    },
    clearPushEndpoint: async ({ userId: user, deviceId: device }) => {
      recorder.deviceClears.push(`${user}/${device}`);
      return won;
    },
  };

  const pushEndpoints: PushEndpointRegistry = {
    listEndpoints: async () => fixture.endpoints ?? [],
    deleteEndpoint: async ({ endpointArn }) => {
      recorder.endpointDeletes.push(endpointArn);
    },
  };

  const queues: QueueDepthReader = {
    read: async (queueUrl) => fixture.queues?.[queueUrl] ?? null,
  };

  const metrics: MaintenanceMetrics = {
    freshness: (band, count) => recorder.freshness.push({ band, count }),
    queueDepth: (depth) => recorder.queueDepths.push(depth),
    jobCompleted: () => undefined,
    jobFailed: (job) => recorder.failures.push(job),
    backlog: () => undefined,
  };

  const rateLimiter: RateLimiter = {
    acquire: async (units) => {
      recorder.rateLimitUnits.push(units);
    },
  };

  return {
    recorder,
    deps: {
      liveSessions,
      invitations,
      currentLocations,
      history,
      devices,
      pushEndpoints,
      queues,
      metrics,
      rateLimiter,
      config: {
        maxItemsPerJob: fixture.maxItemsPerJob ?? 1000,
        historyRetentionDays: 30,
        monitoredQueueUrls: Object.keys(fixture.queues ?? {}),
        platformApplicationArns: fixture.endpoints === undefined ? [] : ['arn:app'],
      },
      now: () => NOW,
      dryRun: fixture.dryRun === true,
    },
  };
}

const expiredSession: LiveSessionRow = {
  sessionId: 's1',
  targetUserId: userId,
  status: 'ACTIVE',
  startedAt: at(-3_600_000),
  expiresAt: at(-60_000),
};

const expiredInvitation: InvitationRow = {
  tokenHash: 'a'.repeat(64),
  familyId,
  status: 'PENDING',
  createdAt: at(-9 * 3_600_000),
  expiresAt: at(-3_600_000),
};

const staleLocation: CurrentLocationRow = {
  userId,
  deviceId,
  capturedAt: at(-4 * 3_600_000),
  trackingState: 'PASSIVE',
};

const oldHistoryRow: HistoryRow = {
  pk: 'USER#u1#DAY#2026-01-01',
  sk: 'TIME#2026-01-01T00:00:00.000Z#EVENT#e1',
  expiresAt: null,
};

describe('independent invocation', () => {
  it('exposes every declared job to the runner', () => {
    expect(allJobs()).toEqual(JOB_NAMES);
  });

  it('runs one job without touching any other store', async () => {
    const { deps, recorder } = build({
      liveSessions: [expiredSession],
      invitations: [expiredInvitation],
      currentLocations: [staleLocation],
      history: [oldHistoryRow],
    });

    const outcome = await runJob('expire-live-sessions', deps);

    expect(outcome.changed).toBe(1);
    expect(recorder.liveSessionExpiries).toEqual(['s1']);
    // Nothing else moved.
    expect(recorder.invitationExpiries).toEqual([]);
    expect(recorder.staleMarks).toEqual([]);
    expect(recorder.historyDeletes).toEqual([]);
  });

  it('expires an invitation on its own', async () => {
    const { deps, recorder } = build({ invitations: [expiredInvitation] });
    const outcome = await runJob('expire-invitations', deps);

    expect(outcome.changed).toBe(1);
    expect(recorder.invitationExpiries).toEqual([expiredInvitation.tokenHash]);
  });

  it('marks a stale user on its own', async () => {
    const { deps, recorder } = build({ currentLocations: [staleLocation] });
    const outcome = await runJob('mark-stale-users', deps);

    expect(outcome.changed).toBe(1);
    expect(recorder.staleMarks).toEqual([`${userId}/${deviceId}`]);
  });

  it('sweeps history on its own', async () => {
    const { deps, recorder } = build({ history: [oldHistoryRow] });
    const outcome = await runJob('sweep-expired-history', deps);

    expect(outcome.changed).toBe(1);
    expect(recorder.historyDeletes).toEqual([{ pk: oldHistoryRow.pk, sk: oldHistoryRow.sk }]);
  });
});

describe('metrics jobs', () => {
  it('emits a count for every freshness band and writes nothing', async () => {
    const { deps, recorder } = build({ currentLocations: [staleLocation] });
    const outcome = await runJob('emit-freshness-metrics', deps);

    expect(outcome.changed).toBe(0);
    expect(recorder.staleMarks).toEqual([]);
    expect(recorder.freshness.map((entry) => entry.band).sort()).toEqual([
      'FRESH',
      'LIVE',
      'RECENT',
      'STALE',
      'UNKNOWN',
    ]);
    expect(recorder.freshness.find((entry) => entry.band === 'STALE')?.count).toBe(1);
  });

  it('publishes depth for each readable queue', async () => {
    const depth: QueueDepth = { queueUrl: 'q1', visible: 3, inFlight: 1, delayed: 0 };
    const { deps, recorder } = build({ queues: { q1: depth } });

    const outcome = await runJob('emit-queue-depth-metrics', deps);

    expect(recorder.queueDepths).toEqual([depth]);
    expect(outcome.examined).toBe(1);
  });

  it('counts an unreadable queue instead of failing the others', async () => {
    const depth: QueueDepth = { queueUrl: 'q2', visible: 0, inFlight: 0, delayed: 0 };
    const { deps, recorder } = build({ queues: { q1: null, q2: depth } });

    const outcome = await runJob('emit-queue-depth-metrics', deps);

    expect(outcome.error).toBeUndefined();
    expect(recorder.queueDepths).toEqual([depth]);
    expect(outcome.remaining).toBe(1);
  });
});

describe('push endpoint reconciliation', () => {
  const liveDevice: DeviceEndpointRef = {
    userId,
    deviceId,
    pushEndpointArn: ENDPOINT,
    status: 'ACTIVE',
    revokedAt: null,
  };

  it('deletes an orphaned endpoint and clears a dangling device reference', async () => {
    const { deps, recorder } = build({
      devices: [{ ...liveDevice, status: 'REVOKED' }],
      endpoints: [{ endpointArn: ENDPOINT, enabled: true }],
    });

    await runJob('reconcile-push-endpoints', deps);

    expect(recorder.endpointDeletes).toEqual([ENDPOINT]);
    expect(recorder.deviceClears).toEqual([`${userId}/${deviceId}`]);
  });

  it('refuses to delete endpoints from a partial view of the devices', async () => {
    // With the device scan truncated, an endpoint can look orphaned purely
    // because the device that owns it was never read. Deleting on that basis
    // would silently unregister a live phone.
    const { deps, recorder } = build({
      devices: [liveDevice, { ...liveDevice, deviceId: 'd2' }],
      endpoints: [{ endpointArn: ENDPOINT, enabled: true }],
      maxItemsPerJob: 1,
    });

    const outcome = await runJob('reconcile-push-endpoints', deps);

    expect(outcome.truncated).toBe(true);
    expect(recorder.endpointDeletes).toEqual([]);
  });
});

describe('isolation and reporting', () => {
  it('does not let one failing job stop its siblings', async () => {
    const { deps, recorder } = build({
      breaks: 'liveSessions',
      invitations: [expiredInvitation],
    });

    const result = await runJobs(['expire-live-sessions', 'expire-invitations'], deps);

    expect(result.failed).toBe(1);
    // The sibling still ran and still did its work.
    expect(recorder.invitationExpiries).toHaveLength(1);
    expect(result.changed).toBe(1);
  });

  it('reports an error NAME only, never a message that could quote a row', async () => {
    const { deps, recorder } = build({ breaks: 'history' });
    const outcome = await runJob('sweep-expired-history', deps);

    expect(outcome.error).toBe('Error');
    expect(JSON.stringify(outcome)).not.toContain('Throttling');
    expect(recorder.failures).toEqual(['sweep-expired-history']);
  });

  it('does not count a conditional write it lost as a change', async () => {
    // The user stopped the session first; their choice stands.
    const { deps } = build({ liveSessions: [expiredSession], loseConditionalWrites: true });
    const outcome = await runJob('expire-live-sessions', deps);

    expect(outcome.changed).toBe(0);
  });
});

describe('idempotence across ticks', () => {
  it('changes nothing on a second run once the first has been applied', async () => {
    const fixture: Fixture = {
      liveSessions: [expiredSession],
      invitations: [expiredInvitation],
      currentLocations: [staleLocation],
      history: [oldHistoryRow],
    };

    const first = await runJobs(allJobs(), build(fixture).deps);
    expect(first.changed).toBeGreaterThan(0);

    // The state the first run produced: everything closed, marked and swept.
    const applied: Fixture = {
      liveSessions: [{ ...expiredSession, status: 'EXPIRED' }],
      invitations: [{ ...expiredInvitation, status: 'EXPIRED' }],
      currentLocations: [{ ...staleLocation, trackingState: 'STALE' }],
      history: [],
    };

    const second = await runJobs(allJobs(), build(applied).deps);
    expect(second.changed).toBe(0);
    expect(second.failed).toBe(0);
  });
});

describe('boundedness', () => {
  it('stops at the item budget and reports the scan as truncated', async () => {
    const rows = Array.from({ length: 5 }, (_unused, index) => ({
      ...expiredSession,
      sessionId: `s${index}`,
    }));
    const { deps, recorder } = build({ liveSessions: rows, maxItemsPerJob: 2 });

    const outcome = await runJob('expire-live-sessions', deps);

    expect(outcome.examined).toBe(2);
    expect(outcome.truncated).toBe(true);
    expect(recorder.liveSessionExpiries).toEqual(['s0', 's1']);
  });

  it('paces every destructive write through the rate limiter', async () => {
    const { deps, recorder } = build({ liveSessions: [expiredSession] });
    await runJob('expire-live-sessions', deps);

    expect(recorder.rateLimitUnits).toEqual([1]);
  });
});

describe('dry run', () => {
  it('reports what would change without writing anything', async () => {
    const { deps, recorder } = build({
      liveSessions: [expiredSession],
      invitations: [expiredInvitation],
      currentLocations: [staleLocation],
      history: [oldHistoryRow],
      dryRun: true,
    });

    const result = await runJobs(allJobs(), deps);

    expect(result.dryRun).toBe(true);
    expect(result.changed).toBeGreaterThan(0);
    expect(recorder.liveSessionExpiries).toEqual([]);
    expect(recorder.invitationExpiries).toEqual([]);
    expect(recorder.staleMarks).toEqual([]);
    expect(recorder.historyDeletes).toEqual([]);
    expect(recorder.endpointDeletes).toEqual([]);
  });
});

describe('createRateLimiter', () => {
  it('lets a burst through and then paces the rest', async () => {
    const sleeps: number[] = [];
    let clock = 0;
    const limiter = createRateLimiter({
      ratePerSecond: 2,
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    });

    await limiter.acquire(1);
    await limiter.acquire(1);
    expect(sleeps).toEqual([]);

    await limiter.acquire(1);
    expect(sleeps).toHaveLength(1);
  });
});
