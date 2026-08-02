import { ACCEPTANCE, AppError, LIMITS } from '@family/contracts';

/**
 * History window validation for `GET /v1/users/{userId}/locations/history`.
 *
 * Rejection reasons are fixed identifiers and the thrown message is a fixed
 * sentence: neither ever contains the submitted timestamps. A precise
 * timestamp is not a coordinate, but it is still a movement signal, and error
 * strings end up in logs.
 */

const MILLISECONDS_PER_SECOND = 1000;
const MILLISECONDS_PER_DAY = 86_400_000;

export const HISTORY_RANGE_REJECTION_REASONS = [
  'FROM_MALFORMED',
  'TO_MALFORMED',
  'RANGE_INVERTED',
  'RANGE_TOO_LONG',
  'RANGE_IN_FUTURE',
] as const;

export type HistoryRangeRejectionReason = (typeof HISTORY_RANGE_REJECTION_REASONS)[number];

export type HistoryRange = {
  readonly fromMs: number;
  readonly toMs: number;
  readonly durationMs: number;
  readonly durationDays: number;
};

export type HistoryRangeResult =
  | { readonly ok: true; readonly range: HistoryRange }
  | { readonly ok: false; readonly reason: HistoryRangeRejectionReason };

export type HistoryRangeOptions = {
  /** Injected for deterministic tests; defaults to the current instant. */
  readonly now?: Date;
};

/** Fixed, value-free copy for each reason. */
const REASON_MESSAGES: Readonly<Record<HistoryRangeRejectionReason, string>> = {
  FROM_MALFORMED: 'The start of the range is not a valid timestamp.',
  TO_MALFORMED: 'The end of the range is not a valid timestamp.',
  RANGE_INVERTED: 'The start of the range must be before its end.',
  RANGE_TOO_LONG: 'The requested range is longer than the maximum allowed window.',
  RANGE_IN_FUTURE: 'The end of the range cannot be in the future.',
};

/** Which query parameter the caller should fix. */
const REASON_PATHS: Readonly<Record<HistoryRangeRejectionReason, string>> = {
  FROM_MALFORMED: 'from',
  TO_MALFORMED: 'to',
  RANGE_INVERTED: 'from',
  RANGE_TOO_LONG: 'to',
  RANGE_IN_FUTURE: 'to',
};

export function historyRangeRejectionMessage(reason: HistoryRangeRejectionReason): string {
  return REASON_MESSAGES[reason];
}

function parseInstant(value: string): number | null {
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Non-throwing form. Use it where a rejection is an expected outcome you want
 * to count or branch on rather than an exception.
 */
export function safeValidateHistoryRange(
  from: string,
  to: string,
  options: HistoryRangeOptions = {},
): HistoryRangeResult {
  const fromMs = parseInstant(from);
  if (fromMs === null) {
    return { ok: false, reason: 'FROM_MALFORMED' };
  }

  const toMs = parseInstant(to);
  if (toMs === null) {
    return { ok: false, reason: 'TO_MALFORMED' };
  }

  if (fromMs >= toMs) {
    return { ok: false, reason: 'RANGE_INVERTED' };
  }

  const durationMs = toMs - fromMs;
  if (durationMs > LIMITS.MAX_HISTORY_RANGE_DAYS * MILLISECONDS_PER_DAY) {
    return { ok: false, reason: 'RANGE_TOO_LONG' };
  }

  const nowMs = (options.now ?? new Date()).getTime();
  // The same clock-skew allowance the ingestion path grants, so a device whose
  // clock runs slightly fast can still ask for "up to now".
  const skewAllowanceMs = ACCEPTANCE.MAX_CLOCK_SKEW_FUTURE_SECONDS * MILLISECONDS_PER_SECOND;
  if (toMs > nowMs + skewAllowanceMs) {
    return { ok: false, reason: 'RANGE_IN_FUTURE' };
  }

  return {
    ok: true,
    range: {
      fromMs,
      toMs,
      durationMs,
      durationDays: durationMs / MILLISECONDS_PER_DAY,
    },
  };
}

/**
 * Throwing form for request handlers.
 *
 * @throws AppError('HISTORY_RANGE_INVALID')
 */
export function validateHistoryRange(
  from: string,
  to: string,
  options: HistoryRangeOptions = {},
): HistoryRange {
  const result = safeValidateHistoryRange(from, to, options);

  if (result.ok) {
    return result.range;
  }

  const message = historyRangeRejectionMessage(result.reason);

  throw new AppError('HISTORY_RANGE_INVALID', message, [
    { path: REASON_PATHS[result.reason], message },
  ]);
}
