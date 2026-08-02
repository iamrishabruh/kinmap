import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  BatchGetCommand,
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';

import { AuditActionSchema, type FamilyId, type UserId } from '@family/contracts';

import type { AuditQueryPlan, CursorKey } from './dashboard.js';
import type { AuditRecord } from './records.js';

/** DynamoDB bindings for the audit trail. */

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

export interface AuditWriter {
  /** Idempotent on `(targetUserId, sk)`; a redelivered command writes one row. */
  write(record: AuditRecord): Promise<void>;
}

export interface AuditReader {
  query(
    plan: AuditQueryPlan,
  ): Promise<{ records: AuditRecord[]; lastEvaluatedKey: CursorKey | null }>;
  resolveDisplayNames(userIds: readonly string[]): Promise<Map<string, string | null>>;
}

export class DynamoAuditWriter implements AuditWriter {
  constructor(
    private readonly documents: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async write(record: AuditRecord): Promise<void> {
    await this.documents
      .send(
        new PutCommand({
          TableName: this.tableName,
          Item: { ...record },
          // Writing the same audit id twice is a redelivery, not a new read.
          ConditionExpression: 'attribute_not_exists(sk)',
        }),
      )
      .catch((error: unknown) => {
        if (error instanceof Error && error.name === 'ConditionalCheckFailedException') return;
        throw error;
      });
  }
}

export class DynamoAuditReader implements AuditReader {
  constructor(
    private readonly documents: DynamoDBDocumentClient,
    private readonly tables: { auditEvents: string; users: string },
  ) {}

  async query(
    plan: AuditQueryPlan,
  ): Promise<{ records: AuditRecord[]; lastEvaluatedKey: CursorKey | null }> {
    const names: Record<string, string> = { '#targetUserId': 'targetUserId' };
    const values: Record<string, unknown> = { ':targetUserId': plan.partitionKey };
    let keyCondition = '#targetUserId = :targetUserId';

    if (plan.skFrom !== null && plan.skTo !== null) {
      names['#sk'] = 'sk';
      values[':skFrom'] = plan.skFrom;
      values[':skTo'] = plan.skTo;
      keyCondition += ' AND #sk BETWEEN :skFrom AND :skTo';
    } else if (plan.skFrom !== null) {
      names['#sk'] = 'sk';
      values[':skFrom'] = plan.skFrom;
      keyCondition += ' AND #sk >= :skFrom';
    } else if (plan.skTo !== null) {
      names['#sk'] = 'sk';
      values[':skTo'] = plan.skTo;
      keyCondition += ' AND #sk <= :skTo';
    }

    let filterExpression: string | undefined;
    if (plan.action !== null) {
      names['#action'] = 'action';
      values[':action'] = plan.action;
      filterExpression = '#action = :action';
    }

    const response = await this.documents.send(
      new QueryCommand({
        TableName: this.tables.auditEvents,
        KeyConditionExpression: keyCondition,
        FilterExpression: filterExpression,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        Limit: plan.limit,
        ScanIndexForward: plan.scanForward,
        ExclusiveStartKey: plan.exclusiveStartKey as Attributes | undefined,
      }),
    );

    const records: AuditRecord[] = [];
    for (const raw of response.Items ?? []) {
      const record = toAuditRecord(raw as Attributes);
      if (record !== null) records.push(record);
    }

    const last = response.LastEvaluatedKey as Attributes | undefined;
    const lastEvaluatedKey =
      last === undefined
        ? null
        : {
            targetUserId: String(last.targetUserId ?? plan.partitionKey),
            sk: String(last.sk ?? ''),
          };

    return { records, lastEvaluatedKey };
  }

  async resolveDisplayNames(userIds: readonly string[]): Promise<Map<string, string | null>> {
    const resolved = new Map<string, string | null>();
    if (userIds.length === 0) return resolved;

    for (let offset = 0; offset < userIds.length; offset += 100) {
      const slice = userIds.slice(offset, offset + 100);
      const response = await this.documents.send(
        new BatchGetCommand({
          RequestItems: {
            [this.tables.users]: {
              Keys: slice.map((userId) => ({ userId })),
              // Only the display name: this lookup must not become a way to
              // read the rest of a profile.
              ProjectionExpression: '#userId, #displayName',
              ExpressionAttributeNames: { '#userId': 'userId', '#displayName': 'displayName' },
            },
          },
        }),
      );

      for (const raw of response.Responses?.[this.tables.users] ?? []) {
        const item = raw as Attributes;
        const userId = readString(item, 'userId');
        if (userId === null) continue;
        resolved.set(userId, readString(item, 'displayName'));
      }
    }

    for (const userId of userIds) {
      if (!resolved.has(userId)) resolved.set(userId, null);
    }
    return resolved;
  }
}

function toAuditRecord(item: Attributes): AuditRecord | null {
  const targetUserId = readString(item, 'targetUserId');
  const sk = readString(item, 'sk');
  const auditId = readString(item, 'auditId');
  const actorUserId = readString(item, 'actorUserId');
  const action = AuditActionSchema.safeParse(item.action);
  const occurredAt = readString(item, 'occurredAt');

  if (
    targetUserId === null ||
    sk === null ||
    auditId === null ||
    actorUserId === null ||
    occurredAt === null ||
    !action.success
  ) {
    return null;
  }

  const metadata =
    item.metadata !== null && typeof item.metadata === 'object' && !Array.isArray(item.metadata)
      ? (item.metadata as Record<string, string | number | boolean>)
      : {};

  return {
    targetUserId,
    sk,
    auditId,
    action: action.data,
    actorUserId: actorUserId as UserId,
    subjectUserId: readString(item, 'subjectUserId') as UserId | null,
    familyId: readString(item, 'familyId') as FamilyId | null,
    metadata,
    coarseArea: readString(item, 'coarseArea'),
    occurredAt,
    requestId: readString(item, 'requestId') ?? '',
    sourceIpHash: readString(item, 'sourceIpHash'),
    expiresAt: typeof item.expiresAt === 'number' ? item.expiresAt : 0,
  };
}
