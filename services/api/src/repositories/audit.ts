import { z } from 'zod';

import {
  AppError,
  AuditActionSchema,
  FamilyIdSchema,
  UserIdSchema,
  type AuditAction,
  type FamilyId,
  type UserId,
} from '@family/contracts';
import { IsoDateTimeSchema } from '@family/schemas';

import { type DocumentClient, type Item } from './document-client.js';
import { ttlAt } from './expressions.js';

/**
 * The audit trail (spec §18).
 *
 * The table is keyed by the person who was *looked at*, not by the person doing
 * the looking, because the question a user must be able to ask is "who accessed
 * my data?". `metadata` is restricted to scalars and is never allowed to carry a
 * coordinate — nothing in this service has one, and the type keeps it that way.
 *
 * The API is granted `PutItem` and read access only. There is deliberately no
 * update or delete path: the record of who looked at somebody is not editable
 * by the service that produces it.
 */

export const AuditMetadataSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean()]),
);
export type AuditMetadata = z.infer<typeof AuditMetadataSchema>;

export type AuditEventInput = {
  readonly action: AuditAction;
  readonly actorUserId: UserId;
  /** The person the action was about. Defaults to the actor for self-actions. */
  readonly targetUserId: UserId;
  readonly familyId: FamilyId | null;
  readonly metadata: AuditMetadata;
  readonly requestId: string;
  readonly sourceIpHash: string | null;
  readonly occurredAt: Date;
};

export const AuditRecordSchema = z.object({
  auditId: z.string().uuid(),
  action: AuditActionSchema,
  actorUserId: UserIdSchema,
  targetUserId: UserIdSchema,
  familyId: FamilyIdSchema.nullable().default(null),
  metadata: AuditMetadataSchema.default({}),
  occurredAt: IsoDateTimeSchema,
  requestId: z.string().min(1).max(128),
  sourceIpHash: z.string().min(1).max(128).nullable().default(null),
});
export type AuditRecord = z.infer<typeof AuditRecordSchema>;

export type AuditPage = {
  readonly entries: AuditRecord[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
};

export interface AuditRepository {
  record(input: AuditEventInput & { auditId: string }): Promise<void>;
  listForTarget(input: {
    targetUserId: UserId;
    from: string;
    to: string;
    action?: AuditAction;
    limit: number;
    cursor: string | null;
  }): Promise<AuditPage>;
}

/**
 * Audit sort keys are `<occurredAt>#<auditId>`, so they always begin with a
 * digit. Support records written to the same table use a `SUPPORT#` prefix,
 * which sorts above every timestamp and is therefore excluded by an
 * ISO-timestamp range query without needing a filter expression.
 */
export function auditSortKey(occurredAt: string, auditId: string): string {
  return `${occurredAt}#${auditId}`;
}

export function createAuditRepository(
  client: DocumentClient,
  tableName: string,
  retentionDays: number,
): AuditRepository {
  return {
    async record(input): Promise<void> {
      const occurredAt = input.occurredAt.toISOString();
      await client.put({
        TableName: tableName,
        Item: {
          targetUserId: input.targetUserId,
          sk: auditSortKey(occurredAt, input.auditId),
          auditId: input.auditId,
          action: input.action,
          actorUserId: input.actorUserId,
          // Left undefined rather than null so the sparse `byFamily` index only
          // contains rows that actually belong to a family.
          familyId: input.familyId ?? undefined,
          metadata: input.metadata,
          occurredAt,
          requestId: input.requestId,
          sourceIpHash: input.sourceIpHash,
          expiresAt: ttlAt(input.occurredAt, retentionDays * 24 * 60 * 60),
        },
      });
    },

    async listForTarget(input): Promise<AuditPage> {
      const values: Record<string, unknown> = {
        ':u': input.targetUserId,
        ':from': input.from,
        // U+FFFF closes the range over `<timestamp>#<auditId>` keys without
        // needing to know the id that follows the timestamp.
        ':to': `${input.to}#￿`,
      };
      const names: Record<string, string> = { '#u': 'targetUserId', '#sk': 'sk' };
      let filter: string | undefined;
      if (input.action !== undefined) {
        names['#action'] = 'action';
        values[':action'] = input.action;
        filter = '#action = :action';
      }

      const page = await client.query({
        TableName: tableName,
        KeyConditionExpression: '#u = :u AND #sk BETWEEN :from AND :to',
        FilterExpression: filter,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        Limit: input.limit,
        // Newest first: "who looked at me recently" is the only useful order.
        ScanIndexForward: false,
        ExclusiveStartKey: decodeCursor(input.cursor),
      });

      const entries = (page.Items ?? []).map(parseAudit);
      return {
        entries,
        nextCursor:
          page.LastEvaluatedKey === undefined ? null : encodeCursor(page.LastEvaluatedKey),
        hasMore: page.LastEvaluatedKey !== undefined,
      };
    },
  };
}

/**
 * Cursors are opaque to the client and are validated on the way back in: a
 * tampered cursor must not become a way to read another partition, so the
 * decoded key is re-checked against the caller's own id by the route.
 */
export function encodeCursor(key: Item): string {
  return Buffer.from(JSON.stringify(key), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | null): Item | undefined {
  if (cursor === null || cursor === '') {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new AppError('VALIDATION_FAILED', 'The pagination cursor is not valid.');
    }
    return parsed as Item;
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError('VALIDATION_FAILED', 'The pagination cursor is not valid.');
  }
}

function parseAudit(item: Item): AuditRecord {
  const parsed = AuditRecordSchema.safeParse(item);
  if (!parsed.success) {
    throw new AppError('INTERNAL_ERROR', 'An audit record could not be read.');
  }
  return parsed.data;
}
