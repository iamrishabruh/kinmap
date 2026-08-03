import { beforeEach, describe, expect, it } from 'vitest';

import { ENTITLEMENTS, SavedPlaceSchema, type FamilyId, type UserId } from '@family/contracts';
import { EncryptionService, InMemoryKmsStub } from '@family/crypto';
import type {
  CreatePlaceResponse,
  DeletePlaceResponse,
  ListPlacesResponse,
  UpdatePlaceResponse,
} from '@family/schemas';
import { InMemoryDocumentClient, type Item } from '@family/test-utils';

import { createPipeline } from '../src/pipeline.js';
import { createPlacesRepository } from '../src/repositories/places.js';
import { createRouter } from '../src/router.js';
import { placeRoutes } from '../src/routes/places.js';
import type { ApiServices } from '../src/services.js';
import type { HttpMethod, HttpRequest } from '../src/types.js';

import {
  authHeaders,
  createFakeDocumentClient,
  createFakeVerifier,
  createHarness,
  familyIdOf,
  seedMembership,
  seedUser,
  testUuid,
  userIdOf,
  TABLES,
  type Harness,
} from './support/harness.js';

/**
 * A saved place is the only coordinate this service handles, so the tests that
 * matter most are not the CRUD ones: they are that the centre is never written
 * down in the clear, never echoed into a log or an error, that the allowance is
 * the server's number rather than the client's, and that a place belonging to
 * somebody else's family is indistinguishable from one that does not exist.
 */

const JSON_HEADERS = { 'content-type': 'application/json' };

const PLACES_TABLE = 'SavedPlaces';

const alice = userIdOf(1);
const bob = userIdOf(2);
const family = familyIdOf(1);
const bobsFamily = familyIdOf(2);
const strangersFamily = familyIdOf(99);

/** Somewhere precise enough that finding it in a log line would be damning. */
const LATITUDE = 51.500729;
const LONGITUDE = -0.124625;

function homeRequest(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    familyId: family,
    name: 'Home',
    category: 'HOME',
    latitude: LATITUDE,
    longitude: LONGITUDE,
    radiusMeters: 150,
    notifyOnArrival: true,
    notifyOnDeparture: false,
    ...overrides,
  });
}

type PlacesHarness = Harness & {
  /** The SavedPlaces store, kept separate so the assertions can read the rows. */
  readonly places: InMemoryDocumentClient;
};

/**
 * The shared harness declares the tables its own route table reaches. Saved
 * places get their own store and their own router, which keeps this area's
 * wiring self-contained — and incidentally proves the repository touches no
 * other table.
 */
function createPlacesHarness(): PlacesHarness {
  const harness = createHarness();
  const store = new InMemoryDocumentClient([
    {
      name: PLACES_TABLE,
      keySchema: { partitionKey: 'familyId', sortKey: 'placeId' },
      indexes: { byCreator: { partitionKey: 'createdBy', sortKey: 'placeId' } },
    },
  ]);

  const services: ApiServices = {
    ...harness.services,
    places: createPlacesRepository(createFakeDocumentClient(store), PLACES_TABLE),
    // The real EncryptionService over an offline KMS: the sealing path under
    // test is the one that runs in production, not a stand-in for it.
  };

  const pipeline = createPipeline({
    router: createRouter(placeRoutes),
    services,
    logger: harness.logger,
    verifier: createFakeVerifier(),
  });

  return {
    ...harness,
    places: store,
    services,
    pipeline,
    async call(input: Partial<HttpRequest> & { method: HttpMethod; path: string }) {
      const response = await pipeline(harness.request(input));
      return {
        statusCode: response.statusCode,
        headers: response.headers,
        body: response.body === '' ? null : (JSON.parse(response.body) as unknown),
      };
    },
  };
}

function seedSubscription(
  harness: PlacesHarness,
  input: { userId: UserId; familyId: FamilyId; plan: string; status?: string },
): void {
  harness.store.seed(TABLES.subscriptions, [
    {
      userId: input.userId,
      familyId: input.familyId,
      plan: input.plan,
      status: input.status ?? 'ACTIVE',
      source: 'APP_STORE',
      isTrial: false,
      currentPeriodEndsAt: null,
      gracePeriodEndsAt: null,
      willRenew: true,
      managementUrl: null,
      refreshedAt: harness.now().toISOString(),
    },
  ]);
}

function storedPlaces(harness: PlacesHarness): Item[] {
  return harness.places.dump(PLACES_TABLE);
}

function onlyStoredPlace(harness: PlacesHarness): Item {
  const rows = storedPlaces(harness);
  const row = rows[0];
  if (rows.length !== 1 || row === undefined) {
    throw new Error(`Expected exactly one stored place, found ${String(rows.length)}.`);
  }
  return row;
}

function createHome(
  harness: PlacesHarness,
  input: { as?: UserId; key?: string; body?: string } = {},
): ReturnType<PlacesHarness['call']> {
  return harness.call({
    method: 'POST',
    path: '/v1/places',
    headers: {
      ...authHeaders(input.as ?? alice),
      ...JSON_HEADERS,
      'idempotency-key': input.key ?? 'place-0001',
    },
    rawBody: input.body ?? homeRequest(),
  });
}

describe('saved places', () => {
  let harness: PlacesHarness;

  beforeEach(() => {
    harness = createPlacesHarness();
    seedUser(harness, { userId: alice });
    seedUser(harness, { userId: bob });
    seedMembership(harness, { familyId: family, userId: alice, role: 'OWNER' });
    seedMembership(harness, { familyId: bobsFamily, userId: bob, role: 'OWNER' });
  });

  it('creates a place and answers with the centre it was given', async () => {
    const response = await createHome(harness);

    expect(response.statusCode).toBe(201);
    const body = response.body as CreatePlaceResponse;
    expect(body.place).toMatchObject({
      familyId: family,
      name: 'Home',
      category: 'HOME',
      latitude: LATITUDE,
      longitude: LONGITUDE,
      radiusMeters: 150,
      createdBy: alice,
    });
    expect(body.placeCount).toBe(1);
    expect(body.maxPlaces).toBe(ENTITLEMENTS.FREE.maxSavedPlaces);
  });

  it('stores the centre in the shape the geofence worker can read', async () => {
    // The row must satisfy SavedPlaceSchema from @family/contracts. geofence-worker
    // parses every row with it and skips the ones that fail, so a place stored in
    // any other shape produces no fences and no arrival alerts, and reports
    // nothing while doing it.
    await createHome(harness);

    const row = onlyStoredPlace(harness);
    const parsed = SavedPlaceSchema.safeParse(row);

    expect(
      parsed.success,
      'a stored place must satisfy the contract, or it silently produces no geofences',
    ).toBe(true);
    expect(row.latitude).toBe(LATITUDE);
    expect(row.longitude).toBe(LONGITUDE);
  });

  it('reads the centre back for a member of the family', async () => {
    await createHome(harness);

    const response = await harness.call({
      method: 'GET',
      path: '/v1/places',
      headers: authHeaders(alice),
      query: { familyId: family },
    });

    expect(response.statusCode).toBe(200);
    const body = response.body as ListPlacesResponse;
    expect(body.places).toHaveLength(1);
    expect(body.places[0]).toMatchObject({ latitude: LATITUDE, longitude: LONGITUDE });
    expect(body.placeCount).toBe(1);
  });

  it('keeps a rejected coordinate out of the error body and the logs', async () => {
    const outOfRange = 91.5;
    const response = await createHome(harness, {
      body: homeRequest({ latitude: outOfRange }),
    });

    expect(response.statusCode).toBe(422);
    expect(response.body).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
    expect(JSON.stringify(response.body)).not.toContain(String(outOfRange));
    // The rejection was logged — so the absence below is a real property, not
    // an assertion over an empty array.
    expect(harness.logs.some((record) => record.message === 'request_rejected')).toBe(true);
    expect(JSON.stringify(harness.logs)).not.toContain(String(outOfRange));
    expect(JSON.stringify(harness.logs)).not.toContain(String(LONGITUDE));
  });

  it('enforces the free allowance from ENTITLEMENTS, server-side', async () => {
    expect(ENTITLEMENTS.FREE.maxSavedPlaces).toBe(1);

    const first = await createHome(harness, { key: 'place-0001' });
    expect(first.statusCode).toBe(201);

    const second = await createHome(harness, {
      key: 'place-0002',
      body: homeRequest({ name: 'School', category: 'SCHOOL' }),
    });
    expect(second.statusCode).toBe(402);
    expect(second.body).toMatchObject({ error: { code: 'PLAN_LIMIT_EXCEEDED' } });
    expect(storedPlaces(harness)).toHaveLength(1);
  });

  it('takes the allowance from the family subscription row', async () => {
    seedSubscription(harness, { userId: alice, familyId: family, plan: 'FAMILY_MONTHLY' });

    const first = await createHome(harness, { key: 'place-0001' });
    expect((first.body as CreatePlaceResponse).maxPlaces).toBe(ENTITLEMENTS.FAMILY.maxSavedPlaces);

    const second = await createHome(harness, {
      key: 'place-0002',
      body: homeRequest({ name: 'School', category: 'SCHOOL' }),
    });
    expect(second.statusCode).toBe(201);
    expect((second.body as CreatePlaceResponse).placeCount).toBe(2);
  });

  it('collapses a lapsed subscription to the free allowance', async () => {
    // The row still names a paid plan; only its status has moved. Reading the
    // plan and not the status is exactly how an expired payer keeps a paid cap.
    seedSubscription(harness, {
      userId: alice,
      familyId: family,
      plan: 'FAMILY_PLUS_ANNUAL',
      status: 'EXPIRED',
    });

    const first = await createHome(harness, { key: 'place-0001' });
    expect((first.body as CreatePlaceResponse).maxPlaces).toBe(ENTITLEMENTS.FREE.maxSavedPlaces);

    const second = await createHome(harness, {
      key: 'place-0002',
      body: homeRequest({ name: 'School', category: 'SCHOOL' }),
    });
    expect(second.statusCode).toBe(402);
  });

  it('refuses a plan named by the client outright', async () => {
    const response = await createHome(harness, {
      body: homeRequest({ plan: 'FAMILY_PLUS_ANNUAL', maxPlaces: 200 }),
    });

    expect(response.statusCode).toBe(422);
    expect(storedPlaces(harness)).toHaveLength(0);
  });

  it('lists only the named family, and answers a stranger opaquely', async () => {
    await createHome(harness);

    const own = await harness.call({
      method: 'GET',
      path: '/v1/places',
      headers: authHeaders(bob),
      query: { familyId: bobsFamily },
    });
    expect(own.statusCode).toBe(200);
    expect((own.body as ListPlacesResponse).places).toHaveLength(0);

    const someoneElses = await harness.call({
      method: 'GET',
      path: '/v1/places',
      headers: authHeaders(bob),
      query: { familyId: family },
    });
    const neverExisted = await harness.call({
      method: 'GET',
      path: '/v1/places',
      headers: authHeaders(bob),
      query: { familyId: strangersFamily },
    });

    expect(someoneElses.statusCode).toBe(403);
    // Byte for byte the same answer: membership is not something this endpoint
    // will confirm or deny.
    expect(errorOf(someoneElses.body)).toEqual(errorOf(neverExisted.body));
    expect(errorOf(someoneElses.body).message).not.toMatch(/family|member|place/i);
  });

  it('moves a place, and the moved row still satisfies the contract', async () => {
    const created = await createHome(harness);
    const placeId = (created.body as CreatePlaceResponse).place.placeId;
    const before = onlyStoredPlace(harness);

    const movedLatitude = 51.507351;
    const movedLongitude = -0.127758;
    const response = await harness.call({
      method: 'PATCH',
      path: `/v1/places/${placeId}`,
      headers: { ...authHeaders(alice), ...JSON_HEADERS },
      rawBody: JSON.stringify({
        name: 'Home (new)',
        latitude: movedLatitude,
        longitude: movedLongitude,
      }),
    });

    expect(response.statusCode).toBe(200);
    expect((response.body as UpdatePlaceResponse).place).toMatchObject({
      name: 'Home (new)',
      latitude: movedLatitude,
      longitude: movedLongitude,
    });

    const after = onlyStoredPlace(harness);
    expect(after.latitude).toBe(movedLatitude);
    expect(after.longitude).toBe(movedLongitude);
    expect(after.latitude).not.toBe(before.latitude);
    expect(SavedPlaceSchema.safeParse(after).success).toBe(true);
  });

  it('will not let a stranger reach a place by id', async () => {
    const created = await createHome(harness);
    const placeId = (created.body as CreatePlaceResponse).place.placeId;

    const patch = JSON.stringify({ name: 'Not yours' });
    const guessed = await harness.call({
      method: 'PATCH',
      path: `/v1/places/${placeId}`,
      headers: { ...authHeaders(bob), ...JSON_HEADERS },
      rawBody: patch,
    });
    const invented = await harness.call({
      method: 'PATCH',
      path: `/v1/places/${testUuid(0xd4, 7)}`,
      headers: { ...authHeaders(bob), ...JSON_HEADERS },
      rawBody: patch,
    });

    expect(guessed.statusCode).toBe(403);
    expect(errorOf(guessed.body)).toEqual(errorOf(invented.body));
    expect(onlyStoredPlace(harness)).toMatchObject({ name: 'Home' });
  });

  it('freezes a place the plan no longer covers, but still allows deleting it', async () => {
    const created = await createHome(harness);
    const placeId = (created.body as CreatePlaceResponse).place.placeId;
    // Exactly what the subscription worker writes on a downgrade.
    harness.places.seed(PLACES_TABLE, [{ ...onlyStoredPlace(harness), readOnly: true }]);

    const patched = await harness.call({
      method: 'PATCH',
      path: `/v1/places/${placeId}`,
      headers: { ...authHeaders(alice), ...JSON_HEADERS },
      rawBody: JSON.stringify({ radiusMeters: 500 }),
    });
    expect(patched.statusCode).toBe(402);
    expect(patched.body).toMatchObject({ error: { code: 'PLAN_LIMIT_EXCEEDED' } });
    expect(onlyStoredPlace(harness)).toMatchObject({ radiusMeters: 150 });

    const deleted = await harness.call({
      method: 'DELETE',
      path: `/v1/places/${placeId}`,
      headers: authHeaders(alice),
    });
    expect(deleted.statusCode).toBe(200);
    expect(storedPlaces(harness)).toHaveLength(0);
  });

  it('deletes a place and names the fence the devices must drop', async () => {
    const created = await createHome(harness);
    const placeId = (created.body as CreatePlaceResponse).place.placeId;

    const response = await harness.call({
      method: 'DELETE',
      path: `/v1/places/${placeId}`,
      headers: authHeaders(alice),
    });

    expect(response.statusCode).toBe(200);
    expect(response.body as DeletePlaceResponse).toMatchObject({
      placeId,
      familyId: family,
      deletedByUserId: alice,
      unregisterGeofenceIds: [placeId],
    });
    expect(storedPlaces(harness)).toHaveLength(0);

    // Gone is gone, and a deleted id answers like an id that never existed.
    const again = await harness.call({
      method: 'DELETE',
      path: `/v1/places/${placeId}`,
      headers: authHeaders(alice),
    });
    expect(again.statusCode).toBe(403);
  });

  it('creates one place for a retried request', async () => {
    const first = await createHome(harness, { key: 'place-retry-1' });
    const second = await createHome(harness, { key: 'place-retry-1' });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.headers['idempotent-replay']).toBe('true');
    expect(second.body).toEqual(first.body);
    expect(storedPlaces(harness)).toHaveLength(1);
  });

  it('requires an idempotency key to create', async () => {
    const response = await harness.call({
      method: 'POST',
      path: '/v1/places',
      headers: { ...authHeaders(alice), ...JSON_HEADERS },
      rawBody: homeRequest(),
    });

    expect(response.statusCode).toBe(422);
    expect(storedPlaces(harness)).toHaveLength(0);
  });
});

function errorOf(body: unknown): { code: string; message: string } {
  const { error } = body as { error: { code: string; message: string } };
  return { code: error.code, message: error.message };
}
