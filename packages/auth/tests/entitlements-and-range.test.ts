import { describe, expect, it } from 'vitest';

import {
  evaluateHistoryRange,
  historyEnabled,
  isVisibleTo,
  liveSessionsEnabled,
  resolveEntitlements,
} from '../src/index.js';

import { FAMILY_ID, OUTSIDER_ID, REQUESTER_ID, TARGET_ID, membership } from './fixtures.js';

const NOW = new Date('2026-08-02T12:00:00.000Z');

describe('resolveEntitlements', () => {
  it('falls back to FREE with no subscription row', () => {
    const snapshot = resolveEntitlements(null);
    expect(snapshot.tier).toBe('FREE');
    expect(historyEnabled(snapshot.entitlements)).toBe(false);
    expect(liveSessionsEnabled(snapshot.entitlements)).toBe(false);
  });

  it('maps each paid plan to its tier', () => {
    expect(
      resolveEntitlements({ familyId: FAMILY_ID, plan: 'FAMILY_ANNUAL', status: 'ACTIVE' }).tier,
    ).toBe('FAMILY');
    expect(
      resolveEntitlements({ familyId: FAMILY_ID, plan: 'FAMILY_PLUS_MONTHLY', status: 'ACTIVE' })
        .tier,
    ).toBe('FAMILY_PLUS');
  });

  it('keeps entitlements through billing retry and grace, drops them otherwise', () => {
    for (const status of ['ACTIVE', 'IN_GRACE_PERIOD', 'IN_BILLING_RETRY'] as const) {
      expect(
        resolveEntitlements({ familyId: FAMILY_ID, plan: 'FAMILY_MONTHLY', status }).tier,
      ).toBe('FAMILY');
    }
    for (const status of ['EXPIRED', 'CANCELLED', 'REVOKED', 'REFUNDED', 'PAUSED'] as const) {
      expect(
        resolveEntitlements({ familyId: FAMILY_ID, plan: 'FAMILY_MONTHLY', status }).tier,
      ).toBe('FREE');
    }
  });
});

describe('evaluateHistoryRange', () => {
  const paid = { retentionDays: 30, now: NOW };

  it('accepts a window inside both the platform limit and retention', () => {
    const result = evaluateHistoryRange(
      { from: '2026-07-28T00:00:00.000Z', to: '2026-08-01T00:00:00.000Z' },
      paid,
    );
    expect(result).toEqual({
      valid: true,
      effective: { from: '2026-07-28T00:00:00.000Z', to: '2026-08-01T00:00:00.000Z' },
    });
  });

  it('clamps the start to the retention floor rather than rejecting', () => {
    const result = evaluateHistoryRange(
      { from: '2026-07-02T00:00:00.000Z', to: '2026-08-02T00:00:00.000Z' },
      paid,
    );
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.effective.from).toBe('2026-07-03T12:00:00.000Z');
    }
  });

  const rejections = [
    {
      name: 'inverted',
      range: { from: '2026-08-01T00:00:00.000Z', to: '2026-07-01T00:00:00.000Z' },
      rejection: 'INVERTED',
    },
    {
      name: 'in the future',
      range: { from: '2026-08-02T00:00:00.000Z', to: '2026-08-05T00:00:00.000Z' },
      rejection: 'FUTURE',
    },
    {
      name: 'longer than the platform maximum',
      range: { from: '2026-05-01T00:00:00.000Z', to: '2026-08-01T00:00:00.000Z' },
      rejection: 'TOO_LONG',
    },
    {
      name: 'entirely older than retention',
      range: { from: '2025-01-01T00:00:00.000Z', to: '2025-01-10T00:00:00.000Z' },
      rejection: 'OUTSIDE_RETENTION',
    },
    {
      name: 'not an ISO instant',
      range: { from: '2026-07-28', to: '2026-08-01' },
      rejection: 'UNPARSEABLE',
    },
    {
      name: 'free text',
      range: { from: 'last tuesday', to: 'now' },
      rejection: 'UNPARSEABLE',
    },
  ] as const;

  for (const { name, range, rejection } of rejections) {
    it(`rejects a window that is ${name}`, () => {
      expect(evaluateHistoryRange(range, paid)).toEqual({ valid: false, rejection });
    });
  }

  it('rejects everything when the plan retains nothing', () => {
    expect(
      evaluateHistoryRange(
        { from: '2026-08-01T00:00:00.000Z', to: '2026-08-02T00:00:00.000Z' },
        { retentionDays: 0, now: NOW },
      ),
    ).toEqual({ valid: false, rejection: 'OUTSIDE_RETENTION' });
  });

  it('tolerates the accepted clock skew on the upper bound', () => {
    const justAhead = new Date(NOW.getTime() + 60_000).toISOString();
    expect(
      evaluateHistoryRange({ from: '2026-08-02T00:00:00.000Z', to: justAhead }, paid).valid,
    ).toBe(true);
  });
});

describe('isVisibleTo', () => {
  it('defaults to every active member when no list is set', () => {
    expect(isVisibleTo(membership({ userId: TARGET_ID }), REQUESTER_ID)).toBe(true);
  });

  it('honours an allow-list', () => {
    const record = membership({ userId: TARGET_ID, visibleToUserIds: [REQUESTER_ID] });
    expect(isVisibleTo(record, REQUESTER_ID)).toBe(true);
    expect(isVisibleTo(record, OUTSIDER_ID)).toBe(false);
  });

  it('lets the deny-list win', () => {
    const record = membership({
      userId: TARGET_ID,
      visibleToUserIds: null,
      hiddenFromUserIds: [REQUESTER_ID],
    });
    expect(isVisibleTo(record, REQUESTER_ID)).toBe(false);
    expect(isVisibleTo(record, OUTSIDER_ID)).toBe(true);
  });
});
