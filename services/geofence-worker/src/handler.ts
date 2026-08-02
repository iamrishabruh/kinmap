import { randomUUID } from 'node:crypto';

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SendMessageBatchCommand, SQSClient } from '@aws-sdk/client-sqs';

import { AwsKmsDataKeyProvider, EncryptionService } from '@family/crypto';
import { createLogger, createMetrics } from '@family/observability';

import {
  createDocumentClient,
  DynamoGeofenceStateStore,
  DynamoMembershipReader,
  DynamoSavedPlaceReader,
} from './dynamo.js';
import { loadConfig } from './env.js';
import type { GeofenceFix } from './geofence.js';
import type { SqsBatchResponse, SqsEvent, SqsRecord } from './lambda-types.js';
import { parseAcceptedLocationEvent, type GeofenceNotificationCommand } from './messages.js';
import { processAcceptedLocation, type ProcessDeps } from './process.js';

/**
 * services/geofence-worker — SQS consumer for accepted-location events.
 *
 * Thin by design: parse, decrypt, delegate to `process.js`, publish, report
 * per-message failures. Every decision worth testing lives in `geofence.js`.
 *
 * PRIVACY: the decrypted coordinate exists only inside `toFix` and the pure
 * evaluator. It is never logged, never traced, never put in a metric dimension
 * and never placed in an outbound message.
 */

const config = loadConfig();

const logger = createLogger({
  service: config.serviceName,
  env: config.appEnv,
  bindings: { component: 'geofence-worker' },
});

const metrics = createMetrics({
  namespace: config.metricsNamespace,
  dimensions: { service: config.serviceName, env: config.appEnv },
});

const dynamoClient = new DynamoDBClient({});
const documents = createDocumentClient(dynamoClient);
const sqs = new SQSClient({});

const encryption = new EncryptionService({
  keyProvider: new AwsKmsDataKeyProvider({ keyId: config.coordinateKeyId }),
});

const deps: ProcessDeps = {
  memberships: new DynamoMembershipReader(documents, config.familyMembershipsTable),
  places: new DynamoSavedPlaceReader(documents, config.savedPlacesTable),
  state: new DynamoGeofenceStateStore(documents, config.geofenceStateTable, config.stateTtlDays),
  tuning: {
    hysteresisRatio: 0.15,
    minHysteresisMeters: 20,
    maxHysteresisMeters: 200,
    arrivalDwellSeconds: config.arrivalDwellSeconds,
    departureDwellSeconds: config.departureDwellSeconds,
    maxAccuracyMeters: 500,
  },
  newCommandId: () => randomUUID(),
};

/** SQS batch size is 10 and the SQS batch-send API caps at 10, so one call. */
const MAX_SEND_BATCH = 10;

export async function handler(event: SqsEvent): Promise<SqsBatchResponse> {
  const batchItemFailures: Array<{ itemIdentifier: string }> = [];
  const commands: GeofenceNotificationCommand[] = [];

  for (const record of event.Records) {
    try {
      const produced = await handleRecord(record);
      commands.push(...produced);
    } catch (error) {
      // One poisoned message must not replay the other nine: a replayed arrival
      // is a duplicate push to an entire family.
      batchItemFailures.push({ itemIdentifier: record.messageId });
      metrics.count('GeofenceEventFailed');
      logger.error('Geofence evaluation failed for a message.', {
        messageId: record.messageId,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
    }
  }

  if (commands.length > 0) {
    try {
      await publishCommands(commands);
    } catch (error) {
      // The state writes already committed, so replaying the whole batch would
      // re-evaluate every fence as a duplicate and emit nothing. Losing the
      // command is the lesser failure; it is counted and alarmed on.
      metrics.count('GeofenceEventFailed', commands.length);
      logger.error('Failed to publish geofence notification commands.', {
        commandCount: commands.length,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
    }
  }

  return { batchItemFailures };
}

async function handleRecord(record: SqsRecord): Promise<GeofenceNotificationCommand[]> {
  const event = parseAcceptedLocationEvent(JSON.parse(record.body) as unknown);
  const fix = await toFix(event);

  const result = await processAcceptedLocation(fix, deps);

  metrics.count('GeofenceEventProcessed');
  logger.info('Evaluated an accepted location against saved places.', {
    // Ids and counts only. The subject's position is not derivable from any of
    // these, which is what makes the line safe to keep for 90 days.
    userId: fix.userId,
    eventId: fix.eventId,
    familyCount: result.evaluatedFamilies,
    placeCount: result.evaluatedPlaces,
    transitionCount: result.commands.length,
  });

  return result.commands;
}

async function toFix(event: ReturnType<typeof parseAcceptedLocationEvent>): Promise<GeofenceFix> {
  const point = await encryption.decryptCoordinates(event.encryptedCoordinate, event.keyContext);
  return {
    eventId: event.eventId,
    userId: event.userId,
    latitude: point.lat,
    longitude: point.lng,
    horizontalAccuracy: event.horizontalAccuracy,
    capturedAt: event.capturedAt,
  };
}

async function publishCommands(commands: readonly GeofenceNotificationCommand[]): Promise<void> {
  for (let offset = 0; offset < commands.length; offset += MAX_SEND_BATCH) {
    const slice = commands.slice(offset, offset + MAX_SEND_BATCH);
    await sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: config.notificationCommandsQueueUrl,
        Entries: slice.map((command) => ({
          Id: command.commandId,
          MessageBody: JSON.stringify(command),
        })),
      }),
    );
  }
}
