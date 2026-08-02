/**
 * Pause durations offered on the sharing screen.
 *
 * Every option states exactly what it does and when it ends. "Snooze" and
 * other soft words are banned: a user pausing location sharing is making a
 * privacy decision and must not have to guess how long it lasts.
 */

export type PauseDuration = {
  id: string;
  /** Null means "until I turn it back on" — no automatic resume, ever. */
  durationMinutes: number | null;
  label: string;
  /** Rendered under the label; spells out the resume behaviour. */
  detail: string;
};

export const PAUSE_DURATIONS: readonly PauseDuration[] = [
  {
    id: 'PAUSE_15M',
    durationMinutes: 15,
    label: 'Pause for 15 minutes',
    detail: 'Sharing turns itself back on automatically after 15 minutes.',
  },
  {
    id: 'PAUSE_1H',
    durationMinutes: 60,
    label: 'Pause for 1 hour',
    detail: 'Sharing turns itself back on automatically after 1 hour.',
  },
  {
    id: 'PAUSE_8H',
    durationMinutes: 8 * 60,
    label: 'Pause for 8 hours',
    detail: 'Sharing turns itself back on automatically after 8 hours.',
  },
  {
    id: 'PAUSE_24H',
    durationMinutes: 24 * 60,
    label: 'Pause for 24 hours',
    detail: 'Sharing turns itself back on automatically after 24 hours.',
  },
  {
    id: 'PAUSE_INDEFINITE',
    durationMinutes: null,
    label: 'Pause until I turn it back on',
    detail: 'Nothing resumes automatically. Your family sees that you are paused.',
  },
] as const;

/**
 * Human phrasing for how long a pause has left. Returns null once the pause has
 * elapsed so the caller can render the resumed state instead of "0 minutes".
 */
export function describeRemainingPause(
  pausedUntil: string | null,
  now: Date = new Date(),
): string | null {
  if (!pausedUntil) return 'until you turn it back on';

  const endsAt = Date.parse(pausedUntil);
  if (Number.isNaN(endsAt)) return null;

  const remainingMinutes = Math.ceil((endsAt - now.getTime()) / 60_000);
  if (remainingMinutes <= 0) return null;
  if (remainingMinutes < 60) {
    return `for another ${remainingMinutes} minute${remainingMinutes === 1 ? '' : 's'}`;
  }

  const hours = Math.floor(remainingMinutes / 60);
  const minutes = remainingMinutes % 60;
  if (minutes === 0) return `for another ${hours} hour${hours === 1 ? '' : 's'}`;
  return `for another ${hours}h ${minutes}m`;
}

export function findPauseDuration(id: string): PauseDuration | undefined {
  return PAUSE_DURATIONS.find((option) => option.id === id);
}
