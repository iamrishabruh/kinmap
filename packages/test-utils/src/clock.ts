/**
 * Deterministic clock. Location logic is full of freshness, staleness, backoff
 * and expiry thresholds; testing those against the real wall clock produces
 * tests that pass on a fast machine and fail on a slow one.
 */
export type Clock = {
  now(): Date;
  nowIso(): string;
  nowMs(): number;
  advance(ms: number): void;
  set(date: Date | string): void;
};

export function createClock(start: Date | string = '2026-01-01T00:00:00.000Z'): Clock {
  let current = typeof start === 'string' ? new Date(start).getTime() : start.getTime();
  return {
    now: () => new Date(current),
    nowIso: () => new Date(current).toISOString(),
    nowMs: () => current,
    advance: (ms) => {
      current += ms;
    },
    set: (date) => {
      current = typeof date === 'string' ? new Date(date).getTime() : date.getTime();
    },
  };
}

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
