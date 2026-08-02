import { describe, expect, it } from 'vitest';

import type { QuietHours } from '@family/schemas';

import { isMinuteWithinWindow, isWithinQuietHours, minuteOfDayInZone } from '../src/quiet-hours.js';

const overnight: QuietHours = { enabled: true, startMinuteOfDay: 22 * 60, endMinuteOfDay: 7 * 60 };
const daytime: QuietHours = { enabled: true, startMinuteOfDay: 9 * 60, endMinuteOfDay: 17 * 60 };

describe('minuteOfDayInZone', () => {
  it('reads the wall clock in the requested zone, not the server zone', () => {
    // 2026-06-01T23:30Z is 16:30 in Los Angeles (PDT, UTC-7).
    const instant = new Date('2026-06-01T23:30:00.000Z');
    expect(minuteOfDayInZone(instant, 'UTC')).toBe(23 * 60 + 30);
    expect(minuteOfDayInZone(instant, 'America/Los_Angeles')).toBe(16 * 60 + 30);
    expect(minuteOfDayInZone(instant, 'Asia/Kolkata')).toBe(5 * 60);
  });

  it('falls back to UTC for a missing or unusable zone', () => {
    const instant = new Date('2026-06-01T23:30:00.000Z');
    expect(minuteOfDayInZone(instant, null)).toBe(23 * 60 + 30);
    expect(minuteOfDayInZone(instant, 'Not/AZone')).toBe(23 * 60 + 30);
  });

  it('reports midnight as minute zero', () => {
    expect(minuteOfDayInZone(new Date('2026-06-01T00:00:00.000Z'), 'UTC')).toBe(0);
  });
});

describe('isMinuteWithinWindow', () => {
  it('handles a same-day window with an inclusive start and exclusive end', () => {
    expect(isMinuteWithinWindow(9 * 60, 9 * 60, 17 * 60)).toBe(true);
    expect(isMinuteWithinWindow(17 * 60 - 1, 9 * 60, 17 * 60)).toBe(true);
    expect(isMinuteWithinWindow(17 * 60, 9 * 60, 17 * 60)).toBe(false);
    expect(isMinuteWithinWindow(8 * 60, 9 * 60, 17 * 60)).toBe(false);
  });

  it('handles a window that wraps past midnight', () => {
    expect(isMinuteWithinWindow(23 * 60, 22 * 60, 7 * 60)).toBe(true);
    expect(isMinuteWithinWindow(3 * 60, 22 * 60, 7 * 60)).toBe(true);
    expect(isMinuteWithinWindow(7 * 60, 22 * 60, 7 * 60)).toBe(false);
    expect(isMinuteWithinWindow(12 * 60, 22 * 60, 7 * 60)).toBe(false);
  });

  it('treats an empty window as "no quiet hours" rather than "always quiet"', () => {
    expect(isMinuteWithinWindow(0, 600, 600)).toBe(false);
    expect(isMinuteWithinWindow(600, 600, 600)).toBe(false);
  });
});

describe('isWithinQuietHours', () => {
  it('is off entirely when the user disabled it', () => {
    const instant = new Date('2026-06-02T02:00:00.000Z');
    expect(isWithinQuietHours({ ...overnight, enabled: false }, instant, 'UTC')).toBe(false);
  });

  it('silences the recipient in their own zone, not the subject´s', () => {
    // 06:00 UTC is 23:00 the previous day in Los Angeles: quiet there, awake in London.
    const instant = new Date('2026-06-02T06:00:00.000Z');
    expect(isWithinQuietHours(overnight, instant, 'America/Los_Angeles')).toBe(true);
    expect(isWithinQuietHours(overnight, instant, 'Europe/London')).toBe(false);
  });

  it('applies a daytime window as written', () => {
    expect(isWithinQuietHours(daytime, new Date('2026-06-02T10:00:00.000Z'), 'UTC')).toBe(true);
    expect(isWithinQuietHours(daytime, new Date('2026-06-02T18:00:00.000Z'), 'UTC')).toBe(false);
  });
});
