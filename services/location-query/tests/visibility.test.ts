import { describe, expect, it } from 'vitest';

import { classifyFreshness, classifyMember, isRenderableMember } from '../src/domain/visibility.js';

import { HIDDEN_FROM_REQUESTER, member, PAUSED, REQUESTER, SHARER } from './fixtures.js';

const NOW_MS = new Date('2026-08-02T12:00:00.000Z').getTime();

describe('classifyMember', () => {
  it('shows a sharing member', () => {
    expect(classifyMember(member({ userId: SHARER }), REQUESTER)).toEqual({ kind: 'VISIBLE' });
  });

  it('always shows the caller their own card', () => {
    expect(
      classifyMember(member({ userId: REQUESTER, sharingStatus: 'PAUSED' }), REQUESTER),
    ).toEqual({ kind: 'VISIBLE' });
  });

  it('reports a paused member as PAUSED, with no way to carry a position', () => {
    expect(classifyMember(member({ userId: PAUSED, sharingStatus: 'PAUSED' }), REQUESTER)).toEqual({
      kind: 'HIDDEN',
      sharingStatus: 'PAUSED',
    });
  });

  it('passes through every other non-sharing status verbatim', () => {
    for (const sharingStatus of ['DISABLED', 'PERMISSION_BLOCKED', 'NEVER_ENABLED'] as const) {
      expect(classifyMember(member({ userId: PAUSED, sharingStatus }), REQUESTER)).toEqual({
        kind: 'HIDDEN',
        sharingStatus,
      });
    }
  });

  it('does not tell a requester they have been singled out', () => {
    const hidden = member({
      userId: HIDDEN_FROM_REQUESTER,
      sharingStatus: 'SHARING',
      hiddenFromUserIds: [REQUESTER],
    });

    // Indistinguishable from a member who simply turned sharing off.
    expect(classifyMember(hidden, REQUESTER)).toEqual({
      kind: 'HIDDEN',
      sharingStatus: 'DISABLED',
    });
  });

  it('honours an allow-list that excludes the requester', () => {
    const restricted = member({
      userId: HIDDEN_FROM_REQUESTER,
      visibleToUserIds: [SHARER],
    });

    expect(classifyMember(restricted, REQUESTER)).toEqual({
      kind: 'HIDDEN',
      sharingStatus: 'DISABLED',
    });
    expect(classifyMember(restricted, SHARER)).toEqual({ kind: 'VISIBLE' });
  });

  it('lets a deny-list beat an allow-list', () => {
    const conflicted = member({
      userId: HIDDEN_FROM_REQUESTER,
      visibleToUserIds: [REQUESTER],
      hiddenFromUserIds: [REQUESTER],
    });

    expect(classifyMember(conflicted, REQUESTER)).toEqual({
      kind: 'HIDDEN',
      sharingStatus: 'DISABLED',
    });
  });
});

describe('isRenderableMember', () => {
  it('drops every membership state other than ACTIVE', () => {
    expect(isRenderableMember(member({ userId: SHARER }))).toBe(true);
    for (const status of ['PENDING', 'REMOVED', 'LEFT', 'BLOCKED'] as const) {
      expect(isRenderableMember(member({ userId: SHARER, status }))).toBe(false);
    }
  });
});

describe('classifyFreshness', () => {
  it('buckets by age rather than exposing it', () => {
    expect(classifyFreshness('2026-08-02T11:59:30.000Z', NOW_MS)).toBe('LIVE');
    expect(classifyFreshness('2026-08-02T11:55:00.000Z', NOW_MS)).toBe('FRESH');
    expect(classifyFreshness('2026-08-02T11:30:00.000Z', NOW_MS)).toBe('RECENT');
    expect(classifyFreshness('2026-08-01T11:30:00.000Z', NOW_MS)).toBe('STALE');
  });

  it('tolerates small clock skew but refuses to guess at large skew', () => {
    expect(classifyFreshness('2026-08-02T12:00:30.000Z', NOW_MS)).toBe('LIVE');
    expect(classifyFreshness('2026-08-02T18:00:00.000Z', NOW_MS)).toBe('UNKNOWN');
  });

  it('returns UNKNOWN for an unusable timestamp', () => {
    expect(classifyFreshness('not-a-date', NOW_MS)).toBe('UNKNOWN');
  });
});
