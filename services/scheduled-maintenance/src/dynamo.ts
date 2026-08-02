import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DeleteEndpointCommand,
  ListEndpointsByPlatformApplicationCommand,
  type SNSClient,
} from '@aws-sdk/client-sns';
import { GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

import { TrackingStateSchema, type DeviceId, type FamilyId, type UserId } from '@family/contracts';

import type {
  CurrentLocationRow,
  DeviceEndpointRef,
  HistoryKey,
  HistoryRow,
  InvitationRow,
  LiveSessionRow,
  PushEndpointSummary,
  QueueDepth,
} from './jobs.js';
import { queueNameFromUrl } from './jobs.js';
import type {
  CurrentLocationStore,
  DeviceStore,
  HistoryStore,
  InvitationStore,
  LiveSessionStore,
  Page,
  PushEndpointRegistry,
  QueueDepthReader,
  ScanInput,
} from './ports.js';

/** AWS bindings for the maintenance jobs. */

export function createDocumentClient(client?: DynamoDBClient): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(client ?? new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true, convertClassInstanceToMap: false },
  });
}

type Attributes = Record<string, unknown>;

function readString(item: Attributes, key: string): string | null {
  const value = item[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readNumber(item: Attributes, key: string): number | null {
  const value = item[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** TTL and deadline attributes appear as either an epoch number or an ISO string. */
function readInstant(item: Attributes, key: string): string | number | null {
  const value = item[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function cursorOf(lastEvaluatedKey: Attributes | undefined): Attributes | null {
  return lastEvaluatedKey === undefined ? null : lastEvaluatedKey;
}

function isConditionalCheckFailure(error: unknown): boolean {
  return error instanceof Error && error.name === 'ConditionalCheckFailedException';
}

// ---------------------------------------------------------------------------
// Live sessions
// ---------------------------------------------------------------------------

export class DynamoLiveSessionStore implements LiveSessionStore {
  constructor(
    private readonly documents: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async scanOpen(input: ScanInput): Promise<Page<LiveSessionRow>> {
    const response = await this.documents.send(
      new ScanCommand({
        TableName: this.tableName,
        Limit: input.limit,
        ExclusiveStartKey: input.cursor ?? undefined,
        // Filtering server-side keeps closed sessions off the wire entirely.
        FilterExpression: '#status IN (:requested, :active)',
        // Only what the planner needs. The session row is not projected wholesale.
        ProjectionExpression: 'sessionId, targetUserId, #status, startedAt, expiresAt',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':requested': 'REQUESTED', ':active': 'ACTIVE' },
      }),
    );

    const items: LiveSessionRow[] = [];
    for (const raw of response.Items ?? []) {
      const item = raw as Attributes;
      const sessionId = readString(item, 'sessionId');
      const targetUserId = readString(item, 'targetUserId');
      const status = readString(item, 'status');
      if (sessionId === null || targetUserId === null || status === null) continue;

      items.push({
        sessionId,
        targetUserId: targetUserId as UserId,
        status,
        startedAt: readString(item, 'startedAt'),
        expiresAt: readInstant(item, 'expiresAt'),
      });
    }

    return { items, cursor: cursorOf(response.LastEvaluatedKey as Attributes | undefined) };
  }

  async expire(input: { sessionId: string; now: Date }): Promise<boolean> {
    try {
      await this.documents.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { sessionId: input.sessionId },
          UpdateExpression:
            'SET #status = :expired, endedAt = :now, endedReason = :reason, updatedAt = :now',
          // A session the user stopped or the target rejected in the meantime is
          // left exactly as they left it.
          ConditionExpression: '#status IN (:requested, :active)',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':expired': 'EXPIRED',
            ':requested': 'REQUESTED',
            ':active': 'ACTIVE',
            ':reason': 'EXPIRED',
            ':now': input.now.toISOString(),
          },
        }),
      );
      return true;
    } catch (error) {
      if (isConditionalCheckFailure(error)) return false;
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

export class DynamoInvitationStore implements InvitationStore {
  constructor(
    private readonly documents: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async scanOpen(input: ScanInput): Promise<Page<InvitationRow>> {
    const response = await this.documents.send(
      new ScanCommand({
        TableName: this.tableName,
        Limit: input.limit,
        ExclusiveStartKey: input.cursor ?? undefined,
        FilterExpression: '#status = :pending',
        // The raw token is never stored and never projected; only its hash.
        ProjectionExpression: 'tokenHash, familyId, #status, createdAt, expiresAt',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':pending': 'PENDING' },
      }),
    );

    const items: InvitationRow[] = [];
    for (const raw of response.Items ?? []) {
      const item = raw as Attributes;
      const tokenHash = readString(item, 'tokenHash');
      const familyId = readString(item, 'familyId');
      const status = readString(item, 'status');
      if (tokenHash === null || familyId === null || status === null) continue;

      items.push({
        tokenHash,
        familyId: familyId as FamilyId,
        status,
        createdAt: readString(item, 'createdAt'),
        expiresAt: readInstant(item, 'expiresAt'),
      });
    }

    return { items, cursor: cursorOf(response.LastEvaluatedKey as Attributes | undefined) };
  }

  async expire(input: { tokenHash: string; now: Date }): Promise<boolean> {
    try {
      await this.documents.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { tokenHash: input.tokenHash },
          UpdateExpression: 'SET #status = :expired, updatedAt = :now',
          ConditionExpression: '#status = :pending',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':expired': 'EXPIRED',
            ':pending': 'PENDING',
            ':now': input.now.toISOString(),
          },
        }),
      );
      return true;
    } catch (error) {
      if (isConditionalCheckFailure(error)) return false;
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// Current locations
// ---------------------------------------------------------------------------

export class DynamoCurrentLocationStore implements CurrentLocationStore {
  constructor(
    private readonly documents: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async scan(input: ScanInput): Promise<Page<CurrentLocationRow>> {
    const response = await this.documents.send(
      new ScanCommand({
        TableName: this.tableName,
        Limit: input.limit,
        ExclusiveStartKey: input.cursor ?? undefined,
        // The sealed coordinate is deliberately NOT projected. This service has
        // no use for a position and must not be able to leak one.
        ProjectionExpression: 'userId, deviceId, capturedAt, trackingState',
      }),
    );

    const items: CurrentLocationRow[] = [];
    for (const raw of response.Items ?? []) {
      const item = raw as Attributes;
      const userId = readString(item, 'userId');
      const deviceId = readString(item, 'deviceId');
      const trackingState = TrackingStateSchema.safeParse(item.trackingState);
      if (userId === null || deviceId === null || !trackingState.success) continue;

      items.push({
        userId: userId as UserId,
        deviceId: deviceId as DeviceId,
        capturedAt: readString(item, 'capturedAt'),
        trackingState: trackingState.data,
      });
    }

    return { items, cursor: cursorOf(response.LastEvaluatedKey as Attributes | undefined) };
  }

  async markStale(input: {
    userId: UserId;
    deviceId: DeviceId;
    capturedAt: string | null;
    now: Date;
  }): Promise<boolean> {
    // Guarding on the exact capture time we judged means an upload that landed
    // between the scan and this write is never overwritten as stale.
    const guard =
      input.capturedAt === null ? 'attribute_not_exists(capturedAt)' : 'capturedAt = :capturedAt';

    const values: Record<string, unknown> = {
      ':stale': 'STALE',
      ':now': input.now.toISOString(),
    };
    if (input.capturedAt !== null) values[':capturedAt'] = input.capturedAt;

    try {
      await this.documents.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { userId: input.userId, deviceId: input.deviceId },
          UpdateExpression: 'SET trackingState = :stale, staleMarkedAt = :now',
          ConditionExpression: `${guard} AND trackingState <> :stale`,
          ExpressionAttributeValues: values,
        }),
      );
      return true;
    } catch (error) {
      if (isConditionalCheckFailure(error)) return false;
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// Location history
// ---------------------------------------------------------------------------

export class DynamoHistoryStore implements HistoryStore {
  constructor(
    private readonly documents: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async scan(input: ScanInput): Promise<Page<HistoryRow>> {
    const response = await this.documents.send(
      new ScanCommand({
        TableName: this.tableName,
        Limit: input.limit,
        ExclusiveStartKey: input.cursor ?? undefined,
        // Keys and TTL only — never the sealed point itself.
        ProjectionExpression: 'pk, sk, expiresAt',
      }),
    );

    const items: HistoryRow[] = [];
    for (const raw of response.Items ?? []) {
      const item = raw as Attributes;
      const pk = readString(item, 'pk');
      const sk = readString(item, 'sk');
      if (pk === null || sk === null) continue;
      items.push({ pk, sk, expiresAt: readNumber(item, 'expiresAt') });
    }

    return { items, cursor: cursorOf(response.LastEvaluatedKey as Attributes | undefined) };
  }

  async deleteRows(keys: readonly HistoryKey[]): Promise<number> {
    if (keys.length === 0) return 0;

    const response = await this.documents.send(
      new BatchWriteCommand({
        RequestItems: {
          [this.tableName]: keys.map((key) => ({
            DeleteRequest: { Key: { pk: key.pk, sk: key.sk } },
          })),
        },
      }),
    );

    const unprocessed = response.UnprocessedItems?.[this.tableName]?.length ?? 0;
    // Unprocessed rows are simply swept again on the next tick; the sweep is
    // idempotent, so retrying here would only lengthen the invocation.
    return keys.length - unprocessed;
  }
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

export class DynamoDeviceStore implements DeviceStore {
  constructor(
    private readonly documents: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async scan(input: ScanInput): Promise<Page<DeviceEndpointRef>> {
    const response = await this.documents.send(
      new ScanCommand({
        TableName: this.tableName,
        Limit: input.limit,
        ExclusiveStartKey: input.cursor ?? undefined,
        // No push token: the ARN is enough to reconcile, and a token is a
        // credential we have no reason to move around.
        ProjectionExpression: 'userId, deviceId, pushEndpointArn, #status, revokedAt',
        ExpressionAttributeNames: { '#status': 'status' },
      }),
    );

    const items: DeviceEndpointRef[] = [];
    for (const raw of response.Items ?? []) {
      const item = raw as Attributes;
      const userId = readString(item, 'userId');
      const deviceId = readString(item, 'deviceId');
      if (userId === null || deviceId === null) continue;

      items.push({
        userId: userId as UserId,
        deviceId: deviceId as DeviceId,
        pushEndpointArn: readString(item, 'pushEndpointArn'),
        status: readString(item, 'status') ?? 'ACTIVE',
        revokedAt: readString(item, 'revokedAt'),
      });
    }

    return { items, cursor: cursorOf(response.LastEvaluatedKey as Attributes | undefined) };
  }

  async clearPushEndpoint(input: { userId: UserId; deviceId: DeviceId }): Promise<boolean> {
    try {
      await this.documents.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { userId: input.userId, deviceId: input.deviceId },
          // The token goes with the ARN: a stale token is a credential for a
          // channel that no longer exists.
          UpdateExpression: 'REMOVE pushEndpointArn, pushToken',
          ConditionExpression: 'attribute_exists(pushEndpointArn)',
        }),
      );
      return true;
    } catch (error) {
      if (isConditionalCheckFailure(error)) return false;
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// SNS platform endpoints
// ---------------------------------------------------------------------------

export class SnsPushEndpointRegistry implements PushEndpointRegistry {
  constructor(private readonly sns: SNSClient) {}

  async listEndpoints(input: { platformApplicationArn: string }): Promise<PushEndpointSummary[]> {
    const summaries: PushEndpointSummary[] = [];
    let nextToken: string | undefined;

    do {
      const response = await this.sns.send(
        new ListEndpointsByPlatformApplicationCommand({
          PlatformApplicationArn: input.platformApplicationArn,
          NextToken: nextToken,
        }),
      );

      for (const endpoint of response.Endpoints ?? []) {
        const endpointArn = endpoint.EndpointArn;
        if (endpointArn === undefined || endpointArn.length === 0) continue;
        // SNS reports attributes as strings.
        summaries.push({
          endpointArn,
          enabled: (endpoint.Attributes?.Enabled ?? 'true').toLowerCase() !== 'false',
        });
      }

      nextToken = response.NextToken;
    } while (nextToken !== undefined && nextToken.length > 0);

    return summaries;
  }

  async deleteEndpoint(input: { endpointArn: string }): Promise<void> {
    try {
      await this.sns.send(new DeleteEndpointCommand({ EndpointArn: input.endpointArn }));
    } catch (error) {
      // An already-deleted endpoint is the desired end state.
      if (error instanceof Error && error.name === 'NotFoundException') return;
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// SQS queue depth
// ---------------------------------------------------------------------------

export class SqsQueueDepthReader implements QueueDepthReader {
  constructor(private readonly sqs: SQSClient) {}

  async read(queueUrl: string): Promise<QueueDepth | null> {
    try {
      const response = await this.sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl: queueUrl,
          AttributeNames: [
            'ApproximateNumberOfMessages',
            'ApproximateNumberOfMessagesNotVisible',
            'ApproximateNumberOfMessagesDelayed',
          ],
        }),
      );

      const attributes = response.Attributes ?? {};
      const toCount = (value: string | undefined): number => {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : 0;
      };

      return {
        queueUrl,
        visible: toCount(attributes.ApproximateNumberOfMessages),
        inFlight: toCount(attributes.ApproximateNumberOfMessagesNotVisible),
        delayed: toCount(attributes.ApproximateNumberOfMessagesDelayed),
      };
    } catch {
      // One unreadable queue must not fail the metrics job for the rest. The
      // name is safe to keep; the URL would carry the account id.
      void queueNameFromUrl(queueUrl);
      return null;
    }
  }
}
