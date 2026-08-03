import { createHash } from 'node:crypto';

import { z } from 'zod';

import type {
  SubscriptionRecord as AuthSubscriptionRecord,
  SubscriptionRepository,
} from '@family/auth';
import {
  AppError,
  FamilyIdSchema,
  PlanSchema,
  SubscriptionStatusSchema,
  UserIdSchema,
  type FamilyId,
  type UserId,
} from '@family/contracts';
import { IsoDateTimeSchema, PlatformSchema, SubscriptionSourceSchema } from '@family/schemas';

import { isConditionalCheckFailed, type DocumentClient, type Item } from './document-client.js';

/**
 * The Subscriptions table is written only by the billing service, from a
 * provider webhook whose signature it has verified. This service reads it and
 * never writes: a client-supplied receipt or plan is not an input to any
 * entitlement decision (spec §23).
 *
 * The SubscriptionReceipts table beside it is the one thing this service does
 * write, and it is a hand-off rather than a decision: a receipt the client
 * submitted is parked there for services/subscription-worker, which holds the
 * provider credentials, to verify against the store. Nothing read out of that
 * table ever grants an entitlement — the worker writes the Subscriptions row
 * and the Subscriptions row is still the only source of truth.
 */

export const SubscriptionRecordSchema = z.object({
  userId: UserIdSchema,
  familyId: FamilyIdSchema.nullable().default(null),
  plan: PlanSchema,
  status: SubscriptionStatusSchema,
  source: SubscriptionSourceSchema.default('NONE'),
  isTrial: z.boolean().default(false),
  currentPeriodEndsAt: IsoDateTimeSchema.nullable().default(null),
  gracePeriodEndsAt: IsoDateTimeSchema.nullable().default(null),
  willRenew: z.boolean().default(false),
  managementUrl: z.string().url().max(2048).nullable().default(null),
  refreshedAt: IsoDateTimeSchema,
});
export type SubscriptionRecord = z.infer<typeof SubscriptionRecordSchema>;

/**
 * A receipt submitted by a client, waiting for the worker.
 *
 * Partitioned by `userId` and sorted by the receipt's own digest, so the same
 * receipt submitted twice is one row rather than two, whatever the client does
 * with its idempotency keys. `status` and `submittedAt` are the key of the index
 * the worker sweeps, so a row missing either would be invisible to it — the same
 * property the deletion job table depends on.
 *
 * `status` past PENDING is written by the worker, never here: this service may
 * not decide that a receipt is valid.
 */
export const ReceiptSubmissionStatusSchema = z.enum(['PENDING', 'VERIFIED', 'REJECTED']);
export type ReceiptSubmissionStatus = z.infer<typeof ReceiptSubmissionStatusSchema>;

export const ReceiptSubmissionRecordSchema = z.object({
  userId: UserIdSchema,
  /** SHA-256 of the receipt, hex. Derived here so the credential is handled once. */
  receiptFingerprint: z.string().length(64),
  submissionId: z.string().uuid(),
  platform: PlatformSchema,
  /**
   * What the client believes it bought. A hint for the worker's product map and
   * nothing more — the plan comes from what the store confirms, never from this.
   */
  productId: z.string().min(1).max(120),
  /**
   * The credential itself, and the only reason this row exists. It is encrypted
   * at rest under the platform key, expires with the row, and is never returned
   * to a caller, written to a log line or attached to an audit event.
   */
  receipt: z.string().min(16).max(65_536),
  status: ReceiptSubmissionStatusSchema,
  submittedAt: IsoDateTimeSchema,
  requestId: z.string().min(1).max(128),
  /** Epoch seconds, applied by the table's TTL. */
  expiresAt: z.number().int().positive(),
});
export type ReceiptSubmissionRecord = z.infer<typeof ReceiptSubmissionRecordSchema>;

/**
 * How long a submitted receipt is kept.
 *
 * Long enough to survive a provider outage and a queue redrive, short enough
 * that a store credential does not outlive the verification it was handed over
 * for. Nothing reads these rows after the worker has folded the result into the
 * subscription record.
 */
const RECEIPT_RETENTION_SECONDS = 7 * 24 * 60 * 60;

export type ReceiptSubmission = {
  readonly userId: UserId;
  readonly submissionId: string;
  readonly platform: ReceiptSubmissionRecord['platform'];
  readonly productId: string;
  readonly receipt: string;
  readonly requestId: string;
  readonly now: Date;
};

/**
 * `ALREADY_PENDING` means this exact receipt is already queued for the same
 * user. It is not an error: the caller gets the same answer either way, and a
 * client that resubmits on every launch must not be able to re-order the
 * worker's queue by doing so.
 */
export type ReceiptSubmissionOutcome = 'RECORDED' | 'ALREADY_PENDING';

export interface SubscriptionsRepository extends SubscriptionRepository {
  getForUser(userId: UserId): Promise<SubscriptionRecord | null>;
  /** Parks a client-submitted receipt for services/subscription-worker. */
  submitReceipt(input: ReceiptSubmission): Promise<ReceiptSubmissionOutcome>;
}

export function createSubscriptionsRepository(
  client: DocumentClient,
  tableName: string,
  /**
   * The receipt hand-off table. Null when this function has not been granted
   * one, in which case a submission is refused rather than accepted and
   * dropped — a 202 for a receipt nobody will ever verify is a lie the client
   * would act on.
   */
  receiptsTableName: string | null = null,
): SubscriptionsRepository {
  async function getForUser(userId: UserId): Promise<SubscriptionRecord | null> {
    const result = await client.get({ TableName: tableName, Key: { userId } });
    if (result.Item === undefined) {
      return null;
    }
    return parseSubscription(result.Item);
  }

  return {
    getForUser,

    async submitReceipt(input): Promise<ReceiptSubmissionOutcome> {
      if (receiptsTableName === null) {
        throw new AppError('UPSTREAM_UNAVAILABLE', 'Receipts cannot be submitted right now.');
      }

      const submittedAt = input.now.toISOString();
      const record: ReceiptSubmissionRecord = {
        userId: input.userId,
        receiptFingerprint: fingerprintReceipt(input.receipt),
        submissionId: input.submissionId,
        platform: input.platform,
        productId: input.productId,
        receipt: input.receipt,
        status: 'PENDING',
        submittedAt,
        requestId: input.requestId,
        expiresAt: Math.floor(input.now.getTime() / 1000) + RECEIPT_RETENTION_SECONDS,
      };

      try {
        await client.put({
          TableName: receiptsTableName,
          Item: { ...record },
          // A receipt already waiting stays as it was submitted. A receipt the
          // worker has already ruled on is re-armed, because a store can change
          // its mind — a refund reversed, a billing retry that finally settled.
          ConditionExpression: 'attribute_not_exists(receiptFingerprint) OR #s <> :pending',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':pending': 'PENDING' },
        });
        return 'RECORDED';
      } catch (error) {
        if (isConditionalCheckFailed(error)) {
          return 'ALREADY_PENDING';
        }
        throw error;
      }
    },

    /**
     * Entitlements are family-scoped: one payer covers the whole family. The
     * `byFamily` index answers "does anyone in this family pay?" without a scan.
     */
    async getSubscriptionForFamily(input: {
      familyId: FamilyId;
    }): Promise<AuthSubscriptionRecord | null> {
      const page = await client.query({
        TableName: tableName,
        IndexName: 'byFamily',
        KeyConditionExpression: '#f = :f',
        ExpressionAttributeNames: { '#f': 'familyId' },
        ExpressionAttributeValues: { ':f': input.familyId },
      });

      let best: SubscriptionRecord | null = null;
      for (const item of page.Items ?? []) {
        const record = parseSubscription(item);
        // The most generous currently-entitled row wins; a lapsed row must not
        // shadow a family member who is still paying.
        if (best === null || rank(record) > rank(best)) {
          best = record;
        }
      }
      return best === null
        ? null
        : { familyId: input.familyId, plan: best.plan, status: best.status };
    },
  };
}

/** Entitled rows sort above everything else; ties fall back to recency. */
function rank(record: SubscriptionRecord): number {
  const entitled =
    record.status === 'ACTIVE' ||
    record.status === 'IN_GRACE_PERIOD' ||
    record.status === 'IN_BILLING_RETRY';
  return entitled ? 2 : 1;
}

/**
 * The row key for a receipt.
 *
 * A digest rather than the receipt itself, so the sort key of a row — the value
 * that shows up in a key condition, a paging cursor or a DynamoDB error — is
 * never the credential. A store receipt carries far more entropy than a hash
 * needs, so the digest identifies the submission without being reversible into
 * it.
 */
function fingerprintReceipt(receipt: string): string {
  return createHash('sha256').update(receipt, 'utf8').digest('hex');
}

function parseSubscription(item: Item): SubscriptionRecord {
  const parsed = SubscriptionRecordSchema.safeParse(item);
  if (!parsed.success) {
    throw new AppError('INTERNAL_ERROR', 'A subscription record could not be read.');
  }
  return parsed.data;
}
