import { type RetryPolicy } from '@family/contracts';

/**
 * Exponential backoff with symmetric jitter.
 *
 * Jitter is not cosmetic here. Every device in a family — and every device that
 * lost connectivity during the same outage — comes back at the same moment, so
 * an unjittered schedule turns one outage into a synchronised thundering herd
 * against the ingestion endpoint the instant it recovers.
 *
 * `random` is injected so the schedule is assertable in tests.
 */
export function computeBackoffDelayMs(
  policy: RetryPolicy,
  /** Number of attempts already made. 1 means "the first attempt just failed". */
  attempt: number,
  random: () => number = Math.random,
): number {
  const safeAttempt = Math.max(1, Math.floor(attempt));
  const multiplier = Math.max(1, policy.multiplier);
  const base = Math.max(0, policy.baseDelayMs);
  const ceiling = Math.max(base, policy.maxDelayMs);

  // Cap the exponent before computing the power so a large attempt count
  // cannot overflow to Infinity on the way to being clamped.
  const growth = Math.pow(multiplier, Math.min(safeAttempt - 1, 32));
  const raw = Math.min(ceiling, base * growth);

  const ratio = Math.min(1, Math.max(0, policy.jitterRatio));
  if (ratio === 0) {
    return Math.round(raw);
  }
  const jittered = raw * (1 + ratio * (random() * 2 - 1));
  return Math.round(Math.min(ceiling, Math.max(0, jittered)));
}

/**
 * True when the queue has spent its budget on these events and they must be
 * dropped rather than retried indefinitely (spec §11).
 */
export function hasExhaustedAttempts(policy: RetryPolicy, attempts: number): boolean {
  return attempts >= Math.max(1, policy.maxAttempts);
}

/** Honours a server `Retry-After` when it asks for a longer wait than our own. */
export function applyServerRetryAfter(
  computedDelayMs: number,
  retryAfterSeconds: number | null,
): number {
  if (retryAfterSeconds === null || !Number.isFinite(retryAfterSeconds)) {
    return computedDelayMs;
  }
  return Math.max(computedDelayMs, Math.max(0, retryAfterSeconds) * 1000);
}
