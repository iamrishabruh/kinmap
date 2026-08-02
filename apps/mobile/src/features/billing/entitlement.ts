import {
  ENTITLEMENTS,
  ENTITLED_SUBSCRIPTION_STATUSES,
  type Entitlements,
  type PlanTier,
  type SubscriptionStatus,
} from '@family/contracts';

import type { ServerEntitlements } from '../settings/api/contracts';

/**
 * What the user is told they have.
 *
 * THE RULE, AND WHY
 * -----------------
 * `GET /v1/subscriptions/entitlements` is the only authority. The RevenueCat
 * SDK's `CustomerInfo` is a *hint* and nothing more, for three reasons:
 *
 *   - it is a client-side value on a device the user controls, so it is not a
 *     basis for granting anything;
 *   - it reflects the store's view, which can be ahead of ours (a purchase
 *     whose webhook has not landed) or behind it (a refund, a chargeback, a
 *     family-sharing revocation, a promotional grant issued by support);
 *   - the server enforces the limits in `ENTITLEMENTS` regardless of what the
 *     client believes, so a client that shows more than the server will grant
 *     produces a user who is told they can add a seventh family member and then
 *     gets an error when they try.
 *
 * So: when the server has spoken, its answer is displayed. When it has not, the
 * hint may be displayed but is explicitly labelled as unconfirmed, and the UI
 * must not use it to unlock anything irreversible.
 */

export type EntitlementSource =
  /** Authoritative: came from GET /v1/subscriptions/entitlements. */
  | 'SERVER'
  /** Unconfirmed: the RevenueCat client value, shown while the server is unreachable. */
  | 'CLIENT_HINT'
  /** Nothing known. Treated as FREE and said so. */
  | 'NONE';

/** The RevenueCat-derived view. Deliberately a separate, narrower type. */
export type ClientEntitlementHint = {
  tier: PlanTier;
  activeEntitlementIds: readonly string[];
  willRenew: boolean;
  expiresAt: string | null;
  /** Store-provided subscription management URL, when the SDK knows one. */
  managementUrl: string | null;
  observedAt: string;
};

export type EntitlementView = {
  /** The tier to render and to gate UI on. */
  tier: PlanTier;
  entitlements: Entitlements;
  source: EntitlementSource;
  /**
   * True when `tier` is not server-confirmed. Screens must not use a
   * provisional tier to unlock a paid action, only to avoid flashing "Free" at
   * a paying user.
   */
  isProvisional: boolean;
  /**
   * True when the store client and the server disagree. Triggers a sync so the
   * server can re-read the receipt, rather than silently trusting the client.
   */
  needsServerSync: boolean;
  status: SubscriptionStatus | null;
  willRenew: boolean;
  renewsAt: string | null;
  expiresAt: string | null;
  isInGracePeriod: boolean;
  store: ServerEntitlements['store'] | 'UNKNOWN';
  /** User-facing sentence explaining an unconfirmed or disputed state. */
  notice: string | null;
};

/** Privilege ordering. Never used for anything but comparison. */
const TIER_RANK: Record<PlanTier, number> = {
  FREE: 0,
  FAMILY: 1,
  FAMILY_PLUS: 2,
};

export function compareTiers(a: PlanTier, b: PlanTier): number {
  return TIER_RANK[a] - TIER_RANK[b];
}

export function isUpgrade(from: PlanTier, to: PlanTier): boolean {
  return compareTiers(to, from) > 0;
}

export function isDowngrade(from: PlanTier, to: PlanTier): boolean {
  return compareTiers(to, from) < 0;
}

/**
 * RevenueCat entitlement identifier → tier. Configured at startup from the
 * dashboard's identifiers so a rename there does not need an app release to be
 * *safe*; it only affects the hint, never the server's answer.
 */
let entitlementIdToTier: Record<string, PlanTier> = {
  family: 'FAMILY',
  family_plus: 'FAMILY_PLUS',
};

export function configureEntitlementMapping(mapping: Record<string, PlanTier>): void {
  entitlementIdToTier = { ...mapping };
}

export function getEntitlementMapping(): Readonly<Record<string, PlanTier>> {
  return entitlementIdToTier;
}

/** Highest tier implied by a set of active RevenueCat entitlement identifiers. */
export function tierFromEntitlementIds(ids: readonly string[]): PlanTier {
  return ids.reduce<PlanTier>((best, id) => {
    const tier = entitlementIdToTier[id];
    if (!tier) return best;
    return compareTiers(tier, best) > 0 ? tier : best;
  }, 'FREE');
}

/**
 * The one function that decides what the user sees.
 *
 * Server first, always. The hint is only ever consulted when the server value
 * is absent, and even then it is flagged.
 */
export function resolveEntitlementView(input: {
  server: ServerEntitlements | null;
  clientHint?: ClientEntitlementHint | null;
}): EntitlementView {
  const { server } = input;
  const clientHint = input.clientHint ?? null;

  if (server) {
    // A subscription can exist in a status that grants nothing (EXPIRED,
    // REVOKED, REFUNDED). The server already reflects that in `tier`, but we
    // re-check rather than assume, because displaying FAMILY_PLUS next to
    // "Refunded" would be incoherent.
    const statusGrants = ENTITLED_SUBSCRIPTION_STATUSES.includes(server.status);
    const tier: PlanTier = statusGrants ? server.tier : 'FREE';

    const disagrees = clientHint !== null && clientHint.tier !== tier;

    return {
      tier,
      entitlements: ENTITLEMENTS[tier],
      source: 'SERVER',
      isProvisional: false,
      needsServerSync: disagrees,
      status: server.status,
      willRenew: server.willRenew,
      renewsAt: server.renewsAt,
      expiresAt: server.expiresAt,
      isInGracePeriod: server.isInGracePeriod,
      store: server.store,
      notice: disagrees
        ? 'Your store account shows a different plan. We are checking with the store — this usually resolves within a few minutes.'
        : null,
    };
  }

  if (clientHint) {
    return {
      tier: clientHint.tier,
      entitlements: ENTITLEMENTS[clientHint.tier],
      source: 'CLIENT_HINT',
      isProvisional: true,
      needsServerSync: true,
      status: null,
      willRenew: clientHint.willRenew,
      renewsAt: null,
      expiresAt: clientHint.expiresAt,
      isInGracePeriod: false,
      store: 'UNKNOWN',
      notice:
        'We could not reach our servers, so this is what your store account says. We will confirm it as soon as you are back online.',
    };
  }

  return {
    tier: 'FREE',
    entitlements: ENTITLEMENTS.FREE,
    source: 'NONE',
    isProvisional: true,
    needsServerSync: true,
    status: null,
    willRenew: false,
    renewsAt: null,
    expiresAt: null,
    isInGracePeriod: false,
    store: 'UNKNOWN',
    notice: 'We could not check your plan. Pull down to try again.',
  };
}

/**
 * Whether a paid action may be unlocked. Deliberately stricter than what is
 * displayed: an unconfirmed tier is never enough to spend a seat or start a
 * live session, because the server will reject it anyway and the user deserves
 * a clear reason rather than a failed action.
 */
export function canUnlockPaidFeature(view: EntitlementView, required: PlanTier): boolean {
  if (view.isProvisional) return false;
  return compareTiers(view.tier, required) >= 0;
}

export function describeStatus(view: EntitlementView): string {
  if (view.source === 'NONE') return 'Plan unknown';
  if (view.isProvisional) return `${TIER_LABELS[view.tier]} (not yet confirmed)`;

  switch (view.status) {
    case 'IN_GRACE_PERIOD':
      return `${TIER_LABELS[view.tier]} — payment problem`;
    case 'IN_BILLING_RETRY':
      return `${TIER_LABELS[view.tier]} — retrying payment`;
    case 'CANCELLED':
      return `${TIER_LABELS[view.tier]} — cancelled`;
    case 'PAUSED':
      return `${TIER_LABELS[view.tier]} — paused`;
    case 'EXPIRED':
    case 'REVOKED':
    case 'REFUNDED':
      return TIER_LABELS.FREE;
    default:
      return TIER_LABELS[view.tier];
  }
}

export const TIER_LABELS: Record<PlanTier, string> = {
  FREE: 'Free',
  FAMILY: 'Family',
  FAMILY_PLUS: 'Family Plus',
};

/** Plain-language list of what a tier includes, for the plan cards. */
export function describeTierBenefits(tier: PlanTier): string[] {
  const entitlements = ENTITLEMENTS[tier];
  const benefits = [
    `Up to ${entitlements.maxMembersPerFamily} people in a family`,
    entitlements.maxFamilies === 1 ? 'One family' : `Up to ${entitlements.maxFamilies} families`,
    `${entitlements.maxSavedPlaces} saved place${entitlements.maxSavedPlaces === 1 ? '' : 's'}`,
    entitlements.historyRetentionDays === 0
      ? 'No location history kept'
      : `${entitlements.historyRetentionDays} days of location history`,
    entitlements.liveSessionsEnabled
      ? 'Live location for short trips'
      : 'Live location not included',
  ];
  if (entitlements.arrivalDepartureAlerts) benefits.push('Arrival and departure alerts');
  if (entitlements.prioritySupport) benefits.push('Priority support');
  return benefits;
}
