import { beforeEach, describe, expect, it } from 'vitest';

import { buildAuthorizationChecker, type AuthorizationChecker } from '@family/auth';
import { AppError, LIMITS, type UserId } from '@family/contracts';
import { EncryptionService, InMemoryKmsStub, type EncryptedCoordinateRecord } from '@family/crypto';
import { createLogger, createMemorySink } from '@family/observability';
import {
  CurrentLocationsResponseSchema,
  LocationHistoryQuerySchema,
  VisibleLocationHistoryResponseSchema,
} from '@family/schemas';

import type { SealedHistoryRow } from '../src/ports.js';
import { createInMemoryRateLimiter } from '../src/repositories/rate-limiter.js';
import {
  readCurrentLocations,
  readLocationHistory,
  type QueryDependencies,
} from '../src/service.js';

import {
  authContext,
  DEVICE_ID,
  FAMILY_ID,
  HIDDEN_FROM_REQUESTER,
  InMemoryAccounts,
  InMemoryCurrentLocations,
  InMemoryDevices,
  InMemoryHistory,
  InMemoryMemberships,
  InMemorySavedPlaces,
  InMemorySubscriptions,
  member,
  NOW,
  OUTSIDER,
  PAUSED,
  RecordingAuditWriter,
  REQUESTER,
  sealedFixRow,
  SHARER,
} from './fixtures.js';

/**
 * The read path with the REAL @family/auth checker over in-memory repositories,
 * so these tests exercise the authorization checklist that ships rather than a
 * stub of it.
 */

/** Narrows a rejected promise to the AppError the API contract guarantees. */
async function rejection(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (thrown) {
    return thrown as AppError;
  }
  throw new Error('Expected the operation to be denied.');
}

type Harness = {
  deps: QueryDependencies;
  checker: AuthorizationChecker;
  accounts: InMemoryAccounts;
  devices: InMemoryDevices;
  memberships: InMemoryMemberships;
  currentLocations: InMemoryCurrentLocations;
  history: InMemoryHistory;
  savedPlaces: InMemorySavedPlaces;
  audit: RecordingAuditWriter;
  crypto: EncryptionService;
  logLines: string[];
};

async function seal(
  crypto: EncryptionService,
  userId: UserId,
  lat: number,
  lng: number,
): Promise<EncryptedCoordinateRecord> {
  return crypto.encryptCoordinates({ lat, lng }, { familyId: FAMILY_ID, userId });
}

function harness(): Harness {
  const accounts = new InMemoryAccounts()
    .add(REQUESTER)
    .add(SHARER)
    .add(PAUSED)
    .add(HIDDEN_FROM_REQUESTER)
    .add(OUTSIDER);

  const devices = new InMemoryDevices()
    .add(REQUESTER, DEVICE_ID)
    .add(SHARER, DEVICE_ID)
    .add(OUTSIDER, DEVICE_ID);

  const memberships = new InMemoryMemberships()
    .add(member({ userId: REQUESTER, role: 'OWNER' }))
    .add(member({ userId: SHARER }))
    .add(
      member({
        userId: PAUSED,
        sharingStatus: 'PAUSED',
        sharingChangedAt: '2026-08-01T09:00:00.000Z',
      }),
    )
    .add(member({ userId: HIDDEN_FROM_REQUESTER, hiddenFromUserIds: [REQUESTER] }));

  const currentLocations = new InMemoryCurrentLocations();
  const history = new InMemoryHistory();
  const savedPlaces = new InMemorySavedPlaces();
  const audit = new RecordingAuditWriter();
  const memory = createMemorySink();
  const crypto = new EncryptionService({ keyProvider: new InMemoryKmsStub() });

  const checker = buildAuthorizationChecker({
    accounts,
    devices,
    memberships,
    subscriptions: new InMemorySubscriptions(),
    rateLimiter: createInMemoryRateLimiter(() => NOW.getTime()),
    now: () => NOW,
  });

  return {
    checker,
    accounts,
    devices,
    memberships,
    currentLocations,
    history,
    savedPlaces,
    audit,
    crypto,
    logLines: memory.lines,
    deps: {
      checker,
      memberships,
      currentLocations,
      history,
      savedPlaces,
      opener: crypto,
      audit,
      logger: createLogger({ service: 'location-query', env: 'development', sink: memory.sink }),
      now: () => NOW,
    },
  };
}

describe('readCurrentLocations', () => {
  let context: Harness;

  beforeEach(() => {
    context = harness();
  });

  it('returns a coordinate only for members who are actually sharing', async () => {
    context.currentLocations.set(
      sealedFixRow({
        userId: SHARER,
        sealed: await seal(context.crypto, SHARER, 51.5007, -0.1246),
        capturedAt: '2026-08-02T11:59:00.000Z',
      }),
    );
    context.currentLocations.set(
      sealedFixRow({
        userId: PAUSED,
        sealed: await seal(context.crypto, PAUSED, 40.7, -74.0),
        capturedAt: '2026-08-02T11:59:00.000Z',
      }),
    );

    const response = await readCurrentLocations(
      { auth: authContext(), familyId: FAMILY_ID, userIds: null },
      context.deps,
    );

    expect(CurrentLocationsResponseSchema.parse(response)).toEqual(response);

    const byUser = new Map(response.members.map((entry) => [entry.userId, entry]));

    const sharer = byUser.get(SHARER);
    expect(sharer?.visibility).toBe('VISIBLE');
    expect(sharer?.visibility === 'VISIBLE' ? sharer.point.latitude : null).toBeCloseTo(51.5007, 6);
    expect(sharer?.visibility === 'VISIBLE' ? sharer.freshness : null).toBe('LIVE');

    const paused = byUser.get(PAUSED);
    expect(paused).toEqual({
      visibility: 'HIDDEN',
      userId: PAUSED,
      sharingStatus: 'PAUSED',
      freshness: 'UNKNOWN',
      sharingChangedAt: '2026-08-01T09:00:00.000Z',
    });
    // Structurally impossible for the hidden arm to carry a position.
    expect(JSON.stringify(paused)).not.toContain('40.7');
  });

  it('hides a member who excluded the requester, without saying so', async () => {
    context.currentLocations.set(
      sealedFixRow({
        userId: HIDDEN_FROM_REQUESTER,
        sealed: await seal(context.crypto, HIDDEN_FROM_REQUESTER, 48.8584, 2.2945),
        capturedAt: '2026-08-02T11:59:00.000Z',
      }),
    );

    const response = await readCurrentLocations(
      { auth: authContext(), familyId: FAMILY_ID, userIds: null },
      context.deps,
    );

    const entry = response.members.find((row) => row.userId === HIDDEN_FROM_REQUESTER);
    expect(entry?.visibility).toBe('HIDDEN');
    expect(entry?.visibility === 'HIDDEN' ? entry.sharingStatus : null).toBe('DISABLED');
    expect(JSON.stringify(response)).not.toContain('48.8584');
  });

  it('reports a sharing member with no stored fix without inventing one', async () => {
    const response = await readCurrentLocations(
      { auth: authContext(), familyId: FAMILY_ID, userIds: null },
      context.deps,
    );

    const entry = response.members.find((row) => row.userId === SHARER);
    expect(entry?.visibility).toBe('HIDDEN');
    expect(entry?.visibility === 'HIDDEN' ? entry.sharingStatus : null).toBe('NEVER_ENABLED');
  });

  it('writes an audit event for every member actually revealed', async () => {
    context.currentLocations.set(
      sealedFixRow({
        userId: SHARER,
        sealed: await seal(context.crypto, SHARER, 51.5, -0.12),
        capturedAt: '2026-08-02T11:59:00.000Z',
      }),
    );

    await readCurrentLocations(
      { auth: authContext(), familyId: FAMILY_ID, userIds: null },
      context.deps,
    );

    expect(context.audit.events).toHaveLength(1);
    const [entry] = context.audit.events;
    expect(entry?.action).toBe('LOCATION_CURRENT_READ');
    expect(entry?.actorUserId).toBe(REQUESTER);
    expect(entry?.targetUserId).toBe(SHARER);
    expect(JSON.stringify(entry?.metadata)).not.toContain('51.5');
  });

  it('refuses to serve a read it cannot record', async () => {
    context.currentLocations.set(
      sealedFixRow({
        userId: SHARER,
        sealed: await seal(context.crypto, SHARER, 51.5, -0.12),
        capturedAt: '2026-08-02T11:59:00.000Z',
      }),
    );
    context.audit.failNext = true;

    await expect(
      readCurrentLocations(
        { auth: authContext(), familyId: FAMILY_ID, userIds: null },
        context.deps,
      ),
    ).rejects.toBeInstanceOf(Error);
  });

  it('denies a caller who is not in the family, opaquely', async () => {
    const error = await rejection(
      readCurrentLocations(
        { auth: authContext(OUTSIDER), familyId: FAMILY_ID, userIds: null },
        context.deps,
      ),
    );

    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe('FORBIDDEN');
    expect(error.message).toBe('You do not have access to this resource.');
  });

  it('denies a caller whose token carries no registered device', async () => {
    const error = await rejection(
      readCurrentLocations(
        { auth: authContext(REQUESTER, null), familyId: FAMILY_ID, userIds: null },
        context.deps,
      ),
    );

    expect(error.code).toBe('FORBIDDEN');
  });

  it('resolves a saved place without handing the client its geometry', async () => {
    context.savedPlaces.add({
      placeId: '99999999-9999-4999-8999-999999999999',
      name: 'Home',
      latitude: 51.5007,
      longitude: -0.1246,
      radiusMeters: 150,
    });
    context.currentLocations.set(
      sealedFixRow({
        userId: SHARER,
        sealed: await seal(context.crypto, SHARER, 51.5008, -0.1247),
        capturedAt: '2026-08-02T11:59:00.000Z',
      }),
    );

    const response = await readCurrentLocations(
      { auth: authContext(), familyId: FAMILY_ID, userIds: null },
      context.deps,
    );

    const entry = response.members.find((row) => row.userId === SHARER);
    expect(entry?.visibility === 'VISIBLE' ? entry.placeName : null).toBe('Home');
    expect(JSON.stringify(response)).not.toContain('radiusMeters');
  });
});

describe('readLocationHistory', () => {
  let context: Harness;

  beforeEach(() => {
    context = harness();
  });

  async function addHistoryRow(input: {
    userId: UserId;
    capturedAt: string;
    lat: number;
    lng: number;
    /** Epoch seconds. Set it in the past to model a TTL sweep that has not run. */
    expiresAt?: number;
  }): Promise<SealedHistoryRow> {
    const day = input.capturedAt.slice(0, 10);
    const base = sealedFixRow({
      userId: input.userId,
      sealed: await seal(context.crypto, input.userId, input.lat, input.lng),
      capturedAt: input.capturedAt,
    });
    const row: SealedHistoryRow = {
      ...base,
      day,
      sortKey: `TIME#${input.capturedAt}#EVENT#${base.eventId}`,
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
    };
    context.history.add(row);
    return row;
  }

  function query(
    overrides: Record<string, unknown> = {},
  ): ReturnType<typeof LocationHistoryQuerySchema.parse> {
    return LocationHistoryQuerySchema.parse({
      from: '2026-08-01T00:00:00.000Z',
      to: '2026-08-02T12:00:00.000Z',
      familyId: FAMILY_ID,
      ...overrides,
    });
  }

  it('returns the points inside the window, oldest first', async () => {
    await addHistoryRow({
      userId: SHARER,
      capturedAt: '2026-08-01T09:00:00.000Z',
      lat: 51.1,
      lng: -0.1,
    });
    await addHistoryRow({
      userId: SHARER,
      capturedAt: '2026-08-02T09:00:00.000Z',
      lat: 51.2,
      lng: -0.2,
    });

    const response = await readLocationHistory(
      { auth: authContext(), targetUserId: SHARER, query: query() },
      context.deps,
    );

    expect(response.visibility).toBe('VISIBLE');
    const visible = VisibleLocationHistoryResponseSchema.parse(response);
    expect(visible.points.map((point) => point.capturedAt)).toEqual([
      '2026-08-01T09:00:00.000Z',
      '2026-08-02T09:00:00.000Z',
    ]);
    expect(visible.retentionDays).toBe(30);
  });

  it('filters a row DynamoDB has not physically deleted yet', async () => {
    // Inside the requested window, but its TTL elapsed a day ago. DynamoDB
    // promises deletion "within 48 hours", so this row is genuinely readable —
    // the reader must not depend on the sweeper having run.
    await addHistoryRow({
      userId: SHARER,
      capturedAt: '2026-08-01T09:00:00.000Z',
      lat: 40.0,
      lng: -74.0,
      expiresAt: Math.floor(NOW.getTime() / 1000) - 86_400,
    });
    await addHistoryRow({
      userId: SHARER,
      capturedAt: '2026-08-02T09:00:00.000Z',
      lat: 51.2,
      lng: -0.2,
    });

    const response = await readLocationHistory(
      { auth: authContext(), targetUserId: SHARER, query: query() },
      context.deps,
    );

    const visible = VisibleLocationHistoryResponseSchema.parse(response);
    expect(visible.points).toHaveLength(1);
    expect(visible.points[0]?.capturedAt).toBe('2026-08-02T09:00:00.000Z');
    expect(JSON.stringify(response)).not.toContain('-74');
  });

  it('clamps the window to what the plan actually retains', async () => {
    // Thirty-two days old: inside the requested window, outside retention.
    await addHistoryRow({
      userId: SHARER,
      capturedAt: '2026-07-01T09:00:00.000Z',
      lat: 40.0,
      lng: -74.0,
    });
    await addHistoryRow({
      userId: SHARER,
      capturedAt: '2026-08-02T09:00:00.000Z',
      lat: 51.2,
      lng: -0.2,
    });

    const response = await readLocationHistory(
      {
        auth: authContext(),
        targetUserId: SHARER,
        // The widest window the request schema permits.
        query: query({ from: '2026-07-02T13:00:00.000Z', to: '2026-08-02T12:00:00.000Z' }),
      },
      context.deps,
    );

    const visible = VisibleLocationHistoryResponseSchema.parse(response);
    expect(visible.points).toHaveLength(1);
    // Moved forward to `now - retentionDays`, and the older partition is never
    // even queried.
    expect(visible.from).toBe('2026-07-03T12:00:00.000Z');
    expect(context.history.requests.some((request) => request.day === '2026-07-01')).toBe(false);
    expect(JSON.stringify(response)).not.toContain('-74');
  });

  it('pages with an opaque cursor and does not repeat a point', async () => {
    for (let hour = 0; hour < 5; hour += 1) {
      await addHistoryRow({
        userId: SHARER,
        capturedAt: `2026-08-02T0${hour}:00:00.000Z`,
        lat: 51 + hour / 100,
        lng: -0.1,
      });
    }

    const first = await readLocationHistory(
      { auth: authContext(), targetUserId: SHARER, query: query({ limit: '2' }) },
      context.deps,
    );
    const firstPage = VisibleLocationHistoryResponseSchema.parse(first);
    expect(firstPage.points).toHaveLength(2);
    expect(firstPage.page.hasMore).toBe(true);
    expect(firstPage.page.nextCursor).not.toBeNull();

    const second = await readLocationHistory(
      {
        auth: authContext(),
        targetUserId: SHARER,
        query: query({ limit: '2', cursor: firstPage.page.nextCursor }),
      },
      context.deps,
    );
    const secondPage = VisibleLocationHistoryResponseSchema.parse(second);

    const firstIds = firstPage.points.map((point) => point.eventId);
    const secondIds = secondPage.points.map((point) => point.eventId);
    expect(secondIds.some((id) => firstIds.includes(id))).toBe(false);
  });

  it('clamps an oversized page request to the platform maximum', async () => {
    await addHistoryRow({
      userId: SHARER,
      capturedAt: '2026-08-02T09:00:00.000Z',
      lat: 51.2,
      lng: -0.2,
    });

    await readLocationHistory(
      {
        auth: authContext(),
        targetUserId: SHARER,
        query: query({ limit: String(LIMITS.MAX_HISTORY_PAGE_SIZE) }),
      },
      context.deps,
    );

    for (const request of context.history.requests) {
      expect(request.limit).toBeLessThanOrEqual(LIMITS.MAX_HISTORY_PAGE_SIZE + 1);
    }
  });

  it('denies history for a target who has paused sharing, opaquely', async () => {
    await addHistoryRow({
      userId: PAUSED,
      capturedAt: '2026-08-02T09:00:00.000Z',
      lat: 51.2,
      lng: -0.2,
    });

    const error = await rejection(
      readLocationHistory(
        { auth: authContext(), targetUserId: PAUSED, query: query() },
        context.deps,
      ),
    );

    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe('FORBIDDEN');
  });

  it('denies history entirely on a plan that retains nothing', async () => {
    const free = harness();
    const freeChecker = buildAuthorizationChecker({
      accounts: free.accounts,
      devices: free.devices,
      memberships: free.memberships,
      subscriptions: new InMemorySubscriptions('FREE', 'EXPIRED'),
      rateLimiter: createInMemoryRateLimiter(() => NOW.getTime()),
      now: () => NOW,
    });

    const error = await rejection(
      readLocationHistory(
        { auth: authContext(), targetUserId: SHARER, query: query() },
        { ...free.deps, checker: freeChecker },
      ),
    );

    expect(error.code).toBe('FORBIDDEN');
  });

  it('finds the shared family when the client does not name one', async () => {
    await addHistoryRow({
      userId: SHARER,
      capturedAt: '2026-08-02T09:00:00.000Z',
      lat: 51.2,
      lng: -0.2,
    });

    const response = await readLocationHistory(
      { auth: authContext(), targetUserId: SHARER, query: query({ familyId: undefined }) },
      context.deps,
    );

    expect(VisibleLocationHistoryResponseSchema.parse(response).familyId).toBe(FAMILY_ID);
  });

  it('writes an audit event carrying counts, never a position', async () => {
    await addHistoryRow({
      userId: SHARER,
      capturedAt: '2026-08-02T09:00:00.000Z',
      lat: 51.2,
      lng: -0.2,
    });

    await readLocationHistory(
      { auth: authContext(), targetUserId: SHARER, query: query() },
      context.deps,
    );

    const entry = context.audit.events.find((event) => event.action === 'LOCATION_HISTORY_READ');
    expect(entry).toBeDefined();
    expect(entry?.metadata.pointCount).toBe(1);
    expect(JSON.stringify(entry)).not.toContain('51.2');
  });

  it('never writes a coordinate to the log', async () => {
    await addHistoryRow({
      userId: SHARER,
      capturedAt: '2026-08-02T09:00:00.000Z',
      lat: 51.2345,
      lng: -0.9876,
    });

    await readLocationHistory(
      { auth: authContext(), targetUserId: SHARER, query: query() },
      context.deps,
    );

    const logs = context.logLines.join('\n');
    expect(logs).not.toContain('51.2345');
    expect(logs).not.toContain('-0.9876');
  });
});
