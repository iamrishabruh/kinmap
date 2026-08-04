import { beforeEach, describe, expect, it } from 'vitest';

import type { FamilyId, PlaceId, UserId } from '@family/contracts';
import type { AccountDeletionPreviewResponse } from '@family/schemas';

import {
  authHeaders,
  createHarness,
  deviceIdOf,
  familyIdOf,
  seedCurrentLocation,
  seedDevice,
  seedFamily,
  seedHistoryPoint,
  seedMembership,
  seedUser,
  testUuid,
  userIdOf,
  TABLES,
  type Harness,
} from './support/harness.js';

/**
 * The screen in front of an irreversible action.
 *
 * The interesting assertions are not that the numbers look plausible. They are
 * that the preview agrees with the deletion it is previewing, that it counts
 * location rows without any part of one reaching a response or a log line, and
 * that looking is not doing: after a preview the account must be exactly as it
 * was, because a user who is still deciding has consented to nothing.
 */

const JSON_HEADERS = { 'content-type': 'application/json' };

const owner = userIdOf(1);
const partner = userIdOf(2);

/** Owned, and nobody else is in it: it would be dissolved. */
const soloFamily = familyIdOf(1);
/** Owned, with another active member: it would be handed over. */
const sharedFamily = familyIdOf(2);
/** Somebody else's family the owner is merely a member of. */
const guestFamily = familyIdOf(3);

const phone = deviceIdOf(1);
const retiredTablet = deviceIdOf(2);

/**
 * Stands in for the sealed coordinate on a stored point. It is a string this
 * service could not decrypt even if it held it, and finding any of it in a
 * response or a log line would be exactly the failure these tests exist for.
 */
const SEALED = 'sealed-51.500729--0.124625';

const placeIdOf = (n: number): PlaceId => testUuid(0xd4, n) as PlaceId;

function seedPlace(
  harness: Harness,
  input: { familyId: FamilyId; placeId: PlaceId; createdBy: UserId; name: string },
): void {
  const timestamp = harness.now().toISOString();
  harness.store.seed(TABLES.savedPlaces, [
    {
      familyId: input.familyId,
      placeId: input.placeId,
      name: input.name,
      category: 'HOME',
      latitude: 51.500729,
      longitude: -0.124625,
      radiusMeters: 150,
      notifyOnArrival: true,
      notifyOnDeparture: false,
      readOnly: false,
      createdBy: input.createdBy,
      createdAt: timestamp,
      updatedAt: timestamp,
      schemaVersion: 1,
    },
  ]);
}

function seedSubscription(
  harness: Harness,
  input: { userId: UserId; status: string; source: string },
): void {
  harness.store.seed(TABLES.subscriptions, [
    {
      userId: input.userId,
      familyId: null,
      plan: 'FAMILY_MONTHLY',
      status: input.status,
      source: input.source,
      isTrial: false,
      currentPeriodEndsAt: null,
      gracePeriodEndsAt: null,
      willRenew: true,
      managementUrl: null,
      refreshedAt: harness.now().toISOString(),
    },
  ]);
}

async function preview(
  harness: Harness,
  userId: UserId = owner,
): Promise<{ statusCode: number; body: unknown }> {
  const response = await harness.call({
    method: 'GET',
    path: '/v1/account/deletion/preview',
    headers: authHeaders(userId),
  });
  return { statusCode: response.statusCode, body: response.body };
}

async function previewBody(harness: Harness): Promise<AccountDeletionPreviewResponse> {
  const response = await preview(harness);
  expect(response.statusCode).toBe(200);
  return response.body as AccountDeletionPreviewResponse;
}

describe('GET /v1/account/deletion/preview', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness();

    seedUser(harness, { userId: owner });
    seedUser(harness, { userId: partner });

    seedFamily(harness, { familyId: soloFamily, ownerUserId: owner, name: 'Just Me' });
    seedMembership(harness, { familyId: soloFamily, userId: owner, role: 'OWNER' });

    seedFamily(harness, { familyId: sharedFamily, ownerUserId: owner, name: 'The Household' });
    seedMembership(harness, { familyId: sharedFamily, userId: owner, role: 'OWNER' });
    seedMembership(harness, { familyId: sharedFamily, userId: partner, role: 'MEMBER' });

    seedFamily(harness, { familyId: guestFamily, ownerUserId: partner, name: 'Their Family' });
    seedMembership(harness, { familyId: guestFamily, userId: partner, role: 'OWNER' });
    seedMembership(harness, { familyId: guestFamily, userId: owner, role: 'MEMBER' });

    seedDevice(harness, { userId: owner, deviceId: phone });
    seedDevice(harness, { userId: owner, deviceId: retiredTablet, status: 'REVOKED' });
    seedDevice(harness, { userId: partner, deviceId: deviceIdOf(3) });

    // Two of the owner's places sit in the family that would dissolve; the third
    // is in a family that survives, and the fourth is not theirs at all.
    seedPlace(harness, {
      familyId: soloFamily,
      placeId: placeIdOf(1),
      createdBy: owner,
      name: 'Home',
    });
    seedPlace(harness, {
      familyId: soloFamily,
      placeId: placeIdOf(2),
      createdBy: owner,
      name: 'Gym',
    });
    seedPlace(harness, {
      familyId: soloFamily,
      placeId: placeIdOf(3),
      createdBy: partner,
      name: 'Their Office',
    });
    seedPlace(harness, {
      familyId: sharedFamily,
      placeId: placeIdOf(4),
      createdBy: owner,
      name: 'School',
    });

    // The clock is 2026-03-01T12:00:00Z.
    seedHistoryPoint(harness, {
      userId: owner,
      day: '2026-03-01',
      eventId: 'e1',
      sealed: SEALED,
    });
    seedHistoryPoint(harness, {
      userId: owner,
      day: '2026-03-01',
      eventId: 'e2',
      sealed: SEALED,
    });
    seedHistoryPoint(harness, {
      userId: owner,
      day: '2026-02-24',
      eventId: 'e3',
      sealed: SEALED,
    });
    seedCurrentLocation(harness, { userId: owner, deviceId: phone, sealed: SEALED });
    // Another person's points must never be counted into somebody else's total.
    seedHistoryPoint(harness, { userId: partner, day: '2026-03-01', eventId: 'e4' });
    seedCurrentLocation(harness, { userId: partner, deviceId: deviceIdOf(3) });
  });

  it('says what goes, family by family', async () => {
    const body = await previewBody(harness);

    expect(body).toEqual({
      ownedFamilies: [
        {
          familyId: soloFamily,
          name: 'Just Me',
          memberCount: 1,
          // Nobody is left to inherit it.
          willBeDissolved: true,
        },
        {
          familyId: sharedFamily,
          name: 'The Household',
          memberCount: 2,
          willBeDissolved: false,
        },
      ],
      // Only the family they are a guest in.
      memberFamilyCount: 1,
      storedLocationPointCount: 4,
      // The two in the family that dissolves; the one in the surviving family
      // is inherited, and the partner's is not theirs to lose.
      savedPlaceCount: 2,
      // The revoked tablet is not something the deletion takes away.
      registeredDeviceCount: 1,
      hasActiveSubscription: false,
      subscriptionStore: 'NONE',
      gracePeriodDays: 30,
    });
  });

  it('counts location rows without any part of one reaching the response or the logs', async () => {
    const response = await preview(harness);

    expect((response.body as AccountDeletionPreviewResponse).storedLocationPointCount).toBe(4);
    expect(JSON.stringify(response.body)).not.toContain('sealed');
    expect(JSON.stringify(response.body)).not.toContain('51.500729');
    expect(JSON.stringify(harness.logs)).not.toContain(SEALED);
    expect(JSON.stringify(harness.logs)).not.toContain('51.500729');
    // Nor the count itself, which is a fact about how much somebody moves.
    expect(JSON.stringify(harness.logs)).not.toContain('storedLocationPointCount');
  });

  it('ignores partitions the purge would not sweep, so the two agree', async () => {
    // Older than retention plus the TTL margin: the deletion job does not sweep
    // this partition, so counting it would promise a deletion that never comes.
    seedHistoryPoint(harness, { userId: owner, day: '2025-01-04', eventId: 'ancient' });

    const body = await previewBody(harness);

    expect(body.storedLocationPointCount).toBe(4);
  });

  it('agrees with the deletion it is previewing', async () => {
    const before = await previewBody(harness);

    const deleted = await harness.call({
      method: 'DELETE',
      path: '/v1/account',
      headers: { ...authHeaders(owner), ...JSON_HEADERS, 'idempotency-key': 'delete-key-0001' },
      rawBody: JSON.stringify({ confirmation: 'DELETE' }),
    });

    expect(deleted.statusCode).toBe(202);
    const body = deleted.body as { affectedFamilyIds: string[]; gracePeriodDays: number };
    expect(body.affectedFamilyIds).toEqual(before.ownedFamilies.map((family) => family.familyId));
    expect(body.gracePeriodDays).toBe(before.gracePeriodDays);
  });

  it('changes nothing at all', async () => {
    await preview(harness);
    await preview(harness);

    expect(harness.store.dump(TABLES.deletionJobs)).toEqual([]);
    // Not one audit row: reading one's own account is not a sensitive action,
    // and a preview is not a request to delete anything.
    expect(harness.store.dump(TABLES.auditEvents)).toEqual([]);

    const user = harness.store.dump(TABLES.users).find((row) => row['userId'] === owner);
    expect(user).toMatchObject({
      status: 'ACTIVE',
      sharingStatus: 'SHARING',
      scheduledPurgeAt: null,
    });

    const devices = harness.store
      .dump(TABLES.devices)
      .filter((row) => row['userId'] === owner && row['deviceId'] === phone);
    expect(devices[0]).toMatchObject({ status: 'ACTIVE' });

    const memberships = harness.store
      .dump(TABLES.familyMemberships)
      .filter((row) => row['userId'] === owner);
    expect(memberships).toHaveLength(3);
    for (const membership of memberships) {
      expect(membership).toMatchObject({ sharingStatus: 'SHARING' });
    }

    // And the rows it counted are still there to be counted again.
    expect(harness.store.dump(TABLES.locationHistory)).toHaveLength(4);
    expect(harness.store.dump(TABLES.currentLocations)).toHaveLength(2);
  });

  it('counts only the caller and never another member', async () => {
    const response = await preview(harness, partner);

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      ownedFamilies: [{ familyId: guestFamily, memberCount: 2, willBeDissolved: false }],
      memberFamilyCount: 1,
      // One history row and one current fix of their own.
      storedLocationPointCount: 2,
      savedPlaceCount: 0,
      registeredDeviceCount: 1,
    });
  });

  it('names the store only while a subscription is live', async () => {
    seedSubscription(harness, { userId: owner, status: 'ACTIVE', source: 'APP_STORE' });

    await expect(previewBody(harness)).resolves.toMatchObject({
      hasActiveSubscription: true,
      subscriptionStore: 'APP_STORE',
    });
  });

  it('does not send somebody to a store that is not billing them', async () => {
    seedSubscription(harness, { userId: owner, status: 'EXPIRED', source: 'APP_STORE' });

    await expect(previewBody(harness)).resolves.toMatchObject({
      hasActiveSubscription: false,
      subscriptionStore: 'NONE',
    });
  });

  it('treats a promotional grant as an entitlement with nothing to cancel', async () => {
    seedSubscription(harness, { userId: owner, status: 'ACTIVE', source: 'PROMOTIONAL' });

    await expect(previewBody(harness)).resolves.toMatchObject({
      hasActiveSubscription: true,
      subscriptionStore: 'NONE',
    });
  });

  it('does not invent a family that is already gone', async () => {
    const ghost = familyIdOf(9);
    seedMembership(harness, { familyId: ghost, userId: owner, role: 'OWNER' });

    const body = await previewBody(harness);

    expect(body.ownedFamilies.map((family) => family.familyId)).toEqual([soloFamily, sharedFamily]);
  });

  it('does not count a family the caller has already left', async () => {
    seedMembership(harness, {
      familyId: familyIdOf(4),
      userId: owner,
      role: 'MEMBER',
      status: 'REMOVED',
    });
    seedFamily(harness, { familyId: familyIdOf(4), ownerUserId: partner });

    const body = await previewBody(harness);

    expect(body.memberFamilyCount).toBe(1);
  });

  it('is a 404 for a purged account rather than an empty preview', async () => {
    harness.store.seed(TABLES.users, [
      {
        ...(harness.store.dump(TABLES.users).find((row) => row['userId'] === owner) ?? {}),
        status: 'DELETED',
      },
    ]);

    const response = await preview(harness);

    expect(response.statusCode).toBe(404);
  });

  it('requires an authenticated caller', async () => {
    const response = await harness.call({
      method: 'GET',
      path: '/v1/account/deletion/preview',
    });

    expect(response.statusCode).toBe(401);
  });
});
