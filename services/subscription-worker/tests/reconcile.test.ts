import { describe, expect, it } from 'vitest';

import { ENTITLEMENTS, type FamilyId, type PlaceId, type UserId } from '@family/contracts';

import { SubscriptionEventSchema, type SubscriptionEvent } from '../src/events.js';
import {
  applySubscriptionEvent,
  effectiveStatus,
  planReadOnlyMarking,
  resolveEffectiveSubscription,
  type PlatformSubscription,
  type SubscriptionInventory,
  type SubscriptionState,
} from '../src/reconcile.js';

const USER_ID = '11111111-1111-4111-8111-111111111111' as UserId;
const FAMILY_ID = '33333333-3333-4333-8333-333333333333' as FamilyId;
const OTHER_FAMILY_ID = '44444444-4444-4444-8444-444444444444' as FamilyId;
const NOW = new Date('2026-06-01T12:00:00.000Z');

function event(overrides: Partial<SubscriptionEvent> = {}): SubscriptionEvent {
  return SubscriptionEventSchema.parse({
    eventId: 'evt-1',
    provider: 'apple',
    type: 'PURCHASE',
    appUserId: USER_ID,
    userId: USER_ID,
    source: 'APP_STORE',
    originalTransactionId: 'txn-1',
    productId: 'kinmap.family.monthly',
    plan: 'FAMILY_MONTHLY',
    status: 'ACTIVE',
    environment: 'PRODUCTION',
    expiresAt: '2026-07-01T12:00:00.000Z',
    gracePeriodEndsAt: null,
    willRenew: true,
    occurredAt: '2026-06-01T11:00:00.000Z',
    ...overrides,
  } satisfies SubscriptionEvent);
}

function platform(overrides: Partial<PlatformSubscription> = {}): PlatformSubscription {
  return {
    source: 'APP_STORE',
    plan: 'FAMILY_MONTHLY',
    status: 'ACTIVE',
    productId: 'kinmap.family.monthly',
    originalTransactionId: 'txn-1',
    expiresAt: '2026-07-01T12:00:00.000Z',
    gracePeriodEndsAt: null,
    willRenew: true,
    environment: 'PRODUCTION',
    lastEventId: 'evt-0',
    lastEventAt: '2026-05-01T00:00:00.000Z',
    ...overrides,
  };
}

function state(platforms: PlatformSubscription[]): SubscriptionState {
  return { userId: USER_ID, platforms, updatedAt: '2026-05-01T00:00:00.000Z' };
}

describe('applySubscriptionEvent', () => {
  it('records a first purchase against its store', () => {
    const outcome = applySubscriptionEvent(null, event(), { now: NOW });

    expect(outcome.changed).toBe(true);
    expect(outcome.state.platforms).toHaveLength(1);
    expect(outcome.state.platforms[0]?.plan).toBe('FAMILY_MONTHLY');
    expect(outcome.state.platforms[0]?.lastEventId).toBe('evt-1');
  });

  it('ignores a redelivered event', () => {
    const existing = state([
      platform({ lastEventId: 'evt-1', lastEventAt: '2026-06-01T11:00:00.000Z' }),
    ]);

    const outcome = applySubscriptionEvent(existing, event(), { now: NOW });

    expect(outcome.changed).toBe(false);
    expect(outcome.ignored).toBe('DUPLICATE');
  });

  it('refuses an event older than the one already recorded', () => {
    const existing = state([
      platform({ lastEventId: 'evt-9', lastEventAt: '2026-06-01T12:00:00.000Z' }),
    ]);

    const outcome = applySubscriptionEvent(
      existing,
      event({ eventId: 'evt-8', occurredAt: '2026-05-30T00:00:00.000Z', type: 'EXPIRATION' }),
      { now: NOW },
    );

    expect(outcome.changed).toBe(false);
    expect(outcome.ignored).toBe('OUT_OF_ORDER');
  });

  it('keeps one record per store rather than overwriting across stores', () => {
    const existing = state([platform()]);

    const outcome = applySubscriptionEvent(
      existing,
      event({
        eventId: 'evt-2',
        provider: 'google',
        source: 'PLAY_STORE',
        originalTransactionId: 'token-1',
        plan: 'FAMILY_PLUS_MONTHLY',
      }),
      { now: NOW },
    );

    expect(outcome.state.platforms).toHaveLength(2);
    expect(outcome.state.platforms.map((entry) => entry.source).sort()).toEqual([
      'APP_STORE',
      'PLAY_STORE',
    ]);
  });

  it('carries the previous plan forward for an event that names none', () => {
    const existing = state([platform()]);

    const outcome = applySubscriptionEvent(
      existing,
      event({
        eventId: 'evt-3',
        type: 'EXPIRATION',
        plan: null,
        productId: null,
        status: 'EXPIRED',
      }),
      { now: NOW },
    );

    expect(outcome.changed).toBe(true);
    expect(outcome.state.platforms[0]?.plan).toBe('FAMILY_MONTHLY');
    expect(outcome.state.platforms[0]?.status).toBe('EXPIRED');
  });
});

describe('effectiveStatus', () => {
  it('expires an ACTIVE record whose expiry has passed, without any webhook', () => {
    const stale = platform({ expiresAt: '2026-05-01T00:00:00.000Z' });
    expect(effectiveStatus(stale, NOW)).toBe('EXPIRED');
  });

  it('keeps an ACTIVE record with a future expiry', () => {
    expect(effectiveStatus(platform(), NOW)).toBe('ACTIVE');
  });

  it('expires a grace period once its own deadline passes', () => {
    const inGrace = platform({
      status: 'IN_GRACE_PERIOD',
      gracePeriodEndsAt: '2026-05-20T00:00:00.000Z',
    });
    expect(effectiveStatus(inGrace, NOW)).toBe('EXPIRED');

    const stillInGrace = platform({
      status: 'IN_GRACE_PERIOD',
      gracePeriodEndsAt: '2026-06-10T00:00:00.000Z',
    });
    expect(effectiveStatus(stillInGrace, NOW)).toBe('IN_GRACE_PERIOD');
  });

  it('leaves a refund or revocation alone; they are not time-based', () => {
    expect(effectiveStatus(platform({ status: 'REFUNDED' }), NOW)).toBe('REFUNDED');
    expect(effectiveStatus(platform({ status: 'REVOKED' }), NOW)).toBe('REVOKED');
  });
});

describe('resolveEffectiveSubscription', () => {
  it('derives entitlements from the stored record, not from any claim', () => {
    const effective = resolveEffectiveSubscription(state([platform()]), NOW);

    expect(effective.tier).toBe('FAMILY');
    expect(effective.entitlements).toEqual(ENTITLEMENTS.FAMILY);
  });

  it('falls back to FREE once the stored expiry has passed', () => {
    const effective = resolveEffectiveSubscription(
      state([platform({ expiresAt: '2026-01-01T00:00:00.000Z' })]),
      NOW,
    );

    expect(effective.tier).toBe('FREE');
    expect(effective.entitlements).toEqual(ENTITLEMENTS.FREE);
    // The status still explains why, so the app can say something useful.
    expect(effective.status).toBe('EXPIRED');
  });

  it('grants the better of two live cross-platform subscriptions', () => {
    const effective = resolveEffectiveSubscription(
      state([
        platform({ source: 'APP_STORE', plan: 'FAMILY_MONTHLY' }),
        platform({
          source: 'PLAY_STORE',
          plan: 'FAMILY_PLUS_ANNUAL',
          originalTransactionId: 'token-1',
        }),
      ]),
      NOW,
    );

    expect(effective.tier).toBe('FAMILY_PLUS');
    expect(effective.source).toBe('PLAY_STORE');
  });

  it('breaks a same-tier tie on the later expiry', () => {
    const effective = resolveEffectiveSubscription(
      state([
        platform({ source: 'APP_STORE', expiresAt: '2026-06-15T00:00:00.000Z' }),
        platform({
          source: 'PLAY_STORE',
          expiresAt: '2026-09-15T00:00:00.000Z',
          originalTransactionId: 'token-1',
        }),
      ]),
      NOW,
    );

    expect(effective.source).toBe('PLAY_STORE');
    expect(effective.expiresAt).toBe('2026-09-15T00:00:00.000Z');
  });

  it('still entitles a subscription in grace period or billing retry', () => {
    for (const status of ['IN_GRACE_PERIOD', 'IN_BILLING_RETRY'] as const) {
      const effective = resolveEffectiveSubscription(
        state([platform({ status, gracePeriodEndsAt: '2026-06-20T00:00:00.000Z' })]),
        NOW,
      );
      expect(effective.tier).toBe('FAMILY');
    }
  });

  it('treats a cancelled-but-unexpired subscription as still paid for', () => {
    // Auto-renew off, period end in the future: they keep what they bought.
    const effective = resolveEffectiveSubscription(state([platform({ willRenew: false })]), NOW);

    expect(effective.tier).toBe('FAMILY');
    expect(effective.willRenew).toBe(false);
  });

  it('is FREE for a user with no record at all', () => {
    expect(resolveEffectiveSubscription(null, NOW).tier).toBe('FREE');
  });
});

describe('planReadOnlyMarking (a downgrade must not delete)', () => {
  function inventory(
    placeCount: number,
    readOnlyFrom = Number.POSITIVE_INFINITY,
  ): SubscriptionInventory {
    const places = Array.from({ length: placeCount }, (_, index) => ({
      placeId: `place-${String(index).padStart(3, '0')}` as PlaceId,
      familyId: FAMILY_ID,
      createdAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
      readOnly: index >= readOnlyFrom,
    }));
    return { places, members: [] };
  }

  it('marks the newest excess read-only and keeps the oldest', () => {
    const plan = planReadOnlyMarking(ENTITLEMENTS.FREE, inventory(4));

    // FREE allows one saved place: the oldest survives, three become read-only.
    expect(plan.placesToMarkReadOnly.map((ref) => ref.placeId)).toEqual([
      'place-001',
      'place-002',
      'place-003',
    ]);
    expect(plan.placesToRestore).toHaveLength(0);
  });

  it('restores everything on the way back up', () => {
    const plan = planReadOnlyMarking(ENTITLEMENTS.FAMILY, inventory(4, 1));

    expect(plan.placesToMarkReadOnly).toHaveLength(0);
    expect(plan.placesToRestore.map((ref) => ref.placeId)).toEqual([
      'place-001',
      'place-002',
      'place-003',
    ]);
  });

  it('is idempotent: re-running against the marked state proposes nothing', () => {
    const first = planReadOnlyMarking(ENTITLEMENTS.FREE, inventory(4));
    expect(first.placesToMarkReadOnly).toHaveLength(3);

    const second = planReadOnlyMarking(ENTITLEMENTS.FREE, inventory(4, 1));
    expect(second.placesToMarkReadOnly).toHaveLength(0);
    expect(second.placesToRestore).toHaveLength(0);
  });

  it('scopes the allowance per family', () => {
    const places = [
      ...inventory(2).places,
      {
        placeId: 'other-000' as PlaceId,
        familyId: OTHER_FAMILY_ID,
        createdAt: '2026-01-01T00:00:00.000Z',
        readOnly: false,
      },
    ];

    const plan = planReadOnlyMarking(ENTITLEMENTS.FREE, { places, members: [] });

    expect(plan.placesToMarkReadOnly.map((ref) => ref.placeId)).toEqual(['place-001']);
  });

  it('never curtails the owner, who is the person who has to fix the billing', () => {
    const members = [
      {
        familyId: FAMILY_ID,
        userId: 'zzzz-owner' as UserId,
        role: 'OWNER' as const,
        joinedAt: '2026-12-01T00:00:00.000Z',
        readOnly: false,
      },
      {
        familyId: FAMILY_ID,
        userId: 'aaaa-member' as UserId,
        role: 'MEMBER' as const,
        joinedAt: '2026-01-01T00:00:00.000Z',
        readOnly: false,
      },
      {
        familyId: FAMILY_ID,
        userId: 'bbbb-member' as UserId,
        role: 'MEMBER' as const,
        joinedAt: '2026-02-01T00:00:00.000Z',
        readOnly: false,
      },
    ];

    // FREE allows two members per family.
    const plan = planReadOnlyMarking(ENTITLEMENTS.FREE, { places: [], members });

    expect(plan.membersToMarkReadOnly.map((ref) => ref.userId)).toEqual(['bbbb-member']);
  });

  it('proposes nothing when everything already fits', () => {
    const plan = planReadOnlyMarking(ENTITLEMENTS.FAMILY_PLUS, inventory(10));
    expect(plan.placesToMarkReadOnly).toHaveLength(0);
    expect(plan.placesToRestore).toHaveLength(0);
  });
});
