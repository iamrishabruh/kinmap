import { DynamoDBClient } from '@aws-sdk/client-dynamodb';

import { AppError, UserIdSchema, type UserId } from '@family/contracts';
import { createLogger, createMetrics } from '@family/observability';
import { GetAuditLogQuerySchema } from '@family/schemas';

import { actorIdsToResolve, buildAuditLogResponse, planAuditQuery } from './dashboard.js';
import { createDocumentClient, DynamoAuditReader, DynamoAuditWriter } from './dynamo.js';
import { loadConfig } from './env.js';
import { buildAuditRecord, parseAuditCommand } from './records.js';

/**
 * services/audit-worker — two jobs, one Lambda.
 *
 *  - SQS: audit commands become AuditEvents rows with a TTL. The row is
 *    sanitised on the way in and never contains a coordinate.
 *  - HTTP: `GET /v1/privacy/audit` serves the caller their OWN trail. The
 *    partition key comes from the verified token, never from the request, so
 *    there is no parameter to tamper with.
 */

type SqsRecord = { readonly messageId: string; readonly body: string };
type SqsEvent = { readonly Records: readonly SqsRecord[] };
type SqsBatchResponse = { batchItemFailures: Array<{ itemIdentifier: string }> };

type HttpEvent = {
  readonly version: '2.0';
  readonly rawPath: string;
  readonly queryStringParameters?: Readonly<Record<string, string | undefined>>;
  readonly requestContext: {
    readonly requestId: string;
    readonly http: { readonly method: string; readonly path: string };
    readonly authorizer?: { readonly jwt?: { readonly claims?: Record<string, unknown> } };
  };
};

type HttpResponse = { statusCode: number; headers: Record<string, string>; body: string };

const config = loadConfig();

const logger = createLogger({
  service: config.serviceName,
  env: config.appEnv,
  bindings: { component: 'audit-worker' },
});

const metrics = createMetrics({
  namespace: config.metricsNamespace,
  dimensions: { service: config.serviceName, env: config.appEnv },
});

const documents = createDocumentClient(new DynamoDBClient({}));
const writer = new DynamoAuditWriter(documents, config.auditEventsTable);
const reader = new DynamoAuditReader(documents, {
  auditEvents: config.auditEventsTable,
  users: config.usersTable,
});

const JSON_HEADERS = { 'content-type': 'application/json' } as const;

export async function handler(
  event: SqsEvent | HttpEvent,
): Promise<SqsBatchResponse | HttpResponse> {
  if ('Records' in event) return await handleCommands(event);
  return await handleDashboard(event);
}

async function handleCommands(event: SqsEvent): Promise<SqsBatchResponse> {
  const batchItemFailures: Array<{ itemIdentifier: string }> = [];

  for (const record of event.Records) {
    try {
      const command = parseAuditCommand(JSON.parse(record.body) as unknown);
      await writer.write(
        buildAuditRecord({ command, retentionDays: config.retentionDays, now: new Date() }),
      );
      metrics.count('AuditEventWritten', 1, { action: command.action });
    } catch (error) {
      // A sensitive read that cannot be recorded must be retried, not dropped.
      batchItemFailures.push({ itemIdentifier: record.messageId });
      logger.error('Failed to write an audit event.', {
        messageId: record.messageId,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
    }
  }

  return { batchItemFailures };
}

async function handleDashboard(event: HttpEvent): Promise<HttpResponse> {
  const requestId = event.requestContext.requestId;
  const callerUserId = callerFrom(event);

  if (callerUserId === null) {
    return errorResponse(
      new AppError('UNAUTHENTICATED', 'Sign in to view your privacy log.'),
      requestId,
    );
  }

  const query = GetAuditLogQuerySchema.safeParse(event.queryStringParameters ?? {});
  if (!query.success) {
    return errorResponse(
      new AppError('VALIDATION_FAILED', 'The privacy log request is not valid.'),
      requestId,
    );
  }

  try {
    // The partition key is the caller. There is no "targetUserId" parameter to
    // supply, so this endpoint cannot be pointed at anyone else.
    const plan = planAuditQuery({ callerUserId, query: query.data });
    const { records, lastEvaluatedKey } = await reader.query(plan);
    const displayNames = await reader.resolveDisplayNames(actorIdsToResolve(records));

    const response = buildAuditLogResponse({ records, displayNames, lastEvaluatedKey });

    logger.info('Served a privacy audit page.', {
      requestId,
      entryCount: response.entries.length,
      hasMore: response.page.hasMore,
    });

    return { statusCode: 200, headers: { ...JSON_HEADERS }, body: JSON.stringify(response) };
  } catch (error) {
    logger.error('Privacy audit query failed.', {
      requestId,
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
    return errorResponse(
      new AppError('INTERNAL_ERROR', 'Unable to load your privacy log.'),
      requestId,
    );
  }
}

/** The verified token is the only source of the caller's identity. */
function callerFrom(event: HttpEvent): UserId | null {
  const claims = event.requestContext.authorizer?.jwt?.claims;
  const subject = claims?.sub;
  const parsed = UserIdSchema.safeParse(subject);
  return parsed.success ? parsed.data : null;
}

function errorResponse(error: AppError, requestId: string): HttpResponse {
  return {
    statusCode: error.status,
    headers: { ...JSON_HEADERS },
    body: JSON.stringify({
      error: { code: error.code, message: error.message, requestId },
    }),
  };
}
