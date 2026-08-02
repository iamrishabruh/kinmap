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
import { IsoDateTimeSchema, SubscriptionSourceSchema } from '@family/schemas';

import { type DocumentClient, type Item } from './document-client.js';

/**
 * The Subscriptions table is written only by the billing service, from a
 * provider webhook whose signature it has verified. This service reads it and
 * never writes: a client-supplied receipt or plan is not an input to any
 * entitlement decision (spec §23).
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

export interface SubscriptionsRepository extends SubscriptionRepository {
  getForUser(userId: UserId): Promise<SubscriptionRecord | null>;
}

export function createSubscriptionsRepository(
  client: DocumentClient,
  tableName: string,
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

function parseSubscription(item: Item): SubscriptionRecord {
  const parsed = SubscriptionRecordSchema.safeParse(item);
  if (!parsed.success) {
    throw new AppError('INTERNAL_ERROR', 'A subscription record could not be read.');
  }
  return parsed.data;
}
