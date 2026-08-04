import { describe, expect, it } from 'vitest';

import { AppError } from '@family/contracts';

import { buildAuthorizationChecker, type DenialReason } from '../src/index.js';

import {
  FAMILY_ID,
  OTHER_FAMILY_ID,
  OUTSIDER_ID,
  REQUESTER_DEVICE_ID,
  REQUESTER_ID,
  TARGET_ID,
  VALID_RANGE,
  authContext,
  createWorld,
  type World,
} from './fixtures.js';

/**
 * Spec §34: a stalker must not be able to tell *why* they were refused.
 *
 * "Not a member", "no such family", "she paused sharing", "she hid from you",
 * "you are rate limited" and "your plan does not include this" must all be the
 * same 403 with the same body, or the difference itself becomes the signal.
 */

type Scenario = {
  name: string;
  /** The audited reason this row is meant to exercise; null when unauditable. */
  reason: DenialReason | null;
  run: (world: World) => Promise<unknown>;
};

const request = (): { auth: ReturnType<typeof authContext>; familyId: string } => ({
  auth: authContext(),
  familyId: FAMILY_ID,
});

const readRequest = (): {
  auth: ReturnType<typeof authContext>;
  familyId: string;
  targetUserId: string;
} => ({ ...request(), targetUserId: TARGET_ID });

const SCENARIOS: readonly Scenario[] = [
  {
    // An empty subject, not a malformed one: a subject is minted by the identity
    // provider and cannot be judged by shape — Cognito's format has already
    // changed once under this codebase. Absent is the only thing still
    // knowable without a lookup, and it leaves no trustworthy actor to audit.
    name: 'principal with no subject',
    reason: null,
    run: (world) =>
      buildAuthorizationChecker(world.deps).assertCanReadCurrentLocation({
        ...readRequest(),
        auth: authContext({ userId: '' }),
      }),
  },
  {
    name: 'principal whose subject has no account',
    reason: 'REQUESTER_ACCOUNT_MISSING',
    run: (world) =>
      buildAuthorizationChecker(world.deps).assertCanReadCurrentLocation({
        ...readRequest(),
        auth: authContext({ userId: 'nobody-with-this-subject' }),
      }),
  },
  {
    name: 'malformed family id',
    reason: 'MALFORMED_REQUEST',
    run: (world) =>
      buildAuthorizationChecker(world.deps).assertCanReadCurrentLocation({
        ...readRequest(),
        familyId: 'still-not-a-uuid',
      }),
  },
  {
    name: 'requester account missing',
    reason: 'REQUESTER_ACCOUNT_MISSING',
    run: (world) => {
      world.removeAccount(REQUESTER_ID);
      return buildAuthorizationChecker(world.deps).assertCanReadCurrentLocation(readRequest());
    },
  },
  {
    name: 'requester account suspended',
    reason: 'REQUESTER_ACCOUNT_INACTIVE',
    run: (world) => {
      world.setAccountStatus(REQUESTER_ID, 'SUSPENDED');
      return buildAuthorizationChecker(world.deps).assertCanReadCurrentLocation(readRequest());
    },
  },
  {
    name: 'no device binding',
    reason: 'REQUESTER_DEVICE_MISSING',
    run: (world) =>
      buildAuthorizationChecker(world.deps).assertCanReadCurrentLocation({
        ...readRequest(),
        auth: authContext({ deviceId: null }),
      }),
  },
  {
    name: 'device not registered',
    reason: 'REQUESTER_DEVICE_NOT_REGISTERED',
    run: (world) => {
      world.removeDevice(REQUESTER_DEVICE_ID);
      return buildAuthorizationChecker(world.deps).assertCanReadCurrentLocation(readRequest());
    },
  },
  {
    name: 'device revoked',
    reason: 'REQUESTER_DEVICE_NOT_ACTIVE',
    run: (world) => {
      world.setDeviceStatus(REQUESTER_DEVICE_ID, 'REVOKED');
      return buildAuthorizationChecker(world.deps).assertCanReadCurrentLocation(readRequest());
    },
  },
  {
    name: 'family does not contain the requester',
    reason: 'REQUESTER_NOT_A_MEMBER',
    run: (world) =>
      buildAuthorizationChecker(world.deps).assertCanReadCurrentLocation({
        ...readRequest(),
        familyId: OTHER_FAMILY_ID,
      }),
  },
  {
    name: 'requester was removed from the family',
    reason: 'REQUESTER_MEMBERSHIP_INACTIVE',
    run: (world) => {
      world.setMembershipStatus(REQUESTER_ID, 'REMOVED');
      return buildAuthorizationChecker(world.deps).assertCanReadCurrentLocation(readRequest());
    },
  },
  {
    name: 'requester role is too low',
    reason: 'REQUESTER_ROLE_INSUFFICIENT',
    run: (world) => {
      world.setMembershipRole(REQUESTER_ID, 'MEMBER');
      return buildAuthorizationChecker(world.deps).assertCanMutateFamily(request());
    },
  },
  {
    name: 'target is not in the family',
    reason: 'TARGET_NOT_A_MEMBER',
    run: (world) => {
      world.removeMembership(TARGET_ID);
      return buildAuthorizationChecker(world.deps).assertCanReadCurrentLocation(readRequest());
    },
  },
  {
    name: 'target left the family',
    reason: 'TARGET_MEMBERSHIP_INACTIVE',
    run: (world) => {
      world.setMembershipStatus(TARGET_ID, 'LEFT');
      return buildAuthorizationChecker(world.deps).assertCanReadCurrentLocation(readRequest());
    },
  },
  {
    name: 'target paused sharing',
    reason: 'TARGET_SHARING_DISABLED',
    run: (world) => {
      world.setSharingStatus(TARGET_ID, 'PAUSED');
      return buildAuthorizationChecker(world.deps).assertCanReadCurrentLocation(readRequest());
    },
  },
  {
    name: 'target hid from this requester',
    reason: 'TARGET_VISIBILITY_EXCLUDES_REQUESTER',
    run: (world) => {
      world.setVisibility(TARGET_ID, [OUTSIDER_ID]);
      return buildAuthorizationChecker(world.deps).assertCanReadCurrentLocation(readRequest());
    },
  },
  {
    name: 'target outranks the requester',
    reason: 'TARGET_OUTRANKS_REQUESTER',
    run: (world) => {
      world.setMembershipRole(TARGET_ID, 'OWNER');
      return buildAuthorizationChecker(world.deps).assertCanManageMember(readRequest());
    },
  },
  {
    name: 'plan does not include history',
    reason: 'ENTITLEMENT_REQUIRED',
    run: (world) => {
      world.setPlan('FREE');
      return buildAuthorizationChecker(world.deps).assertCanReadHistory({
        ...readRequest(),
        range: VALID_RANGE,
      });
    },
  },
  {
    name: 'history window is invalid',
    reason: 'DATE_RANGE_INVALID',
    run: (world) =>
      buildAuthorizationChecker(world.deps).assertCanReadHistory({
        ...readRequest(),
        range: { from: '2026-08-01T00:00:00.000Z', to: '2026-01-01T00:00:00.000Z' },
      }),
  },
  {
    name: 'rate limited',
    reason: 'RATE_LIMITED',
    run: (world) => {
      world.denyRateLimit();
      return buildAuthorizationChecker(world.deps).assertCanReadCurrentLocation(readRequest());
    },
  },
  {
    name: 'live session targeted at self',
    reason: 'MALFORMED_REQUEST',
    run: (world) =>
      buildAuthorizationChecker(world.deps).assertCanStartLiveSession({
        ...readRequest(),
        targetUserId: REQUESTER_ID,
      }),
  },
];

/** Everything a caller could possibly observe from the thrown value. */
function fingerprint(error: AppError): string {
  return JSON.stringify({
    name: error.name,
    code: error.code,
    status: error.status,
    message: error.message,
    fields: error.fields ?? null,
    retryAfterSeconds: error.retryAfterSeconds ?? null,
    ownProperties: Object.keys(error).sort(),
    /** The envelope the API edge would serialise (spec §21). */
    envelope: {
      error: {
        code: error.code,
        message: error.message,
        requestId: 'REDACTED-FOR-COMPARISON',
      },
    },
  });
}

async function capture(scenario: Scenario): Promise<{ error: AppError; world: World }> {
  const world = createWorld();
  try {
    await scenario.run(world);
  } catch (error) {
    if (error instanceof AppError) {
      return { error, world };
    }
    throw error;
  }
  throw new Error(`scenario "${scenario.name}" was expected to deny`);
}

describe('denials are indistinguishable', () => {
  it('produces a byte-identical error for every failed check', async () => {
    const fingerprints = new Map<string, string[]>();

    for (const scenario of SCENARIOS) {
      const { error } = await capture(scenario);
      const key = fingerprint(error);
      const existing = fingerprints.get(key) ?? [];
      existing.push(scenario.name);
      fingerprints.set(key, existing);
    }

    expect([...fingerprints.values()]).toHaveLength(1);
    expect([...fingerprints.keys()][0]).toContain('"code":"FORBIDDEN"');
    expect([...fingerprints.values()][0]).toHaveLength(SCENARIOS.length);
  });

  it('never leaks the internal reason into the thrown error', async () => {
    for (const scenario of SCENARIOS) {
      const { error } = await capture(scenario);
      // Exactly what an API edge can serialise: the message and the error's own
      // enumerable state. The stack never leaves the server.
      const surface = [error.message, JSON.stringify({ ...error }), String(error)].join('\n');

      if (scenario.reason !== null) {
        expect(surface).not.toContain(scenario.reason);
      }
      expect(surface).not.toContain(TARGET_ID);
      expect(surface).not.toContain(FAMILY_ID);
      expect(surface.toLowerCase()).not.toContain('sharing');
      expect(surface.toLowerCase()).not.toContain('paused');
      expect(surface.toLowerCase()).not.toContain('subscription');
      expect(surface.toLowerCase()).not.toContain('member');
    }
  });

  it('records the distinguishing reason server-side instead', async () => {
    const observed = new Set<string>();

    for (const scenario of SCENARIOS) {
      const { world } = await capture(scenario);
      const denial = world.audit.find((entry) => entry.decision === 'DENIED');
      if (scenario.reason === null) {
        // An unverifiable principal has no trustworthy actor id to audit.
        expect(denial).toBeUndefined();
        continue;
      }
      expect(denial?.reason).toBe(scenario.reason);
      observed.add(scenario.reason);
    }

    // Every auditable denial reason is covered by a scenario above; adding a new
    // one without an anti-probing scenario fails here.
    expect([...observed].sort()).toEqual(
      [
        'DATE_RANGE_INVALID',
        'ENTITLEMENT_REQUIRED',
        'MALFORMED_REQUEST',
        'RATE_LIMITED',
        'REQUESTER_ACCOUNT_INACTIVE',
        'REQUESTER_ACCOUNT_MISSING',
        'REQUESTER_DEVICE_MISSING',
        'REQUESTER_DEVICE_NOT_ACTIVE',
        'REQUESTER_DEVICE_NOT_REGISTERED',
        'REQUESTER_MEMBERSHIP_INACTIVE',
        'REQUESTER_NOT_A_MEMBER',
        'REQUESTER_ROLE_INSUFFICIENT',
        'TARGET_MEMBERSHIP_INACTIVE',
        'TARGET_NOT_A_MEMBER',
        'TARGET_OUTRANKS_REQUESTER',
        'TARGET_SHARING_DISABLED',
        'TARGET_VISIBILITY_EXCLUDES_REQUESTER',
      ].sort(),
    );
  });

  it('answers a probe for a non-existent family exactly as for a real one', async () => {
    const stranger = await capture({
      name: 'unknown family',
      reason: 'REQUESTER_NOT_A_MEMBER',
      run: (world) =>
        buildAuthorizationChecker(world.deps).assertCanReadCurrentLocation({
          ...readRequest(),
          familyId: OTHER_FAMILY_ID,
        }),
    });
    const paused = await capture({
      name: 'paused target',
      reason: 'TARGET_SHARING_DISABLED',
      run: (world) => {
        world.setSharingStatus(TARGET_ID, 'PAUSED');
        return buildAuthorizationChecker(world.deps).assertCanReadCurrentLocation(readRequest());
      },
    });

    expect(fingerprint(stranger.error)).toBe(fingerprint(paused.error));
    // The difference exists only in the operator-side audit trail.
    expect(stranger.world.audit.at(-1)?.reason).toBe('REQUESTER_NOT_A_MEMBER');
    expect(paused.world.audit.at(-1)?.reason).toBe('TARGET_SHARING_DISABLED');
  });
});
