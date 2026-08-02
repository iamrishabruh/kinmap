import { z } from 'zod';

import { AppError, FamilyIdSchema, UserIdSchema, type UserId } from '@family/contracts';
import {
  IsoDateTimeSchema,
  SupportAccessScopeSchema,
  SupportDiagnosticsSchema,
  SupportTicketStatusSchema,
  SupportTopicSchema,
} from '@family/schemas';

import { type DocumentClient, type Item } from './document-client.js';

/**
 * Support, access-grant and abuse-report records.
 *
 * These share the AuditEvents table, partitioned by the user they belong to.
 * That is a deliberate reuse rather than a missing table: all three are
 * user-scoped, append-only records that the API may create and read but must
 * never rewrite, which is exactly the grant this function holds on that table
 * (`PutItem` plus read; no `UpdateItem`, no `DeleteItem`).
 *
 * Because nothing here can be updated in place, a revocation is *appended* as
 * its own record rather than mutating the grant. Sort keys are prefixed with
 * `SUPPORT#`, which sorts above every ISO-8601 timestamp and therefore never
 * appears in the audit-log range query.
 */

const SUPPORT_PREFIX = 'SUPPORT#';

export const SupportTicketRecordSchema = z.object({
  ticketId: z.string().uuid(),
  userId: UserIdSchema,
  topic: SupportTopicSchema,
  subject: z.string().min(1).max(120),
  body: z.string().min(1).max(4000),
  familyId: FamilyIdSchema.nullable().default(null),
  diagnostics: SupportDiagnosticsSchema.nullable().default(null),
  status: SupportTicketStatusSchema,
  priority: z.enum(['STANDARD', 'PRIORITY']),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type SupportTicketRecord = z.infer<typeof SupportTicketRecordSchema>;

export const SupportGrantRecordSchema = z.object({
  grantId: z.string().uuid(),
  ticketId: z.string().uuid(),
  userId: UserIdSchema,
  scopes: z.array(SupportAccessScopeSchema).min(1).max(4),
  grantedAt: IsoDateTimeSchema,
  expiresAt: IsoDateTimeSchema,
});
export type SupportGrantRecord = z.infer<typeof SupportGrantRecordSchema>;

export const AbuseReportRecordSchema = z.object({
  reportId: z.string().uuid(),
  reporterUserId: UserIdSchema,
  reportedUserId: UserIdSchema,
  familyId: FamilyIdSchema.nullable().default(null),
  category: z.string().min(1).max(40),
  description: z.string().min(1).max(4000),
  blocked: z.boolean(),
  leftFamily: z.boolean(),
  submittedAt: IsoDateTimeSchema,
});
export type AbuseReportRecord = z.infer<typeof AbuseReportRecordSchema>;

export interface SupportRepository {
  createTicket(record: SupportTicketRecord): Promise<void>;
  listTickets(userId: UserId): Promise<SupportTicketRecord[]>;
  createGrant(record: SupportGrantRecord): Promise<void>;
  getGrant(input: { userId: UserId; grantId: string }): Promise<SupportGrantRecord | null>;
  /** Appended, never an in-place edit; the grant record itself is immutable. */
  revokeGrant(input: { userId: UserId; grantId: string; revokedAt: Date }): Promise<void>;
  isGrantRevoked(input: { userId: UserId; grantId: string }): Promise<boolean>;
  createReport(record: AbuseReportRecord): Promise<void>;
}

export function createSupportRepository(
  client: DocumentClient,
  tableName: string,
): SupportRepository {
  const ticketKey = (record: SupportTicketRecord): string =>
    `${SUPPORT_PREFIX}TICKET#${record.createdAt}#${record.ticketId}`;
  const grantKey = (grantId: string): string => `${SUPPORT_PREFIX}GRANT#${grantId}`;
  const revocationKey = (grantId: string): string => `${SUPPORT_PREFIX}GRANTREVOKED#${grantId}`;

  return {
    async createTicket(record): Promise<void> {
      await client.put({
        TableName: tableName,
        Item: { targetUserId: record.userId, sk: ticketKey(record), ...record },
      });
    },

    async listTickets(userId): Promise<SupportTicketRecord[]> {
      const page = await client.query({
        TableName: tableName,
        KeyConditionExpression: '#u = :u AND begins_with(#sk, :prefix)',
        ExpressionAttributeNames: { '#u': 'targetUserId', '#sk': 'sk' },
        ExpressionAttributeValues: { ':u': userId, ':prefix': `${SUPPORT_PREFIX}TICKET#` },
        ScanIndexForward: false,
      });
      return (page.Items ?? []).map((item) => parse(SupportTicketRecordSchema, item, 'ticket'));
    },

    async createGrant(record): Promise<void> {
      await client.put({
        TableName: tableName,
        Item: { targetUserId: record.userId, sk: grantKey(record.grantId), ...record },
      });
    },

    async getGrant(input): Promise<SupportGrantRecord | null> {
      const result = await client.get({
        TableName: tableName,
        Key: { targetUserId: input.userId, sk: grantKey(input.grantId) },
      });
      return result.Item === undefined
        ? null
        : parse(SupportGrantRecordSchema, result.Item, 'access grant');
    },

    async revokeGrant(input): Promise<void> {
      await client.put({
        TableName: tableName,
        Item: {
          targetUserId: input.userId,
          sk: revocationKey(input.grantId),
          grantId: input.grantId,
          revokedAt: input.revokedAt.toISOString(),
        },
      });
    },

    async isGrantRevoked(input): Promise<boolean> {
      const result = await client.get({
        TableName: tableName,
        Key: { targetUserId: input.userId, sk: revocationKey(input.grantId) },
      });
      return result.Item !== undefined;
    },

    async createReport(record): Promise<void> {
      await client.put({
        TableName: tableName,
        Item: {
          targetUserId: record.reporterUserId,
          sk: `${SUPPORT_PREFIX}REPORT#${record.submittedAt}#${record.reportId}`,
          ...record,
        },
      });
    },
  };
}

function parse<TSchema extends z.ZodType>(
  schema: TSchema,
  item: Item,
  label: string,
): z.output<TSchema> {
  const parsed = schema.safeParse(item);
  if (!parsed.success) {
    throw new AppError('INTERNAL_ERROR', `A ${label} record could not be read.`);
  }
  return parsed.data as z.output<TSchema>;
}
