import {
  emptyFreshnessHistogram,
  JOB_NAMES,
  limitBatch,
  mergeFreshnessHistograms,
  planEndpointReconciliation,
  planHistorySweep,
  planStaleMarking,
  selectExpiredInvitations,
  selectExpiredLiveSessions,
  summarise,
  type FreshnessHistogram,
  type JobName,
  type JobOutcome,
} from './jobs.js';
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
  ScanCursor,
  ScanInput,
} from './ports.js';

/**
 * Orchestration for the scheduled maintenance jobs.
 *
 * Three rules shape everything below:
 *
 *  INDEPENDENCE — a job never depends on another having run, and a job that
 *  throws is caught, counted and reported without stopping its siblings. A
 *  throttled history sweep must not prevent live sessions from expiring; one of
 *  those is a cost problem and the other is someone still being watched.
 *
 *  IDEMPOTENCE — every write is conditional or naturally repeatable, so an
 *  overlapping schedule, a retry or a manual invocation converge on the same
 *  state rather than corrupting it.
 *
 *  BOUNDEDNESS — each job reads at most `maxItemsPerJob` rows and writes at a
 *  paced rate, then reports what it left behind. Backlog is a metric, not a
 *  reason to hold a Lambda open until it times out.
 */

export type RunnerConfig = {
  readonly maxItemsPerJob: number;
  readonly historyRetentionDays: number;
  readonly monitoredQueueUrls: readonly string[];
  readonly platformApplicationArns: readonly string[];
};

export type RunnerDeps = {
  readonly liveSessions: LiveSessionStore;
  readonly invitations: InvitationStore;
  readonly currentLocations: CurrentLocationStore;
  readonly history: HistoryStore;
  readonly devices: DeviceStore;
  readonly pushEndpoints: PushEndpointRegistry;
  readonly queues: QueueDepthReader;
  readonly metrics: MaintenanceMetrics;
  readonly rateLimiter: RateLimiter;
  readonly config: RunnerConfig;
  readonly now: () => Date;
  /** Plan and report without writing. Used to rehearse a retention change. */
  readonly dryRun: boolean;
};

/** How many DynamoDB rows one BatchWriteItem call may delete. */
const MAX_DELETE_BATCH = 25;

/** A single scan page. Kept well under the 1MB response cap. */
const SCAN_PAGE_SIZE = 250;

type Collected<T> = { items: T[]; truncated: boolean };

/**
 * Pages a scan until the budget is spent or the table ends.
 *
 * `truncated` is the honest signal that rows were left unexamined: without it a
 * bounded job looks identical to one that found nothing to do.
 */
async function collect<T>(
  scan: (input: ScanInput) => Promise<Page<T>>,
  budget: number,
): Promise<Collected<T>> {
  const items: T[] = [];
  let cursor: ScanCursor | null = null;

  while (items.length < budget) {
    const limit = Math.min(SCAN_PAGE_SIZE, budget - items.length);
    const page: Page<T> = await scan({ limit, cursor });
    items.push(...page.items);
    cursor = page.cursor;
    if (cursor === null) return { items, truncated: false };
  }

  return { items, truncated: cursor !== null };
}

type PartialOutcome = Omit<JobOutcome, 'job' | 'durationMs' | 'error'>;

// ---------------------------------------------------------------------------
// Individual jobs
// ---------------------------------------------------------------------------

async function expireLiveSessions(deps: RunnerDeps): Promise<PartialOutcome> {
  const { items, truncated } = await collect(
    (input) => deps.liveSessions.scanOpen(input),
    deps.config.maxItemsPerJob,
  );
  const now = deps.now();
  const expired = selectExpiredLiveSessions(items, now.getTime());
  const batch = limitBatch(expired, deps.config.maxItemsPerJob);

  let changed = 0;
  if (!deps.dryRun) {
    for (const row of batch) {
      await deps.rateLimiter.acquire(1);
      if (await deps.liveSessions.expire({ sessionId: row.sessionId, now })) changed += 1;
    }
  }

  return {
    examined: items.length,
    changed: deps.dryRun ? batch.length : changed,
    remaining: expired.length - batch.length,
    truncated,
  };
}

async function expireInvitations(deps: RunnerDeps): Promise<PartialOutcome> {
  const { items, truncated } = await collect(
    (input) => deps.invitations.scanOpen(input),
    deps.config.maxItemsPerJob,
  );
  const now = deps.now();
  const expired = selectExpiredInvitations(items, now.getTime());
  const batch = limitBatch(expired, deps.config.maxItemsPerJob);

  let changed = 0;
  if (!deps.dryRun) {
    for (const row of batch) {
      await deps.rateLimiter.acquire(1);
      if (await deps.invitations.expire({ tokenHash: row.tokenHash, now })) changed += 1;
    }
  }

  return {
    examined: items.length,
    changed: deps.dryRun ? batch.length : changed,
    remaining: expired.length - batch.length,
    truncated,
  };
}

async function markStaleUsers(deps: RunnerDeps): Promise<PartialOutcome> {
  const { items, truncated } = await collect(
    (input) => deps.currentLocations.scan(input),
    deps.config.maxItemsPerJob,
  );
  const now = deps.now();
  const plan = planStaleMarking({ rows: items, nowMs: now.getTime() });
  const batch = limitBatch(plan.mark, deps.config.maxItemsPerJob);

  let changed = 0;
  if (!deps.dryRun) {
    for (const row of batch) {
      await deps.rateLimiter.acquire(1);
      const applied = await deps.currentLocations.markStale({
        userId: row.userId,
        deviceId: row.deviceId,
        capturedAt: row.capturedAt,
        now,
      });
      if (applied) changed += 1;
    }
  }

  return {
    examined: plan.scanned,
    changed: deps.dryRun ? batch.length : changed,
    remaining: plan.mark.length - batch.length,
    truncated,
  };
}

/**
 * Publishes the freshness histogram for the whole fleet.
 *
 * Read-only: it shares a planner with the STALE job but applies nothing, so the
 * two can run on different schedules without interfering.
 */
async function emitFreshnessMetrics(deps: RunnerDeps): Promise<PartialOutcome> {
  const { items, truncated } = await collect(
    (input) => deps.currentLocations.scan(input),
    deps.config.maxItemsPerJob,
  );
  const plan = planStaleMarking({ rows: items, nowMs: deps.now().getTime() });

  let histogram: FreshnessHistogram = emptyFreshnessHistogram();
  histogram = mergeFreshnessHistograms(histogram, plan.freshness);

  for (const band of Object.keys(histogram) as Array<keyof FreshnessHistogram>) {
    deps.metrics.freshness(band, histogram[band]);
  }

  return { examined: plan.scanned, changed: 0, remaining: 0, truncated };
}

/**
 * Publishes backlog depth for every monitored queue.
 *
 * A queue that cannot be read is counted as `remaining` rather than thrown:
 * losing one queue's metric must not cost the metrics of the others.
 */
async function emitQueueDepthMetrics(deps: RunnerDeps): Promise<PartialOutcome> {
  let examined = 0;
  let unreadable = 0;

  for (const queueUrl of deps.config.monitoredQueueUrls) {
    const depth = await deps.queues.read(queueUrl);
    if (depth === null) {
      unreadable += 1;
      continue;
    }
    deps.metrics.queueDepth(depth);
    examined += 1;
  }

  return { examined, changed: 0, remaining: unreadable, truncated: false };
}

async function sweepExpiredHistory(deps: RunnerDeps): Promise<PartialOutcome> {
  const { items, truncated } = await collect(
    (input) => deps.history.scan(input),
    deps.config.maxItemsPerJob,
  );
  const plan = planHistorySweep({
    rows: items,
    now: deps.now(),
    retentionDays: deps.config.historyRetentionDays,
  });
  const batch = limitBatch(plan.delete, deps.config.maxItemsPerJob);

  let changed = 0;
  if (!deps.dryRun) {
    for (let offset = 0; offset < batch.length; offset += MAX_DELETE_BATCH) {
      const slice = batch.slice(offset, offset + MAX_DELETE_BATCH);
      await deps.rateLimiter.acquire(slice.length);
      changed += await deps.history.deleteRows(slice);
    }
  }

  return {
    examined: plan.scanned,
    changed: deps.dryRun ? batch.length : changed,
    remaining: plan.delete.length - batch.length,
    truncated,
  };
}

async function reconcilePushEndpoints(deps: RunnerDeps): Promise<PartialOutcome> {
  const { items: devices, truncated } = await collect(
    (input) => deps.devices.scan(input),
    deps.config.maxItemsPerJob,
  );

  const endpoints = [];
  for (const platformApplicationArn of deps.config.platformApplicationArns) {
    endpoints.push(...(await deps.pushEndpoints.listEndpoints({ platformApplicationArn })));
  }

  // A truncated device scan means the claim set is incomplete, and an endpoint
  // would look orphaned only because we never read the device that owns it.
  // Deleting on that basis would silently unregister a live phone, so the SNS
  // side is skipped and only the device side — which is safe on partial data —
  // is applied.
  const plan = planEndpointReconciliation({
    endpoints: truncated ? [] : endpoints,
    devices,
  });

  let changed = 0;
  if (!deps.dryRun) {
    for (const endpointArn of limitBatch(plan.deleteEndpoints, deps.config.maxItemsPerJob)) {
      await deps.rateLimiter.acquire(1);
      await deps.pushEndpoints.deleteEndpoint({ endpointArn });
      changed += 1;
    }
    for (const device of limitBatch(plan.clearDevices, deps.config.maxItemsPerJob)) {
      await deps.rateLimiter.acquire(1);
      if (await deps.devices.clearPushEndpoint(device)) changed += 1;
    }
  } else {
    changed = plan.deleteEndpoints.length + plan.clearDevices.length;
  }

  return {
    examined: devices.length + endpoints.length,
    changed,
    remaining: 0,
    truncated,
  };
}

const JOBS: Record<JobName, (deps: RunnerDeps) => Promise<PartialOutcome>> = {
  'expire-live-sessions': expireLiveSessions,
  'expire-invitations': expireInvitations,
  'mark-stale-users': markStaleUsers,
  'emit-freshness-metrics': emitFreshnessMetrics,
  'emit-queue-depth-metrics': emitQueueDepthMetrics,
  'sweep-expired-history': sweepExpiredHistory,
  'reconcile-push-endpoints': reconcilePushEndpoints,
};

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Runs one job, converting any failure into a recorded outcome.
 *
 * The error is reduced to its NAME before it leaves this function: a thrown
 * DynamoDB error can quote the offending item, and that item may hold a sealed
 * coordinate or an invitation token.
 */
export async function runJob(job: JobName, deps: RunnerDeps): Promise<JobOutcome> {
  const startedMs = deps.now().getTime();
  const execute = JOBS[job];

  try {
    const partial = await execute(deps);
    const durationMs = Math.max(0, deps.now().getTime() - startedMs);

    deps.metrics.jobCompleted(job, { changed: partial.changed, durationMs });
    if (partial.remaining > 0) deps.metrics.backlog(job, partial.remaining);

    return { job, durationMs, ...partial };
  } catch (error) {
    deps.metrics.jobFailed(job);
    return {
      job,
      examined: 0,
      changed: 0,
      remaining: 0,
      truncated: false,
      durationMs: Math.max(0, deps.now().getTime() - startedMs),
      error: error instanceof Error ? error.name : 'UnknownError',
    };
  }
}

export type MaintenanceRunResult = {
  readonly ranAt: string;
  readonly dryRun: boolean;
  readonly outcomes: readonly JobOutcome[];
  readonly changed: number;
  readonly failed: number;
  readonly hasBacklog: boolean;
};

/** Runs the requested jobs in order, isolating each from the others. */
export async function runJobs(
  jobs: readonly JobName[],
  deps: RunnerDeps,
): Promise<MaintenanceRunResult> {
  const outcomes: JobOutcome[] = [];
  for (const job of jobs) {
    outcomes.push(await runJob(job, deps));
  }

  return {
    ranAt: deps.now().toISOString(),
    dryRun: deps.dryRun,
    outcomes,
    ...summarise(outcomes),
  };
}

export function allJobs(): readonly JobName[] {
  return JOB_NAMES;
}

/**
 * A token bucket that lets a small burst through and then paces the rest.
 *
 * Shared across the jobs in one invocation so the schedule as a whole, not each
 * job in isolation, respects the write budget.
 */
export function createRateLimiter(options: {
  ratePerSecond: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): RateLimiter {
  const rate = Math.max(1, options.ratePerSecond);
  const sleep =
    options.sleep ??
    ((ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;

  let allowance = rate;
  let lastCheck = now();

  return {
    async acquire(units: number): Promise<void> {
      const current = now();
      allowance = Math.min(rate, allowance + ((current - lastCheck) / 1000) * rate);
      lastCheck = current;

      if (allowance >= units) {
        allowance -= units;
        return;
      }

      const deficit = units - allowance;
      allowance = 0;
      await sleep(Math.ceil((deficit / rate) * 1000));
    },
  };
}
