import { describe, expect, it } from 'vitest';

import { resolveCoordinateScope, resolveDisposition } from '../src/domain/sharing.js';

import { FAMILY_A, FAMILY_B, sharingMembership, USER_ID } from './fixtures.js';

describe('resolveDisposition', () => {
  it('stores when the account is active and at least one membership is sharing', () => {
    const result = resolveDisposition({
      accountStatus: 'ACTIVE',
      memberships: [sharingMembership()],
    });

    expect(result.disposition).toBe('STORE');
    expect(result.reason).toBeNull();
    expect(result.sharingMemberships).toHaveLength(1);
  });

  it('suppresses while the account is pending deletion', () => {
    const result = resolveDisposition({
      accountStatus: 'PENDING_DELETION',
      memberships: [sharingMembership()],
    });

    expect(result.disposition).toBe('SUPPRESS');
    expect(result.reason).toBe('ACCOUNT_NOT_ACTIVE');
    expect(result.sharingMemberships).toEqual([]);
  });

  it('suppresses every non-sharing status identically', () => {
    for (const sharingStatus of [
      'PAUSED',
      'DISABLED',
      'PERMISSION_BLOCKED',
      'NEVER_ENABLED',
    ] as const) {
      const result = resolveDisposition({
        accountStatus: 'ACTIVE',
        memberships: [sharingMembership(FAMILY_A, { sharingStatus })],
      });
      expect(result.disposition).toBe('SUPPRESS');
      expect(result.reason).toBe('SHARING_NOT_ENABLED');
    }
  });

  it('suppresses a user with no active membership', () => {
    const result = resolveDisposition({
      accountStatus: 'ACTIVE',
      memberships: [sharingMembership(FAMILY_A, { status: 'REMOVED' })],
    });

    expect(result.disposition).toBe('SUPPRESS');
    expect(result.reason).toBe('NO_ACTIVE_MEMBERSHIP');
  });
});

describe('resolveCoordinateScope', () => {
  it('is deterministic and independent of membership ordering', () => {
    const forwards = resolveCoordinateScope(USER_ID, [
      sharingMembership(FAMILY_A),
      sharingMembership(FAMILY_B),
    ]);
    const backwards = resolveCoordinateScope(USER_ID, [
      sharingMembership(FAMILY_B),
      sharingMembership(FAMILY_A),
    ]);

    expect(forwards).toBe(backwards);
    expect(forwards).toBe(FAMILY_A);
  });

  it('falls back to the user themself when they belong to no family', () => {
    expect(resolveCoordinateScope(USER_ID, [])).toBe(USER_ID);
  });
});
