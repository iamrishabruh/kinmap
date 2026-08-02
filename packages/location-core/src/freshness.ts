import {
  ACCEPTANCE,
  FRESHNESS_THRESHOLDS,
  type Freshness,
  type LocationEvent,
} from '@family/contracts';

import { parseIsoMs } from './internal.js';

/**
 * Freshness classification (spec §19).
 *
 * Viewers are shown a freshness band rather than a raw age so that "last seen"
 * copy stays honest without inviting a stalker to infer movement patterns from
 * second-level precision.
 */

/** Ordering from most to least trustworthy. UNKNOWN sorts last. */
export const FRESHNESS_RANK: Record<Freshness, number> = {
  LIVE: 4,
  FRESH: 3,
  RECENT: 2,
  STALE: 1,
  UNKNOWN: 0,
};

/**
 * Age in seconds of a capture timestamp, or null when it cannot be trusted.
 *
 * A timestamp slightly in the future is normal clock skew between a phone and
 * the server and is treated as age zero. Beyond
 * `ACCEPTANCE.MAX_CLOCK_SKEW_FUTURE_SECONDS` the device clock is wrong enough
 * that any age we computed would be fiction, so we refuse to guess.
 */
export function freshnessAgeSeconds(
  capturedAt: string | null | undefined,
  nowMs: number,
): number | null {
  const capturedMs = parseIsoMs(capturedAt);
  if (capturedMs === null || !Number.isFinite(nowMs)) return null;
  const ageSeconds = (nowMs - capturedMs) / 1000;
  if (ageSeconds < 0) {
    return -ageSeconds > ACCEPTANCE.MAX_CLOCK_SKEW_FUTURE_SECONDS ? null : 0;
  }
  return ageSeconds;
}

/**
 * Classify a capture timestamp into a `Freshness` band.
 *
 * Boundaries are inclusive of the lower band: an age of exactly
 * `LIVE_SECONDS` is still LIVE.
 */
export function classifyFreshness(capturedAt: string | null | undefined, nowMs: number): Freshness {
  const age = freshnessAgeSeconds(capturedAt, nowMs);
  if (age === null) return 'UNKNOWN';
  if (age <= FRESHNESS_THRESHOLDS.LIVE_SECONDS) return 'LIVE';
  if (age <= FRESHNESS_THRESHOLDS.FRESH_SECONDS) return 'FRESH';
  if (age <= FRESHNESS_THRESHOLDS.RECENT_SECONDS) return 'RECENT';
  return 'STALE';
}

/** Classify a captured location event. */
export function classifyEventFreshness(event: LocationEvent, nowMs: number): Freshness {
  return classifyFreshness(event.capturedAt, nowMs);
}

/** Negative when `a` is less fresh than `b`; suitable for `Array#sort`. */
export function compareFreshness(a: Freshness, b: Freshness): number {
  return FRESHNESS_RANK[a] - FRESHNESS_RANK[b];
}

export function isAtLeastAsFresh(a: Freshness, b: Freshness): boolean {
  return FRESHNESS_RANK[a] >= FRESHNESS_RANK[b];
}

/**
 * Whether a band is fresh enough to render as a live-ish position rather than a
 * historical one.
 */
export function isActionableFreshness(freshness: Freshness): boolean {
  return freshness === 'LIVE' || freshness === 'FRESH';
}
