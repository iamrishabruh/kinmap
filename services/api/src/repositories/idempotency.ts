import { z } from 'zod';

import { AppError } from '@family/contracts';

import { isConditionalCheckFailed, type DocumentClient, type Item } from './document-client.js';
import { ttlAt } from './expressions.js';

/**
 * The Idempotency table backs two short-lived, single-item, conditionally
 * written concerns:
 *
 *  1. idempotency claims — `<userId>#<clientKey>`;
 *  2. rate-limit token buckets — `RATE#<bucket>#<principal>`.
 *
 * Both are keyed, both are TTL'd, and both are written with a condition
 * expression, so they share a table rather than requiring a second one. The key
 * prefixes keep the two namespaces disjoint, and an idempotency key is always
 * scoped by the caller's user id so one principal can neither collide with nor
 * probe another's keys.
 */

export const IdempotencyRecordSchema = z.object({
  idempotencyKey: z.string().min(1),
  fingerprint: z.string().min(1),
  status: z.enum(['IN_PROGRESS', 'COMPLETED']),
  statusCode: z.number().int().nullable().default(null),
  body: z.string().nullable().default(null),
  createdAt: z.string(),
  completedAt: z.string().nullable().default(null),
});
export type IdempotencyRecord = z.infer<typeof IdempotencyRecordSchema>;

export type ClaimResult =
  | { readonly outcome: 'CLAIMED' }
  | { readonly outcome: 'EXISTS'; readonly record: IdempotencyRecord };

export interface IdempotencyStore {
  claim(input: { key: string; fingerprint: string; now: Date }): Promise<ClaimResult>;
  complete(input: { key: string; statusCode: number; body: string; now: Date }): Promise<void>;
  /** Frees the key so a failed request can be retried with the same one. */
  release(input: { key: string }): Promise<void>;
}

export function createIdempotencyStore(
  client: DocumentClient,
  tableName: string,
  ttlSeconds: number,
): IdempotencyStore {
  return {
    async claim(input): Promise<ClaimResult> {
      try {
        await client.put({
          TableName: tableName,
          Item: {
            idempotencyKey: input.key,
            fingerprint: input.fingerprint,
            status: 'IN_PROGRESS',
            statusCode: null,
            body: null,
            createdAt: input.now.toISOString(),
            completedAt: null,
            expiresAt: ttlAt(input.now, ttlSeconds),
          },
          ConditionExpression: 'attribute_not_exists(idempotencyKey)',
        });
        return { outcome: 'CLAIMED' };
      } catch (error) {
        if (!isConditionalCheckFailed(error)) {
          throw error;
        }
        const existing = await client.get({
          TableName: tableName,
          Key: { idempotencyKey: input.key },
          ConsistentRead: true,
        });
        if (existing.Item === undefined) {
          // The row expired between the failed put and this read. Treating it as
          // a fresh claim is safe: nothing is stored to replay.
          return { outcome: 'CLAIMED' };
        }
        return { outcome: 'EXISTS', record: parseRecord(existing.Item) };
      }
    },

    async complete(input): Promise<void> {
      await client.update({
        TableName: tableName,
        Key: { idempotencyKey: input.key },
        UpdateExpression: 'SET #s = :done, #c = :code, #b = :body, #ca = :at',
        ConditionExpression: 'attribute_exists(idempotencyKey)',
        ExpressionAttributeNames: {
          '#s': 'status',
          '#c': 'statusCode',
          '#b': 'body',
          '#ca': 'completedAt',
        },
        ExpressionAttributeValues: {
          ':done': 'COMPLETED',
          ':code': input.statusCode,
          ':body': input.body,
          ':at': input.now.toISOString(),
        },
      });
    },

    async release(input): Promise<void> {
      try {
        await client.delete({
          TableName: tableName,
          Key: { idempotencyKey: input.key },
          // Only an unfinished claim is released; a completed response stays
          // replayable even if a later request fails.
          ConditionExpression: '#s = :inProgress',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':inProgress': 'IN_PROGRESS' },
        });
      } catch (error) {
        if (!isConditionalCheckFailed(error)) {
          throw error;
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Token buckets
// ---------------------------------------------------------------------------

export const TokenBucketStateSchema = z.object({
  tokens: z.number(),
  refilledAtMs: z.number().int(),
});
export type TokenBucketState = z.infer<typeof TokenBucketStateSchema>;

export interface TokenBucketStore {
  read(key: string): Promise<TokenBucketState | null>;
  /**
   * Compare-and-set on `refilledAtMs`. Returns false when another request
   * updated the bucket first, which the limiter treats as contention rather
   * than as an allowance.
   */
  write(input: {
    key: string;
    tokens: number;
    refilledAtMs: number;
    expectedRefilledAtMs: number | null;
    now: Date;
    ttlSeconds: number;
  }): Promise<boolean>;
}

export function createTokenBucketStore(
  client: DocumentClient,
  tableName: string,
): TokenBucketStore {
  return {
    async read(key): Promise<TokenBucketState | null> {
      const result = await client.get({
        TableName: tableName,
        Key: { idempotencyKey: key },
        ConsistentRead: true,
      });
      if (result.Item === undefined) {
        return null;
      }
      const parsed = TokenBucketStateSchema.safeParse(result.Item);
      // A malformed bucket is discarded rather than trusted; the caller then
      // starts from a full bucket, which is the same as a first request.
      return parsed.success ? parsed.data : null;
    },

    async write(input): Promise<boolean> {
      try {
        await client.put({
          TableName: tableName,
          Item: {
            idempotencyKey: input.key,
            tokens: input.tokens,
            refilledAtMs: input.refilledAtMs,
            expiresAt: ttlAt(input.now, input.ttlSeconds),
          },
          ConditionExpression:
            input.expectedRefilledAtMs === null
              ? 'attribute_not_exists(idempotencyKey)'
              : '#r = :expected',
          ExpressionAttributeNames:
            input.expectedRefilledAtMs === null ? undefined : { '#r': 'refilledAtMs' },
          ExpressionAttributeValues:
            input.expectedRefilledAtMs === null
              ? undefined
              : { ':expected': input.expectedRefilledAtMs },
        });
        return true;
      } catch (error) {
        if (isConditionalCheckFailed(error)) {
          return false;
        }
        throw error;
      }
    },
  };
}

function parseRecord(item: Item): IdempotencyRecord {
  const parsed = IdempotencyRecordSchema.safeParse(item);
  if (!parsed.success) {
    throw new AppError('INTERNAL_ERROR', 'The idempotency record could not be read.');
  }
  return parsed.data;
}
