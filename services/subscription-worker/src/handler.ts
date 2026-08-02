import { randomUUID } from 'node:crypto';

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { SendMessageBatchCommand, SQSClient } from '@aws-sdk/client-sqs';

import type { UserId } from '@family/contracts';
import { createLogger, createMetrics } from '@family/observability';

import {
  createDocumentClient,
  DynamoIdempotencyStore,
  DynamoInventoryReader,
  DynamoReadOnlyMarker,
  DynamoSubscriptionStore,
} from './dynamo.js';
import { loadConfig } from './env.js';
import { parseSubscriptionEvent, type SubscriptionEvent } from './events.js';
import {
  isHttpEvent,
  isScheduledEvent,
  isSqsEvent,
  type HttpEvent,
  type HttpResponse,
  type SqsBatchResponse,
  type SqsEvent,
  type WorkerEvent,
} from './lambda-types.js';
import {
  normalizeAppleNotification,
  normalizeGoogleNotification,
  normalizeRevenueCatWebhook,
} from './normalize.js';
import type { NotificationCommandPublisher, SubscriptionEventPublisher } from './ports.js';
import { SecretCache } from './secrets.js';
import {
  applySubscriptionEventToStore,
  ingestSubscriptionEvent,
  reconcileUserEntitlements,
  type ApplyDeps,
} from './service.js';
import { verifyAppleSignedPayload } from './verify/apple.js';
import {
  createGooglePubSubVerifier,
  decodeRtdnMessage,
  verifyGoogleRtdn,
  type OidcTokenVerifier,
} from './verify/google.js';
import { verifyRevenueCatWebhook } from './verify/revenuecat.js';

/**
 * services/subscription-worker — three invocation shapes, one entry point.
 *
 *  - HTTP: a provider webhook. Verified, normalised, deduplicated, queued. The
 *    response is ALWAYS a 200 acknowledgement with the same body, exactly as
 *    the schema contract requires: a provider must not retry because of our
 *    downstream problems, and the response must not be usable to probe whether
 *    an account exists.
 *  - SQS: a queued event, applied to the stored record.
 *  - Scheduled: the periodic entitlement reconciliation sweep.
 */

const config = loadConfig();

const logger = createLogger({
  service: config.serviceName,
  env: config.appEnv,
  bindings: { component: 'subscription-worker' },
});

const metrics = createMetrics({
  namespace: config.metricsNamespace,
  dimensions: { service: config.serviceName, env: config.appEnv },
});

const documents = createDocumentClient(new DynamoDBClient({}));
const sqs = new SQSClient({});
const secrets = new SecretCache(new SecretsManagerClient({}));

const eventPublisher: SubscriptionEventPublisher = {
  async publish(events) {
    if (events.length === 0) return;
    await sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: config.subscriptionEventsQueueUrl,
        Entries: events.map((event, index) => ({
          Id: `${String(index)}-${event.eventId}`.slice(0, 80),
          MessageBody: JSON.stringify(event),
        })),
      }),
    );
  },
};

const notificationPublisher: NotificationCommandPublisher = {
  async publish(commands) {
    if (commands.length === 0) return;
    await sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: config.notificationCommandsQueueUrl,
        Entries: commands.map((command, index) => ({
          Id: `notice-${String(index)}-${randomUUID()}`.slice(0, 80),
          MessageBody: JSON.stringify(command),
        })),
      }),
    );
  },
};

const idempotency = new DynamoIdempotencyStore(documents, config.idempotencyTable);

const applyDeps: ApplyDeps = {
  subscriptions: new DynamoSubscriptionStore(documents, config.subscriptionsTable),
  inventory: new DynamoInventoryReader(documents, {
    memberships: config.familyMembershipsTable,
    savedPlaces: config.savedPlacesTable,
  }),
  readOnly: new DynamoReadOnlyMarker(documents, {
    memberships: config.familyMembershipsTable,
    savedPlaces: config.savedPlacesTable,
  }),
  notifications: notificationPublisher,
  newCommandId: () => randomUUID(),
  now: () => new Date(),
};

let googleVerifier: OidcTokenVerifier | undefined;
if (config.googlePubSubAudience !== undefined) {
  googleVerifier = createGooglePubSubVerifier(config.googlePubSubAudience);
}

/** Providers always get the same acknowledgement, whatever happened here. */
const ACK: HttpResponse = {
  statusCode: 200,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ received: true }),
};

export async function handler(
  event: WorkerEvent,
): Promise<HttpResponse | SqsBatchResponse | { reconciled: number }> {
  if (isHttpEvent(event)) return await handleWebhook(event);
  if (isSqsEvent(event)) return await handleQueue(event);
  if (isScheduledEvent(event)) return await handleScheduled(event.task, event.userId);
  return ACK;
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

function headerOf(event: HttpEvent, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(event.headers)) {
    if (key.toLowerCase() === lower && value !== undefined) return value;
  }
  return undefined;
}

function rawBody(event: HttpEvent): string {
  const body = event.body ?? '';
  return event.isBase64Encoded === true ? Buffer.from(body, 'base64').toString('utf8') : body;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function handleWebhook(event: HttpEvent): Promise<HttpResponse> {
  const path = event.rawPath.toLowerCase();
  const body = parseJsonObject(rawBody(event));
  const context = { productPlanMap: config.productPlanMap, now: () => new Date() };

  // Every branch below either assigns this or returns, so an initialiser here
  // would only mask a future branch that forgot to.
  let normalized: SubscriptionEvent | null;
  let provider = 'unknown';

  try {
    if (path.endsWith('/revenuecat')) {
      provider = 'revenuecat';
      const secret = await secrets.getField(config.revenueCatSecretArn, 'webhookSecret');
      const verification = verifyRevenueCatWebhook({
        authorizationHeader: headerOf(event, 'authorization'),
        expectedSecret: secret,
      });
      if (!verification.verified) return reject(provider, verification.reason);
      normalized = body === null ? null : normalizeRevenueCatWebhook(body, context);
    } else if (path.endsWith('/apple')) {
      provider = 'apple';
      const signedPayload = typeof body?.signedPayload === 'string' ? body.signedPayload : null;
      if (signedPayload === null) return reject(provider, 'MALFORMED_JWS');

      const roots = await appleRootCertificates();
      const verification = verifyAppleSignedPayload(signedPayload, {
        rootCertificates: roots,
        expectedBundleId: config.appleBundleId,
      });
      if (!verification.verified) return reject(provider, verification.reason);
      normalized = normalizeAppleNotification(verification.payload, context);
    } else if (path.endsWith('/google')) {
      provider = 'google';
      const verification = await verifyGoogleRtdn({
        authorizationHeader: headerOf(event, 'authorization'),
        verifier: googleVerifier,
        expectedServiceAccountEmail: config.googlePubSubServiceAccountEmail,
      });
      if (!verification.verified) return reject(provider, verification.reason);

      const message = body === null ? null : (body.message as Record<string, unknown> | undefined);
      const data = typeof message?.data === 'string' ? message.data : null;
      const messageId = typeof message?.messageId === 'string' ? message.messageId : null;
      if (data === null || messageId === null) return reject(provider, 'MALFORMED_ENVELOPE');

      const decoded = decodeRtdnMessage(data);
      normalized =
        decoded === null ? null : normalizeGoogleNotification(decoded, context, messageId);
    } else {
      return reject(provider, 'UNKNOWN_PROVIDER');
    }
  } catch (error) {
    metrics.count('SubscriptionWebhookFailed', 1, { provider });
    logger.error('Webhook verification raised.', {
      provider,
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
    return ACK;
  }

  if (normalized === null) {
    return reject(provider, 'UNPARSEABLE_BODY');
  }

  const result = await ingestSubscriptionEvent(normalized, {
    idempotency,
    events: eventPublisher,
    idempotencyTtlSeconds: config.idempotencyTtlSeconds,
  });

  logger.info('Accepted a subscription webhook.', {
    provider,
    eventType: normalized.type,
    result,
  });
  return ACK;
}

/** A rejection is counted and logged, then acknowledged like everything else. */
function reject(provider: string, reason: string): HttpResponse {
  metrics.count('SubscriptionWebhookFailed', 1, { provider, reason });
  logger.warn('Rejected a subscription webhook.', { provider, reason });
  return ACK;
}

let cachedAppleRoots: Buffer[] | null = null;

/**
 * Apple Root CA certificates, in DER, from the configured secret as a JSON
 * array of base64 strings. Empty means Apple webhooks are refused outright,
 * which is the correct failure mode for a missing trust anchor.
 */
async function appleRootCertificates(): Promise<Buffer[]> {
  if (cachedAppleRoots !== null) return cachedAppleRoots;
  const raw = await secrets.getField(config.appleSecretArn, 'rootCertificates');
  if (raw === undefined) {
    cachedAppleRoots = [];
    return cachedAppleRoots;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    cachedAppleRoots = Array.isArray(parsed)
      ? parsed
          .filter((entry): entry is string => typeof entry === 'string')
          .map((entry) => Buffer.from(entry, 'base64'))
      : [];
  } catch {
    cachedAppleRoots = [];
  }
  return cachedAppleRoots;
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

async function handleQueue(event: SqsEvent): Promise<SqsBatchResponse> {
  const batchItemFailures: Array<{ itemIdentifier: string }> = [];

  for (const record of event.Records) {
    try {
      const parsed = parseSubscriptionEvent(JSON.parse(record.body) as unknown);
      const report = await applySubscriptionEventToStore(parsed, applyDeps);
      logger.info('Applied a subscription event.', {
        provider: parsed.provider,
        eventType: parsed.type,
        applied: report.applied,
        reason: report.reason,
        tierBefore: report.tierBefore,
        tierAfter: report.tierAfter,
        markedReadOnly:
          (report.readOnlyPlan?.placesToMarkReadOnly.length ?? 0) +
          (report.readOnlyPlan?.membersToMarkReadOnly.length ?? 0),
      });
    } catch (error) {
      batchItemFailures.push({ itemIdentifier: record.messageId });
      metrics.count('SubscriptionWebhookFailed', 1, { stage: 'apply' });
      logger.error('Failed to apply a subscription event.', {
        messageId: record.messageId,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
    }
  }

  return { batchItemFailures };
}

// ---------------------------------------------------------------------------
// Scheduled reconciliation
// ---------------------------------------------------------------------------

async function handleScheduled(task: string, userId?: string): Promise<{ reconciled: number }> {
  if (task !== config.reconciliationTaskName) {
    logger.warn('Ignoring an unrecognised scheduled task.', { task });
    return { reconciled: 0 };
  }

  if (userId !== undefined) {
    const report = await reconcileUserEntitlements(userId as UserId, applyDeps);
    return { reconciled: report.applied ? 1 : 0 };
  }

  // A full sweep is driven from the subscriptions table by the maintenance
  // service, which owns paged scanning; this entry point reconciles on demand.
  logger.info('Entitlement reconciliation requested without a target account.', { task });
  return { reconciled: 0 };
}
