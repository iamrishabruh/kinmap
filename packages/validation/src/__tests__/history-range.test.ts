import { describe, expect, it } from 'vitest';

import { ACCEPTANCE, AppError, LIMITS } from '@family/contracts';

import {
  HISTORY_RANGE_REJECTION_REASONS,
  historyRangeRejectionMessage,
  safeValidateHistoryRange,
  validateHistoryRange,
} from '../index.js';

const NOW = new Date('2026-08-02T12:00:00.000Z');
const NOW_MS = NOW.getTime();
const MILLISECONDS_PER_DAY = 86_400_000;

function daysBefore(days: number): string {
  return new Date(NOW_MS - days * MILLISECONDS_PER_DAY).toISOString();
}

function secondsAfter(seconds: number): string {
  return new Date(NOW_MS + seconds * 1000).toISOString();
}

const options = { now: NOW };

describe('safeValidateHistoryRange', () => {
  it('accepts a normal window and reports its duration', () => {
    const result = safeValidateHistoryRange(daysBefore(7), daysBefore(0), options);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.range.durationDays).toBeCloseTo(7, 9);
    expect(result.range.fromMs).toBe(NOW_MS - 7 * MILLISECONDS_PER_DAY);
    expect(result.range.toMs).toBe(NOW_MS);
    expect(result.range.durationMs).toBe(7 * MILLISECONDS_PER_DAY);
  });

  it('accepts a window of exactly MAX_HISTORY_RANGE_DAYS', () => {
    const result = safeValidateHistoryRange(
      daysBefore(LIMITS.MAX_HISTORY_RANGE_DAYS),
      daysBefore(0),
      options,
    );

    expect(result.ok).toBe(true);
  });

  it('rejects a window one millisecond past the limit', () => {
    const to = daysBefore(0);
    const from = new Date(
      NOW_MS - LIMITS.MAX_HISTORY_RANGE_DAYS * MILLISECONDS_PER_DAY - 1,
    ).toISOString();

    const result = safeValidateHistoryRange(from, to, options);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('RANGE_TOO_LONG');
  });

  it('rejects a 32-day window', () => {
    const result = safeValidateHistoryRange(daysBefore(32), daysBefore(0), options);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('RANGE_TOO_LONG');
  });

  it('rejects an unparseable start', () => {
    const result = safeValidateHistoryRange('last tuesday', daysBefore(0), options);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('FROM_MALFORMED');
  });

  it('rejects an unparseable end', () => {
    const result = safeValidateHistoryRange(daysBefore(1), 'soon', options);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('TO_MALFORMED');
  });

  it('rejects an empty string as a start', () => {
    const result = safeValidateHistoryRange('', daysBefore(0), options);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('FROM_MALFORMED');
  });

  it('rejects an inverted window', () => {
    const result = safeValidateHistoryRange(daysBefore(1), daysBefore(2), options);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('RANGE_INVERTED');
  });

  it('rejects a zero-length window', () => {
    const result = safeValidateHistoryRange(daysBefore(1), daysBefore(1), options);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('RANGE_INVERTED');
  });

  it('rejects a window ending beyond the clock-skew allowance', () => {
    const result = safeValidateHistoryRange(
      daysBefore(1),
      secondsAfter(ACCEPTANCE.MAX_CLOCK_SKEW_FUTURE_SECONDS + 1),
      options,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('RANGE_IN_FUTURE');
  });

  it('tolerates a slightly fast client clock', () => {
    const result = safeValidateHistoryRange(
      daysBefore(1),
      secondsAfter(ACCEPTANCE.MAX_CLOCK_SKEW_FUTURE_SECONDS),
      options,
    );

    expect(result.ok).toBe(true);
  });

  it('checks length before futureness, so the more actionable reason wins', () => {
    const result = safeValidateHistoryRange(daysBefore(60), secondsAfter(3600), options);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('RANGE_TOO_LONG');
  });

  it('defaults to the real clock when none is injected', () => {
    const now = Date.now();
    const result = safeValidateHistoryRange(
      new Date(now - MILLISECONDS_PER_DAY).toISOString(),
      new Date(now).toISOString(),
    );

    expect(result.ok).toBe(true);
  });
});

describe('validateHistoryRange', () => {
  it('returns the range on success', () => {
    const range = validateHistoryRange(daysBefore(3), daysBefore(0), options);

    expect(range.durationDays).toBeCloseTo(3, 9);
  });

  it('throws AppError with HISTORY_RANGE_INVALID', () => {
    try {
      validateHistoryRange(daysBefore(32), daysBefore(0), options);
      expect.unreachable('validateHistoryRange should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      const appError = error as AppError;
      expect(appError.code).toBe('HISTORY_RANGE_INVALID');
      expect(appError.status).toBe(422);
      expect(appError.fields).toEqual([
        { path: 'to', message: historyRangeRejectionMessage('RANGE_TOO_LONG') },
      ]);
    }
  });

  it('points at the start when the start is the problem', () => {
    try {
      validateHistoryRange('nonsense', daysBefore(0), options);
      expect.unreachable('validateHistoryRange should have thrown');
    } catch (error) {
      expect((error as AppError).fields?.[0]?.path).toBe('from');
    }
  });

  it('points at the end when the end is the problem', () => {
    try {
      validateHistoryRange(daysBefore(1), 'nonsense', options);
      expect.unreachable('validateHistoryRange should have thrown');
    } catch (error) {
      expect((error as AppError).fields?.[0]?.path).toBe('to');
    }
  });
});

describe('history range rejection reasons stay loggable', () => {
  it('has a message for every reason', () => {
    for (const reason of HISTORY_RANGE_REJECTION_REASONS) {
      expect(historyRangeRejectionMessage(reason).length).toBeGreaterThan(0);
    }
  });

  it('never embeds a number in a reason or its message', () => {
    for (const reason of HISTORY_RANGE_REJECTION_REASONS) {
      expect(reason).not.toMatch(/\d/);
      expect(historyRangeRejectionMessage(reason)).not.toMatch(/\d/);
    }
  });

  it('never embeds a submitted timestamp in the thrown error', () => {
    const from = '2026-07-01T08:15:00.000Z';
    const to = '2026-08-02T09:45:00.000Z';

    try {
      validateHistoryRange(from, to, options);
      expect.unreachable('validateHistoryRange should have thrown');
    } catch (error) {
      const serialised = `${(error as AppError).message} ${JSON.stringify(
        (error as AppError).fields,
      )}`;

      expect(serialised).not.toContain(from);
      expect(serialised).not.toContain(to);
      expect(serialised).not.toMatch(/\d/);
    }
  });
});
