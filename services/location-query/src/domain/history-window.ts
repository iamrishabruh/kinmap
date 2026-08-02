import { AppError, LIMITS, type UserId } from '@family/contracts';

/**
 * History paging over the `USER#<id>#DAY#<yyyy-mm-dd>` partitions.
 *
 * Three rules live here, all of them pure:
 *
 *  1. A window is expanded into an explicit, bounded list of day partitions, so
 *     a read is a fixed number of `Query` calls rather than a scan.
 *  2. LOGICAL EXPIRY: a row older than the plan's retention is filtered at read
 *     time. DynamoDB TTL deletes "within 48 hours", which is not a guarantee a
 *     privacy promise can be built on — the reader must not depend on it.
 *  3. The cursor is opaque, self-describing and validated. A caller cannot use
 *     it to reach a different user's partition, because the userId is never
 *     taken from the cursor: it comes from the authorised request.
 */

const MS_PER_DAY = 86_400_000;

export function historyPartitionKeyForDay(userId: UserId, day: string): string {
  return `USER#${userId}#DAY#${day}`;
}

/** Inclusive sort-key bounds for a `TIME#<iso>#EVENT#<id>` range query. */
export function sortKeyBounds(fromIso: string, toIso: string): { low: string; high: string } {
  return {
    low: `TIME#${new Date(instantOf(fromIso)).toISOString()}`,
    // U+FFFF sorts after every character a UUID event id can contain, so the
    // upper bound includes every event captured at exactly `toIso`.
    high: `TIME#${new Date(instantOf(toIso)).toISOString()}#EVENT#￿`,
  };
}

function instantOf(isoTimestamp: string): number {
  const parsed = Date.parse(isoTimestamp);
  if (Number.isNaN(parsed)) {
    throw new AppError('HISTORY_RANGE_INVALID', 'The requested history range is not valid.');
  }
  return parsed;
}

/**
 * UTC days covered by `[fromIso, toIso]`, oldest first.
 *
 * @throws AppError('HISTORY_RANGE_INVALID') when the window is inverted or wider
 * than `LIMITS.MAX_HISTORY_RANGE_DAYS`. The range has already been clamped to
 * the plan's retention by the authorization checker; this is the cost guard.
 */
export function dayPartitions(fromIso: string, toIso: string): string[] {
  const fromMs = instantOf(fromIso);
  const toMs = instantOf(toIso);
  if (fromMs > toMs) {
    throw new AppError('HISTORY_RANGE_INVALID', 'The requested history range is not valid.');
  }
  if (toMs - fromMs > LIMITS.MAX_HISTORY_RANGE_DAYS * MS_PER_DAY) {
    throw new AppError('HISTORY_RANGE_INVALID', 'The requested history range is not valid.');
  }

  const days: string[] = [];
  const firstDayMs = Math.floor(fromMs / MS_PER_DAY) * MS_PER_DAY;
  const lastDayMs = Math.floor(toMs / MS_PER_DAY) * MS_PER_DAY;

  for (let dayMs = firstDayMs; dayMs <= lastDayMs; dayMs += MS_PER_DAY) {
    days.push(new Date(dayMs).toISOString().slice(0, 10));
  }
  return days;
}

export function resolvePageSize(requested: number): number {
  if (!Number.isInteger(requested) || requested < 1) {
    return LIMITS.DEFAULT_HISTORY_PAGE_SIZE;
  }
  return Math.min(requested, LIMITS.MAX_HISTORY_PAGE_SIZE);
}

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

export type HistoryCursor = {
  /** `yyyy-mm-dd` partition the next page resumes in. */
  readonly day: string;
  /** Sort key of the last row returned; the next page starts strictly after it. */
  readonly sk: string;
};

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function encodeCursor(cursor: HistoryCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/**
 * @throws AppError('VALIDATION_FAILED') on anything that is not a cursor this
 * service issued. The message never quotes the offending value.
 */
export function decodeCursor(raw: string): HistoryCursor {
  const invalid = (): AppError =>
    new AppError('VALIDATION_FAILED', 'The request could not be validated.', [
      { path: 'cursor', message: 'This value is not in the expected format.' },
    ]);

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
  } catch {
    throw invalid();
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw invalid();
  }
  const candidate = parsed as { day?: unknown; sk?: unknown };
  if (
    typeof candidate.day !== 'string' ||
    !DAY_PATTERN.test(candidate.day) ||
    typeof candidate.sk !== 'string' ||
    !candidate.sk.startsWith('TIME#')
  ) {
    throw invalid();
  }
  return { day: candidate.day, sk: candidate.sk };
}

// ---------------------------------------------------------------------------
// Logical expiry
// ---------------------------------------------------------------------------

export type ExpiryCheckInput = {
  readonly capturedAt: string;
  /** DynamoDB TTL attribute, epoch seconds. Optional on older rows. */
  readonly expiresAt?: number | undefined;
};

/**
 * True when a row must not be returned, whether or not DynamoDB has physically
 * removed it yet. Both the retention floor and the row's own TTL are honoured,
 * so shortening a plan takes effect on the next read rather than on the next
 * TTL sweep.
 */
export function isLogicallyExpired(
  row: ExpiryCheckInput,
  retentionDays: number,
  now: Date,
): boolean {
  const nowMs = now.getTime();
  if (row.expiresAt !== undefined && row.expiresAt * 1000 <= nowMs) {
    return true;
  }
  const capturedMs = Date.parse(row.capturedAt);
  if (Number.isNaN(capturedMs)) {
    // An unreadable timestamp cannot be proven to be inside retention.
    return true;
  }
  if (retentionDays <= 0) {
    return true;
  }
  return capturedMs < nowMs - retentionDays * MS_PER_DAY;
}
