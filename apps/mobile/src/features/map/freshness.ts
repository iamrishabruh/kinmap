import { FRESHNESS_THRESHOLDS, type Freshness } from '@family/contracts';

import { secondsBetween } from '@/features/ui/format';

/**
 * Freshness buckets (spec §19).
 *
 * The whole point of this module is that a position we are unsure about looks
 * different from one we are sure about. A dot on a map is read as "they are
 * here, now"; if the fix is forty minutes old, the interface has to say so
 * before the user acts on it. Nothing here may round a stale fix up.
 */

/** Anything older than this is STALE and must be styled as such. */
export const STALE_AFTER_SECONDS = FRESHNESS_THRESHOLDS.RECENT_SECONDS;

export function freshnessForAge(ageSeconds: number): Freshness {
  if (!Number.isFinite(ageSeconds) || ageSeconds < 0) return 'UNKNOWN';
  if (ageSeconds <= FRESHNESS_THRESHOLDS.LIVE_SECONDS) return 'LIVE';
  if (ageSeconds <= FRESHNESS_THRESHOLDS.FRESH_SECONDS) return 'FRESH';
  if (ageSeconds <= FRESHNESS_THRESHOLDS.RECENT_SECONDS) return 'RECENT';
  return 'STALE';
}

export function freshnessFor(capturedAt: string | null, nowMs: number): Freshness {
  if (capturedAt === null) return 'UNKNOWN';
  const age = secondsBetween(capturedAt, nowMs);
  if (!Number.isFinite(age)) return 'UNKNOWN';
  return freshnessForAge(age);
}

/** True for buckets where the position should be treated as unreliable. */
export function isStaleFreshness(freshness: Freshness): boolean {
  return freshness === 'STALE' || freshness === 'UNKNOWN';
}

export const FRESHNESS_ORDER: Record<Freshness, number> = {
  LIVE: 0,
  FRESH: 1,
  RECENT: 2,
  STALE: 3,
  UNKNOWN: 4,
};

/** Short badge text. Paired with, never a substitute for, the relative time. */
export function freshnessBadge(freshness: Freshness): string {
  switch (freshness) {
    case 'LIVE':
      return 'Live';
    case 'FRESH':
      return 'Recent';
    case 'RECENT':
      return 'Older';
    case 'STALE':
      return 'Out of date';
    case 'UNKNOWN':
    default:
      return 'Unknown';
  }
}
