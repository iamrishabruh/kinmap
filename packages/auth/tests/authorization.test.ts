import { beforeEach, describe, expect, it } from 'vitest';

import { AppError } from '@family/contracts';

import { buildAuthorizationChecker, type AuthorizationChecker } from '../src/index.js';

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
  membership,
  type World,
} from './fixtures.js';

function checkerFor(world: World): AuthorizationChecker {
  return buildAuthorizationChecker(world.deps);
}

function readRequest(): {
  auth: ReturnType<typeof authContext>;
  familyId: string;
  targetUserId: string;
} {
  return { auth: authContext(), familyId: FAMILY_ID, targetUserId: TARGET_ID };
}

async function captureDenial(operation: Promise<unknown>): Promise<AppError> {
  try {
    await operation;
  } catch (error) {
    if (error instanceof AppError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected the operation to be denied');
}

describe('baseline: a fully permitted world', () => {
  let world: World;
  let checker: AuthorizationChecker;

  beforeEach(() => {
    world = createWorld();
    checker = checkerFor(world);
  });

  it('allows reading a sharing family member', async () => {
    const grant = await checker.assertCanReadCurrentLocation(readRequest());

    expect(grant.operation).toBe('READ_CURRENT_LOCATION');
    expect(grant.requesterUserId).toBe(REQUESTER_ID);
    expect(grant.targetUserId).toBe(TARGET_ID);
    expect(grant.targetMembership?.userId).toBe(TARGET_ID);
    expect(grant.tier).toBe('FAMILY');
  });

  it('allows history and returns the clamped window', async () => {
    const grant = await checker.assertCanReadHistory({ ...readRequest(), range: VALID_RANGE });

    expect(grant.retentionDays).toBe(30);
    expect(grant.effectiveRange.to).toBe(VALID_RANGE.to);
    expect(grant.effectiveRange.from).toBe(VALID_RANGE.from);
  });

  it('allows a live session and clamps its duration to the platform ceiling', async () => {
    const grant = await checker.assertCanStartLiveSession({
      ...readRequest(),
      requestedDurationSeconds: 86_400,
    });

    expect(grant.maxDurationSeconds).toBe(600);
  });

  it('allows an admin to mutate the family and manage a lower-ranked member', async () => {
    await expect(
      checker.assertCanMutateFamily({ auth: authContext(), familyId: FAMILY_ID }),
    ).resolves.toMatchObject({ operation: 'MUTATE_FAMILY', targetUserId: null });
    await expect(checker.assertCanManageMember(readRequest())).resolves.toMatchObject({
      operation: 'MANAGE_MEMBER',
    });
  });

  it('runs the checklist in order and stops at the first failure', async () => {
    world.setMembershipStatus(REQUESTER_ID, 'REMOVED');
    await captureDenial(checker.assertCanReadCurrentLocation(readRequest()));

    // Requester membership is step 4, so nothing about the target was fetched
    // and the rate limiter was never consumed.
    expect(world.calls).toContain(`memberships:${FAMILY_ID}:${REQUESTER_ID}`);
    expect(world.calls).not.toContain(`memberships:${FAMILY_ID}:${TARGET_ID}`);
    expect(world.calls.some((call) => call.startsWith('rate:'))).toBe(false);
  });

  it('consumes the rate limiter only after every other check passes', async () => {
    await checker.assertCanReadCurrentLocation(readRequest());
    expect(world.calls.at(-1)).toBe(`rate:READ_CURRENT_LOCATION:user:${REQUESTER_ID}`);
  });
});

/**
 * Each row breaks exactly one link in the §18 chain. All of them must deny, and
 * the audit trail must name the check that fired — that is what proves the check
 * is independently load-bearing rather than shadowed by another.
 */
describe('every check can deny on its own', () => {
  const scenarios: ReadonlyArray<{
    name: string;
    reason: string;
    arrange: (world: World) => void;
    act?: (checker: AuthorizationChecker) => Promise<unknown>;
  }> = [
    {
      name: 'requester account is missing',
      reason: 'REQUESTER_ACCOUNT_MISSING',
      arrange: (world) => {
        world.removeAccount(REQUESTER_ID);
      },
    },
    {
      name: 'requester account is suspended',
      reason: 'REQUESTER_ACCOUNT_INACTIVE',
      arrange: (world) => {
        world.setAccountStatus(REQUESTER_ID, 'SUSPENDED');
      },
    },
    {
      name: 'requester account is pending deletion',
      reason: 'REQUESTER_ACCOUNT_INACTIVE',
      arrange: (world) => {
        world.setAccountStatus(REQUESTER_ID, 'PENDING_DELETION');
      },
    },
    {
      name: 'requester device is not registered',
      reason: 'REQUESTER_DEVICE_NOT_REGISTERED',
      arrange: (world) => {
        world.removeDevice(REQUESTER_DEVICE_ID);
      },
    },
    {
      name: 'requester device was revoked',
      reason: 'REQUESTER_DEVICE_NOT_ACTIVE',
      arrange: (world) => {
        world.setDeviceStatus(REQUESTER_DEVICE_ID, 'REVOKED');
      },
    },
    {
      name: 'requester is not a member of the family',
      reason: 'REQUESTER_NOT_A_MEMBER',
      arrange: (world) => {
        world.removeMembership(REQUESTER_ID);
      },
    },
    {
      name: 'requester membership is no longer active',
      reason: 'REQUESTER_MEMBERSHIP_INACTIVE',
      arrange: (world) => {
        world.setMembershipStatus(REQUESTER_ID, 'REMOVED');
      },
    },
    {
      name: 'target is not a member of the family',
      reason: 'TARGET_NOT_A_MEMBER',
      arrange: (world) => {
        world.removeMembership(TARGET_ID);
      },
    },
    {
      name: 'target membership is not active',
      reason: 'TARGET_MEMBERSHIP_INACTIVE',
      arrange: (world) => {
        world.setMembershipStatus(TARGET_ID, 'LEFT');
      },
    },
    {
      name: 'target paused sharing',
      reason: 'TARGET_SHARING_DISABLED',
      arrange: (world) => {
        world.setSharingStatus(TARGET_ID, 'PAUSED');
      },
    },
    {
      name: 'target visibility list excludes the requester',
      reason: 'TARGET_VISIBILITY_EXCLUDES_REQUESTER',
      arrange: (world) => {
        world.setVisibility(TARGET_ID, [OUTSIDER_ID]);
      },
    },
    {
      name: 'entitlement does not cover the feature',
      reason: 'ENTITLEMENT_REQUIRED',
      arrange: (world) => {
        world.setPlan('FREE');
      },
      act: (checker) => checker.assertCanReadHistory({ ...readRequest(), range: VALID_RANGE }),
    },
    {
      name: 'date range is invalid',
      reason: 'DATE_RANGE_INVALID',
      arrange: () => {
        // no world change: the range itself is the defect
      },
      act: (checker) =>
        checker.assertCanReadHistory({
          ...readRequest(),
          range: { from: '2026-08-01T00:00:00.000Z', to: '2026-07-01T00:00:00.000Z' },
        }),
    },
    {
      name: 'rate limit is exhausted',
      reason: 'RATE_LIMITED',
      arrange: (world) => {
        world.denyRateLimit();
      },
    },
  ];

  for (const scenario of scenarios) {
    it(`denies when ${scenario.name}`, async () => {
      const world = createWorld();
      scenario.arrange(world);
      const checker = checkerFor(world);

      const error = await captureDenial(
        scenario.act === undefined
          ? checker.assertCanReadCurrentLocation(readRequest())
          : scenario.act(checker),
      );

      expect(error.code).toBe('FORBIDDEN');
      expect(error.status).toBe(403);
      const denial = world.audit.find((entry) => entry.decision === 'DENIED');
      expect(denial?.reason).toBe(scenario.reason);
    });
  }

  it('denies a principal that is not a real account', async () => {
    // A subject cannot be judged by its shape: it is minted by the identity
    // provider, and Cognito's format has already changed once under this
    // codebase. So an unknown principal is caught where it actually matters —
    // there is no account for it — and the denial is the same opaque FORBIDDEN
    // every other refusal produces.
    const world = createWorld();
    const checker = checkerFor(world);

    const error = await captureDenial(
      checker.assertCanReadCurrentLocation({
        ...readRequest(),
        auth: authContext({ userId: 'nobody-with-this-subject' }),
      }),
    );

    expect(error.code).toBe('FORBIDDEN');
  });

  it('still refuses a principal with no subject at all', async () => {
    const world = createWorld();
    const checker = checkerFor(world);

    const error = await captureDenial(
      checker.assertCanReadCurrentLocation({
        ...readRequest(),
        auth: authContext({ userId: '' }),
      }),
    );

    expect(error.code).toBe('FORBIDDEN');
    // Nothing to look up, so nothing is looked up.
    expect(world.calls).toHaveLength(0);
  });

  it('denies an id token presented as an access token', async () => {
    const world = createWorld();
    const checker = checkerFor(world);

    const error = await captureDenial(
      checker.assertCanReadCurrentLocation({
        ...readRequest(),
        auth: authContext({ tokenUse: 'id' }),
      }),
    );
    expect(error.code).toBe('FORBIDDEN');
    expect(world.calls).toHaveLength(0);
  });

  it('denies a request for a family the requester never named correctly', async () => {
    const world = createWorld();
    const checker = checkerFor(world);

    await captureDenial(
      checker.assertCanReadCurrentLocation({ ...readRequest(), familyId: OTHER_FAMILY_ID }),
    );
    expect(world.audit.at(-1)?.reason).toBe('REQUESTER_NOT_A_MEMBER');
  });

  it('denies when the device claim is absent entirely', async () => {
    const world = createWorld();
    const checker = checkerFor(world);

    await captureDenial(
      checker.assertCanReadCurrentLocation({
        ...readRequest(),
        auth: authContext({ deviceId: null }),
      }),
    );
    expect(world.audit.at(-1)?.reason).toBe('REQUESTER_DEVICE_MISSING');
  });

  it('denies when another user device id is presented', async () => {
    const world = createWorld();
    const checker = checkerFor(world);

    await captureDenial(
      checker.assertCanReadCurrentLocation({
        ...readRequest(),
        auth: authContext({ userId: TARGET_ID, deviceId: REQUESTER_DEVICE_ID }),
      }),
    );
    expect(world.audit.at(-1)?.reason).toBe('REQUESTER_DEVICE_NOT_REGISTERED');
  });

  it('allows the device check to be waived for a specific operation', async () => {
    const world = createWorld({ deviceRequirements: { READ_CURRENT_LOCATION: false } });
    const checker = checkerFor(world);

    await expect(
      checker.assertCanReadCurrentLocation({
        ...readRequest(),
        auth: authContext({ deviceId: null }),
      }),
    ).resolves.toMatchObject({ operation: 'READ_CURRENT_LOCATION' });
  });
});

describe('revocation takes effect immediately', () => {
  it('a removed member loses access on the very next call', async () => {
    const world = createWorld();
    const checker = checkerFor(world);

    await expect(checker.assertCanReadCurrentLocation(readRequest())).resolves.toBeDefined();

    world.setMembershipStatus(REQUESTER_ID, 'REMOVED');

    const error = await captureDenial(checker.assertCanReadCurrentLocation(readRequest()));
    expect(error.code).toBe('FORBIDDEN');
    expect(world.audit.at(-1)?.reason).toBe('REQUESTER_MEMBERSHIP_INACTIVE');
  });

  it('a member removed from the other side stops being readable', async () => {
    const world = createWorld();
    const checker = checkerFor(world);

    await expect(checker.assertCanReadCurrentLocation(readRequest())).resolves.toBeDefined();

    world.setMembershipStatus(TARGET_ID, 'REMOVED');

    await captureDenial(checker.assertCanReadCurrentLocation(readRequest()));
    expect(world.audit.at(-1)?.reason).toBe('TARGET_MEMBERSHIP_INACTIVE');
  });

  it('a blocked member cannot read', async () => {
    const world = createWorld();
    world.setMembershipStatus(REQUESTER_ID, 'BLOCKED');

    await captureDenial(checkerFor(world).assertCanReadCurrentLocation(readRequest()));
    expect(world.audit.at(-1)?.reason).toBe('REQUESTER_MEMBERSHIP_INACTIVE');
  });

  it('a pending invitation grants nothing yet', async () => {
    const world = createWorld();
    world.setMembershipStatus(REQUESTER_ID, 'PENDING');

    await captureDenial(checkerFor(world).assertCanReadCurrentLocation(readRequest()));
    expect(world.audit.at(-1)?.reason).toBe('REQUESTER_MEMBERSHIP_INACTIVE');
  });
});

describe('the target controls their own visibility', () => {
  const nonSharing = ['PAUSED', 'DISABLED', 'PERMISSION_BLOCKED', 'NEVER_ENABLED'] as const;

  for (const sharingStatus of nonSharing) {
    it(`denies a read while the target is ${sharingStatus}`, async () => {
      const world = createWorld();
      world.setSharingStatus(TARGET_ID, sharingStatus);

      const error = await captureDenial(
        checkerFor(world).assertCanReadCurrentLocation(readRequest()),
      );
      expect(error.code).toBe('FORBIDDEN');
      expect(world.audit.at(-1)?.reason).toBe('TARGET_SHARING_DISABLED');
    });
  }

  it('denies history and live sessions for a paused target too', async () => {
    const world = createWorld();
    world.setSharingStatus(TARGET_ID, 'PAUSED');
    const checker = checkerFor(world);

    await captureDenial(checker.assertCanReadHistory({ ...readRequest(), range: VALID_RANGE }));
    await captureDenial(checker.assertCanStartLiveSession(readRequest()));
  });

  it('honours an explicit allow-list', async () => {
    const world = createWorld();
    world.setVisibility(TARGET_ID, [REQUESTER_ID]);

    await expect(
      checkerFor(world).assertCanReadCurrentLocation(readRequest()),
    ).resolves.toBeDefined();
  });

  it('an empty allow-list hides the member from everyone', async () => {
    const world = createWorld();
    world.setVisibility(TARGET_ID, []);

    await captureDenial(checkerFor(world).assertCanReadCurrentLocation(readRequest()));
    expect(world.audit.at(-1)?.reason).toBe('TARGET_VISIBILITY_EXCLUDES_REQUESTER');
  });

  it('a deny-list beats an allow-list and outranks the requester role', async () => {
    const world = createWorld();
    world.setMembershipRole(REQUESTER_ID, 'OWNER');
    world.setVisibility(TARGET_ID, [REQUESTER_ID]);
    world.setHiddenFrom(TARGET_ID, [REQUESTER_ID]);

    await captureDenial(checkerFor(world).assertCanReadCurrentLocation(readRequest()));
    expect(world.audit.at(-1)?.reason).toBe('TARGET_VISIBILITY_EXCLUDES_REQUESTER');
  });

  it('lets a member read their own location even while paused and hidden', async () => {
    const world = createWorld();
    world.setSharingStatus(REQUESTER_ID, 'PAUSED');
    world.setVisibility(REQUESTER_ID, []);

    await expect(
      checkerFor(world).assertCanReadCurrentLocation({
        auth: authContext(),
        familyId: FAMILY_ID,
        targetUserId: REQUESTER_ID,
      }),
    ).resolves.toMatchObject({ targetUserId: REQUESTER_ID });
  });
});

describe('subscription entitlements', () => {
  it('denies history on the free tier', async () => {
    const world = createWorld({ plan: 'FREE' });
    await captureDenial(
      checkerFor(world).assertCanReadHistory({ ...readRequest(), range: VALID_RANGE }),
    );
    expect(world.audit.at(-1)?.reason).toBe('ENTITLEMENT_REQUIRED');
  });

  it('denies live sessions on the free tier', async () => {
    const world = createWorld({ plan: 'FREE' });
    await captureDenial(checkerFor(world).assertCanStartLiveSession(readRequest()));
    expect(world.audit.at(-1)?.reason).toBe('ENTITLEMENT_REQUIRED');
  });

  it('treats a missing subscription as free', async () => {
    const world = createWorld({ plan: null });
    await captureDenial(
      checkerFor(world).assertCanReadHistory({ ...readRequest(), range: VALID_RANGE }),
    );
    expect(world.audit.at(-1)?.reason).toBe('ENTITLEMENT_REQUIRED');
  });

  it('treats an expired subscription as free', async () => {
    const world = createWorld();
    world.setSubscriptionStatus('EXPIRED');
    await captureDenial(checkerFor(world).assertCanStartLiveSession(readRequest()));
    expect(world.audit.at(-1)?.reason).toBe('ENTITLEMENT_REQUIRED');
  });

  it('keeps paid features during a billing grace period', async () => {
    const world = createWorld();
    world.setSubscriptionStatus('IN_GRACE_PERIOD');
    await expect(checkerFor(world).assertCanStartLiveSession(readRequest())).resolves.toBeDefined();
  });

  it('still allows current-location reads on the free tier', async () => {
    const world = createWorld({ plan: 'FREE' });
    await expect(
      checkerFor(world).assertCanReadCurrentLocation(readRequest()),
    ).resolves.toMatchObject({ tier: 'FREE' });
  });
});

describe('history windows', () => {
  it('clamps a legal window back to the retention floor', async () => {
    const world = createWorld();
    // 31 days is the platform maximum, but a paid plan only retains 30, so the
    // first day of the request is outside what exists.
    const grant = await checkerFor(world).assertCanReadHistory({
      ...readRequest(),
      range: { from: '2026-07-02T00:00:00.000Z', to: '2026-08-02T00:00:00.000Z' },
    });

    expect(grant.effectiveRange.from).toBe('2026-07-03T12:00:00.000Z');
    expect(grant.effectiveRange.to).toBe('2026-08-02T00:00:00.000Z');
    expect(grant.retentionDays).toBe(30);
  });

  it('denies a window that exceeds the platform maximum even before retention', async () => {
    const world = createWorld();
    await captureDenial(
      checkerFor(world).assertCanReadHistory({
        ...readRequest(),
        range: { from: '2020-01-01T00:00:00.000Z', to: '2026-08-02T00:00:00.000Z' },
      }),
    );
    expect(world.audit.at(-1)?.reason).toBe('DATE_RANGE_INVALID');
  });

  it('denies a window longer than the platform maximum', async () => {
    const world = createWorld();
    await captureDenial(
      checkerFor(world).assertCanReadHistory({
        ...readRequest(),
        range: { from: '2026-06-01T00:00:00.000Z', to: '2026-08-02T00:00:00.000Z' },
      }),
    );
    expect(world.audit.at(-1)?.reason).toBe('DATE_RANGE_INVALID');
  });

  it('denies a window in the future', async () => {
    const world = createWorld();
    await captureDenial(
      checkerFor(world).assertCanReadHistory({
        ...readRequest(),
        range: { from: '2026-08-02T00:00:00.000Z', to: '2026-08-09T00:00:00.000Z' },
      }),
    );
    expect(world.audit.at(-1)?.reason).toBe('DATE_RANGE_INVALID');
  });

  it('denies an unparseable window', async () => {
    const world = createWorld();
    await captureDenial(
      checkerFor(world).assertCanReadHistory({
        ...readRequest(),
        range: { from: 'yesterday', to: 'today' },
      }),
    );
    expect(world.audit.at(-1)?.reason).toBe('DATE_RANGE_INVALID');
  });

  it('denies a window entirely older than retention', async () => {
    const world = createWorld();
    await captureDenial(
      checkerFor(world).assertCanReadHistory({
        ...readRequest(),
        range: { from: '2025-01-01T00:00:00.000Z', to: '2025-01-15T00:00:00.000Z' },
      }),
    );
    expect(world.audit.at(-1)?.reason).toBe('DATE_RANGE_INVALID');
  });
});

describe('family and member management', () => {
  it('denies a plain member attempting a family mutation', async () => {
    const world = createWorld();
    world.setMembershipRole(REQUESTER_ID, 'MEMBER');

    await captureDenial(
      checkerFor(world).assertCanMutateFamily({ auth: authContext(), familyId: FAMILY_ID }),
    );
    expect(world.audit.at(-1)?.reason).toBe('REQUESTER_ROLE_INSUFFICIENT');
  });

  it('denies an admin attempting an owner-only mutation', async () => {
    const world = createWorld();
    await captureDenial(
      checkerFor(world).assertCanMutateFamily({
        auth: authContext(),
        familyId: FAMILY_ID,
        minimumRole: 'OWNER',
      }),
    );
    expect(world.audit.at(-1)?.reason).toBe('REQUESTER_ROLE_INSUFFICIENT');
  });

  it('denies an admin managing a peer admin', async () => {
    const world = createWorld();
    world.setMembershipRole(TARGET_ID, 'ADMIN');

    await captureDenial(checkerFor(world).assertCanManageMember(readRequest()));
    expect(world.audit.at(-1)?.reason).toBe('TARGET_OUTRANKS_REQUESTER');
  });

  it('denies an admin managing the owner', async () => {
    const world = createWorld();
    world.setMembershipRole(TARGET_ID, 'OWNER');

    await captureDenial(checkerFor(world).assertCanManageMember(readRequest()));
    expect(world.audit.at(-1)?.reason).toBe('TARGET_OUTRANKS_REQUESTER');
  });

  it('lets an owner manage an admin', async () => {
    const world = createWorld();
    world.setMembershipRole(REQUESTER_ID, 'OWNER');
    world.setMembershipRole(TARGET_ID, 'ADMIN');

    await expect(checkerFor(world).assertCanManageMember(readRequest())).resolves.toBeDefined();
  });

  it('lets a plain member manage only themselves', async () => {
    const world = createWorld();
    world.setMembershipRole(REQUESTER_ID, 'MEMBER');
    const checker = checkerFor(world);

    await expect(
      checker.assertCanManageMember({
        auth: authContext(),
        familyId: FAMILY_ID,
        targetUserId: REQUESTER_ID,
      }),
    ).resolves.toBeDefined();
    await captureDenial(checker.assertCanManageMember(readRequest()));
  });

  it('lets an admin act on a member whose invitation is still pending', async () => {
    const world = createWorld();
    world.setMembershipStatus(TARGET_ID, 'PENDING');

    await expect(checkerFor(world).assertCanManageMember(readRequest())).resolves.toBeDefined();
  });

  it('refuses a live session targeted at yourself', async () => {
    const world = createWorld();
    await captureDenial(
      checkerFor(world).assertCanStartLiveSession({
        auth: authContext(),
        familyId: FAMILY_ID,
        targetUserId: REQUESTER_ID,
      }),
    );
    expect(world.audit.at(-1)?.reason).toBe('MALFORMED_REQUEST');
  });

  it('ignores a client-supplied membership record', async () => {
    const world = createWorld();
    world.removeMembership(REQUESTER_ID);
    const forged = membership({ userId: REQUESTER_ID, role: 'OWNER' });

    // The forged record exists only in the caller's imagination; the checker
    // reads its own repository.
    expect(forged.role).toBe('OWNER');
    await captureDenial(checkerFor(world).assertCanReadCurrentLocation(readRequest()));
    expect(world.audit.at(-1)?.reason).toBe('REQUESTER_NOT_A_MEMBER');
  });
});

describe('audit trail', () => {
  it('records the allowed decision with ids only', async () => {
    const world = createWorld();
    await checkerFor(world).assertCanReadCurrentLocation(readRequest());

    const entry = world.audit.at(-1);
    expect(entry).toMatchObject({
      operation: 'READ_CURRENT_LOCATION',
      decision: 'ALLOWED',
      reason: null,
      actorUserId: REQUESTER_ID,
      targetUserId: TARGET_ID,
      familyId: FAMILY_ID,
    });
    // Ids, enums and timestamps only — no coordinate can appear here.
    expect(JSON.stringify(entry)).not.toMatch(/\d+\.\d{4,}/);
  });

  it('fails the request when an allowed sensitive read cannot be recorded', async () => {
    const world = createWorld();
    world.failAuditWrites();

    await expect(checkerFor(world).assertCanReadCurrentLocation(readRequest())).rejects.toThrow();
  });

  it('still denies when the audit write fails on a denial', async () => {
    const world = createWorld();
    world.setSharingStatus(TARGET_ID, 'PAUSED');
    world.failAuditWrites();

    const error = await captureDenial(
      checkerFor(world).assertCanReadCurrentLocation(readRequest()),
    );
    expect(error.code).toBe('FORBIDDEN');
  });

  it('works without an audit sink at all', async () => {
    const world = createWorld({ withAuditSink: false });
    await expect(
      checkerFor(world).assertCanReadCurrentLocation(readRequest()),
    ).resolves.toBeDefined();
  });
});
