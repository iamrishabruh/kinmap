import { beforeEach, describe, expect, it } from 'vitest';

import { buildAuthorizationChecker, type AuthorizationChecker } from '@family/auth';
import { AppError, type FamilyId, type UserId } from '@family/contracts';

import { planSharingChange } from '../src/domain/sharing.js';
import type { MembershipRecord } from '../src/repositories/families.js';

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
 * The consent contract: pausing sharing must deny the very next read.
 *
 * This is asserted end to end — the API writes the pause, and the real
 * authorization checker from `@family/auth` (the same one the location service
 * uses) is then asked whether the viewer may read the target's current position.
 * Nothing is mocked in between, so the test would fail if the pause were written
 * anywhere the checker does not read.
 */

const JSON_HEADERS = { 'content-type': 'application/json' };

const target = userIdOf(1);
const viewer = userIdOf(2);
const viewerDevice = deviceIdOf(2);
const familyOne = familyIdOf(1);
const familyTwo = familyIdOf(2);

function checkerFor(harness: Harness): AuthorizationChecker {
  return buildAuthorizationChecker({
    accounts: harness.services.accounts,
    devices: harness.services.devices,
    memberships: harness.services.memberships,
    subscriptions: harness.services.subscriptions,
    rateLimiter: { consume: async () => ({ allowed: true }) },
    now: harness.now,
  });
}

function readCurrentLocation(harness: Harness, familyId: FamilyId): Promise<unknown> {
  return checkerFor(harness).assertCanReadCurrentLocation({
    auth: authContextFor({ userId: viewer, deviceId: viewerDevice }),
    familyId,
    targetUserId: target,
  });
}

describe('pausing sharing', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness();
    seedUser(harness, { userId: target });
    seedUser(harness, { userId: viewer });
    seedDevice(harness, { userId: viewer, deviceId: viewerDevice });
    for (const familyId of [familyOne, familyTwo]) {
      seedFamily(harness, { familyId, ownerUserId: viewer });
      seedMembership(harness, { familyId, userId: target });
      seedMembership(harness, { familyId, userId: viewer, role: 'OWNER' });
    }
  });

  it('denies the next current-location read after a family-scoped pause', async () => {
    // Before: the viewer may read.
    await expect(readCurrentLocation(harness, familyOne)).resolves.toBeDefined();

    const paused = await harness.call({
      method: 'PATCH',
      path: '/v1/privacy/sharing',
      headers: { ...authHeaders(target), ...JSON_HEADERS },
      rawBody: JSON.stringify({ scope: 'FAMILY', familyId: familyOne, sharing: false }),
    });
    expect(paused.statusCode).toBe(200);

    // After: the very next read is denied, with no intervening step.
    await expect(readCurrentLocation(harness, familyOne)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('denies with the same opaque error a stranger would get', async () => {
    await harness.call({
      method: 'PATCH',
      path: '/v1/privacy/sharing',
      headers: { ...authHeaders(target), ...JSON_HEADERS },
      rawBody: JSON.stringify({ scope: 'FAMILY', familyId: familyOne, sharing: false }),
    });

    const denial: AppError = await readCurrentLocation(harness, familyOne).then(
      () => {
        throw new Error('Expected the read to be denied.');
      },
      (error: unknown) => error as AppError,
    );

    expect(denial).toBeInstanceOf(AppError);
    expect(denial.code).toBe('FORBIDDEN');
    // Nothing in the message says "paused" — a stalker must not be able to tell
    // a pause from a removal from a person who never existed.
    expect(denial.message).toBe('You do not have access to this resource.');
    expect(denial.message).not.toMatch(/pause|sharing|family|member/i);
  });

  it('leaves other families readable when the pause is family-scoped', async () => {
    await harness.call({
      method: 'PATCH',
      path: '/v1/privacy/sharing',
      headers: { ...authHeaders(target), ...JSON_HEADERS },
      rawBody: JSON.stringify({ scope: 'FAMILY', familyId: familyOne, sharing: false }),
    });

    await expect(readCurrentLocation(harness, familyOne)).rejects.toBeInstanceOf(AppError);
    await expect(readCurrentLocation(harness, familyTwo)).resolves.toBeDefined();
  });

  it('denies everywhere after a global pause', async () => {
    const response = await harness.call({
      method: 'PATCH',
      path: '/v1/privacy/sharing',
      headers: { ...authHeaders(target), ...JSON_HEADERS },
      rawBody: JSON.stringify({ scope: 'GLOBAL', sharing: false }),
    });
    expect(response.statusCode).toBe(200);

    await expect(readCurrentLocation(harness, familyOne)).rejects.toBeInstanceOf(AppError);
    await expect(readCurrentLocation(harness, familyTwo)).rejects.toBeInstanceOf(AppError);
  });

  it('reports who lost sight of the user, by id only', async () => {
    const response = await harness.call({
      method: 'PATCH',
      path: '/v1/privacy/sharing',
      headers: { ...authHeaders(target), ...JSON_HEADERS },
      rawBody: JSON.stringify({ scope: 'FAMILY', familyId: familyOne, sharing: false }),
    });

    const body = response.body as { affectedViewerUserIds: UserId[] };
    expect(body.affectedViewerUserIds).toEqual([viewer]);
  });

  it('restores access on resume', async () => {
    await harness.call({
      method: 'PATCH',
      path: '/v1/privacy/sharing',
      headers: { ...authHeaders(target), ...JSON_HEADERS },
      rawBody: JSON.stringify({ scope: 'GLOBAL', sharing: false }),
    });
    await expect(readCurrentLocation(harness, familyOne)).rejects.toBeInstanceOf(AppError);

    await harness.call({
      method: 'PATCH',
      path: '/v1/privacy/sharing',
      headers: { ...authHeaders(target), ...JSON_HEADERS },
      rawBody: JSON.stringify({ scope: 'GLOBAL', sharing: true }),
    });

    await expect(readCurrentLocation(harness, familyOne)).resolves.toBeDefined();
  });

  it('does not let a global resume undo a family-scoped pause', async () => {
    await harness.call({
      method: 'PATCH',
      path: '/v1/privacy/sharing',
      headers: { ...authHeaders(target), ...JSON_HEADERS },
      rawBody: JSON.stringify({ scope: 'FAMILY', familyId: familyOne, sharing: false }),
    });
    await harness.call({
      method: 'PATCH',
      path: '/v1/privacy/sharing',
      headers: { ...authHeaders(target), ...JSON_HEADERS },
      rawBody: JSON.stringify({ scope: 'GLOBAL', sharing: true }),
    });

    await expect(readCurrentLocation(harness, familyOne)).rejects.toBeInstanceOf(AppError);
    await expect(readCurrentLocation(harness, familyTwo)).resolves.toBeDefined();
  });

  it('refuses a family the caller does not belong to, opaquely', async () => {
    const response = await harness.call({
      method: 'PATCH',
      path: '/v1/privacy/sharing',
      headers: { ...authHeaders(target), ...JSON_HEADERS },
      rawBody: JSON.stringify({ scope: 'FAMILY', familyId: familyIdOf(99), sharing: false }),
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toMatchObject({ error: { code: 'FORBIDDEN' } });
  });

  it('records an audit event for the pause', async () => {
    await harness.call({
      method: 'PATCH',
      path: '/v1/privacy/sharing',
      headers: { ...authHeaders(target), ...JSON_HEADERS },
      rawBody: JSON.stringify({ scope: 'FAMILY', familyId: familyOne, sharing: false }),
    });

    const events = harness.store.dump('AuditEvents');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'SHARING_PAUSED',
      actorUserId: target,
      targetUserId: target,
      familyId: familyOne,
    });
  });
});

describe('planSharingChange', () => {
  const now = new Date('2026-03-01T12:00:00.000Z');

  function membership(overrides: Partial<MembershipRecord> = {}): MembershipRecord {
    return {
      familyId: familyOne,
      userId: target,
      role: 'MEMBER',
      status: 'ACTIVE',
      sharingStatus: 'SHARING',
      visibleToUserIds: null,
      hiddenFromUserIds: [],
      pausedUntil: null,
      pausedScope: null,
      sharingChangedAt: now.toISOString(),
      joinedAt: now.toISOString(),
      updatedAt: now.toISOString(),
      ...overrides,
    };
  }

  it('excludes viewers the target had already hidden from', () => {
    const hidden = userIdOf(3);
    const roster = [membership(), membership({ userId: viewer }), membership({ userId: hidden })];

    const plan = planSharingChange({
      userId: target,
      request: { scope: 'FAMILY', familyId: familyOne, sharing: false, pauseUntil: null },
      memberships: [membership({ hiddenFromUserIds: [hidden] })],
      rosters: new Map([[familyOne, roster]]),
      currentGlobalStatus: 'SHARING',
      currentGlobalPausedUntil: null,
    });

    // The already-hidden member loses nothing, so they are not "affected".
    expect(plan.affectedViewerUserIds).toEqual([viewer]);
  });

  it('reports nobody as affected when the target was already paused', () => {
    const plan = planSharingChange({
      userId: target,
      request: { scope: 'GLOBAL', familyId: null, sharing: false, pauseUntil: null },
      memberships: [membership({ sharingStatus: 'PAUSED' })],
      rosters: new Map([[familyOne, [membership(), membership({ userId: viewer })]]]),
      currentGlobalStatus: 'PAUSED',
      currentGlobalPausedUntil: null,
    });

    expect(plan.affectedViewerUserIds).toEqual([]);
  });

  it('carries a timed pause through to every write', () => {
    const pauseUntil = '2026-03-01T13:00:00.000Z';

    const plan = planSharingChange({
      userId: target,
      request: { scope: 'GLOBAL', familyId: null, sharing: false, pauseUntil },
      memberships: [membership(), membership({ familyId: familyTwo })],
      rosters: new Map(),
      currentGlobalStatus: 'SHARING',
      currentGlobalPausedUntil: null,
    });

    expect(plan.writes).toHaveLength(2);
    for (const write of plan.writes) {
      expect(write).toMatchObject({
        sharingStatus: 'PAUSED',
        pausedUntil: pauseUntil,
        pausedScope: 'GLOBAL',
      });
    }
    expect(plan.globalPausedUntil).toBe(pauseUntil);
  });
});
