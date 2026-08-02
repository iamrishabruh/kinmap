import type { QuietHours } from '@family/schemas';

/**
 * Quiet hours are evaluated in the RECIPIENT's time zone, not the server's and
 * not the subject's. A parent in Lisbon must not be woken at 03:00 because the
 * arrival happened at 22:00 in Chicago.
 *
 * Time-zone conversion uses `Intl`, which the Node 22 Lambda runtime ships with
 * full ICU data for. An unknown or malformed zone identifier degrades to UTC
 * rather than throwing: a broken profile field must not stop delivery of a
 * safety-relevant notification.
 */

export const MINUTES_PER_DAY = 1440;

/** Minute-of-day (0..1439) for `instant` as seen in `timeZone`. */
export function minuteOfDayInZone(instant: Date, timeZone: string | null): number {
  const zone = timeZone ?? 'UTC';
  const parts = formatParts(instant, zone) ?? formatParts(instant, 'UTC');
  if (parts === null) {
    // Neither the requested zone nor UTC could be formatted; fall back to the
    // raw UTC arithmetic rather than reporting a nonsense hour.
    return (instant.getUTCHours() * 60 + instant.getUTCMinutes()) % MINUTES_PER_DAY;
  }
  return (parts.hour * 60 + parts.minute) % MINUTES_PER_DAY;
}

function formatParts(instant: Date, timeZone: string): { hour: number; minute: number } | null {
  try {
    const formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
    });
    let hour: number | null = null;
    let minute: number | null = null;
    for (const part of formatter.formatToParts(instant)) {
      if (part.type === 'hour') hour = Number(part.value);
      if (part.type === 'minute') minute = Number(part.value);
    }
    if (hour === null || minute === null || !Number.isFinite(hour) || !Number.isFinite(minute)) {
      return null;
    }
    // `h23` renders midnight as 24 in some ICU versions.
    return { hour: hour % 24, minute };
  } catch {
    return null;
  }
}

/**
 * Whether `minuteOfDay` falls inside the window, handling the overnight case
 * where the window wraps past midnight (22:00 -> 07:00).
 *
 * The start minute is inclusive and the end minute is exclusive, so a window of
 * `start === end` means "no quiet hours" rather than "always quiet" — silencing
 * a user forever because they dragged two sliders together would be a bug they
 * could not diagnose.
 */
export function isMinuteWithinWindow(
  minuteOfDay: number,
  startMinuteOfDay: number,
  endMinuteOfDay: number,
): boolean {
  if (startMinuteOfDay === endMinuteOfDay) return false;
  if (startMinuteOfDay < endMinuteOfDay) {
    return minuteOfDay >= startMinuteOfDay && minuteOfDay < endMinuteOfDay;
  }
  return minuteOfDay >= startMinuteOfDay || minuteOfDay < endMinuteOfDay;
}

export function isWithinQuietHours(
  quietHours: QuietHours,
  instant: Date,
  timeZone: string | null,
): boolean {
  if (!quietHours.enabled) return false;
  return isMinuteWithinWindow(
    minuteOfDayInZone(instant, timeZone),
    quietHours.startMinuteOfDay,
    quietHours.endMinuteOfDay,
  );
}
