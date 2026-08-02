import { resolveEntitlements } from '@family/auth';
import {
  FAMILY_ROLE_RANK,
  PLAN_TIER,
  type Entitlements,
  type FamilyId,
  type FamilyRole,
  type Plan,
  type PlanTier,
  type PlaceId,
  type SubscriptionStatus,
  type UserId,
} from '@family/contracts';
import type { SubscriptionSource } from '@family/schemas';

import type { StoreEnvironment, SubscriptionEvent } from './events.js';

/**
 * Entitlement reconciliation (spec §23).
 *
 * The governing rule: entitlements are ALWAYS re-derived from the stored
 * record, never taken from the event. A webhook can say "this user bought
 * FAMILY_PLUS"; it cannot say "this user is entitled to FAMILY_PLUS". The event
 * updates the record; `resolveEffectiveSubscription` then derives the tier from
 * that record using PLAN_TIER and ENTITLEMENTS, applying expiry as it goes. A
 * forged or replayed event therefore cannot grant anything a stored, expired
 * record would not already grant.
 *
 * The second rule: a downgrade never deletes. Losing a payment method must not
 * destroy a family's saved places. Excess data is marked READ-ONLY, which the
 * API refuses to mutate but happily reads, and an upgrade restores it exactly.
 *
 * Everything here is pure: no clients, no clock of its own, no logging.
 */

export type PlatformSubscription = {
  readonly source: SubscriptionSource;
  readonly plan: Plan;
  readonly status: SubscriptionStatus;
  readonly productId: string | null;
  readonly originalTransactionId: string | null;
  readonly expiresAt: string | null;
  readonly gracePeriodEndsAt: string | null;
  readonly willRenew: boolean;
  readonly environment: StoreEnvironment;
  readonly lastEventId: string | null;
  readonly lastEventAt: string | null;
};

export type SubscriptionState = {
  readonly userId: UserId;
  /** At most one record per store. Cross-platform purchases coexist here. */
  readonly platforms: readonly PlatformSubscription[];
  readonly updatedAt: string;
};

export type ApplyOutcome = {
  readonly state: SubscriptionState;
  readonly changed: boolean;
  /** Non-null when the event was deliberately not applied. */
  readonly ignored: 'DUPLICATE' | 'OUT_OF_ORDER' | 'NO_PLAN' | 'UNRESOLVED_ACCOUNT' | null;
};

function parseMs(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Folds one normalised event into the stored record.
 *
 * Ordering matters more than it looks: stores redeliver, and Pub/Sub in
 * particular makes no ordering promise at all. An out-of-order "expired" landing
 * after a "renewed" would silently cut off a paying customer, so an event older
 * than the one already recorded for that platform is dropped.
 */
export function applySubscriptionEvent(
  state: SubscriptionState | null,
  event: SubscriptionEvent,
  options: { readonly now: Date },
): ApplyOutcome {
  const userId = state?.userId ?? event.userId;
  if (userId === null) {
    // Nothing to attach the event to; the caller resolves the account first.
    return {
      state: state ?? { userId: '' as UserId, platforms: [], updatedAt: options.now.toISOString() },
      changed: false,
      ignored: 'UNRESOLVED_ACCOUNT',
    };
  }

  const platforms = [...(state?.platforms ?? [])];
  const index = platforms.findIndex((platform) => platform.source === event.source);
  const existing = index === -1 ? undefined : platforms[index];

  if (existing !== undefined && existing.lastEventId === event.eventId) {
    return {
      state: state ?? emptyState(userId, options.now),
      changed: false,
      ignored: 'DUPLICATE',
    };
  }

  const existingAt = parseMs(existing?.lastEventAt ?? null);
  const incomingAt = parseMs(event.occurredAt);
  if (existingAt !== null && incomingAt !== null && incomingAt < existingAt) {
    return {
      state: state ?? emptyState(userId, options.now),
      changed: false,
      ignored: 'OUT_OF_ORDER',
    };
  }

  // A plan-less event (a Play refund, an unmapped SKU) still carries lifecycle
  // truth, so it updates the status of the record it already has rather than
  // being discarded.
  const plan = event.plan ?? existing?.plan ?? null;
  if (plan === null) {
    return { state: state ?? emptyState(userId, options.now), changed: false, ignored: 'NO_PLAN' };
  }

  const next: PlatformSubscription = {
    source: event.source,
    plan,
    status: event.status,
    productId: event.productId ?? existing?.productId ?? null,
    originalTransactionId: event.originalTransactionId ?? existing?.originalTransactionId ?? null,
    expiresAt: event.expiresAt ?? existing?.expiresAt ?? null,
    gracePeriodEndsAt: event.gracePeriodEndsAt,
    willRenew: event.willRenew,
    environment: event.environment,
    lastEventId: event.eventId,
    lastEventAt: event.occurredAt,
  };

  if (index === -1) {
    platforms.push(next);
  } else {
    platforms[index] = next;
  }

  return {
    state: { userId, platforms, updatedAt: options.now.toISOString() },
    changed: true,
    ignored: null,
  };
}

function emptyState(userId: UserId, now: Date): SubscriptionState {
  return { userId, platforms: [], updatedAt: now.toISOString() };
}

export type EffectiveSubscription = {
  readonly plan: Plan;
  readonly tier: PlanTier;
  readonly status: SubscriptionStatus;
  readonly source: SubscriptionSource;
  readonly entitlements: Entitlements;
  readonly expiresAt: string | null;
  readonly gracePeriodEndsAt: string | null;
  readonly willRenew: boolean;
};

const TIER_RANK: Record<PlanTier, number> = { FREE: 0, FAMILY: 1, FAMILY_PLUS: 2 };

/**
 * The status a stored platform record actually has *right now*.
 *
 * A record can sit at ACTIVE forever if the "expired" notification was never
 * delivered — stores drop webhooks. Applying the recorded expiry here is what
 * makes the scheduled reconciliation sweep able to close that gap without any
 * store round-trip.
 */
export function effectiveStatus(platform: PlatformSubscription, now: Date): SubscriptionStatus {
  const instant = now.getTime();

  if (platform.status === 'IN_GRACE_PERIOD') {
    const graceEnd = parseMs(platform.gracePeriodEndsAt);
    if (graceEnd !== null && graceEnd <= instant) return 'EXPIRED';
    return 'IN_GRACE_PERIOD';
  }

  if (platform.status === 'ACTIVE' || platform.status === 'IN_BILLING_RETRY') {
    const expiry = parseMs(platform.expiresAt);
    if (expiry !== null && expiry <= instant) return 'EXPIRED';
  }

  return platform.status;
}

/**
 * Cross-platform reconciliation.
 *
 * A user who bought on iOS, switched to Android and never cancelled the first
 * has two live records. They get the better of the two — charging twice and
 * granting once would be indefensible — with a later expiry breaking a tie.
 */
export function resolveEffectiveSubscription(
  state: SubscriptionState | null,
  now: Date,
): EffectiveSubscription {
  const free = freeSubscription();
  if (state === null || state.platforms.length === 0) return free;

  let best: { platform: PlatformSubscription; status: SubscriptionStatus } | null = null;

  for (const platform of state.platforms) {
    const status = effectiveStatus(platform, now);
    const snapshot = resolveEntitlements({
      familyId: '' as FamilyId,
      plan: platform.plan,
      status,
    });
    if (snapshot.tier === 'FREE') continue;

    if (best === null) {
      best = { platform, status };
      continue;
    }

    const bestTier = PLAN_TIER[best.platform.plan];
    const candidateTier = PLAN_TIER[platform.plan];
    if (TIER_RANK[candidateTier] > TIER_RANK[bestTier]) {
      best = { platform, status };
      continue;
    }
    if (TIER_RANK[candidateTier] === TIER_RANK[bestTier]) {
      const bestExpiry = parseMs(best.platform.expiresAt) ?? 0;
      const candidateExpiry = parseMs(platform.expiresAt) ?? 0;
      if (candidateExpiry > bestExpiry) best = { platform, status };
    }
  }

  if (best === null) {
    // Nothing is entitled. Report the most recently touched record's status so
    // the app can explain *why* the user is on FREE, while the entitlements
    // themselves come from the FREE row of the contract table.
    const latest = [...state.platforms].sort(
      (a, b) => (parseMs(b.lastEventAt) ?? 0) - (parseMs(a.lastEventAt) ?? 0),
    )[0];
    if (latest === undefined) return free;
    return {
      ...free,
      status: effectiveStatus(latest, now),
      source: latest.source,
      expiresAt: latest.expiresAt,
      gracePeriodEndsAt: latest.gracePeriodEndsAt,
      willRenew: latest.willRenew,
    };
  }

  const snapshot = resolveEntitlements({
    familyId: '' as FamilyId,
    plan: best.platform.plan,
    status: best.status,
  });

  return {
    plan: best.platform.plan,
    tier: snapshot.tier,
    status: best.status,
    source: best.platform.source,
    entitlements: snapshot.entitlements,
    expiresAt: best.platform.expiresAt,
    gracePeriodEndsAt: best.platform.gracePeriodEndsAt,
    willRenew: best.platform.willRenew,
  };
}

function freeSubscription(): EffectiveSubscription {
  const snapshot = resolveEntitlements(null);
  return {
    plan: 'FREE',
    tier: snapshot.tier,
    status: 'EXPIRED',
    source: 'NONE',
    entitlements: snapshot.entitlements,
    expiresAt: null,
    gracePeriodEndsAt: null,
    willRenew: false,
  };
}

// ---------------------------------------------------------------------------
// Downgrade: mark read-only, never delete
// ---------------------------------------------------------------------------

export type InventoryPlace = {
  readonly placeId: PlaceId;
  readonly familyId: FamilyId;
  readonly createdAt: string;
  readonly readOnly: boolean;
};

export type InventoryMember = {
  readonly familyId: FamilyId;
  readonly userId: UserId;
  readonly role: FamilyRole;
  readonly joinedAt: string;
  readonly readOnly: boolean;
};

export type SubscriptionInventory = {
  readonly places: readonly InventoryPlace[];
  readonly members: readonly InventoryMember[];
};

/** Every entry carries its partition key, so applying a plan needs no lookup. */
export type PlaceRef = { readonly familyId: FamilyId; readonly placeId: PlaceId };
export type MemberRef = { readonly familyId: FamilyId; readonly userId: UserId };

export type ReadOnlyPlan = {
  readonly placesToMarkReadOnly: PlaceRef[];
  readonly placesToRestore: PlaceRef[];
  readonly membersToMarkReadOnly: MemberRef[];
  readonly membersToRestore: MemberRef[];
};

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const bucket = groups.get(key(item));
    if (bucket === undefined) groups.set(key(item), [item]);
    else bucket.push(item);
  }
  return groups;
}

/**
 * Decides what a plan change makes read-only and what it restores.
 *
 * The oldest entries are always the ones kept, which makes the result stable:
 * running this twice, or running it after an unrelated write, produces exactly
 * the same set. A user who downgrades and immediately upgrades again gets their
 * data back untouched, because nothing was ever removed.
 */
export function planReadOnlyMarking(
  entitlements: Entitlements,
  inventory: SubscriptionInventory,
): ReadOnlyPlan {
  const placesToMarkReadOnly: PlaceRef[] = [];
  const placesToRestore: PlaceRef[] = [];
  const membersToMarkReadOnly: MemberRef[] = [];
  const membersToRestore: MemberRef[] = [];

  for (const [, places] of groupBy(inventory.places, (place) => place.familyId)) {
    const ordered = [...places].sort(
      (a, b) =>
        Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.placeId.localeCompare(b.placeId),
    );
    ordered.forEach((place, position) => {
      const shouldBeReadOnly = position >= entitlements.maxSavedPlaces;
      const ref: PlaceRef = { familyId: place.familyId, placeId: place.placeId };
      if (shouldBeReadOnly && !place.readOnly) placesToMarkReadOnly.push(ref);
      if (!shouldBeReadOnly && place.readOnly) placesToRestore.push(ref);
    });
  }

  for (const [, members] of groupBy(inventory.members, (member) => member.familyId)) {
    const ordered = [...members].sort((a, b) => {
      // The owner is never the one whose access is curtailed: they are the
      // person who has to fix the billing.
      const rank = FAMILY_ROLE_RANK[b.role] - FAMILY_ROLE_RANK[a.role];
      if (rank !== 0) return rank;
      return Date.parse(a.joinedAt) - Date.parse(b.joinedAt) || a.userId.localeCompare(b.userId);
    });
    ordered.forEach((member, position) => {
      const shouldBeReadOnly = position >= entitlements.maxMembersPerFamily;
      if (shouldBeReadOnly && !member.readOnly) {
        membersToMarkReadOnly.push({ familyId: member.familyId, userId: member.userId });
      }
      if (!shouldBeReadOnly && member.readOnly) {
        membersToRestore.push({ familyId: member.familyId, userId: member.userId });
      }
    });
  }

  return { placesToMarkReadOnly, placesToRestore, membersToMarkReadOnly, membersToRestore };
}
