import {
  ENTITLED_SUBSCRIPTION_STATUSES,
  ENTITLEMENTS,
  PLAN_TIER,
  type Entitlements,
  type PlanTier,
} from '@family/contracts';

import type { EntitlementSnapshot, SubscriptionRecord } from './types.js';

/**
 * Server-authoritative entitlement resolution (spec §23).
 *
 * A client-supplied plan or receipt is never an input here: the tier is derived
 * from the stored subscription row, and anything that is not currently in an
 * entitled status collapses to FREE.
 */
export function resolveEntitlements(subscription: SubscriptionRecord | null): EntitlementSnapshot {
  const tier: PlanTier =
    subscription !== null && ENTITLED_SUBSCRIPTION_STATUSES.includes(subscription.status)
      ? PLAN_TIER[subscription.plan]
      : 'FREE';

  return { tier, entitlements: ENTITLEMENTS[tier] };
}

/** Convenience predicate for the history feature gate. */
export function historyEnabled(entitlements: Entitlements): boolean {
  return entitlements.historyRetentionDays > 0;
}

/** Convenience predicate for the live-session feature gate. */
export function liveSessionsEnabled(entitlements: Entitlements): boolean {
  return entitlements.liveSessionsEnabled;
}
