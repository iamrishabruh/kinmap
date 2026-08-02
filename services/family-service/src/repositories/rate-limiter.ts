import type { RateLimitDecision, RateLimiter } from '@family/auth';

/**
 * Per-container fixed-window limiter.
 *
 * This is a cost and abuse damper, not a security control: Lambda scales
 * horizontally, so the effective limit is the per-minute cap multiplied by the
 * live container count. The controls that actually stop a stalker — membership,
 * sharing status and per-member visibility — are all evaluated before this one,
 * and none of them are cached.
 *
 * Keys are built by @family/auth and contain an operation name and a user id.
 * They never contain a coordinate, so retaining them in memory is safe.
 */

const WINDOW_MS = 60_000;

/** Bounded so a container cannot be pushed into an out-of-memory kill. */
const MAX_TRACKED_KEYS = 10_000;

type Window = { count: number; resetAtMs: number };

export function createInMemoryRateLimiter(now: () => number = Date.now): RateLimiter {
  const windows = new Map<string, Window>();

  return {
    consume(input: {
      key: string;
      limitPerMinute: number;
      requestId: string;
    }): Promise<RateLimitDecision> {
      const nowMs = now();

      if (windows.size >= MAX_TRACKED_KEYS) {
        for (const [key, window] of windows) {
          if (window.resetAtMs <= nowMs) {
            windows.delete(key);
          }
        }
        if (windows.size >= MAX_TRACKED_KEYS) {
          // Refuse rather than grow without bound; a denial is the safe answer.
          return Promise.resolve({ allowed: false, retryAfterSeconds: 60 });
        }
      }

      const existing = windows.get(input.key);
      if (existing === undefined || existing.resetAtMs <= nowMs) {
        windows.set(input.key, { count: 1, resetAtMs: nowMs + WINDOW_MS });
        return Promise.resolve({ allowed: true });
      }

      if (existing.count >= input.limitPerMinute) {
        return Promise.resolve({
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAtMs - nowMs) / 1000)),
        });
      }

      existing.count += 1;
      return Promise.resolve({ allowed: true });
    },
  };
}
