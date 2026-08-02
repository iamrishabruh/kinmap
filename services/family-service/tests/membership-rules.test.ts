import { describe, expect, it } from 'vitest';

import { AppError, ENTITLEMENTS, LIMITS } from '@family/contracts';

import {
  assertCanChangeRole,
  assertCanCreateFamily,
  assertCanInvite,
  assertExactlyOneOwner,
  assertSeatAvailable,
  canManageMembers,
  memberCapacity,
  planOwnershipTransfer,
  planRemoval,
  seatsInUse,
  type MemberSummary,
} from '../src/domain/membership-rules.js';

import { ADMIN, MEMBER, OWNER, SECOND_ADMIN } from './fixtures.js';

const REQUEST_ID = 'req-1';

const owner: MemberSummary = { userId: OWNER, role: 'OWNER', status: 'ACTIVE' };
const admin: MemberSummary = { userId: ADMIN, role: 'ADMIN', status: 'ACTIVE' };
const otherAdmin: MemberSummary = { userId: SECOND_ADMIN, role: 'ADMIN', status: 'ACTIVE' };
const plainMember: MemberSummary = { userId: MEMBER, role: 'MEMBER', status: 'ACTIVE' };

function appErrorOf(run: () => unknown): AppError {
  try {
    run();
  } catch (thrown) {
    return thrown as AppError;
  }
  throw new Error('Expected the rule to reject.');
}

describe('exactly one owner', () => {
  it('accepts a family with a single active owner', () => {
    expect(() => assertExactlyOneOwner([owner, admin, plainMember])).not.toThrow();
  });

  it('rejects a family with none', () => {
    expect(() => assertExactlyOneOwner([admin, plainMember])).toThrowError(AppError);
  });

  it('rejects a family with two', () => {
    expect(() =>
      assertExactlyOneOwner([owner, { userId: MEMBER, role: 'OWNER', status: 'ACTIVE' }]),
    ).toThrowError(AppError);
  });

  it('does not count a removed owner row towards the invariant', () => {
    expect(() =>
      assertExactlyOneOwner([owner, { userId: MEMBER, role: 'OWNER', status: 'REMOVED' }]),
    ).not.toThrow();
  });
});

describe('who may manage members', () => {
  it('is only the owner and admins', () => {
    expect(canManageMembers('OWNER')).toBe(true);
    expect(canManageMembers('ADMIN')).toBe(true);
    expect(canManageMembers('ADULT')).toBe(false);
    expect(canManageMembers('MEMBER')).toBe(false);
  });

  it('refuses an invitation from an ordinary member, opaquely', () => {
    const error = appErrorOf(() =>
      assertCanInvite({
        actor: plainMember,
        members: [owner, plainMember],
        entitlements: ENTITLEMENTS.FAMILY,
        requestId: REQUEST_ID,
      }),
    );

    expect(error.code).toBe('FORBIDDEN');
    expect(error.message).toBe('You do not have access to this resource.');
  });

  it('allows an admin to invite while seats remain', () => {
    expect(() =>
      assertCanInvite({
        actor: admin,
        members: [owner, admin],
        entitlements: ENTITLEMENTS.FAMILY,
        requestId: REQUEST_ID,
      }),
    ).not.toThrow();
  });
});

describe('capacity', () => {
  it('counts an outstanding invitation as an occupied seat', () => {
    expect(seatsInUse([owner, { userId: MEMBER, role: 'MEMBER', status: 'PENDING' }])).toBe(2);
  });

  it('does not count a departed member', () => {
    expect(seatsInUse([owner, { userId: MEMBER, role: 'MEMBER', status: 'LEFT' }])).toBe(1);
  });

  it('never exceeds the platform ceiling, whatever the plan claims', () => {
    expect(memberCapacity({ ...ENTITLEMENTS.FAMILY_PLUS, maxMembersPerFamily: 1_000 })).toBe(
      LIMITS.MAX_FAMILY_MEMBERS,
    );
  });

  it('reports a full family with a code the client can act on', () => {
    const full: MemberSummary[] = Array.from({ length: 2 }, (_unused, index) => ({
      userId: `${index}`,
      role: 'MEMBER',
      status: 'ACTIVE',
    }));

    const error = appErrorOf(() => assertSeatAvailable(full, ENTITLEMENTS.FREE));
    expect(error.code).toBe('PLAN_LIMIT_EXCEEDED');
  });
});

describe('removal', () => {
  it('lets an admin remove an ordinary member', () => {
    expect(planRemoval({ actor: admin, target: plainMember, requestId: REQUEST_ID })).toEqual({
      resultingStatus: 'REMOVED',
      selfInitiated: false,
    });
  });

  it('lets any member leave without holding a role', () => {
    expect(planRemoval({ actor: plainMember, target: plainMember, requestId: REQUEST_ID })).toEqual(
      {
        resultingStatus: 'LEFT',
        selfInitiated: true,
      },
    );
  });

  it('refuses to remove the owner, whoever asks', () => {
    for (const actor of [admin, owner, plainMember]) {
      const error = appErrorOf(() => planRemoval({ actor, target: owner, requestId: REQUEST_ID }));
      expect(error.code).toBe('CONFLICT');
      expect(error.message).toContain('Transfer ownership');
    }
  });

  it('refuses to let the owner leave without transferring first', () => {
    const error = appErrorOf(() =>
      planRemoval({ actor: owner, target: owner, requestId: REQUEST_ID }),
    );
    expect(error.code).toBe('CONFLICT');
  });

  it('refuses an admin removing a peer admin', () => {
    const error = appErrorOf(() =>
      planRemoval({ actor: admin, target: otherAdmin, requestId: REQUEST_ID }),
    );
    expect(error.code).toBe('FORBIDDEN');
  });

  it('refuses an ordinary member removing anyone else', () => {
    const error = appErrorOf(() =>
      planRemoval({
        actor: plainMember,
        target: { userId: SECOND_ADMIN, role: 'MEMBER', status: 'ACTIVE' },
        requestId: REQUEST_ID,
      }),
    );
    expect(error.code).toBe('FORBIDDEN');
  });
});

describe('role changes', () => {
  it('lets the owner promote a member to admin', () => {
    expect(() =>
      assertCanChangeRole({
        actor: owner,
        target: plainMember,
        nextRole: 'ADMIN',
        requestId: REQUEST_ID,
      }),
    ).not.toThrow();
  });

  it('refuses an admin minting a peer admin', () => {
    const error = appErrorOf(() =>
      assertCanChangeRole({
        actor: admin,
        target: plainMember,
        nextRole: 'ADMIN',
        requestId: REQUEST_ID,
      }),
    );
    expect(error.code).toBe('FORBIDDEN');
  });

  it('lets an admin set a role strictly below their own', () => {
    expect(() =>
      assertCanChangeRole({
        actor: admin,
        target: plainMember,
        nextRole: 'ADULT',
        requestId: REQUEST_ID,
      }),
    ).not.toThrow();
  });

  it('refuses anyone promoting themself', () => {
    const error = appErrorOf(() =>
      assertCanChangeRole({
        actor: admin,
        target: admin,
        nextRole: 'ADULT',
        requestId: REQUEST_ID,
      }),
    );
    expect(error.code).toBe('FORBIDDEN');
  });

  it('refuses demoting the owner', () => {
    const error = appErrorOf(() =>
      assertCanChangeRole({
        actor: owner,
        target: { userId: MEMBER, role: 'OWNER', status: 'ACTIVE' },
        nextRole: 'ADMIN',
        requestId: REQUEST_ID,
      }),
    );
    expect(error.code).toBe('CONFLICT');
  });
});

describe('ownership transfer', () => {
  it('demotes the outgoing owner to admin', () => {
    expect(planOwnershipTransfer({ actor: owner, target: admin, requestId: REQUEST_ID })).toEqual({
      previousOwnerUserId: OWNER,
      newOwnerUserId: ADMIN,
      previousOwnerRole: 'ADMIN',
    });
  });

  it('refuses a transfer initiated by anyone but the owner', () => {
    const error = appErrorOf(() =>
      planOwnershipTransfer({ actor: admin, target: plainMember, requestId: REQUEST_ID }),
    );
    expect(error.code).toBe('FORBIDDEN');
  });

  it('refuses a transfer to someone whose invitation is still outstanding', () => {
    const error = appErrorOf(() =>
      planOwnershipTransfer({
        actor: owner,
        target: { userId: MEMBER, role: 'MEMBER', status: 'PENDING' },
        requestId: REQUEST_ID,
      }),
    );
    expect(error.code).toBe('FORBIDDEN');
  });

  it('refuses a transfer to yourself', () => {
    const error = appErrorOf(() =>
      planOwnershipTransfer({ actor: owner, target: owner, requestId: REQUEST_ID }),
    );
    expect(error.code).toBe('CONFLICT');
  });
});

describe('family creation limits', () => {
  it('allows the first family on a free plan', () => {
    expect(() =>
      assertCanCreateFamily({ existingFamilyCount: 0, entitlements: ENTITLEMENTS.FREE }),
    ).not.toThrow();
  });

  it('refuses a second family on a plan that allows one', () => {
    const error = appErrorOf(() =>
      assertCanCreateFamily({ existingFamilyCount: 1, entitlements: ENTITLEMENTS.FREE }),
    );
    expect(error.code).toBe('PLAN_LIMIT_EXCEEDED');
  });
});
