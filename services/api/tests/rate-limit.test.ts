import { beforeEach, describe, expect, it } from 'vitest';

import { ApiErrorSchema, RATE_LIMITS } from '@family/contracts';

import { createTokenBucketRateLimiter } from '../src/middleware/rateLimit.js';
import { createTokenBucketStore } from '../src/repositories/idempotency.js';

import {
  authHeaders,
  createHarness,
  deviceIdOf,
  seedUser,
  userIdOf,
  TABLES,
  type Harness,
} from './support/harness.js';

/**
 * The token bucket is an abuse control, so the properties worth pinning are
 * exhaustion, refill, and what a denied caller is told: `RATE_LIMITED` is one of
 * the few refusals that is deliberately NOT opaque, because telling a legitimate
 * client when to come back reveals nothing about anybody else.
 */

describe('token bucket', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness();
  });

  it('allows a full bucket and then denies', async () => {
    const limiter = createTokenBucketRateLimiter(
      createTokenBucketStore(harness.client, TABLES.idempotency),
      { now: harness.now },
    );
    const consume = (): Promise<{ allowed: boolean; retryAfterSeconds?: number }> =>
      limiter.consume({ key: 'RATE#TEST#user', limitPerMinute: 3, requestId: 'r' });

    expect((await consume()).allowed).toBe(true);
    expect((await consume()).allowed).toBe(true);
    expect((await consume()).allowed).toBe(true);

    const denied = await consume();
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('refills continuously rather than in windows', async () => {
    const limiter = createTokenBucketRateLimiter(
      createTokenBucketStore(harness.client, TABLES.idempotency),
      { now: harness.now },
    );
    const consume = (): Promise<{ allowed: boolean }> =>
      limiter.consume({ key: 'RATE#TEST#refill', limitPerMinute: 6, requestId: 'r' });

    for (let index = 0; index < 6; index += 1) {
      expect((await consume()).allowed).toBe(true);
    }
    expect((await consume()).allowed).toBe(false);

    // Six per minute is one every ten seconds.
    harness.advance(10_000);
    expect((await consume()).allowed).toBe(true);
    expect((await consume()).allowed).toBe(false);
  });

  it('keeps buckets separate per principal', async () => {
    const limiter = createTokenBucketRateLimiter(
      createTokenBucketStore(harness.client, TABLES.idempotency),
      { now: harness.now },
    );

    expect(
      (await limiter.consume({ key: 'RATE#TEST#a', limitPerMinute: 1, requestId: 'r' })).allowed,
    ).toBe(true);
    expect(
      (await limiter.consume({ key: 'RATE#TEST#a', limitPerMinute: 1, requestId: 'r' })).allowed,
    ).toBe(false);
    expect(
      (await limiter.consume({ key: 'RATE#TEST#b', limitPerMinute: 1, requestId: 'r' })).allowed,
    ).toBe(true);
  });
});

describe('rate limiting through the pipeline', () => {
  let harness: Harness;
  const user = userIdOf(1);

  beforeEach(() => {
    harness = createHarness();
    seedUser(harness, { userId: user });
  });

  it('exhausts the account-mutation bucket and reports when to retry', async () => {
    const call = (): Promise<{
      statusCode: number;
      headers: Record<string, string>;
      body: unknown;
    }> =>
      harness.call({
        method: 'DELETE',
        path: `/v1/devices/${deviceIdOf(1)}`,
        headers: authHeaders(user),
      });

    for (let index = 0; index < RATE_LIMITS.ACCOUNT_MUTATION_PER_USER; index += 1) {
      const response = await call();
      // No such device — but the request was admitted, which is the point.
      expect(response.statusCode).toBe(404);
    }

    const limited = await call();
    expect(limited.statusCode).toBe(429);

    const envelope = ApiErrorSchema.parse(limited.body);
    expect(envelope.error.code).toBe('RATE_LIMITED');
    expect(envelope.error.retryAfterSeconds).toBeGreaterThan(0);
    expect(limited.headers['retry-after']).toBe(String(envelope.error.retryAfterSeconds));
  });

  it('does not spend the quota of a different principal', async () => {
    const other = userIdOf(2);
    seedUser(harness, { userId: other });

    for (let index = 0; index < RATE_LIMITS.ACCOUNT_MUTATION_PER_USER; index += 1) {
      await harness.call({
        method: 'DELETE',
        path: `/v1/devices/${deviceIdOf(1)}`,
        headers: authHeaders(user),
      });
    }

    const exhausted = await harness.call({
      method: 'DELETE',
      path: `/v1/devices/${deviceIdOf(1)}`,
      headers: authHeaders(user),
    });
    const unaffected = await harness.call({
      method: 'DELETE',
      path: `/v1/devices/${deviceIdOf(1)}`,
      headers: authHeaders(other),
    });

    expect(exhausted.statusCode).toBe(429);
    expect(unaffected.statusCode).toBe(404);
  });
});
