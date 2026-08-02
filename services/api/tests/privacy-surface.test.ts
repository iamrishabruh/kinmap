import { beforeEach, describe, expect, it } from 'vitest';

import { buildAuthorizationChecker } from '@family/auth';
import { AppError, type UserId } from '@family/contracts';

import {
  authContextFor,
  authHeaders,
  createHarness,
  deviceIdOf,
  familyIdOf,
  seedDevice,
  seedFamily,
  seedMembership,
  seedUser,
  userIdOf,
  type Harness,
} from './support/harness.js';

/**
 * Privacy properties of the surface that are easy to regress silently: a
 * credential that must never be echoed, and a block that has to work in both
 * directions to be worth anything.
 */

const JSON_HEADERS = { 'content-type': 'application/json' };

const alice = userIdOf(1);
const bob = userIdOf(2);
const aliceDevice = deviceIdOf(1);
const bobDevice = deviceIdOf(2);
const familyId = familyIdOf(1);

describe('device responses', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness();
    seedUser(harness, { userId: alice });
  });

  it('never echoes a push token, on write or on read', async () => {
    const pushToken = 'a'.repeat(64);

    const registered = await harness.call({
      method: 'POST',
      path: '/v1/devices',
      headers: { ...authHeaders(alice), ...JSON_HEADERS, 'idempotency-key': 'register-0001' },
      rawBody: JSON.stringify({
        deviceId: aliceDevice,
        platform: 'ANDROID',
        osVersion: '15',
        appVersion: '1.0.0',
        appBuild: '100',
        modelIdentifier: 'Pixel 9',
        pushToken,
        locale: 'en',
        timeZone: 'UTC',
      }),
    });

    expect(registered.statusCode).toBe(201);
    expect(JSON.stringify(registered.body)).not.toContain(pushToken);
    expect(registered.body).toMatchObject({ device: { pushTokenRegistered: true } });

    const listed = await harness.call({
      method: 'GET',
      path: '/v1/devices',
      headers: authHeaders(alice),
    });
    expect(JSON.stringify(listed.body)).not.toContain(pushToken);

    // It is stored, because the notification service needs it.
    const stored = harness.store.dump('Devices');
    expect(stored[0]).toMatchObject({ pushToken });
  });
});

describe('blocking', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness();
    seedUser(harness, { userId: alice });
    seedUser(harness, { userId: bob });
    seedDevice(harness, { userId: alice, deviceId: aliceDevice });
    seedDevice(harness, { userId: bob, deviceId: bobDevice });
    seedFamily(harness, { familyId, ownerUserId: alice });
    seedMembership(harness, { familyId, userId: alice, role: 'OWNER' });
    seedMembership(harness, { familyId, userId: bob, role: 'MEMBER' });
  });

  function checker(): ReturnType<typeof buildAuthorizationChecker> {
    return buildAuthorizationChecker({
      accounts: harness.services.accounts,
      devices: harness.services.devices,
      memberships: harness.services.memberships,
      subscriptions: harness.services.subscriptions,
      rateLimiter: { consume: async () => ({ allowed: true }) },
      now: harness.now,
    });
  }

  function read(
    requester: UserId,
    requesterDevice: string,
    targetUserId: UserId,
  ): Promise<unknown> {
    return checker().assertCanReadCurrentLocation({
      auth: authContextFor({ userId: requester, deviceId: requesterDevice }),
      familyId,
      targetUserId,
    });
  }

  it('makes the two members invisible to each other in both directions', async () => {
    await expect(read(alice, aliceDevice, bob)).resolves.toBeDefined();
    await expect(read(bob, bobDevice, alice)).resolves.toBeDefined();

    const blocked = await harness.call({
      method: 'POST',
      path: '/v1/support/blocks',
      headers: { ...authHeaders(alice), ...JSON_HEADERS, 'idempotency-key': 'block-0001' },
      rawBody: JSON.stringify({ blockedUserId: bob }),
    });
    expect(blocked.statusCode).toBe(201);

    await expect(read(alice, aliceDevice, bob)).rejects.toBeInstanceOf(AppError);
    await expect(read(bob, bobDevice, alice)).rejects.toBeInstanceOf(AppError);
  });

  it('does not evict the blocked member from the family', async () => {
    await harness.call({
      method: 'POST',
      path: '/v1/support/blocks',
      headers: { ...authHeaders(alice), ...JSON_HEADERS, 'idempotency-key': 'block-0002' },
      rawBody: JSON.stringify({ blockedUserId: bob, removeFromSharedFamilies: true }),
    });

    const memberships = harness.store.dump('FamilyMemberships');
    const bobRow = memberships.find((row) => row['userId'] === bob);
    const aliceRow = memberships.find((row) => row['userId'] === alice);

    // The requester leaves; the blocked member's own membership is untouched.
    expect(bobRow).toMatchObject({ status: 'ACTIVE' });
    expect(aliceRow).toMatchObject({ status: 'LEFT' });
  });

  it('restores visibility on unblock', async () => {
    await harness.call({
      method: 'POST',
      path: '/v1/support/blocks',
      headers: { ...authHeaders(alice), ...JSON_HEADERS, 'idempotency-key': 'block-0003' },
      rawBody: JSON.stringify({ blockedUserId: bob }),
    });
    await expect(read(alice, aliceDevice, bob)).rejects.toBeInstanceOf(AppError);

    const unblocked = await harness.call({
      method: 'DELETE',
      path: `/v1/support/blocks/${bob}`,
      headers: authHeaders(alice),
    });
    expect(unblocked.statusCode).toBe(200);

    await expect(read(alice, aliceDevice, bob)).resolves.toBeDefined();
    await expect(read(bob, bobDevice, alice)).resolves.toBeDefined();
  });

  it('rejects blocking yourself', async () => {
    const response = await harness.call({
      method: 'POST',
      path: '/v1/support/blocks',
      headers: { ...authHeaders(alice), ...JSON_HEADERS, 'idempotency-key': 'block-0004' },
      rawBody: JSON.stringify({ blockedUserId: alice }),
    });

    expect(response.statusCode).toBe(422);
  });
});
