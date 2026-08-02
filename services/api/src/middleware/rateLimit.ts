import type { RateLimitDecision, RateLimiter } from '@family/auth';
import { AppError, type UserId } from '@family/contracts';

import type { TokenBucketStore } from '../repositories/idempotency.js';
import { RATE_LIMIT_BUCKETS, type RateLimitBucket } from '../router.js';

/**
 * A DynamoDB token bucket, keyed by principal.
 *
 * Capacity equals the per-minute ceiling and refills continuously, so a client
 * that has been idle may burst up to a minute's worth and then settles into the
 * steady rate — which is what a mobile app coming back from the background
 * actually does.
 *
 * The compare-and-set on `refilledAtMs` is what makes concurrent invocations
 * safe: two Lambdas that read the same bucket cannot both spend the same token,
 * because only one write carries the `refilledAtMs` the other one read. A lost
 * race is retried once and then *denied*, because failing closed under
 * contention is the correct direction for an abuse control.
 */

const MAX_WRITE_ATTEMPTS = 2;

/** Buckets are worthless once refilled; two minutes is generous headroom. */
const BUCKET_TTL_SECONDS = 120;

export function bucketKey(bucket: RateLimitBucket, principal: string): string {
  return `RATE#${bucket}#${principal}`;
}

/** Prefers the authenticated principal; falls back to the source address. */
export function principalOf(input: { userId: UserId | null; sourceIp: string | null }): string {
  if (input.userId !== null) {
    return `user:${input.userId}`;
  }
  return input.sourceIp === null ? 'anonymous' : `ip:${input.sourceIp}`;
}

export function createTokenBucketRateLimiter(
  store: TokenBucketStore,
  options: { now?: () => Date } = {},
): RateLimiter {
  const now = options.now ?? ((): Date => new Date());

  return {
    async consume(input: {
      key: string;
      limitPerMinute: number;
      requestId: string;
    }): Promise<RateLimitDecision> {
      const capacity = Math.max(1, input.limitPerMinute);
      const tokensPerSecond = capacity / 60;

      for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
        const current = now();
        const nowMs = current.getTime();
        const state = await store.read(input.key);

        const available =
          state === null
            ? capacity
            : Math.min(
                capacity,
                state.tokens + ((nowMs - state.refilledAtMs) / 1000) * tokensPerSecond,
              );

        if (available < 1) {
          return {
            allowed: false,
            retryAfterSeconds: retryAfterSeconds(available, tokensPerSecond),
          };
        }

        const written = await store.write({
          key: input.key,
          tokens: available - 1,
          refilledAtMs: nowMs,
          expectedRefilledAtMs: state?.refilledAtMs ?? null,
          now: current,
          ttlSeconds: BUCKET_TTL_SECONDS,
        });
        if (written) {
          return { allowed: true };
        }
      }

      // Two lost races means real contention on this principal's bucket, which
      // is itself the signal the limiter exists to act on.
      return { allowed: false, retryAfterSeconds: 1 };
    },
  };
}

/** Whole seconds until one token is back, never less than one. */
export function retryAfterSeconds(available: number, tokensPerSecond: number): number {
  if (tokensPerSecond <= 0) {
    return 60;
  }
  return Math.max(1, Math.ceil((1 - available) / tokensPerSecond));
}

/**
 * Applies a route's bucket and converts a denial into the wire error.
 *
 * `RATE_LIMITED` is one of the few refusals that is NOT opaque: telling a
 * legitimate client when to come back is strictly better than making it guess,
 * and it reveals nothing about anybody else's account.
 */
export async function enforceRateLimit(input: {
  limiter: RateLimiter;
  bucket: RateLimitBucket;
  principal: string;
  requestId: string;
}): Promise<void> {
  const decision = await input.limiter.consume({
    key: bucketKey(input.bucket, input.principal),
    limitPerMinute: RATE_LIMIT_BUCKETS[input.bucket],
    requestId: input.requestId,
  });
  if (decision.allowed) {
    return;
  }
  throw new AppError(
    'RATE_LIMITED',
    'Too many requests. Please try again shortly.',
    undefined,
    decision.retryAfterSeconds ?? 1,
  );
}
