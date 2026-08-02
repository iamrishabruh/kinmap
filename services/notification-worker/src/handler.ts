import { randomUUID } from 'node:crypto';

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SNSClient } from '@aws-sdk/client-sns';

import { createLogger, createMetrics } from '@family/observability';

import {
  createDocumentClient,
  DynamoDeduplicationStore,
  DynamoDeliveryRecorder,
  DynamoEventLoader,
  DynamoMembershipReader,
  DynamoPreferencesReader,
  DynamoRateLimiter,
  DynamoTokenRemover,
} from './dynamo.js';
import { loadConfig } from './env.js';
import type { SqsBatchResponse, SqsEvent, SqsRecord } from './lambda-types.js';
import { parseNotificationCommand } from './messages.js';
import { deliverNotification, type DeliveryOutcome, type PipelineDeps } from './pipeline.js';
import { CompositeEndpointRegistry, SnsEndpointDisabler, SnsPushSender } from './push/sns.js';

/**
 * services/notification-worker — SQS consumer for notification commands.
 *
 * The handler is plumbing. Every rule that matters — send-time re-authorisation,
 * quiet hours, deduplication, rate limiting, endpoint retirement — lives in
 * `pipeline.ts` and is unit-tested there.
 */

const config = loadConfig();

const logger = createLogger({
  service: config.serviceName,
  env: config.appEnv,
  bindings: { component: 'notification-worker' },
});

const metrics = createMetrics({
  namespace: config.metricsNamespace,
  dimensions: { service: config.serviceName, env: config.appEnv },
});

const documents = createDocumentClient(new DynamoDBClient({}));
const sns = new SNSClient({});

const tokenRemover = new DynamoTokenRemover(documents, config.devicesTable);

const deps: PipelineDeps = {
  events: new DynamoEventLoader(documents, {
    users: config.usersTable,
    savedPlaces: config.savedPlacesTable,
    liveSessions: config.liveSessionsTable,
  }),
  preferences: new DynamoPreferencesReader(documents, {
    preferences: config.notificationPreferencesTable,
    devices: config.devicesTable,
    users: config.usersTable,
  }),
  memberships: new DynamoMembershipReader(documents, config.familyMembershipsTable),
  deduplication: new DynamoDeduplicationStore(documents, config.idempotencyTable),
  rateLimiter: new DynamoRateLimiter(documents, config.idempotencyTable),
  sender: new SnsPushSender(
    sns,
    {
      apns: config.apnsPlatformApplicationArn,
      apnsSandbox: config.apnsSandboxPlatformApplicationArn,
      fcm: config.fcmPlatformApplicationArn,
    },
    config.appEnv !== 'production',
  ),
  endpoints: new CompositeEndpointRegistry(new SnsEndpointDisabler(sns), tokenRemover),
  recorder: new DynamoDeliveryRecorder(documents, config.idempotencyTable),
  deduplicationTtlSeconds: config.deduplicationTtlSeconds,
  rateLimitPerMinute: config.rateLimitPerMinute,
  newNotificationId: () => randomUUID(),
  now: () => new Date(),
};

export async function handler(event: SqsEvent): Promise<SqsBatchResponse> {
  const batchItemFailures: Array<{ itemIdentifier: string }> = [];

  for (const record of event.Records) {
    try {
      const outcomes = await handleRecord(record);
      if (outcomes.some((outcome) => outcome.retryable)) {
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    } catch (error) {
      batchItemFailures.push({ itemIdentifier: record.messageId });
      metrics.count('NotificationFailed');
      logger.error('Notification command could not be processed.', {
        messageId: record.messageId,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
    }
  }

  return { batchItemFailures };
}

async function handleRecord(record: SqsRecord): Promise<DeliveryOutcome[]> {
  const command = parseNotificationCommand(JSON.parse(record.body) as unknown);
  const outcomes = await deliverNotification(command, deps);

  for (const outcome of outcomes) {
    if (outcome.disposition === 'DELIVERED') {
      metrics.count('NotificationDelivered', 1, { kind: command.kind });
    } else if (outcome.retryable) {
      metrics.count('NotificationFailed', 1, { kind: command.kind });
    }
  }

  logger.info('Processed a notification command.', {
    // Counts and enums only: the log must not reveal who was told what.
    commandId: command.commandId,
    kind: command.kind,
    recipientCount: outcomes.length,
    deliveredCount: outcomes.filter((outcome) => outcome.disposition === 'DELIVERED').length,
    suppressedCount: outcomes.filter(
      (outcome) => outcome.disposition !== 'DELIVERED' && !outcome.retryable,
    ).length,
  });

  return outcomes;
}
