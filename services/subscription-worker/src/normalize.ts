import { PlanSchema, UserIdSchema, type Plan, type UserId } from '@family/contracts';
import type { SubscriptionSource } from '@family/schemas';

import {
  NON_RENEWING_EVENT_TYPES,
  STATUS_FOR_EVENT_TYPE,
  SubscriptionEventSchema,
  type StoreEnvironment,
  type SubscriptionEvent,
  type SubscriptionEventType,
} from './events.js';
import { decodeVerifiedNestedJws } from './verify/apple.js';

/**
 * Three provider vocabularies, one normalised event.
 *
 * Everything in this module is pure and total: an unrecognised notification
 * type becomes `UNHANDLED` rather than throwing, because a store adding a
 * notification type must never take the webhook endpoint down. `UNHANDLED`
 * events are still queued — they carry the current expiry and renewal flags,
 * which is exactly what the reconciler needs to stay accurate.
 */

export type NormalizeContext = {
  readonly productPlanMap: Readonly<Record<string, Plan>>;
  readonly now: () => Date;
};

function planFor(productId: string | null, context: NormalizeContext): Plan | null {
  if (productId === null) return null;
  const mapped = context.productPlanMap[productId];
  if (mapped !== undefined) return mapped;
  const direct = PlanSchema.safeParse(productId);
  return direct.success ? direct.data : null;
}

function asUserId(candidate: unknown): UserId | null {
  const parsed = UserIdSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Milliseconds-since-epoch to an ISO instant, tolerating strings and nulls. */
function isoFromMillis(value: unknown): string | null {
  const millis =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isFinite(millis) || millis <= 0) return null;
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function finish(input: {
  eventId: string;
  provider: SubscriptionEvent['provider'];
  type: SubscriptionEventType;
  appUserId: string;
  userId: UserId | null;
  source: SubscriptionSource;
  originalTransactionId: string | null;
  productId: string | null;
  plan: Plan | null;
  environment: StoreEnvironment;
  expiresAt: string | null;
  gracePeriodEndsAt: string | null;
  willRenew: boolean | null;
  occurredAt: string;
}): SubscriptionEvent {
  const status = STATUS_FOR_EVENT_TYPE[input.type] ?? 'ACTIVE';
  const willRenew = input.willRenew ?? !NON_RENEWING_EVENT_TYPES.has(input.type);
  return SubscriptionEventSchema.parse({
    eventId: input.eventId,
    provider: input.provider,
    type: input.type,
    appUserId: input.appUserId,
    userId: input.userId,
    source: input.source,
    originalTransactionId: input.originalTransactionId,
    productId: input.productId,
    plan: input.plan,
    status,
    environment: input.environment,
    expiresAt: input.expiresAt,
    gracePeriodEndsAt: input.gracePeriodEndsAt,
    willRenew,
    occurredAt: input.occurredAt,
  } satisfies SubscriptionEvent);
}

// ---------------------------------------------------------------------------
// RevenueCat
// ---------------------------------------------------------------------------

const REVENUECAT_EVENT_TYPES: Readonly<Record<string, SubscriptionEventType>> = {
  INITIAL_PURCHASE: 'PURCHASE',
  NON_RENEWING_PURCHASE: 'PURCHASE',
  RENEWAL: 'RENEWAL',
  UNCANCELLATION: 'RESUMED',
  CANCELLATION: 'CANCELLATION',
  SUBSCRIPTION_PAUSED: 'PAUSED',
  EXPIRATION: 'EXPIRATION',
  BILLING_ISSUE: 'BILLING_RETRY_STARTED',
  PRODUCT_CHANGE: 'UPGRADE',
  TRANSFER: 'RESTORE',
  SUBSCRIPTION_EXTENDED: 'RENEWAL',
};

const REVENUECAT_STORE_SOURCES: Readonly<Record<string, SubscriptionSource>> = {
  APP_STORE: 'APP_STORE',
  MAC_APP_STORE: 'APP_STORE',
  PLAY_STORE: 'PLAY_STORE',
  PROMOTIONAL: 'PROMOTIONAL',
};

export function normalizeRevenueCatWebhook(
  body: unknown,
  context: NormalizeContext,
): SubscriptionEvent | null {
  const envelope = asRecord(body);
  const event = asRecord(envelope?.event);
  if (event === null) return null;

  const eventId = asString(event.id);
  const appUserId = asString(event.app_user_id) ?? asString(event.original_app_user_id);
  if (eventId === null || appUserId === null) return null;

  const rawType = asString(event.type) ?? '';
  let type = REVENUECAT_EVENT_TYPES[rawType] ?? 'UNHANDLED';

  // RevenueCat folds refunds into CANCELLATION and distinguishes them only by
  // the reason. A refund revokes access now; a plain cancellation does not.
  if (type === 'CANCELLATION' && asString(event.cancel_reason) === 'CUSTOMER_SUPPORT') {
    type = 'REFUND';
  }
  if (rawType === 'PRODUCT_CHANGE') {
    type = isDowngrade(event, context) ? 'DOWNGRADE' : 'UPGRADE';
  }

  const productId = asString(event.new_product_id) ?? asString(event.product_id);
  const store = asString(event.store) ?? '';

  return finish({
    eventId,
    provider: 'revenuecat',
    type,
    appUserId,
    userId: asUserId(appUserId) ?? asUserId(event.original_app_user_id),
    source: REVENUECAT_STORE_SOURCES[store] ?? 'NONE',
    originalTransactionId:
      asString(event.original_transaction_id) ?? asString(event.transaction_id),
    productId,
    plan: planFor(productId, context),
    environment: asString(event.environment) === 'SANDBOX' ? 'SANDBOX' : 'PRODUCTION',
    expiresAt: isoFromMillis(event.expiration_at_ms),
    gracePeriodEndsAt: isoFromMillis(event.grace_period_expiration_at_ms),
    willRenew: null,
    occurredAt: isoFromMillis(event.event_timestamp_ms) ?? context.now().toISOString(),
  });
}

function isDowngrade(event: Record<string, unknown>, context: NormalizeContext): boolean {
  const from = planFor(asString(event.product_id), context);
  const to = planFor(asString(event.new_product_id), context);
  if (from === null || to === null) return false;
  return PLAN_RANK[to] < PLAN_RANK[from];
}

/** Ordering used only to tell an upgrade from a downgrade. */
export const PLAN_RANK: Record<Plan, number> = {
  FREE: 0,
  FAMILY_MONTHLY: 1,
  FAMILY_ANNUAL: 2,
  FAMILY_PLUS_MONTHLY: 3,
  FAMILY_PLUS_ANNUAL: 4,
};

// ---------------------------------------------------------------------------
// Apple App Store Server Notifications V2
// ---------------------------------------------------------------------------

export function normalizeAppleNotification(
  payload: Record<string, unknown>,
  context: NormalizeContext,
): SubscriptionEvent | null {
  const notificationType = asString(payload.notificationType);
  const subtype = asString(payload.subtype);
  const notificationUuid = asString(payload.notificationUUID);
  if (notificationType === null || notificationUuid === null) return null;

  const data = asRecord(payload.data);
  const signedTransaction = asString(data?.signedTransactionInfo);
  const signedRenewal = asString(data?.signedRenewalInfo);
  const transaction =
    signedTransaction === null ? null : decodeVerifiedNestedJws(signedTransaction);
  const renewal = signedRenewal === null ? null : decodeVerifiedNestedJws(signedRenewal);

  const type = appleEventType(notificationType, subtype);
  const productId = asString(transaction?.productId) ?? asString(renewal?.autoRenewProductId);
  const originalTransactionId = asString(transaction?.originalTransactionId);

  // `appAccountToken` is the one place Apple carries our own identifier.
  const appAccountToken = asString(transaction?.appAccountToken);

  const autoRenewStatus = renewal?.autoRenewStatus;
  const willRenew =
    typeof autoRenewStatus === 'number'
      ? autoRenewStatus === 1
      : notificationType === 'DID_CHANGE_RENEWAL_STATUS'
        ? subtype === 'AUTO_RENEW_ENABLED'
        : null;

  return finish({
    eventId: notificationUuid,
    provider: 'apple',
    type,
    appUserId: appAccountToken ?? originalTransactionId ?? notificationUuid,
    userId: asUserId(appAccountToken),
    source: 'APP_STORE',
    originalTransactionId,
    productId,
    plan: planFor(productId, context),
    environment: asString(data?.environment) === 'Sandbox' ? 'SANDBOX' : 'PRODUCTION',
    expiresAt: isoFromMillis(transaction?.expiresDate),
    gracePeriodEndsAt: isoFromMillis(renewal?.gracePeriodExpiresDate),
    willRenew,
    occurredAt: isoFromMillis(payload.signedDate) ?? context.now().toISOString(),
  });
}

function appleEventType(notificationType: string, subtype: string | null): SubscriptionEventType {
  switch (notificationType) {
    case 'SUBSCRIBED':
      return subtype === 'RESUBSCRIBE' ? 'RESTORE' : 'PURCHASE';
    case 'DID_RENEW':
      return 'RENEWAL';
    case 'DID_CHANGE_RENEWAL_STATUS':
      return subtype === 'AUTO_RENEW_DISABLED' ? 'CANCELLATION' : 'RESUMED';
    case 'DID_CHANGE_RENEWAL_PREF':
      return subtype === 'DOWNGRADE' ? 'DOWNGRADE' : 'UPGRADE';
    case 'DID_FAIL_TO_RENEW':
      // With a grace period the customer keeps access; without one, Apple is
      // retrying billing and access continues until it gives up.
      return subtype === 'GRACE_PERIOD' ? 'GRACE_PERIOD_STARTED' : 'BILLING_RETRY_STARTED';
    case 'EXPIRED':
    case 'GRACE_PERIOD_EXPIRED':
      return 'EXPIRATION';
    case 'REFUND':
      return 'REFUND';
    case 'REVOKE':
      return 'REVOCATION';
    case 'RENEWAL_EXTENDED':
    case 'OFFER_REDEEMED':
      return 'RENEWAL';
    default:
      return 'UNHANDLED';
  }
}

// ---------------------------------------------------------------------------
// Google Play Real-Time Developer Notifications
// ---------------------------------------------------------------------------

const GOOGLE_NOTIFICATION_TYPES: Readonly<Record<number, SubscriptionEventType>> = {
  1: 'RESUMED', // SUBSCRIPTION_RECOVERED
  2: 'RENEWAL', // SUBSCRIPTION_RENEWED
  3: 'CANCELLATION', // SUBSCRIPTION_CANCELED
  4: 'PURCHASE', // SUBSCRIPTION_PURCHASED
  5: 'BILLING_RETRY_STARTED', // SUBSCRIPTION_ON_HOLD
  6: 'GRACE_PERIOD_STARTED', // SUBSCRIPTION_IN_GRACE_PERIOD
  7: 'RESTORE', // SUBSCRIPTION_RESTARTED
  8: 'UNHANDLED', // SUBSCRIPTION_PRICE_CHANGE_CONFIRMED
  9: 'UNHANDLED', // SUBSCRIPTION_DEFERRED
  10: 'PAUSED', // SUBSCRIPTION_PAUSED
  11: 'UNHANDLED', // SUBSCRIPTION_PAUSE_SCHEDULE_CHANGED
  12: 'REVOCATION', // SUBSCRIPTION_REVOKED
  13: 'EXPIRATION', // SUBSCRIPTION_EXPIRED
  20: 'UNHANDLED', // SUBSCRIPTION_PENDING_PURCHASE_CANCELED
};

export function normalizeGoogleNotification(
  message: Record<string, unknown>,
  context: NormalizeContext,
  messageId: string,
): SubscriptionEvent | null {
  const packageName = asString(message.packageName) ?? 'unknown';
  const environment: StoreEnvironment =
    message.testNotification !== undefined ? 'SANDBOX' : 'PRODUCTION';

  const voided = asRecord(message.voidedPurchaseNotification);
  if (voided !== null) {
    const purchaseToken = asString(voided.purchaseToken);
    return finish({
      eventId: messageId,
      provider: 'google',
      type: 'REFUND',
      appUserId: purchaseToken ?? packageName,
      userId: null,
      source: 'PLAY_STORE',
      originalTransactionId: purchaseToken,
      productId: null,
      plan: null,
      environment,
      expiresAt: null,
      gracePeriodEndsAt: null,
      willRenew: false,
      occurredAt: isoFromMillis(message.eventTimeMillis) ?? context.now().toISOString(),
    });
  }

  const subscription = asRecord(message.subscriptionNotification);
  if (subscription === null) return null;

  const notificationType =
    typeof subscription.notificationType === 'number' ? subscription.notificationType : -1;
  const productId = asString(subscription.subscriptionId);
  const purchaseToken = asString(subscription.purchaseToken);

  return finish({
    eventId: messageId,
    provider: 'google',
    type: GOOGLE_NOTIFICATION_TYPES[notificationType] ?? 'UNHANDLED',
    // Play does not carry our user id; the purchase token is the join key and
    // the worker resolves the account from the stored record.
    appUserId: purchaseToken ?? packageName,
    userId: null,
    source: 'PLAY_STORE',
    originalTransactionId: purchaseToken,
    productId,
    plan: planFor(productId, context),
    environment,
    expiresAt: null,
    gracePeriodEndsAt: null,
    willRenew: null,
    occurredAt: isoFromMillis(message.eventTimeMillis) ?? context.now().toISOString(),
  });
}
