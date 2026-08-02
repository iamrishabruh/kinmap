import { PLAN_TIER, type PlanTier, type UserId } from '@family/contracts';

import type { SubscriptionEvent } from './events.js';
import type {
  IdempotencyStore,
  InventoryReader,
  NotificationCommandPublisher,
  ReadOnlyMarker,
  SubscriptionEventPublisher,
  SubscriptionStore,
} from './ports.js';
import {
  applySubscriptionEvent,
  planReadOnlyMarking,
  resolveEffectiveSubscription,
  type EffectiveSubscription,
  type ReadOnlyPlan,
  type SubscriptionState,
} from './reconcile.js';

/**
 * The two halves of the subscription flow.
 *
 * INGEST — a verified webhook, normalised, deduplicated on the provider's own
 * event id and queued. Nothing is applied inline: a store outage or a slow
 * DynamoDB write must never turn into a webhook timeout and a provider retry
 * storm.
 *
 * APPLY — a queued event folded into the stored record, after which entitlements
 * are re-derived from that record and any excess data is marked read-only.
 */

export type IngestDeps = {
  readonly idempotency: IdempotencyStore;
  readonly events: SubscriptionEventPublisher;
  readonly idempotencyTtlSeconds: number;
};

export type IngestResult = 'ENQUEUED' | 'DUPLICATE';

export async function ingestSubscriptionEvent(
  event: SubscriptionEvent,
  deps: IngestDeps,
): Promise<IngestResult> {
  const claimed = await deps.idempotency.claim({
    key: `subscription:${event.provider}:${event.eventId}`,
    ttlSeconds: deps.idempotencyTtlSeconds,
  });
  if (!claimed) return 'DUPLICATE';

  await deps.events.publish([event]);
  return 'ENQUEUED';
}

export type ApplyDeps = {
  readonly subscriptions: SubscriptionStore;
  readonly inventory: InventoryReader;
  readonly readOnly: ReadOnlyMarker;
  readonly notifications: NotificationCommandPublisher;
  readonly newCommandId: () => string;
  readonly now: () => Date;
};

export type ApplyReport = {
  readonly userId: UserId | null;
  readonly applied: boolean;
  readonly reason: 'DUPLICATE' | 'OUT_OF_ORDER' | 'NO_PLAN' | 'UNRESOLVED_ACCOUNT' | null;
  readonly tierBefore: PlanTier;
  readonly tierAfter: PlanTier;
  readonly readOnlyPlan: ReadOnlyPlan | null;
  readonly effective: EffectiveSubscription | null;
};

export async function applySubscriptionEventToStore(
  event: SubscriptionEvent,
  deps: ApplyDeps,
): Promise<ApplyReport> {
  const now = deps.now();

  // --- Resolve the account ------------------------------------------------
  // The webhook's own claim about who this is is only trusted when it is one of
  // our user ids; otherwise the store's transaction id is looked up against the
  // record we already hold.
  const state = await resolveState(event, deps.subscriptions);
  const userId = event.userId ?? state?.userId ?? null;
  if (userId === null) {
    return {
      userId: null,
      applied: false,
      reason: 'UNRESOLVED_ACCOUNT',
      tierBefore: 'FREE',
      tierAfter: 'FREE',
      readOnlyPlan: null,
      effective: null,
    };
  }

  const before = resolveEffectiveSubscription(state, now);

  const outcome = applySubscriptionEvent(
    state ?? { userId, platforms: [], updatedAt: now.toISOString() },
    { ...event, userId },
    { now },
  );

  if (!outcome.changed) {
    return {
      userId,
      applied: false,
      reason: outcome.ignored,
      tierBefore: before.tier,
      tierAfter: before.tier,
      readOnlyPlan: null,
      effective: before,
    };
  }

  // --- Entitlements ALWAYS from the stored record --------------------------
  const effective = resolveEffectiveSubscription(outcome.state, now);

  // --- Downgrade marks excess read-only; it never deletes ------------------
  const inventory = await deps.inventory.load({ userId });
  const readOnlyPlan = planReadOnlyMarking(effective.entitlements, inventory);
  if (hasWork(readOnlyPlan)) {
    await deps.readOnly.apply(readOnlyPlan);
  }

  await deps.subscriptions.save({ state: outcome.state, effective });

  await publishBillingNotice(userId, before, effective, deps);

  return {
    userId,
    applied: true,
    reason: null,
    tierBefore: before.tier,
    tierAfter: effective.tier,
    readOnlyPlan,
    effective,
  };
}

/**
 * Periodic sweep. Re-derives entitlements from the stored record with no store
 * round-trip, which closes the gap left by a webhook the provider never
 * delivered: an expiry that already passed takes effect here.
 */
export async function reconcileUserEntitlements(
  userId: UserId,
  deps: ApplyDeps,
): Promise<ApplyReport> {
  const now = deps.now();
  const state = await deps.subscriptions.getByUser({ userId });
  if (state === null) {
    return {
      userId,
      applied: false,
      reason: 'UNRESOLVED_ACCOUNT',
      tierBefore: 'FREE',
      tierAfter: 'FREE',
      readOnlyPlan: null,
      effective: null,
    };
  }

  const effective = resolveEffectiveSubscription(state, now);
  const inventory = await deps.inventory.load({ userId });
  const readOnlyPlan = planReadOnlyMarking(effective.entitlements, inventory);
  if (hasWork(readOnlyPlan)) {
    await deps.readOnly.apply(readOnlyPlan);
  }
  await deps.subscriptions.save({ state, effective });

  return {
    userId,
    applied: true,
    reason: null,
    tierBefore: effective.tier,
    tierAfter: effective.tier,
    readOnlyPlan,
    effective,
  };
}

async function resolveState(
  event: SubscriptionEvent,
  subscriptions: SubscriptionStore,
): Promise<SubscriptionState | null> {
  if (event.userId !== null) {
    const byUser = await subscriptions.getByUser({ userId: event.userId });
    if (byUser !== null) return byUser;
  }
  if (event.originalTransactionId !== null) {
    return await subscriptions.findByOriginalTransactionId({
      originalTransactionId: event.originalTransactionId,
    });
  }
  return null;
}

function hasWork(plan: ReadOnlyPlan): boolean {
  return (
    plan.placesToMarkReadOnly.length > 0 ||
    plan.placesToRestore.length > 0 ||
    plan.membersToMarkReadOnly.length > 0 ||
    plan.membersToRestore.length > 0
  );
}

const TIER_RANK: Record<PlanTier, number> = { FREE: 0, FAMILY: 1, FAMILY_PLUS: 2 };

/**
 * Tells the payer, and only the payer, that something needs their attention.
 * The command carries ids only; the notification worker renders and re-authorises.
 */
async function publishBillingNotice(
  userId: UserId,
  before: EffectiveSubscription,
  after: EffectiveSubscription,
  deps: ApplyDeps,
): Promise<void> {
  const atRisk = after.status === 'IN_GRACE_PERIOD' || after.status === 'IN_BILLING_RETRY';
  const downgraded = TIER_RANK[after.tier] < TIER_RANK[before.tier];
  if (!atRisk && !downgraded) return;

  await deps.notifications.publish([
    {
      commandId: deps.newCommandId(),
      kind: 'SUBSCRIPTION_EXPIRING',
      familyId: null,
      subjectUserId: null,
      recipientUserIds: [userId],
      placeId: null,
      transition: null,
      liveSessionId: null,
      occurredAt: deps.now().toISOString(),
      sourceEventId: `subscription:${userId}:${after.status}:${String(PLAN_TIER[after.plan])}`,
    },
  ]);
}
