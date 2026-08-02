import { describe, expect, it } from 'vitest';

import { AppError, LIMITS } from '@family/contracts';
import { InvitationSchema } from '@family/schemas';

import {
  assertInvitationQuota,
  evaluateInvitation,
  expiryWindow,
  invitationError,
  isActiveInvitation,
  toInvitation,
  type InvitationRecord,
} from '../src/domain/invitation-rules.js';
import { hashInvitationToken } from '../src/domain/token.js';

import { FAMILY_ID, NOW, OWNER } from './fixtures.js';

const TOKEN = 'a-token-that-is-long-enough-to-be-valid';
const TOKEN_HASH = hashInvitationToken(TOKEN);

function record(overrides: Partial<InvitationRecord> = {}): InvitationRecord {
  const expiresAtMs = NOW.getTime() + 3_600_000;
  return {
    tokenHash: TOKEN_HASH,
    invitationId: '99999999-9999-4999-8999-999999999999',
    familyId: FAMILY_ID,
    role: 'MEMBER',
    status: 'PENDING',
    label: null,
    createdByUserId: OWNER,
    createdAt: '2026-08-02T11:00:00.000Z',
    expiresAt: Math.floor(expiresAtMs / 1000),
    expiresAtIso: new Date(expiresAtMs).toISOString(),
    redemptionCount: 0,
    maxRedemptions: 1,
    acceptedByUserId: null,
    acceptedAt: null,
    revokedAt: null,
    ...overrides,
  };
}

describe('evaluateInvitation', () => {
  it('accepts a live, unused invitation', () => {
    const evaluation = evaluateInvitation({
      record: record(),
      presentedTokenHash: TOKEN_HASH,
      now: NOW,
    });

    expect(evaluation.usable).toBe(true);
  });

  it('rejects a token with no matching row', () => {
    expect(evaluateInvitation({ record: null, presentedTokenHash: TOKEN_HASH, now: NOW })).toEqual({
      usable: false,
      code: 'INVITATION_INVALID',
    });
  });

  it('rejects a hash that does not match the stored one', () => {
    expect(
      evaluateInvitation({
        record: record(),
        presentedTokenHash: hashInvitationToken('another-token'),
        now: NOW,
      }),
    ).toEqual({ usable: false, code: 'INVITATION_INVALID' });
  });

  it('rejects an expired invitation', () => {
    const expired = record({
      expiresAt: Math.floor(NOW.getTime() / 1000) - 1,
      expiresAtIso: new Date(NOW.getTime() - 1000).toISOString(),
    });

    expect(
      evaluateInvitation({ record: expired, presentedTokenHash: TOKEN_HASH, now: NOW }),
    ).toEqual({ usable: false, code: 'INVITATION_EXPIRED' });
  });

  it('rejects an expired invitation DynamoDB has not swept yet', () => {
    // Still PENDING and still present, but a day past its TTL.
    const stale = record({
      expiresAt: Math.floor(NOW.getTime() / 1000) - 86_400,
      status: 'PENDING',
    });

    expect(
      evaluateInvitation({ record: stale, presentedTokenHash: TOKEN_HASH, now: NOW }).usable,
    ).toBe(false);
  });

  it('rejects a revoked invitation, and does so before considering expiry', () => {
    const revoked = record({
      revokedAt: '2026-08-02T11:30:00.000Z',
      status: 'REVOKED',
      expiresAt: Math.floor(NOW.getTime() / 1000) - 10,
    });

    expect(
      evaluateInvitation({ record: revoked, presentedTokenHash: TOKEN_HASH, now: NOW }),
    ).toEqual({ usable: false, code: 'INVITATION_REVOKED' });
  });

  it('rejects an invitation that has already been redeemed', () => {
    const used = record({ status: 'ACCEPTED', redemptionCount: 1 });

    expect(evaluateInvitation({ record: used, presentedTokenHash: TOKEN_HASH, now: NOW })).toEqual({
      usable: false,
      code: 'INVITATION_ALREADY_USED',
    });
  });

  it('rejects an invitation whose redemption count reached the cap', () => {
    const used = record({ redemptionCount: 1, maxRedemptions: 1 });

    expect(evaluateInvitation({ record: used, presentedTokenHash: TOKEN_HASH, now: NOW })).toEqual({
      usable: false,
      code: 'INVITATION_ALREADY_USED',
    });
  });
});

describe('invitationError', () => {
  it('maps every rejection to a caller-safe message with no token in it', () => {
    for (const code of [
      'INVITATION_INVALID',
      'INVITATION_EXPIRED',
      'INVITATION_REVOKED',
      'INVITATION_ALREADY_USED',
    ] as const) {
      const error = invitationError(code);
      expect(error).toBeInstanceOf(AppError);
      expect(error.code).toBe(code);
      expect(error.message).not.toContain(TOKEN);
      expect(error.message).not.toContain(TOKEN_HASH);
    }
  });
});

describe('expiryWindow', () => {
  it('honours a shorter request', () => {
    const window = expiryWindow(NOW, 2);
    expect(window.expiresAt).toBe(Math.floor(NOW.getTime() / 1000) + 7_200);
  });

  it('clamps to the platform ceiling', () => {
    const window = expiryWindow(NOW, LIMITS.INVITATION_TTL_HOURS + 1_000);
    expect(window.expiresAt).toBe(
      Math.floor(NOW.getTime() / 1000) + LIMITS.INVITATION_TTL_HOURS * 3_600,
    );
  });

  it('never produces an already-expired window', () => {
    expect(expiryWindow(NOW, 0).expiresAt).toBeGreaterThan(Math.floor(NOW.getTime() / 1000));
  });
});

describe('assertInvitationQuota', () => {
  it('allows a family below the cap', () => {
    expect(() => assertInvitationQuota(LIMITS.MAX_ACTIVE_INVITATIONS_PER_FAMILY - 1)).not.toThrow();
  });

  it('rate-limits a family at the cap', () => {
    try {
      assertInvitationQuota(LIMITS.MAX_ACTIVE_INVITATIONS_PER_FAMILY);
      throw new Error('Expected the quota to be enforced.');
    } catch (thrown) {
      expect((thrown as AppError).code).toBe('RATE_LIMITED');
    }
  });
});

describe('toInvitation', () => {
  it('produces a resource with no token field at all', () => {
    const projected = toInvitation(record(), NOW);

    expect(InvitationSchema.parse(projected)).toEqual(projected);
    expect(Object.keys(projected)).not.toContain('tokenHash');
    expect(Object.keys(projected)).not.toContain('token');
    expect(JSON.stringify(projected)).not.toContain(TOKEN_HASH);
  });

  it('reports an aged-out PENDING row as EXPIRED', () => {
    const stale = record({ expiresAt: Math.floor(NOW.getTime() / 1000) - 5 });
    expect(toInvitation(stale, NOW).status).toBe('EXPIRED');
    expect(isActiveInvitation(stale, NOW)).toBe(false);
  });
});
