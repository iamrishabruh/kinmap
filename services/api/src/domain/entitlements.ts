import { resolveEntitlements } from '@family/auth';
import { type UserId } from '@family/contracts';
import type { EntitlementsResponse } from '@family/schemas';

import type { SubscriptionRecord } from '../repositories/subscriptions.js';

/**
 * Entitlements are always re-derived from the stored subscription row.
 *
 * A receipt, a product id or a cached tier presented by the client is never an
 * input: the only way a paid feature turns on is a subscription row written by
 * the billing service from a provider webhook it has verified (spec §23). A row
 * that is not in an entitled status collapses to FREE, which is what
 * `resolveEntitlements` encodes.
 */
export function projectEntitlements(input: {
  userId: UserId;
  subscription: SubscriptionRecord | null;
  now: Date;
}): EntitlementsResponse {
  const snapshot = resolveEntitlements(
    input.subscription === null
      ? null
      : {
          // `resolveEntitlements` derives the tier from plan and status alone;
          // the family id is carried only for the caller's own bookkeeping, so a
          // personal subscription with no family attached resolves identically.
          familyId: input.subscription.familyId ?? input.userId,
          plan: input.subscription.plan,
          status: input.subscription.status,
        },
  );

  const subscription = input.subscription;
  return {
    userId: input.userId,
    plan: subscription?.plan ?? 'FREE',
    tier: snapshot.tier,
    status: subscription?.status ?? 'EXPIRED',
    source: subscription?.source ?? 'NONE',
    entitlements: snapshot.entitlements,
    isTrial: subscription?.isTrial ?? false,
    currentPeriodEndsAt: subscription?.currentPeriodEndsAt ?? null,
    gracePeriodEndsAt: subscription?.gracePeriodEndsAt ?? null,
    willRenew: subscription?.willRenew ?? false,
    managementUrl: subscription?.managementUrl ?? null,
    refreshedAt: subscription?.refreshedAt ?? input.now.toISOString(),
  };
}
