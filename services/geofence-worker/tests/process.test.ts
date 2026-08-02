import { beforeEach, describe, expect, it } from 'vitest';

import type { FamilyId, PlaceId, SavedPlace, UserId } from '@family/contracts';
import { METERS_PER_DEGREE_LATITUDE } from '@family/validation';

import type { GeofenceFix, GeofenceState } from '../src/geofence.js';
import type {
  EvaluableMembership,
  GeofenceStateStore,
  MembershipReader,
  SavedPlaceReader,
} from '../src/ports.js';
import { processAcceptedLocation, type ProcessDeps } from '../src/process.js';

const USER_ID = '11111111-1111-4111-8111-111111111111' as UserId;
const FAMILY_A = '33333333-3333-4333-8333-333333333333' as FamilyId;
const FAMILY_B = '44444444-4444-4444-8444-444444444444' as FamilyId;
const PLACE_A = '22222222-2222-4222-8222-222222222222' as PlaceId;
const PLACE_B = '55555555-5555-4555-8555-555555555555' as PlaceId;

const EVENT_1 = '66666666-6666-4666-8666-666666666601';
const EVENT_2 = '66666666-6666-4666-8666-666666666602';
const EVENT_3 = '66666666-6666-4666-8666-666666666603';

const PLACE_LATITUDE = 37.5;
const PLACE_LONGITUDE = -122.25;
const EPOCH = Date.parse('2026-06-01T12:00:00.000Z');

function makePlace(
  overrides: Partial<SavedPlace> & Pick<SavedPlace, 'placeId' | 'familyId'>,
): SavedPlace {
  return {
    name: 'Home',
    category: 'HOME',
    latitude: PLACE_LATITUDE,
    longitude: PLACE_LONGITUDE,
    radiusMeters: 200,
    notifyOnArrival: true,
    notifyOnDeparture: true,
    createdBy: USER_ID,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    schemaVersion: 1,
    ...overrides,
  };
}

function fixAt(distanceMeters: number, offsetSeconds: number, eventId: string): GeofenceFix {
  return {
    eventId,
    userId: USER_ID,
    latitude: PLACE_LATITUDE + distanceMeters / METERS_PER_DEGREE_LATITUDE,
    longitude: PLACE_LONGITUDE,
    horizontalAccuracy: 12,
    capturedAt: new Date(EPOCH + offsetSeconds * 1000).toISOString(),
  };
}

class FakeMemberships implements MembershipReader {
  constructor(private readonly families: EvaluableMembership[]) {}
  listEvaluableFamilies(): Promise<EvaluableMembership[]> {
    return Promise.resolve(this.families);
  }
}

class FakePlaces implements SavedPlaceReader {
  constructor(private readonly byFamily: ReadonlyMap<FamilyId, SavedPlace[]>) {}
  listPlaces(input: { familyId: FamilyId }): Promise<SavedPlace[]> {
    return Promise.resolve(this.byFamily.get(input.familyId) ?? []);
  }
}

class FakeStateStore implements GeofenceStateStore {
  readonly rows = new Map<string, GeofenceState>();
  acceptWrites = true;
  writes = 0;

  get(input: { userId: UserId; placeId: PlaceId }): Promise<GeofenceState | null> {
    return Promise.resolve(this.rows.get(`${input.userId}#${input.placeId}`) ?? null);
  }

  put(input: { state: GeofenceState; expectedVersion: number | null }): Promise<boolean> {
    this.writes += 1;
    if (!this.acceptWrites) return Promise.resolve(false);
    const key = `${input.state.userId}#${input.state.placeId}`;
    this.rows.set(key, { ...input.state, version: (input.expectedVersion ?? 0) + 1 });
    return Promise.resolve(true);
  }
}

function commandIds(): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `aaaaaaaa-aaaa-4aaa-8aaa-${String(counter).padStart(12, '0')}`;
  };
}

describe('processAcceptedLocation', () => {
  let state: FakeStateStore;

  beforeEach(() => {
    state = new FakeStateStore();
  });

  function deps(
    families: EvaluableMembership[],
    places: ReadonlyMap<FamilyId, SavedPlace[]>,
  ): ProcessDeps {
    return {
      memberships: new FakeMemberships(families),
      places: new FakePlaces(places),
      state,
      newCommandId: commandIds(),
    };
  }

  it('evaluates every fence in every family the subject actively shares with', async () => {
    const dependencies = deps(
      [
        { familyId: FAMILY_A, userId: USER_ID },
        { familyId: FAMILY_B, userId: USER_ID },
      ],
      new Map([
        [FAMILY_A, [makePlace({ placeId: PLACE_A, familyId: FAMILY_A })]],
        [FAMILY_B, [makePlace({ placeId: PLACE_B, familyId: FAMILY_B })]],
      ]),
    );

    const first = await processAcceptedLocation(fixAt(500, 0, EVENT_1), dependencies);
    expect(first.evaluatedFamilies).toBe(2);
    expect(first.evaluatedPlaces).toBe(2);
    expect(first.commands).toHaveLength(0);

    await processAcceptedLocation(fixAt(20, 60, EVENT_2), dependencies);
    const arrival = await processAcceptedLocation(fixAt(20, 121, EVENT_3), dependencies);

    expect(arrival.commands).toHaveLength(2);
    expect(arrival.commands.map((command) => command.familyId).sort()).toEqual(
      [FAMILY_A, FAMILY_B].sort(),
    );
    for (const command of arrival.commands) {
      expect(command.transition).toBe('ARRIVAL');
      expect(command.subjectUserId).toBe(USER_ID);
      expect(command.recipientUserIds).toBeNull();
      // The command is opaque: no coordinate, no distance, no place name.
      expect(Object.keys(command).sort()).toEqual(
        [
          'commandId',
          'familyId',
          'kind',
          'occurredAt',
          'placeId',
          'recipientUserIds',
          'sourceEventId',
          'subjectUserId',
          'transition',
        ].sort(),
      );
    }
  });

  it('evaluates nothing when the subject is not actively sharing anywhere', async () => {
    const dependencies = deps(
      [],
      new Map([[FAMILY_A, [makePlace({ placeId: PLACE_A, familyId: FAMILY_A })]]]),
    );

    const result = await processAcceptedLocation(fixAt(20, 0, EVENT_1), dependencies);

    expect(result.evaluatedFamilies).toBe(0);
    expect(result.evaluatedPlaces).toBe(0);
    expect(result.commands).toHaveLength(0);
    expect(state.writes).toBe(0);
  });

  it('still advances the state machine for a place with alerts switched off', async () => {
    const dependencies = deps(
      [{ familyId: FAMILY_A, userId: USER_ID }],
      new Map([
        [FAMILY_A, [makePlace({ placeId: PLACE_A, familyId: FAMILY_A, notifyOnArrival: false })]],
      ]),
    );

    await processAcceptedLocation(fixAt(500, 0, EVENT_1), dependencies);
    await processAcceptedLocation(fixAt(20, 60, EVENT_2), dependencies);
    const arrival = await processAcceptedLocation(fixAt(20, 121, EVENT_3), dependencies);

    expect(arrival.results.map((result) => result.outcome)).toEqual(['ARRIVAL']);
    expect(arrival.commands).toHaveLength(0);
    expect(state.rows.get(`${USER_ID}#${PLACE_A}`)?.inside).toBe(true);
  });

  it('suppresses the command when a concurrent invocation won the state write', async () => {
    const dependencies = deps(
      [{ familyId: FAMILY_A, userId: USER_ID }],
      new Map([[FAMILY_A, [makePlace({ placeId: PLACE_A, familyId: FAMILY_A })]]]),
    );

    await processAcceptedLocation(fixAt(500, 0, EVENT_1), dependencies);
    await processAcceptedLocation(fixAt(20, 60, EVENT_2), dependencies);

    state.acceptWrites = false;
    const arrival = await processAcceptedLocation(fixAt(20, 121, EVENT_3), dependencies);

    expect(arrival.results.map((result) => result.outcome)).toEqual(['ARRIVAL']);
    expect(arrival.results.every((result) => !result.persisted)).toBe(true);
    expect(arrival.commands).toHaveLength(0);
  });

  it('is idempotent when the same message is redelivered', async () => {
    const dependencies = deps(
      [{ familyId: FAMILY_A, userId: USER_ID }],
      new Map([[FAMILY_A, [makePlace({ placeId: PLACE_A, familyId: FAMILY_A })]]]),
    );

    await processAcceptedLocation(fixAt(500, 0, EVENT_1), dependencies);
    await processAcceptedLocation(fixAt(20, 60, EVENT_2), dependencies);
    const arrival = await processAcceptedLocation(fixAt(20, 121, EVENT_3), dependencies);
    expect(arrival.commands).toHaveLength(1);

    const replay = await processAcceptedLocation(fixAt(20, 121, EVENT_3), dependencies);

    expect(replay.results.map((result) => result.outcome)).toEqual(['DUPLICATE']);
    expect(replay.commands).toHaveLength(0);
  });
});
