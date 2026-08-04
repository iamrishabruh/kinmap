import { z } from 'zod';

import { AppError, UserIdSchema, type UserId } from '@family/contracts';
import { IsoDateTimeSchema, type DataExport, type DataExportStatus } from '@family/schemas';

import { isConditionalCheckFailed, type DocumentClient, type Item } from './document-client.js';
import { buildSetExpression } from './expressions.js';
import { JobRecordSchema, type JobRecord, type JobStatus } from './jobs.js';

/**
 * A user's own data lifecycle: getting a copy out, and how long we keep it.
 *
 * The two halves live together because they are one question asked twice — "what
 * of mine do you hold, and for how long?" — and because neither of them may ever
 * touch a coordinate. Nothing in this module reads a location table, and no shape
 * it returns has a field a position could occupy.
 *
 * TWO TABLES, NEITHER OF THEM NEW
 * -------------------------------
 *  - Export requests are rows in **DeletionJobs**, which is already the
 *    platform's queue for erasure and export (see `jobs.ts`). Reusing it is what
 *    makes `POST /v1/privacy/export` and `GET /v1/privacy/exports` agree by
 *    construction rather than by two writers being kept in step by hand. This
 *    module only ever READS that table: `JobsRepository.enqueue` stays its single
 *    writer, so there is exactly one place a job can be created and exactly one
 *    set of conditions guarding it.
 *  - The retention choice is an attribute on the user's own **Users** row,
 *    beside `sharingStatus` and `sharingPausedUntil` — the other two switches a
 *    person owns over their own visibility. It is written through a targeted
 *    update expression, never a put, so this module and `accounts.ts` can hold
 *    different views of the same row without either clobbering the other.
 *
 * The export view is a projection, not a passthrough. A caller is told the state
 * of their request and nothing about the queue behind it: no `scheduledFor`, no
 * `requestId`, no worker bookkeeping. Those are operational facts, and an
 * endpoint that leaks them turns a privacy screen into a scheduling oracle.
 */

/**
 * The retention view of a Users row.
 *
 * A plain `z.object` rather than a strict one: it parses the same row
 * `UserRecordSchema` parses, and every other attribute is deliberately none of
 * this module's business.
 *
 * There is no upper bound on the stored value on purpose. A row written under a
 * more generous plan — or under a higher platform ceiling — must still be
 * readable, because the ceiling is applied when the value is USED. Failing to
 * parse would turn a stale preference into a broken privacy screen, which is the
 * one screen that has to keep working.
 */
export const RetentionPreferenceSchema = z.object({
  userId: UserIdSchema,
  /** Null means "as long as the plan allows"; the user has expressed no view. */
  historyRetentionDays: z.number().int().nonnegative().nullable().default(null),
  historyRetentionUpdatedAt: IsoDateTimeSchema.nullable().default(null),
});
export type RetentionPreference = z.infer<typeof RetentionPreferenceSchema>;

export interface PrivacyExportsRepository {
  /** The caller's own export requests, newest first. */
  listExports(userId: UserId): Promise<DataExport[]>;
  /**
   * One export request, or null when it is not this caller's. "Not yours" and
   * "no such request" are the same answer here so the route can turn both into
   * one opaque denial.
   */
  getExport(input: { userId: UserId; exportId: string }): Promise<DataExport | null>;
  /** Null when there is no such account. Absent attributes read as "no view". */
  getRetention(userId: UserId): Promise<RetentionPreference | null>;
  /** Null when there is no such account; the row is never created here. */
  setRetention(input: {
    userId: UserId;
    historyRetentionDays: number | null;
    now: Date;
  }): Promise<RetentionPreference | null>;
}

export function createPrivacyExportsRepository(
  client: DocumentClient,
  /** DeletionJobs. Read-only from here — `JobsRepository` owns every write. */
  jobsTableName: string,
  /** Users. Only the two retention attributes are ever read or written. */
  usersTableName: string,
): PrivacyExportsRepository {
  return {
    async listExports(userId): Promise<DataExport[]> {
      const exports: DataExport[] = [];
      let cursor: Item | undefined;
      do {
        const page = await client.query({
          TableName: jobsTableName,
          IndexName: 'byUser',
          KeyConditionExpression: '#u = :u',
          ExpressionAttributeNames: { '#u': 'userId' },
          ExpressionAttributeValues: { ':u': userId },
          // Newest first: the request a user is waiting on is the one they just
          // made, and it should not be at the bottom of the list.
          ScanIndexForward: false,
          ExclusiveStartKey: cursor,
        });
        for (const item of page.Items ?? []) {
          const job = parseJob(item);
          // The same partition holds this user's deletion jobs. Filtering here
          // rather than in a FilterExpression keeps the index read simple, and
          // the number of jobs one person can accumulate is small.
          if (job.jobType === 'DATA_EXPORT') {
            exports.push(toDataExport(job));
          }
        }
        cursor = page.LastEvaluatedKey;
      } while (cursor !== undefined);
      return exports;
    },

    async getExport(input): Promise<DataExport | null> {
      // Read by primary key rather than by walking the index: a user who has
      // just asked for an export polls immediately, and `byUser` is a GSI whose
      // lag would show them a 404 for the id they were handed a moment ago.
      const result = await client.get({
        TableName: jobsTableName,
        Key: { jobId: input.exportId },
        ConsistentRead: true,
      });
      if (result.Item === undefined) {
        return null;
      }
      const job = parseJob(result.Item);
      // The table is partitioned by job id, so ownership is not structural here
      // and this comparison IS the authorization boundary. Both failures return
      // null so the caller cannot tell a stranger's export from a typo.
      if (job.userId !== input.userId || job.jobType !== 'DATA_EXPORT') {
        return null;
      }
      return toDataExport(job);
    },

    async getRetention(userId): Promise<RetentionPreference | null> {
      const result = await client.get({
        TableName: usersTableName,
        Key: { userId },
        ConsistentRead: true,
      });
      return result.Item === undefined ? null : parseRetention(result.Item);
    },

    async setRetention(input): Promise<RetentionPreference | null> {
      // The account's own `updatedAt` is deliberately left alone. It is what the
      // sharing projection reports as "when your sharing last changed", and
      // moving it because somebody shortened their history would tell every
      // family member that a consent setting had changed when none had.
      const expression = buildSetExpression({
        historyRetentionDays: input.historyRetentionDays,
        historyRetentionUpdatedAt: input.now.toISOString(),
      });
      if (expression === null) {
        // Unreachable: the patch above always has at least one value. Guarded
        // rather than asserted, because an empty UpdateExpression is a runtime
        // error from DynamoDB and a silent no-op would be worse.
        return null;
      }

      try {
        const result = await client.update({
          TableName: usersTableName,
          Key: { userId: input.userId },
          UpdateExpression: expression.UpdateExpression,
          // Never creates the row. A retention preference for an account that
          // does not exist is a write nobody asked for.
          ConditionExpression: 'attribute_exists(userId)',
          ExpressionAttributeNames: expression.ExpressionAttributeNames,
          ExpressionAttributeValues: expression.ExpressionAttributeValues,
          ReturnValues: 'ALL_NEW',
        });
        return result.Attributes === undefined ? null : parseRetention(result.Attributes);
      } catch (error) {
        if (isConditionalCheckFailed(error)) {
          return null;
        }
        throw error;
      }
    },
  };
}

/**
 * The queue's vocabulary is about work; a user's is about their own request.
 * Everything that is not finished is either waiting or running, and everything
 * that finished either arrived or did not.
 */
function toExportStatus(status: JobStatus): DataExportStatus {
  switch (status) {
    case 'PENDING':
      return 'QUEUED';
    case 'RUNNING':
      return 'IN_PROGRESS';
    case 'COMPLETED':
      return 'DELIVERED';
    case 'FAILED':
      return 'FAILED';
    case 'CANCELLED':
      return 'CANCELLED';
  }
}

/**
 * Field by field, so a queue attribute cannot ride along into a response. The
 * delivery method is a constant because it is a property of the design rather
 * than of the row: the archive leaves by mail, never through this API.
 */
function toDataExport(job: JobRecord): DataExport {
  return {
    exportId: job.jobId,
    status: toExportStatus(job.status),
    requestedAt: job.requestedAt,
    completesBy: job.completesBy,
    deliveryMethod: 'EMAIL_LINK',
  };
}

function parseJob(item: Item): JobRecord {
  const parsed = JobRecordSchema.safeParse(item);
  if (!parsed.success) {
    throw new AppError('INTERNAL_ERROR', 'A job record could not be read.');
  }
  return parsed.data;
}

function parseRetention(item: Item): RetentionPreference {
  const parsed = RetentionPreferenceSchema.safeParse(item);
  if (!parsed.success) {
    throw new AppError('INTERNAL_ERROR', 'The account record could not be read.');
  }
  return parsed.data;
}
