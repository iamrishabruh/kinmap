import {
  AdminDeleteUserCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteEndpointCommand, SNSClient } from '@aws-sdk/client-sns';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';

import type { UserId } from '@family/contracts';
import { createLogger, createMetrics } from '@family/observability';

import {
  createDocumentClient,
  DynamoDeletionJobStore,
  DynamoDeviceRepository,
  DynamoMembershipRepository,
  DynamoSharingRevoker,
  DynamoTombstoneWriter,
  DynamoUserDataDeleter,
  type DeletionTables,
} from './dynamo.js';
import { loadConfig } from './env.js';
import type { DeletionJob } from './job.js';
import type {
  DeletionMetricsSink,
  IdentityDeleter,
  JobRescheduler,
  PushEndpointRegistry,
} from './ports.js';
import { createRateLimiter, runDeletionJob, type RunnerDeps } from './runner.js';

/**
 * services/deletion-worker — resumes one deletion job per message.
 *
 * A message carries only `{ jobId }`. The job itself is the source of truth for
 * what has already been done, so a redelivery, a concurrent invocation or a
 * cold start all resume from the same checkpoint.
 */

type DeletionMessage = { readonly jobId: string };

type SqsRecord = { readonly messageId: string; readonly body: string };
type SqsEvent = { readonly Records: readonly SqsRecord[] };
type SqsBatchResponse = { batchItemFailures: Array<{ itemIdentifier: string }> };
type DirectEvent = { readonly jobId: string };

const config = loadConfig();

const logger = createLogger({
  service: config.serviceName,
  env: config.appEnv,
  bindings: { component: 'deletion-worker' },
});

const metrics = createMetrics({
  namespace: config.metricsNamespace,
  dimensions: { service: config.serviceName, env: config.appEnv },
});

const tables: DeletionTables = {
  deletionJobs: config.deletionJobsTable,
  users: config.usersTable,
  devices: config.devicesTable,
  families: config.familiesTable,
  familyMemberships: config.familyMembershipsTable,
  currentLocations: config.currentLocationsTable,
  locationHistory: config.locationHistoryTable,
  savedPlaces: config.savedPlacesTable,
  notificationPreferences: config.notificationPreferencesTable,
  liveSessions: config.liveSessionsTable,
  geofenceState: config.geofenceStateTable,
};

const documents = createDocumentClient(new DynamoDBClient({}));
const sns = new SNSClient({});
const sqs = new SQSClient({});
const cognito = new CognitoIdentityProviderClient({});

const jobs = new DynamoDeletionJobStore(documents, tables);

const pushEndpoints: PushEndpointRegistry = {
  async deleteEndpoint(input) {
    try {
      await sns.send(new DeleteEndpointCommand({ EndpointArn: input.endpointArn }));
    } catch {
      // SNS reports an already-deleted endpoint as success in most cases and as
      // NotFound otherwise; neither should stop a deletion from completing.
    }
  },
};

const rescheduler: JobRescheduler = {
  async reschedule(input) {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: config.deletionQueueUrl,
        MessageBody: JSON.stringify({ jobId: input.jobId } satisfies DeletionMessage),
        DelaySeconds: Math.min(900, Math.max(0, Math.trunc(input.delaySeconds))),
      }),
    );
  },
};

const metricsSink: DeletionMetricsSink = {
  recordJobAgeHours(hours) {
    metrics.putMetric({
      name: 'DeletionJobOldestAgeHours',
      value: hours,
      unit: 'None',
    });
  },
  recordRowsDeleted(step, rows) {
    if (rows > 0) metrics.count('DeletionRowsDeleted', rows, { step });
  },
};

function identityDeleter(userId: UserId): IdentityDeleter {
  return {
    async deleteUser() {
      try {
        await cognito.send(
          new AdminDeleteUserCommand({ UserPoolId: config.userPoolId, Username: userId }),
        );
      } catch (error) {
        // An already-deleted user is the desired end state, so a UserNotFound
        // is success. Anything else must fail the step and be retried.
        if (error instanceof Error && error.name === 'UserNotFoundException') return;
        throw error;
      }
    },
  };
}

function buildDeps(job: DeletionJob): RunnerDeps {
  return {
    jobs,
    sharing: new DynamoSharingRevoker(documents, tables),
    memberships: new DynamoMembershipRepository(documents, tables),
    devices: new DynamoDeviceRepository(documents, tables),
    pushEndpoints,
    data: new DynamoUserDataDeleter(documents, tables),
    identity: identityDeleter(job.userId),
    tombstones: new DynamoTombstoneWriter(documents, tables, job.userId),
    rescheduler,
    rateLimiter: createRateLimiter({ ratePerSecond: config.maxDeletesPerSecond }),
    metrics: metricsSink,
    tombstonePepper: config.tombstonePepper,
    historyLookbackDays: config.historyLookbackDays,
    maxHistoryDaysPerInvocation: config.maxHistoryDaysPerInvocation,
    rescheduleDelaySeconds: 5,
    now: () => new Date(),
  };
}

export async function handler(
  event: SqsEvent | DirectEvent,
): Promise<SqsBatchResponse | { status: string }> {
  if ('Records' in event) {
    const batchItemFailures: Array<{ itemIdentifier: string }> = [];
    for (const record of event.Records) {
      try {
        const message = JSON.parse(record.body) as Partial<DeletionMessage>;
        if (typeof message.jobId !== 'string') throw new Error('MalformedDeletionMessage');
        await processJob(message.jobId);
      } catch (error) {
        batchItemFailures.push({ itemIdentifier: record.messageId });
        logger.error('Deletion job message failed.', {
          messageId: record.messageId,
          errorName: error instanceof Error ? error.name : 'UnknownError',
        });
      }
    }
    return { batchItemFailures };
  }

  const result = await processJob(event.jobId);
  return { status: result };
}

async function processJob(jobId: string): Promise<string> {
  const job = await jobs.load({ jobId });
  if (job === null) {
    logger.warn('Deletion job not found; nothing to resume.', { jobId });
    return 'NOT_FOUND';
  }

  const result = await runDeletionJob(job, buildDeps(job));

  logger.info('Deletion job advanced.', {
    // Ids and step names only. Nothing about what was in the deleted rows.
    jobId,
    step: result.job.step,
    status: result.job.status,
    stepsExecuted: result.stepsExecuted.length,
    rescheduled: result.rescheduled,
  });

  return result.job.status;
}
