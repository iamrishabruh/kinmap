import type { RetryPolicy } from '@family/contracts';

/**
 * Retry timing. Shares `RetryPolicy` with the native location engine so the
 * app and the background uploader cannot drift apart in how aggressively they
 * hammer a struggling backend.
 */

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  baseDelayMs: 250,
  maxDelayMs: 8_000,
  multiplier: 2,
  jitterRatio: 0.2,
  maxAttempts: 4,
};

/** Never sleep longer than this, whatever `Retry-After` claims. */
export const DEFAULT_MAX_RETRY_AFTER_MS = 60_000;

export function resolveRetryPolicy(
  ...overrides: Array<Partial<RetryPolicy> | undefined>
): RetryPolicy {
  return overrides.reduce<RetryPolicy>(
    (policy, override) => ({ ...policy, ...(override ?? {}) }),
    DEFAULT_RETRY_POLICY,
  );
}

/**
 * `Retry-After` is either delta-seconds or an HTTP-date. Returns milliseconds,
 * or null when the header is absent or unparseable.
 */
export function parseRetryAfter(headerValue: string | null, nowMs: number): number | null {
  if (headerValue === null) return null;
  const trimmed = headerValue.trim();
  if (trimmed.length === 0) return null;

  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1_000;
  }

  const asDate = Date.parse(trimmed);
  if (Number.isNaN(asDate)) return null;
  return Math.max(0, asDate - nowMs);
}

export type BackoffInput = {
  /** 1-based index of the attempt that just failed. */
  attempt: number;
  policy: RetryPolicy;
  retryAfterMs?: number | null;
  maxRetryAfterMs?: number;
  /** Injectable for deterministic tests; 0.5 produces zero jitter. */
  random?: () => number;
};

/**
 * Exponential backoff with symmetric jitter.
 *
 * A server-supplied `Retry-After` wins outright — it is the only party that
 * knows when its rate-limit window resets — but is still clamped, and still
 * jittered so a fleet of devices told "retry in 30s" does not return as one
 * synchronised thundering herd.
 */
export function computeBackoffDelayMs(input: BackoffInput): number {
  const { attempt, policy } = input;
  const random = input.random ?? Math.random;
  const maxRetryAfterMs = input.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS;

  const exponential = policy.baseDelayMs * Math.pow(policy.multiplier, Math.max(0, attempt - 1));
  const capped = Math.min(policy.maxDelayMs, exponential);

  const target =
    input.retryAfterMs !== null && input.retryAfterMs !== undefined
      ? Math.min(input.retryAfterMs, maxRetryAfterMs)
      : capped;

  const jitterRatio = Math.min(1, Math.max(0, policy.jitterRatio));
  const jitter = target * jitterRatio * (random() * 2 - 1);

  return Math.max(0, Math.round(target + jitter));
}

export function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
