import { z } from 'zod';

import { PlanSchema, SubscriptionStatusSchema, UserIdSchema } from '@family/contracts';
import {
  IsoDateTimeSchema,
  SubscriptionSourceSchema,
  WebhookProviderSchema,
} from '@family/schemas';

/**
 * ONE normalised subscription event.
 *
 * RevenueCat, App Store Server Notifications V2 and Google Play RTDN describe
 * the same twelve lifecycle moments in three incompatible vocabularies. Every
 * verified webhook is translated into this shape before it is queued, so the
 * reconciliation logic downstream has exactly one set of cases to handle and
 * one place where a new provider quirk can be absorbed.
 *
 * Note what is NOT here: no receipt, no purchase token, no signed payload, no
 * price. Those are credentials or commercial data with no place in a queue
 * message, and the reconciler never needs them — entitlements are always
 * re-derived from the stored record, not from the event.
 */

export const SubscriptionEventTypeSchema = z.enum([
  'PURCHASE',
  'RESTORE',
  'RENEWAL',
  'CANCELLATION',
  'EXPIRATION',
  'GRACE_PERIOD_STARTED',
  'BILLING_RETRY_STARTED',
  'REFUND',
  'REVOCATION',
  'UPGRADE',
  'DOWNGRADE',
  'PAUSED',
  'RESUMED',
  /** A recognised delivery whose type we deliberately take no action on. */
  'UNHANDLED',
]);
export type SubscriptionEventType = z.infer<typeof SubscriptionEventTypeSchema>;

export const StoreEnvironmentSchema = z.enum(['PRODUCTION', 'SANDBOX']);
export type StoreEnvironment = z.infer<typeof StoreEnvironmentSchema>;

export const SubscriptionEventSchema = z.strictObject({
  /** Provider-issued event id. The deduplication key for the whole pipeline. */
  eventId: z.string().min(1).max(256),
  provider: WebhookProviderSchema,
  type: SubscriptionEventTypeSchema,
  /** The store's own account identifier, as sent. */
  appUserId: z.string().min(1).max(256),
  /** Our user id, when the store identifier is one. Null otherwise. */
  userId: UserIdSchema.nullable(),
  source: SubscriptionSourceSchema,
  originalTransactionId: z.string().min(1).max(256).nullable(),
  productId: z.string().min(1).max(256).nullable(),
  plan: PlanSchema.nullable(),
  status: SubscriptionStatusSchema,
  environment: StoreEnvironmentSchema,
  expiresAt: IsoDateTimeSchema.nullable(),
  gracePeriodEndsAt: IsoDateTimeSchema.nullable(),
  willRenew: z.boolean(),
  occurredAt: IsoDateTimeSchema,
});
export type SubscriptionEvent = z.infer<typeof SubscriptionEventSchema>;

export function parseSubscriptionEvent(body: unknown): SubscriptionEvent {
  return SubscriptionEventSchema.parse(body);
}

/**
 * The status each lifecycle moment implies, in isolation.
 *
 * CANCELLATION is deliberately ACTIVE: on both stores "cancel" means "do not
 * renew", and the customer keeps what they paid for until the period ends.
 * Downgrading them the instant they switch auto-renew off would take away
 * access they are still owed. The `willRenew: false` flag carries the fact, and
 * expiry is applied later from the stored record.
 */
export const STATUS_FOR_EVENT_TYPE: Record<
  SubscriptionEventType,
  z.infer<typeof SubscriptionStatusSchema> | null
> = {
  PURCHASE: 'ACTIVE',
  RESTORE: 'ACTIVE',
  RENEWAL: 'ACTIVE',
  UPGRADE: 'ACTIVE',
  DOWNGRADE: 'ACTIVE',
  RESUMED: 'ACTIVE',
  CANCELLATION: 'ACTIVE',
  EXPIRATION: 'EXPIRED',
  GRACE_PERIOD_STARTED: 'IN_GRACE_PERIOD',
  BILLING_RETRY_STARTED: 'IN_BILLING_RETRY',
  REFUND: 'REFUNDED',
  REVOCATION: 'REVOKED',
  PAUSED: 'PAUSED',
  UNHANDLED: null,
};

/**
 * Lifecycle moments after which the subscription will not renew by itself.
 *
 * DOWNGRADE is absent on purpose: on both stores a downgrade is a *pending
 * renewal preference*, so the subscription does renew — into the cheaper plan.
 */
export const NON_RENEWING_EVENT_TYPES: ReadonlySet<SubscriptionEventType> =
  new Set<SubscriptionEventType>(['CANCELLATION', 'EXPIRATION', 'REFUND', 'REVOCATION', 'PAUSED']);
