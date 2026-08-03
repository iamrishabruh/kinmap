import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SNSClient } from '@aws-sdk/client-sns';
import { SQSClient } from '@aws-sdk/client-sqs';

import { createLogger, createMetrics } from '@family/observability';

import {
  createDocumentClient,
  DynamoCurrentLocationStore,
  DynamoDeviceStore,
  DynamoHistoryStore,
  DynamoInvitationStore,
  DynamoLiveSessionStore,
  SnsPushEndpointRegistry,
  SqsQueueDepthReader,
  DynamoDeletionJobStore,
  SqsDeletionDispatcher,
} from './dynamo.js';
import { loadConfig } from './env.js';
import { isJobName, JOB_NAMES, queueNameFromUrl, type JobName } from './jobs.js';
import type { MaintenanceMetrics } from './ports.js';
import {
  allJobs,
  createRateLimiter,
  runJobs,
  type MaintenanceRunResult,
  type RunnerDeps,
} from './runner.js';

/**
 * services/scheduled-maintenance — the housekeeping EventBridge runs on a timer.
 *
 * Each job is independently invocable (`{"job":"expire-invitations"}`) and
 * idempotent, so a retry, an overlapping schedule or a manual run converge
 * rather than corrupt. Every job is bounded and reports what it left behind
 * instead of holding the Lambda open trying to drain a backlog.
 *
 * The handler is thin: it resolves which jobs to run, builds the dependency
 * graph and delegates. Every decision worth testing lives in `jobs.js`, and
 * every piece of orchestration worth testing lives in `runner.js`.
 */

const config = loadConfig();

const logger = createLogger({
  service: config.serviceName,
  env: config.appEnv,
  bindings: { component: 'scheduled-maintenance' },
});

const metrics = createMetrics({
  namespace: config.metricsNamespace,
  dimensions: { service: config.serviceName, env: config.appEnv },
});

const documents = createDocumentClient(new DynamoDBClient({}));
const sns = new SNSClient({});
const sqs = new SQSClient({});

/**
 * Every metric here is a count or an age keyed by an enum or a queue name.
 * Nothing accepts a user id or a position, so this service structurally cannot
 * emit a per-person dimension (spec §20).
 */
const metricsSink: MaintenanceMetrics = {
  freshness(band, count) {
    metrics.count('CurrentLocationFreshness', count, { band });
  },
  queueDepth(depth) {
    const queue = queueNameFromUrl(depth.queueUrl);
    metrics.count('QueueDepthVisible', depth.visible, { queue });
    metrics.count('QueueDepthInFlight', depth.inFlight, { queue });
    metrics.count('QueueDepthDelayed', depth.delayed, { queue });
  },
  jobCompleted(job, outcome) {
    metrics.count('MaintenanceJobChanged', outcome.changed, { job });
    metrics.duration('MaintenanceJobDuration', outcome.durationMs, { job });
  },
  jobFailed(job) {
    metrics.count('MaintenanceJobFailed', 1, { job });
  },
  backlog(job, remaining) {
    metrics.count('MaintenanceJobBacklog', remaining, { job });
  },
};

export type MaintenanceEvent = {
  readonly job?: string;
  /** Report what would change without writing. */
  readonly dryRun?: boolean;
  /** EventBridge Scheduler delivers a configured input under `detail`. */
  readonly detail?: { readonly job?: string; readonly dryRun?: boolean };
};

function buildDeps(dryRun: boolean): RunnerDeps {
  return {
    liveSessions: new DynamoLiveSessionStore(documents, config.liveSessionsTable),
    invitations: new DynamoInvitationStore(documents, config.invitationsTable),
    currentLocations: new DynamoCurrentLocationStore(documents, config.currentLocationsTable),
    history: new DynamoHistoryStore(documents, config.locationHistoryTable),
    devices: new DynamoDeviceStore(documents, config.devicesTable),
    deletionJobs: new DynamoDeletionJobStore(documents, config.deletionJobsTable),
    deletions: new SqsDeletionDispatcher(sqs, config.deletionQueueUrl),
    pushEndpoints: new SnsPushEndpointRegistry(sns),
    queues: new SqsQueueDepthReader(sqs),
    metrics: metricsSink,
    rateLimiter: createRateLimiter({ ratePerSecond: config.maxWritesPerSecond }),
    config: {
      maxItemsPerJob: config.maxItemsPerJob,
      historyRetentionDays: config.historyRetentionDays,
      monitoredQueueUrls: config.monitoredQueueUrls,
      platformApplicationArns: config.platformApplicationArns,
    },
    now: () => new Date(),
    dryRun,
  };
}

export async function handler(event: MaintenanceEvent = {}): Promise<MaintenanceRunResult> {
  const requested = event.job ?? event.detail?.job;
  const dryRun = (event.dryRun ?? event.detail?.dryRun) === true;

  if (requested !== undefined && !isJobName(requested)) {
    // Fail loudly. A typo in a schedule rule would otherwise look like a
    // successful run that quietly did nothing, for as long as nobody noticed.
    throw new Error(
      `Unknown maintenance job "${requested}". Expected one of: ${JOB_NAMES.join(', ')}`,
    );
  }

  const jobs: readonly JobName[] = requested === undefined ? allJobs() : [requested];
  const result = await runJobs(jobs, buildDeps(dryRun));

  logger.info('Maintenance run complete.', {
    // Counts and job names only; nothing about whose rows were touched.
    jobCount: jobs.length,
    changed: result.changed,
    failed: result.failed,
    hasBacklog: result.hasBacklog,
    dryRun,
  });

  for (const outcome of result.outcomes) {
    if (outcome.error !== undefined) {
      logger.error('Maintenance job failed.', { job: outcome.job, errorName: outcome.error });
    }
  }

  return result;
}
