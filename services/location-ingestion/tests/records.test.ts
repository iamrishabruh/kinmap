import { describe, expect, it } from 'vitest';

import { LIMITS } from '@family/contracts';

import {
  historyExpiresAt,
  historyPartitionKey,
  historyPartitionKeyForDay,
  historySortKey,
  utcDay,
} from '../src/domain/records.js';

import { USER_ID } from './fixtures.js';

const SECONDS_PER_DAY = 86_400;

describe('history keys', () => {
  it('partitions by UTC day, not by the device timezone offset', () => {
    // 23:30 in +05:30 is 18:00 UTC on the previous day.
    expect(utcDay('2026-08-03T23:30:00+05:30')).toBe('2026-08-03');
    expect(utcDay('2026-08-03T02:30:00+05:30')).toBe('2026-08-02');
  });

  it('builds the partition key the table is designed around', () => {
    expect(historyPartitionKey(USER_ID, '2026-08-02T12:00:00.000Z')).toBe(
      `USER#${USER_ID}#DAY#2026-08-02`,
    );
    expect(historyPartitionKeyForDay(USER_ID, '2026-08-02')).toBe(
      historyPartitionKey(USER_ID, '2026-08-02T12:00:00.000Z'),
    );
  });

  it('produces sort keys that order lexicographically by capture time', () => {
    const earlier = historySortKey('2026-08-02T09:00:00.000Z', 'a');
    const later = historySortKey('2026-08-02T21:00:00.000Z', 'a');
    expect(earlier < later).toBe(true);
  });

  it('normalises any offset into the same UTC sort key', () => {
    expect(historySortKey('2026-08-02T12:00:00+00:00', 'x')).toBe(
      historySortKey('2026-08-02T12:00:00.000Z', 'x'),
    );
  });

  it('expires thirty days after capture, not after receipt', () => {
    const capturedAt = '2026-08-02T12:00:00.000Z';
    const expiresAt = historyExpiresAt(capturedAt, LIMITS.HISTORY_RETENTION_DAYS);

    expect(expiresAt).toBe(
      Math.floor(Date.parse(capturedAt) / 1000) + LIMITS.HISTORY_RETENTION_DAYS * SECONDS_PER_DAY,
    );
  });

  it('does not grant extra retention to a point uploaded late', () => {
    const old = historyExpiresAt('2026-07-01T00:00:00.000Z', 30);
    const fresh = historyExpiresAt('2026-08-01T00:00:00.000Z', 30);
    expect(old).toBeLessThan(fresh);
  });
});
