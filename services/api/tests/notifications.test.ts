import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ENTITLEMENTS, type UserId } from '@family/contracts';
import {
  ListNotificationsResponseSchema,
  MarkNotificationsReadResponseSchema,
  GetNotificationPreferencesResponseSchema,
} from '@family/schemas';
import { InMemoryDocumentClient, type TableDefinition } from '@family/test-utils';

import { createPipeline } from '../src/pipeline.js';
import {
  createNotificationPreferencesRepository,
  createNotificationsRepository,
  GLOBAL_PREFERENCE_SCOPE,
  notificationSortKey,
  type NotificationServices,
} from '../src/repositories/notifications.js';
import { createRouter } from '../src/router.js';
import { notificationRoutes } from '../src/routes/notifications.js';
import type { ApiServices } from '../src/services.js';
import type { HttpMethod, HttpRequest } from '../src/types.js';

import {
  authHeaders,
  createFakeDocumentClient,
  createFakeVerifier,
  createHarness,
  familyIdOf,
  seedUser,
  testUuid,
  userIdOf,
  type Harness,
} from './support/harness.js';

/**
 * The notification surface, end to end through the real pipeline.
 *
 * Two properties carry the weight here. A notification row is a pointer made of
 * ids and pre-rendered copy, so no coordinate can reach a response or a log
 * line even when one has been left on the row; and an id that belongs to
 * somebody else is answered exactly as an id that never existed, so this
 * endpoint cannot be turned into a probe.
 */

const JSON_HEADERS = { 'content-type': 'application/json' };

const alice = userIdOf(1);
const bob = userIdOf(2);
const familyId = familyIdOf(1);
const placeIdOf = (n: number): string => testUuid(0xd4, n);
const notificationIdOf = (n: number): string => testUuid(0xe5, n);

const TABLES = {
  notifications: 'Notifications',
  notificationPreferences: 'NotificationPreferences',
} as const;

const TABLE_DEFINITIONS: TableDefinition[] = [
  { name: TABLES.notifications, keySchema: { partitionKey: 'userId', sortKey: 'sk' } },
  {
    name: TABLES.notificationPreferences,
    keySchema: { partitionKey: 'userId', sortKey: 'familyId' },
  },
];

type NotificationHarness = {
  readonly base: Harness;
  readonly store: InMemoryDocumentClient;
  call(input: Partial<HttpRequest> & { method: HttpMethod; path: string }): Promise<{
    statusCode: number;
    headers: Record<string, string>;
    body: unknown;
  }>;
};

/**
 * The shared harness owns the users, subscriptions, rate limiter and clock this
 * area reads; the two notification tables are declared here because no other
 * route touches them.
 */
function createNotificationHarness(): NotificationHarness {
  const base = createHarness();
  const store = new InMemoryDocumentClient(TABLE_DEFINITIONS);
  const client = createFakeDocumentClient(store);

  const services: ApiServices & NotificationServices = {
    ...base.services,
    notifications: createNotificationsRepository(client, TABLES.notifications),
    notificationPreferences: createNotificationPreferencesRepository(
      client,
      TABLES.notificationPreferences,
    ),
  };

  const pipeline = createPipeline({
    router: createRouter(notificationRoutes),
    services,
    logger: base.logger,
    verifier: createFakeVerifier(),
  });

  return {
    base,
    store,
    async call(input) {
      const response = await pipeline(base.request(input));
      return {
        statusCode: response.statusCode,
        headers: response.headers,
        body: response.body === '' ? null : (JSON.parse(response.body) as unknown),
      };
    },
  };
}

function seedNotification(
  harness: NotificationHarness,
  input: {
    userId: UserId;
    notificationId: string;
    occurredAt: string;
    readAt?: string;
    title?: string;
    extra?: Record<string, unknown>;
  },
): void {
  harness.store.seed(TABLES.notifications, [
    {
      userId: input.userId,
      sk: notificationSortKey(input.occurredAt, input.notificationId),
      notificationId: input.notificationId,
      kind: 'ARRIVAL',
      familyId,
      subjectUserId: bob,
      placeId: placeIdOf(1),
      title: input.title ?? 'Ana arrived at School',
      body: 'Ana arrived at School.',
      occurredAt: input.occurredAt,
      ...(input.readAt === undefined ? {} : { readAt: input.readAt }),
      ...input.extra,
    },
  ]);
}

function listNotifications(harness: NotificationHarness, userId: UserId): Promise<unknown> {
  return harness
    .call({ method: 'GET', path: '/v1/notifications', headers: authHeaders(userId) })
    .then((response) => response.body);
}

describe('the notification list', () => {
  let harness: NotificationHarness;

  beforeEach(() => {
    harness = createNotificationHarness();
    seedUser(harness.base, { userId: alice });
    seedUser(harness.base, { userId: bob });
  });

  it('returns the caller‘s notifications newest first, with an unread count', async () => {
    seedNotification(harness, {
      userId: alice,
      notificationId: notificationIdOf(1),
      occurredAt: '2026-03-01T08:00:00.000Z',
      readAt: '2026-03-01T09:00:00.000Z',
    });
    seedNotification(harness, {
      userId: alice,
      notificationId: notificationIdOf(2),
      occurredAt: '2026-03-01T10:00:00.000Z',
    });
    seedNotification(harness, {
      userId: alice,
      notificationId: notificationIdOf(3),
      occurredAt: '2026-03-01T11:00:00.000Z',
    });

    const response = await harness.call({
      method: 'GET',
      path: '/v1/notifications',
      headers: authHeaders(alice),
    });

    expect(response.statusCode).toBe(200);
    const body = ListNotificationsResponseSchema.parse(response.body);
    expect(body.notifications.map((entry) => entry.notificationId)).toEqual([
      notificationIdOf(3),
      notificationIdOf(2),
      notificationIdOf(1),
    ]);
    expect(body.unreadCount).toBe(2);
  });

  it('shows nothing of another user‘s, however many they have', async () => {
    seedNotification(harness, {
      userId: bob,
      notificationId: notificationIdOf(1),
      occurredAt: '2026-03-01T10:00:00.000Z',
    });

    const body = ListNotificationsResponseSchema.parse(await listNotifications(harness, alice));
    expect(body.notifications).toEqual([]);
    expect(body.unreadCount).toBe(0);
  });

  it('drops an attribute the contract does not name, coordinates included', async () => {
    seedNotification(harness, {
      userId: alice,
      notificationId: notificationIdOf(1),
      occurredAt: '2026-03-01T10:00:00.000Z',
      // A writer that should never have put these here.
      extra: { latitude: 51.500729, longitude: -0.124625, geohash: 'gcpuvpk44' },
    });

    const response = await harness.call({
      method: 'GET',
      path: '/v1/notifications',
      headers: authHeaders(alice),
    });

    // The response schema is strict, so this parse fails if anything extra
    // reached the body at all.
    const body = ListNotificationsResponseSchema.parse(response.body);
    expect(body.notifications).toHaveLength(1);

    const serialised = JSON.stringify(response.body);
    for (const leak of ['51.500729', '-0.124625', 'gcpuvpk44', 'latitude', 'geohash']) {
      expect(serialised).not.toContain(leak);
      expect(JSON.stringify(harness.base.logs)).not.toContain(leak);
    }
  });
});

describe('marking notifications read', () => {
  let harness: NotificationHarness;

  beforeEach(() => {
    harness = createNotificationHarness();
    seedUser(harness.base, { userId: alice });
    seedUser(harness.base, { userId: bob });
    seedNotification(harness, {
      userId: alice,
      notificationId: notificationIdOf(1),
      occurredAt: '2026-03-01T09:00:00.000Z',
    });
    seedNotification(harness, {
      userId: alice,
      notificationId: notificationIdOf(2),
      occurredAt: '2026-03-01T10:00:00.000Z',
    });
  });

  function markRead(
    userId: UserId,
    notificationIds: string[],
    headers: Record<string, string> = {},
  ): Promise<{ statusCode: number; headers: Record<string, string>; body: unknown }> {
    return harness.call({
      method: 'POST',
      path: '/v1/notifications/read',
      headers: { ...authHeaders(userId), ...JSON_HEADERS, ...headers },
      rawBody: JSON.stringify({ notificationIds }),
    });
  }

  it('marks the named rows and reports what is still unread', async () => {
    const response = await markRead(alice, [notificationIdOf(1)]);

    expect(response.statusCode).toBe(200);
    expect(MarkNotificationsReadResponseSchema.parse(response.body)).toEqual({
      readCount: 1,
      unreadCount: 1,
    });

    const listed = ListNotificationsResponseSchema.parse(await listNotifications(harness, alice));
    const marked = listed.notifications.find(
      (entry) => entry.notificationId === notificationIdOf(1),
    );
    expect(marked?.readAt).toBe(harness.base.now().toISOString());
    expect(listed.unreadCount).toBe(1);
  });

  it('marks nothing a second time when the call is replayed', async () => {
    await markRead(alice, [notificationIdOf(1), notificationIdOf(2)]);
    const replay = await markRead(alice, [notificationIdOf(1), notificationIdOf(2)]);

    expect(MarkNotificationsReadResponseSchema.parse(replay.body)).toEqual({
      readCount: 0,
      unreadCount: 0,
    });
  });

  it('replays the first response byte for byte when a key is supplied', async () => {
    const key = { 'idempotency-key': 'mark-read-0001' };
    const first = await markRead(alice, [notificationIdOf(1)], key);
    const second = await markRead(alice, [notificationIdOf(1)], key);

    expect(second.body).toEqual(first.body);
    expect(second.headers['idempotent-replay']).toBe('true');
  });

  it('answers an id from another partition exactly as it answers an unknown one', async () => {
    seedNotification(harness, {
      userId: bob,
      notificationId: notificationIdOf(9),
      occurredAt: '2026-03-01T10:00:00.000Z',
    });

    const foreign = await markRead(alice, [notificationIdOf(9)]);
    const unknown = await markRead(alice, [notificationIdOf(42)]);

    expect(foreign.statusCode).toBe(200);
    expect(foreign.body).toEqual(unknown.body);
    expect(MarkNotificationsReadResponseSchema.parse(foreign.body)).toEqual({
      readCount: 0,
      unreadCount: 2,
    });

    // And Bob's row is untouched.
    const bobs = harness.store
      .dump(TABLES.notifications)
      .find((row) => row['notificationId'] === notificationIdOf(9));
    expect(bobs?.['readAt']).toBeUndefined();
  });

  it('rejects a batch larger than the contract allows', async () => {
    const response = await markRead(
      alice,
      Array.from({ length: 201 }, (_, index) => notificationIdOf(index + 100)),
    );

    expect(response.statusCode).toBe(422);
  });
});

describe('notification preferences', () => {
  let harness: NotificationHarness;

  beforeEach(() => {
    harness = createNotificationHarness();
    seedUser(harness.base, { userId: alice });
  });

  function readPreferences(): Promise<{ statusCode: number; body: unknown }> {
    return harness.call({
      method: 'GET',
      path: '/v1/notifications/preferences',
      headers: authHeaders(alice),
    });
  }

  function patchPreferences(
    patch: unknown,
  ): Promise<{ statusCode: number; headers: Record<string, string>; body: unknown }> {
    return harness.call({
      method: 'PATCH',
      path: '/v1/notifications/preferences',
      headers: { ...authHeaders(alice), ...JSON_HEADERS },
      rawBody: JSON.stringify(patch),
    });
  }

  it('starts a user on the same defaults the delivery path applies', async () => {
    const response = await readPreferences();

    expect(response.statusCode).toBe(200);
    const { preferences } = GetNotificationPreferencesResponseSchema.parse(response.body);
    expect(preferences).toMatchObject({
      userId: alice,
      arrivals: { push: true, inApp: true },
      billing: { push: true, inApp: true },
      quietHours: { enabled: false, startMinuteOfDay: 0, endMinuteOfDay: 0 },
      mutedFamilyIds: [],
      mutedUserIds: [],
    });
    // Nothing is stored until the user actually changes something.
    expect(harness.store.dump(TABLES.notificationPreferences)).toEqual([]);
  });

  it('changes only the categories the request names', async () => {
    const response = await patchPreferences({
      liveSessions: { push: false, inApp: true },
      quietHours: { enabled: true, startMinuteOfDay: 1320, endMinuteOfDay: 420 },
      mutedFamilyIds: [familyId],
    });

    expect(response.statusCode).toBe(200);
    const { preferences } = GetNotificationPreferencesResponseSchema.parse(response.body);
    expect(preferences.liveSessions).toEqual({ push: false, inApp: true });
    expect(preferences.quietHours).toEqual({
      enabled: true,
      startMinuteOfDay: 1320,
      endMinuteOfDay: 420,
    });
    expect(preferences.mutedFamilyIds).toEqual([familyId]);
    // Untouched.
    expect(preferences.membership).toEqual({ push: true, inApp: true });
    expect(preferences.updatedAt).toBe(harness.base.now().toISOString());

    const stored = GetNotificationPreferencesResponseSchema.parse((await readPreferences()).body);
    expect(stored.preferences).toEqual(preferences);
  });

  it('writes the row where the notification worker looks for it', async () => {
    await patchPreferences({ arrivals: { push: false, inApp: false } });

    const rows = harness.store.dump(TABLES.notificationPreferences);
    expect(rows).toHaveLength(1);
    // The worker reads `{ userId, familyId: familyId ?? 'GLOBAL' }` and then
    // reads each category off the row by name.
    expect(rows[0]).toMatchObject({
      userId: alice,
      familyId: GLOBAL_PREFERENCE_SCOPE,
      arrivals: { push: false, inApp: false },
      departures: { push: true, inApp: true },
      quietHours: { enabled: false, startMinuteOfDay: 0, endMinuteOfDay: 0 },
    });
  });

  it('refuses a field the contract does not define', async () => {
    const response = await patchPreferences({
      arrivals: { push: true, inApp: true },
      plan: 'FAMILY_PLUS_ANNUAL',
    });

    expect(response.statusCode).toBe(422);
    expect(harness.store.dump(TABLES.notificationPreferences)).toEqual([]);
  });

  it('refuses an empty patch', async () => {
    expect((await patchPreferences({})).statusCode).toBe(422);
  });

  describe('when the plan does not include arrival and departure alerts', () => {
    /**
     * Every tier in the contract table happens to include these alerts today.
     * What this suite is about is the gate itself — that the server asks the
     * stored subscription row and enforces the answer — so the FREE row is
     * flipped for the duration rather than the current commercial answer being
     * baked into an assertion.
     */
    const entitled = ENTITLEMENTS.FREE.arrivalDepartureAlerts;

    beforeEach(() => {
      ENTITLEMENTS.FREE.arrivalDepartureAlerts = false;
    });

    afterEach(() => {
      ENTITLEMENTS.FREE.arrivalDepartureAlerts = entitled;
    });

    function seedSubscription(plan: string, status: string): void {
      harness.base.store.seed('Subscriptions', [
        {
          userId: alice,
          familyId,
          plan,
          status,
          source: 'APP_STORE',
          isTrial: false,
          currentPeriodEndsAt: '2026-04-01T12:00:00.000Z',
          gracePeriodEndsAt: null,
          willRenew: true,
          managementUrl: null,
          refreshedAt: '2026-03-01T12:00:00.000Z',
        },
      ]);
    }

    it('refuses to switch arrival alerts on', async () => {
      const response = await patchPreferences({ arrivals: { push: true, inApp: false } });

      expect(response.statusCode).toBe(402);
      expect(response.body).toMatchObject({ error: { code: 'ENTITLEMENT_REQUIRED' } });
      // The refusal leaves the stored row alone.
      expect(harness.store.dump(TABLES.notificationPreferences)).toEqual([]);
    });

    it('still lets them be switched off, and lets the free categories through', async () => {
      const response = await patchPreferences({
        arrivals: { push: false, inApp: false },
        departures: { push: false, inApp: false },
        quietHours: { enabled: true, startMinuteOfDay: 0, endMinuteOfDay: 60 },
      });

      expect(response.statusCode).toBe(200);
      const { preferences } = GetNotificationPreferencesResponseSchema.parse(response.body);
      expect(preferences.arrivals).toEqual({ push: false, inApp: false });
      expect(preferences.quietHours.enabled).toBe(true);
    });

    it('allows the switch once a paid subscription row says so', async () => {
      seedSubscription('FAMILY_PLUS_ANNUAL', 'ACTIVE');

      const response = await patchPreferences({ arrivals: { push: true, inApp: true } });

      expect(response.statusCode).toBe(200);
      const { preferences } = GetNotificationPreferencesResponseSchema.parse(response.body);
      expect(preferences.arrivals).toEqual({ push: true, inApp: true });
    });

    it('refuses again once that subscription is revoked', async () => {
      seedSubscription('FAMILY_PLUS_ANNUAL', 'REVOKED');

      expect((await patchPreferences({ arrivals: { push: true, inApp: true } })).statusCode).toBe(
        402,
      );
    });
  });
});
