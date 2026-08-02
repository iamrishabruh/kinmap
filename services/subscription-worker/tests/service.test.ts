import { beforeEach, describe, expect, it } from 'vitest';

import { ENTITLEMENTS, type FamilyId, type PlaceId, type UserId } from '@family/contracts';

import { SubscriptionEventSchema, type SubscriptionEvent } from '../src/events.js';
import type {
  IdempotencyStore,
  InventoryReader,
  NotificationCommandPublisher,
  ReadOnlyMarker,
  SubscriptionEventPublisher,
  SubscriptionStore,
} from '../src/ports.js';
import type {
  EffectiveSubscription,
  ReadOnlyPlan,
  SubscriptionInventory,
  SubscriptionState,
} from '../src/reconcile.js';
import {
  applySubscriptionEventToStore,
  ingestSubscriptionEvent,
  reconcileUserEntitlements,
  type ApplyDeps,
} from '../src/service.js';

const USER_ID = '11111111-1111-4111-8111-111111111111' as UserId;
const FAMILY_ID = '33333333-3333-4333-8333-333333333333' as FamilyId;
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
    productId: 'kinmap.familyplus.monthly',
    plan: 'FAMILY_PLUS_MONTHLY',
    status: 'ACTIVE',
    environment: 'PRODUCTION',
    expiresAt: '2026-07-01T12:00:00.000Z',
    gracePeriodEndsAt: null,
    willRenew: true,
    occurredAt: '2026-06-01T11:00:00.000Z',
    ...overrides,
  } satisfies SubscriptionEvent);
}

class FakeStore implements SubscriptionStore {
  states = new Map<string, SubscriptionState>();
  byTransaction = new Map<string, string>();
  saved: Array<{ state: SubscriptionState; effective: EffectiveSubscription }> = [];

  getByUser(input: { userId: UserId }): Promise<SubscriptionState | null> {
    return Promise.resolve(this.states.get(input.userId) ?? null);
  }

  findByOriginalTransactionId(input: {
    originalTransactionId: string;
  }): Promise<SubscriptionState | null> {
    const userId = this.byTransaction.get(input.originalTransactionId);
    return Promise.resolve(userId === undefined ? null : (this.states.get(userId) ?? null));
  }

  save(input: { state: SubscriptionState; effective: EffectiveSubscription }): Promise<void> {
    this.states.set(input.state.userId, input.state);
    this.saved.push(input);
    for (const platform of input.state.platforms) {
      if (platform.originalTransactionId !== null) {
        this.byTransaction.set(platform.originalTransactionId, input.state.userId);
      }
    }
    return Promise.resolve();
  }
}

class FakeInventory implements InventoryReader {
  inventory: SubscriptionInventory = { places: [], members: [] };
  load(): Promise<SubscriptionInventory> {
    return Promise.resolve(this.inventory);
  }
}

class FakeMarker implements ReadOnlyMarker {
  applied: ReadOnlyPlan[] = [];
  apply(plan: ReadOnlyPlan): Promise<void> {
    this.applied.push(plan);
    return Promise.resolve();
  }
}

class FakeNotifications implements NotificationCommandPublisher {
  published: unknown[][] = [];
  publish(commands: readonly unknown[]): Promise<void> {
    this.published.push([...commands]);
    return Promise.resolve();
  }
}

class FakeIdempotency implements IdempotencyStore {
  readonly claimed = new Set<string>();
  claim(input: { key: string; ttlSeconds: number }): Promise<boolean> {
    if (this.claimed.has(input.key)) return Promise.resolve(false);
    this.claimed.add(input.key);
    return Promise.resolve(true);
  }
}

class FakePublisher implements SubscriptionEventPublisher {
  published: SubscriptionEvent[] = [];
  publish(events: readonly SubscriptionEvent[]): Promise<void> {
    this.published.push(...events);
    return Promise.resolve();
  }
}

function places(count: number): SubscriptionInventory {
  return {
    places: Array.from({ length: count }, (_, index) => ({
      placeId: `place-${String(index).padStart(3, '0')}` as PlaceId,
      familyId: FAMILY_ID,
      createdAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
      readOnly: false,
    })),
    members: [],
  };
}

describe('ingestSubscriptionEvent', () => {
  it('queues a verified event once and drops the redelivery', async () => {
    const idempotency = new FakeIdempotency();
    const events = new FakePublisher();
    const deps = { idempotency, events, idempotencyTtlSeconds: 3600 };

    expect(await ingestSubscriptionEvent(event(), deps)).toBe('ENQUEUED');
    expect(await ingestSubscriptionEvent(event(), deps)).toBe('DUPLICATE');
    expect(events.published).toHaveLength(1);
  });
});

describe('applySubscriptionEventToStore', () => {
  let store: FakeStore;
  let inventory: FakeInventory;
  let marker: FakeMarker;
  let notifications: FakeNotifications;
  let deps: ApplyDeps;

  beforeEach(() => {
    store = new FakeStore();
    inventory = new FakeInventory();
    marker = new FakeMarker();
    notifications = new FakeNotifications();
    deps = {
      subscriptions: store,
      inventory,
      readOnly: marker,
      notifications,
      newCommandId: () => '44444444-4444-4444-8444-444444444444',
      now: () => NOW,
    };
  });

  it('derives entitlements from the stored record after applying the event', async () => {
    const report = await applySubscriptionEventToStore(event(), deps);

    expect(report.applied).toBe(true);
    expect(report.tierBefore).toBe('FREE');
    expect(report.tierAfter).toBe('FAMILY_PLUS');
    expect(report.effective?.entitlements).toEqual(ENTITLEMENTS.FAMILY_PLUS);
  });

  it('grants nothing from an event whose expiry is already in the past', async () => {
    const report = await applySubscriptionEventToStore(
      event({ expiresAt: '2026-01-01T00:00:00.000Z' }),
      deps,
    );

    // The event claims ACTIVE; the stored record says the period ended.
    expect(report.effective?.tier).toBe('FREE');
    expect(report.effective?.entitlements).toEqual(ENTITLEMENTS.FREE);
  });

  it('marks excess saved places read-only on a downgrade and never deletes them', async () => {
    inventory.inventory = places(4);
    await applySubscriptionEventToStore(event(), deps);
    expect(marker.applied).toHaveLength(0);

    inventory.inventory = places(4);
    const downgrade = await applySubscriptionEventToStore(
      event({
        eventId: 'evt-2',
        type: 'EXPIRATION',
        status: 'EXPIRED',
        occurredAt: '2026-06-01T11:30:00.000Z',
      }),
      deps,
    );

    expect(downgrade.tierAfter).toBe('FREE');
    expect(marker.applied).toHaveLength(1);
    expect(marker.applied[0]?.placesToMarkReadOnly.map((ref) => ref.placeId)).toEqual([
      'place-001',
      'place-002',
      'place-003',
    ]);
    // Nothing in the plan can delete: the shape has no delete field at all.
    expect(Object.keys(marker.applied[0] ?? {}).sort()).toEqual([
      'membersToMarkReadOnly',
      'membersToRestore',
      'placesToMarkReadOnly',
      'placesToRestore',
    ]);
  });

  it('restores the same places when the subscription comes back', async () => {
    inventory.inventory = places(4);
    await applySubscriptionEventToStore(event(), deps);
    await applySubscriptionEventToStore(
      event({
        eventId: 'evt-2',
        type: 'EXPIRATION',
        status: 'EXPIRED',
        occurredAt: '2026-06-01T11:30:00.000Z',
      }),
      deps,
    );

    inventory.inventory = {
      places: places(4).places.map((place, index) => ({ ...place, readOnly: index > 0 })),
      members: [],
    };
    await applySubscriptionEventToStore(
      event({
        eventId: 'evt-3',
        type: 'RESTORE',
        status: 'ACTIVE',
        occurredAt: '2026-06-01T11:45:00.000Z',
        expiresAt: '2026-08-01T00:00:00.000Z',
      }),
      deps,
    );

    const restored = marker.applied.at(-1);
    expect(restored?.placesToRestore.map((ref) => ref.placeId)).toEqual([
      'place-001',
      'place-002',
      'place-003',
    ]);
    expect(restored?.placesToMarkReadOnly).toHaveLength(0);
  });

  it('resolves the account from the stored purchase token when the event has none', async () => {
    await applySubscriptionEventToStore(event(), deps);

    const playEvent = event({
      eventId: 'evt-play-1',
      provider: 'google',
      source: 'APP_STORE',
      userId: null,
      appUserId: 'txn-1',
      originalTransactionId: 'txn-1',
      occurredAt: '2026-06-01T11:30:00.000Z',
    });

    const report = await applySubscriptionEventToStore(playEvent, deps);

    expect(report.userId).toBe(USER_ID);
    expect(report.applied).toBe(true);
  });

  it('does nothing when the account cannot be resolved at all', async () => {
    const report = await applySubscriptionEventToStore(
      event({ userId: null, originalTransactionId: 'unknown-token' }),
      deps,
    );

    expect(report.applied).toBe(false);
    expect(report.reason).toBe('UNRESOLVED_ACCOUNT');
    expect(store.saved).toHaveLength(0);
  });

  it('notifies the payer when billing needs attention', async () => {
    await applySubscriptionEventToStore(event(), deps);
    notifications.published = [];

    await applySubscriptionEventToStore(
      event({
        eventId: 'evt-4',
        type: 'GRACE_PERIOD_STARTED',
        status: 'IN_GRACE_PERIOD',
        gracePeriodEndsAt: '2026-06-20T00:00:00.000Z',
        occurredAt: '2026-06-01T11:30:00.000Z',
      }),
      deps,
    );

    expect(notifications.published).toHaveLength(1);
    const command = notifications.published[0]?.[0] as Record<string, unknown>;
    expect(command.kind).toBe('SUBSCRIPTION_EXPIRING');
    expect(command.recipientUserIds).toEqual([USER_ID]);
    // Ids only; nothing commercially or personally revealing on the queue.
    expect(command.subjectUserId).toBeNull();
  });

  it('stays silent when nothing about the entitlement got worse', async () => {
    await applySubscriptionEventToStore(event(), deps);
    notifications.published = [];

    await applySubscriptionEventToStore(
      event({ eventId: 'evt-5', type: 'RENEWAL', occurredAt: '2026-06-01T11:30:00.000Z' }),
      deps,
    );

    expect(notifications.published).toHaveLength(0);
  });
});

describe('reconcileUserEntitlements', () => {
  it('closes the gap left by a webhook that was never delivered', async () => {
    const store = new FakeStore();
    const inventory = new FakeInventory();
    const marker = new FakeMarker();
    const deps: ApplyDeps = {
      subscriptions: store,
      inventory,
      readOnly: marker,
      notifications: new FakeNotifications(),
      newCommandId: () => '44444444-4444-4444-8444-444444444444',
      now: () => NOW,
    };

    // A record that still says ACTIVE but whose period ended in January.
    store.states.set(USER_ID, {
      userId: USER_ID,
      platforms: [
        {
          source: 'APP_STORE',
          plan: 'FAMILY_PLUS_ANNUAL',
          status: 'ACTIVE',
          productId: 'kinmap.familyplus.annual',
          originalTransactionId: 'txn-1',
          expiresAt: '2026-01-01T00:00:00.000Z',
          gracePeriodEndsAt: null,
          willRenew: true,
          environment: 'PRODUCTION',
          lastEventId: 'evt-old',
          lastEventAt: '2025-01-01T00:00:00.000Z',
        },
      ],
      updatedAt: '2025-01-01T00:00:00.000Z',
    });
    inventory.inventory = places(3);

    const report = await reconcileUserEntitlements(USER_ID, deps);

    expect(report.effective?.tier).toBe('FREE');
    expect(marker.applied[0]?.placesToMarkReadOnly).toHaveLength(2);
  });
});
