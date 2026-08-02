import { describe, expect, it } from 'vitest';

import { AppError, LIMITS } from '@family/contracts';

import {
  dayPartitions,
  decodeCursor,
  encodeCursor,
  isLogicallyExpired,
  resolvePageSize,
  sortKeyBounds,
} from '../src/domain/history-window.js';

const NOW = new Date('2026-08-02T12:00:00.000Z');

describe('dayPartitions', () => {
  it('covers every UTC day the window touches, oldest first', () => {
    expect(dayPartitions('2026-07-31T22:00:00.000Z', '2026-08-02T01:00:00.000Z')).toEqual([
      '2026-07-31',
      '2026-08-01',
      '2026-08-02',
    ]);
  });

  it('returns a single partition for a window inside one day', () => {
    expect(dayPartitions('2026-08-02T01:00:00.000Z', '2026-08-02T23:00:00.000Z')).toEqual([
      '2026-08-02',
    ]);
  });

  it('refuses an inverted window', () => {
    expect(() =>
      dayPartitions('2026-08-02T12:00:00.000Z', '2026-08-01T12:00:00.000Z'),
    ).toThrowError(AppError);
  });

  it('refuses a window wider than the platform ceiling', () => {
    const from = new Date(NOW.getTime() - (LIMITS.MAX_HISTORY_RANGE_DAYS + 2) * 86_400_000);
    expect(() => dayPartitions(from.toISOString(), NOW.toISOString())).toThrowError(AppError);
  });
});

describe('sortKeyBounds', () => {
  it('brackets every event captured at the boundary instants', () => {
    const bounds = sortKeyBounds('2026-08-02T00:00:00.000Z', '2026-08-02T23:59:59.000Z');
    const atStart = 'TIME#2026-08-02T00:00:00.000Z#EVENT#00000000-0000-4000-8000-000000000000';
    const atEnd = 'TIME#2026-08-02T23:59:59.000Z#EVENT#ffffffff-ffff-4fff-bfff-ffffffffffff';

    expect(atStart >= bounds.low).toBe(true);
    expect(atEnd <= bounds.high).toBe(true);
  });
});

describe('cursor', () => {
  it('round-trips', () => {
    const cursor = { day: '2026-08-02', sk: 'TIME#2026-08-02T09:00:00.000Z#EVENT#abc' };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it('rejects a cursor that is not one we issued', () => {
    for (const candidate of [
      'not-base64!!',
      Buffer.from('{}', 'utf8').toString('base64url'),
      Buffer.from(JSON.stringify({ day: 'yesterday', sk: 'TIME#x' }), 'utf8').toString('base64url'),
      Buffer.from(JSON.stringify({ day: '2026-08-02', sk: 'USER#other' }), 'utf8').toString(
        'base64url',
      ),
    ]) {
      expect(() => decodeCursor(candidate)).toThrowError(AppError);
    }
  });

  it('never quotes the offending value in the error', () => {
    const error = (() => {
      try {
        decodeCursor('bogus-cursor-value');
        return null;
      } catch (thrown) {
        return thrown as AppError;
      }
    })();

    expect(error?.message).not.toContain('bogus-cursor-value');
  });
});

describe('resolvePageSize', () => {
  it('clamps to the platform maximum', () => {
    expect(resolvePageSize(LIMITS.MAX_HISTORY_PAGE_SIZE + 500)).toBe(LIMITS.MAX_HISTORY_PAGE_SIZE);
  });

  it('falls back to the default for a nonsense value', () => {
    expect(resolvePageSize(0)).toBe(LIMITS.DEFAULT_HISTORY_PAGE_SIZE);
    expect(resolvePageSize(Number.NaN)).toBe(LIMITS.DEFAULT_HISTORY_PAGE_SIZE);
  });
});

describe('isLogicallyExpired', () => {
  const withinRetention = { capturedAt: '2026-07-20T12:00:00.000Z' };
  const beyondRetention = { capturedAt: '2026-06-01T12:00:00.000Z' };

  it('keeps a row inside the plan retention', () => {
    expect(isLogicallyExpired(withinRetention, 30, NOW)).toBe(false);
  });

  it('filters a row older than retention even when TTL has not swept it', () => {
    // The row has no `expiresAt` at all: DynamoDB would never delete it.
    expect(isLogicallyExpired(beyondRetention, 30, NOW)).toBe(true);
  });

  it('filters a row whose TTL has already passed but which is still present', () => {
    expect(
      isLogicallyExpired(
        { capturedAt: '2026-08-01T12:00:00.000Z', expiresAt: Math.floor(NOW.getTime() / 1000) - 1 },
        30,
        NOW,
      ),
    ).toBe(true);
  });

  it('filters everything when the plan retains nothing', () => {
    expect(isLogicallyExpired(withinRetention, 0, NOW)).toBe(true);
  });

  it('filters a row whose capture time cannot be trusted', () => {
    expect(isLogicallyExpired({ capturedAt: 'not-a-date' }, 30, NOW)).toBe(true);
  });
});
