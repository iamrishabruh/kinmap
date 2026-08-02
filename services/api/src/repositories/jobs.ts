import { z } from 'zod';

import { AppError, FamilyIdSchema, UserIdSchema, type UserId } from '@family/contracts';
import { IsoDateTimeSchema } from '@family/schemas';

import { isConditionalCheckFailed, type DocumentClient, type Item } from './document-client.js';

/**
 * DeletionJobs is the platform's work queue for erasure and export.
 *
 * The API records the *request* and returns; a worker sweeps due jobs off the
 * `byStatus` index and performs the deletion. That split is deliberate: the API
 * function is granted no access to any coordinate table, so it could not delete
 * a location even if it wanted to, and a user's erasure request must survive a
 * failure of whatever is doing the erasing.
 *
 * Both `status` and `scheduledFor` are always written, because they are the key
 * of the index the scheduler sweeps — a job missing either would be invisible.
 */

export const JobTypeSchema = z.enum(['ACCOUNT_DELETION', 'HISTORY_DELETION', 'DATA_EXPORT']);
export type JobType = z.infer<typeof JobTypeSchema>;

export const JobStatusSchema = z.enum(['PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED']);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const JobRecordSchema = z.object({
  jobId: z.string().uuid(),
  userId: UserIdSchema,
  jobType: JobTypeSchema,
  status: JobStatusSchema,
  requestedAt: IsoDateTimeSchema,
  /** When the worker may start. For account deletion, the end of the grace period. */
  scheduledFor: IsoDateTimeSchema,
  /** Advertised completion deadline, returned to the client. */
  completesBy: IsoDateTimeSchema,
  requestId: z.string().min(1).max(128),
  scope: z.string().max(40).nullable().default(null),
  from: IsoDateTimeSchema.nullable().default(null),
  to: IsoDateTimeSchema.nullable().default(null),
  familyId: FamilyIdSchema.nullable().default(null),
  reason: z.string().max(64).nullable().default(null),
  feedback: z.string().max(1000).nullable().default(null),
});
export type JobRecord = z.infer<typeof JobRecordSchema>;

export interface JobsRepository {
  /** Fails closed on a duplicate job id rather than overwriting a queued job. */
  enqueue(record: JobRecord): Promise<void>;
  listForUser(userId: UserId): Promise<JobRecord[]>;
  cancelPending(input: { userId: UserId; jobType: JobType; now: Date }): Promise<number>;
}

export function createJobsRepository(client: DocumentClient, tableName: string): JobsRepository {
  async function listForUser(userId: UserId): Promise<JobRecord[]> {
    const records: JobRecord[] = [];
    let cursor: Item | undefined;
    do {
      const page = await client.query({
        TableName: tableName,
        IndexName: 'byUser',
        KeyConditionExpression: '#u = :u',
        ExpressionAttributeNames: { '#u': 'userId' },
        ExpressionAttributeValues: { ':u': userId },
        ExclusiveStartKey: cursor,
      });
      for (const item of page.Items ?? []) {
        records.push(parseJob(item));
      }
      cursor = page.LastEvaluatedKey;
    } while (cursor !== undefined);
    return records;
  }

  return {
    async enqueue(record): Promise<void> {
      try {
        await client.put({
          TableName: tableName,
          Item: { ...record },
          ConditionExpression: 'attribute_not_exists(jobId)',
        });
      } catch (error) {
        if (isConditionalCheckFailed(error)) {
          throw new AppError('CONFLICT', 'That request has already been recorded.');
        }
        throw error;
      }
    },

    listForUser,

    async cancelPending(input): Promise<number> {
      const jobs = await listForUser(input.userId);
      let cancelled = 0;
      for (const job of jobs) {
        if (job.jobType !== input.jobType || job.status !== 'PENDING') {
          continue;
        }
        try {
          await client.update({
            TableName: tableName,
            Key: { jobId: job.jobId },
            UpdateExpression: 'SET #s = :cancelled, #u = :now',
            // A job the worker already picked up must not be yanked out from
            // under it; only a still-pending job can be cancelled.
            ConditionExpression: '#s = :pending',
            ExpressionAttributeNames: { '#s': 'status', '#u': 'updatedAt' },
            ExpressionAttributeValues: {
              ':cancelled': 'CANCELLED',
              ':pending': 'PENDING',
              ':now': input.now.toISOString(),
            },
          });
          cancelled += 1;
        } catch (error) {
          if (!isConditionalCheckFailed(error)) {
            throw error;
          }
        }
      }
      return cancelled;
    },
  };
}

function parseJob(item: Item): JobRecord {
  const parsed = JobRecordSchema.safeParse(item);
  if (!parsed.success) {
    throw new AppError('INTERNAL_ERROR', 'A job record could not be read.');
  }
  return parsed.data;
}
