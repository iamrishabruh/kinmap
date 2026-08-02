import { beforeEach, describe, expect, it } from 'vitest';

import { buildAuthorizationChecker } from '@family/auth';
import { AppError } from '@family/contracts';

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
 * Account deletion.
 *
 * Erasure is asynchronous, but the two things the user actually asked for —
 * "stop showing me to people" and "stop my devices uploading" — are applied
 * before the response is written. These tests assert both halves: that the job
 * is durable, and that the revocations are immediate.
 */

const JSON_HEADERS = { 'content-type': 'application/json' };

const owner = userIdOf(1);
const viewer = userIdOf(2);
const viewerDevice = deviceIdOf(2);
const ownerDevice = deviceIdOf(1);
const familyId = familyIdOf(1);

function deleteRequest(
  harness: Harness,
  key = 'delete-key-0001',
): Promise<{
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
}> {
  return harness.call({
    method: 'DELETE',
    path: '/v1/account',
    headers: { ...authHeaders(owner), ...JSON_HEADERS, 'idempotency-key': key },
    rawBody: JSON.stringify({ confirmation: 'DELETE', reason: 'PRIVACY_CONCERN' }),
  });
}

describe('DELETE /v1/account', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness();
    seedUser(harness, { userId: owner });
    seedUser(harness, { userId: viewer });
    seedFamily(harness, { familyId, ownerUserId: owner });
    seedMembership(harness, { familyId, userId: owner, role: 'OWNER' });
    seedMembership(harness, { familyId, userId: viewer, role: 'MEMBER' });
    seedDevice(harness, { userId: owner, deviceId: ownerDevice });
    seedDevice(harness, { userId: viewer, deviceId: viewerDevice });
  });

  it('records a durable job and names the families that need handing over', async () => {
    const response = await deleteRequest(harness);

    expect(response.statusCode).toBe(202);
    expect(response.body).toMatchObject({
      userId: owner,
      status: 'PENDING_DELETION',
      gracePeriodDays: 30,
      affectedFamilyIds: [familyId],
    });

    const jobs = harness.store.dump('DeletionJobs');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      userId: owner,
      jobType: 'ACCOUNT_DELETION',
      status: 'PENDING',
    });
    // The scheduler sweeps the byStatus index; both of its keys must be present.
    expect(jobs[0]).toHaveProperty('scheduledFor');
  });

  it('revokes sharing before anything asynchronous runs', async () => {
    const checker = buildAuthorizationChecker({
      accounts: harness.services.accounts,
      devices: harness.services.devices,
      memberships: harness.services.memberships,
      subscriptions: harness.services.subscriptions,
      rateLimiter: { consume: async () => ({ allowed: true }) },
      now: harness.now,
    });
    const read = (): Promise<unknown> =>
      checker.assertCanReadCurrentLocation({
        auth: authContextFor({ userId: viewer, deviceId: viewerDevice }),
        familyId,
        targetUserId: owner,
      });

    await expect(read()).resolves.toBeDefined();

    await deleteRequest(harness);

    await expect(read()).rejects.toBeInstanceOf(AppError);
  });

  it('revokes every device and destroys its push token', async () => {
    await deleteRequest(harness);

    const devices = harness.store.dump('Devices').filter((device) => device['userId'] === owner);
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({ status: 'REVOKED' });
    expect(devices[0]).not.toHaveProperty('pushToken');

    // Another user's devices are untouched.
    const others = harness.store.dump('Devices').filter((device) => device['userId'] === viewer);
    expect(others[0]).toMatchObject({ status: 'ACTIVE' });
  });

  it('marks the account pending deletion and records an audit event', async () => {
    await deleteRequest(harness);

    const users = harness.store.dump('Users').filter((user) => user['userId'] === owner);
    expect(users[0]).toMatchObject({ status: 'PENDING_DELETION', sharingStatus: 'DISABLED' });

    const events = harness.store
      .dump('AuditEvents')
      .filter((event) => event['action'] === 'ACCOUNT_DELETION_REQUESTED');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actorUserId: owner, targetUserId: owner });
  });

  it('is idempotent: a retry neither duplicates the job nor moves the deadline', async () => {
    const first = await deleteRequest(harness);
    const second = await deleteRequest(harness);

    expect(second.body).toEqual(first.body);
    expect(harness.store.dump('DeletionJobs')).toHaveLength(1);
  });

  it('does not create a second job when the same account is deleted twice', async () => {
    await deleteRequest(harness, 'delete-key-0001');
    // A different key, so idempotency does not short-circuit it: the conditional
    // status update and the job lookup are what keep this safe.
    const again = await deleteRequest(harness, 'delete-key-0002');

    expect(again.statusCode).toBe(202);
    expect(harness.store.dump('DeletionJobs')).toHaveLength(1);
  });

  it('cancels a pending deletion', async () => {
    await deleteRequest(harness);

    const cancelled = await harness.call({
      method: 'POST',
      path: '/v1/account/deletion/cancel',
      headers: authHeaders(owner),
    });

    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.body).toMatchObject({ userId: owner, status: 'ACTIVE' });

    const users = harness.store.dump('Users').filter((user) => user['userId'] === owner);
    expect(users[0]).toMatchObject({ status: 'ACTIVE', scheduledPurgeAt: null });

    const jobs = harness.store.dump('DeletionJobs');
    expect(jobs[0]).toMatchObject({ status: 'CANCELLED' });
  });

  it('refuses to cancel a deletion that was never requested', async () => {
    const response = await harness.call({
      method: 'POST',
      path: '/v1/account/deletion/cancel',
      headers: authHeaders(owner),
    });

    expect(response.statusCode).toBe(409);
  });
});
