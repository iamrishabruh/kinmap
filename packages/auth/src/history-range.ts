import { ACCEPTANCE, LIMITS } from '@family/contracts';

/**
 * History window validation (spec §18, step 9).
 *
 * Two different jobs are done here and they are deliberately not merged:
 *  - a *malformed or oversized* window is rejected, because an unbounded scan is
 *    an availability and cost attack; and
 *  - a window that reaches further back than the plan's retention is *clamped*,
 *    because that is a plan boundary rather than a hostile request.
 */

export type HistoryRange = {
  /** ISO-8601, inclusive. */
  from: string;
  /** ISO-8601, inclusive. */
  to: string;
};

export type HistoryRangeRejection =
  'UNPARSEABLE' | 'INVERTED' | 'FUTURE' | 'TOO_LONG' | 'OUTSIDE_RETENTION';

export type HistoryRangeEvaluation =
  { valid: true; effective: HistoryRange } | { valid: false; rejection: HistoryRangeRejection };

export type HistoryRangeOptions = {
  /** From the resolved entitlements; 0 means history is not available at all. */
  retentionDays: number;
  now: Date;
  maxRangeDays?: number;
};

const MS_PER_DAY = 86_400_000;

export function evaluateHistoryRange(
  range: HistoryRange,
  options: HistoryRangeOptions,
): HistoryRangeEvaluation {
  const fromMs = parseIsoInstant(range.from);
  const toMs = parseIsoInstant(range.to);
  if (fromMs === null || toMs === null) {
    return { valid: false, rejection: 'UNPARSEABLE' };
  }
  if (fromMs > toMs) {
    return { valid: false, rejection: 'INVERTED' };
  }

  const nowMs = options.now.getTime();
  const skewMs = ACCEPTANCE.MAX_CLOCK_SKEW_FUTURE_SECONDS * 1_000;
  if (toMs > nowMs + skewMs) {
    return { valid: false, rejection: 'FUTURE' };
  }

  const maxRangeDays = options.maxRangeDays ?? LIMITS.MAX_HISTORY_RANGE_DAYS;
  if (toMs - fromMs > maxRangeDays * MS_PER_DAY) {
    return { valid: false, rejection: 'TOO_LONG' };
  }

  if (options.retentionDays <= 0) {
    return { valid: false, rejection: 'OUTSIDE_RETENTION' };
  }

  const retentionFloorMs = nowMs - options.retentionDays * MS_PER_DAY;
  const effectiveFromMs = Math.max(fromMs, retentionFloorMs);
  if (effectiveFromMs > toMs) {
    // The whole window predates what the plan retains: there is nothing to read.
    return { valid: false, rejection: 'OUTSIDE_RETENTION' };
  }

  return {
    valid: true,
    effective: {
      from: new Date(effectiveFromMs).toISOString(),
      to: new Date(toMs).toISOString(),
    },
  };
}

/**
 * `new Date(value)` accepts sloppy inputs such as "2026-13-45" on some engines
 * and non-ISO strings on all of them, so the shape is checked before parsing.
 */
function parseIsoInstant(value: string): number | null {
  if (typeof value !== 'string' || value.trim() === '') {
    return null;
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}
