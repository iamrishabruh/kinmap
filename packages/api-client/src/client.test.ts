import { describe, expect, it, vi } from 'vitest';

import { AppError } from '@family/contracts';

import { ApiClient } from './client.js';
import { computeBackoffDelayMs, parseRetryAfter } from './retry.js';
import {
  HEADER_IDEMPOTENCY_KEY,
  HEADER_REQUEST_ID,
  type ApiClientOptions,
  type FetchLike,
} from './types.js';

/**
 * Every test drives a mocked `fetch`. Backoff sleeps are captured rather than
 * awaited so the suite stays instant and deterministic: `random: () => 0.5`
 * makes the symmetric jitter exactly zero.
 */

const LAT = 37.774929;
const LNG = -122.419418;

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function errorResponse(
  status: number,
  code: string,
  message = 'nope',
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Response {
  return jsonResponse(
    status,
    { error: { code, message, requestId: 'req-server', ...extra } },
    headers,
  );
}

function createHarness(
  responses: Array<Response | ((init: RequestInit) => Response)>,
  overrides: Partial<ApiClientOptions> = {},
) {
  let token: string | null = 'token-1';
  const queue = [...responses];
  const sleeps: number[] = [];
  const logs: Array<{ message: string; context?: Record<string, unknown> }> = [];

  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const next = queue.shift();
    if (!next) throw new Error('fetch called more times than the test queued responses');
    return typeof next === 'function' ? next(init) : next;
  });

  const refresh = vi.fn(async () => {
    token = 'token-2';
    return token;
  });

  const record = (message: string, context?: Record<string, unknown>): void => {
    logs.push({ message, context });
  };

  const client = new ApiClient({
    baseUrl: 'https://api.example.test/',
    appEnv: 'staging',
    getAccessToken: () => token,
    refreshAccessToken: refresh,
    fetch: fetchMock as unknown as FetchLike,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
    now: () => 1_767_225_600_000,
    generateRequestId: () => 'req-fixed',
    generateIdempotencyKey: () => 'idem-fixed',
    logger: { debug: record, info: record, warn: record, error: record },
    ...overrides,
  });

  return {
    client,
    fetchMock,
    sleeps,
    refresh,
    logs,
    setToken: (next: string | null) => {
      token = next;
    },
  };
}

type CallRecorder = { mock: { calls: readonly unknown[][] } };

function headerOf(fetchMock: CallRecorder, call: number, name: string): string | undefined {
  const init = fetchMock.mock.calls[call]?.[1] as RequestInit | undefined;
  const headers = init?.headers as Record<string, string> | undefined;
  return headers?.[name];
}

describe('401 → refresh → retry once', () => {
  it('refreshes the token and replays the request with the new one', async () => {
    const harness = createHarness([
      errorResponse(401, 'SESSION_EXPIRED'),
      jsonResponse(200, { ok: true }),
    ]);

    await expect(harness.client.get({ path: '/v1/ping' })).resolves.toEqual({ ok: true });

    expect(harness.refresh).toHaveBeenCalledTimes(1);
    expect(harness.fetchMock).toHaveBeenCalledTimes(2);
    expect(headerOf(harness.fetchMock, 0, 'Authorization')).toBe('Bearer token-1');
    expect(headerOf(harness.fetchMock, 1, 'Authorization')).toBe('Bearer token-2');
    // A refresh is not a retry: no backoff was spent.
    expect(harness.sleeps).toEqual([]);
  });

  it('refreshes at most once per request and then surfaces the 401', async () => {
    const harness = createHarness([
      errorResponse(401, 'SESSION_EXPIRED'),
      errorResponse(401, 'SESSION_EXPIRED'),
    ]);

    const error = await harness.client.get({ path: '/v1/ping' }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('SESSION_EXPIRED');
    expect(harness.refresh).toHaveBeenCalledTimes(1);
    expect(harness.fetchMock).toHaveBeenCalledTimes(2);
  });

  it('single-flights the refresh across concurrent 401s', async () => {
    const harness = createHarness([], {});
    // Rebuild with a fetch that answers based on the token it was handed.
    const refresh = vi.fn(async () => 'token-2');
    let current = 'token-1';
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      return headers.Authorization === 'Bearer token-2'
        ? jsonResponse(200, { ok: true })
        : errorResponse(401, 'SESSION_EXPIRED');
    });

    const client = new ApiClient({
      baseUrl: 'https://api.example.test',
      appEnv: 'staging',
      getAccessToken: () => current,
      refreshAccessToken: async () => {
        const next = await refresh();
        current = next;
        return next;
      },
      fetch: fetchMock as unknown as FetchLike,
      sleep: async () => undefined,
      random: () => 0.5,
    });

    const results = await Promise.all(
      Array.from({ length: 6 }, () => client.get({ path: '/v1/ping' })),
    );

    expect(results).toHaveLength(6);
    // Six 401s, one refresh — this is the whole point of the single flight.
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(harness.refresh).not.toHaveBeenCalled();
  });

  it('does not attempt a refresh when no refresh callback is configured', async () => {
    const harness = createHarness([errorResponse(401, 'UNAUTHENTICATED')], {
      refreshAccessToken: undefined,
    });

    await expect(harness.client.get({ path: '/v1/ping' })).rejects.toBeInstanceOf(AppError);
    expect(harness.fetchMock).toHaveBeenCalledTimes(1);
  });

  it('calls onAuthenticationLost when the session cannot be recovered', async () => {
    const onAuthenticationLost = vi.fn();
    const harness = createHarness([errorResponse(401, 'SESSION_EXPIRED')], {
      refreshAccessToken: async () => null,
      onAuthenticationLost,
    });

    await expect(harness.client.get({ path: '/v1/ping' })).rejects.toBeInstanceOf(AppError);
    expect(onAuthenticationLost).toHaveBeenCalledTimes(1);
  });
});

describe('429 and 5xx backoff', () => {
  it('honours Retry-After in seconds', async () => {
    const harness = createHarness([
      errorResponse(429, 'RATE_LIMITED', 'slow down', {}, { 'retry-after': '2' }),
      jsonResponse(200, { ok: true }),
    ]);

    await expect(harness.client.get({ path: '/v1/ping' })).resolves.toEqual({ ok: true });

    expect(harness.sleeps).toEqual([2_000]);
    expect(harness.fetchMock).toHaveBeenCalledTimes(2);
  });

  it('falls back to the envelope retryAfterSeconds when the header is absent', async () => {
    const harness = createHarness([
      errorResponse(429, 'RATE_LIMITED', 'slow down', { retryAfterSeconds: 5 }),
      jsonResponse(200, { ok: true }),
    ]);

    await harness.client.get({ path: '/v1/ping' });
    expect(harness.sleeps).toEqual([5_000]);
  });

  it('clamps an absurd Retry-After', async () => {
    const harness = createHarness([
      errorResponse(429, 'RATE_LIMITED', 'slow down', {}, { 'retry-after': '86400' }),
      jsonResponse(200, { ok: true }),
    ]);

    await harness.client.get({ path: '/v1/ping' });
    expect(harness.sleeps).toEqual([60_000]);
  });

  it('backs off exponentially on 5xx and gives up after maxAttempts', async () => {
    const harness = createHarness(
      [
        errorResponse(503, 'UPSTREAM_UNAVAILABLE'),
        errorResponse(503, 'UPSTREAM_UNAVAILABLE'),
        errorResponse(503, 'UPSTREAM_UNAVAILABLE'),
      ],
      { retry: { maxAttempts: 3, baseDelayMs: 100, multiplier: 2, maxDelayMs: 10_000 } },
    );

    const error = await harness.client.get({ path: '/v1/ping' }).catch((e: unknown) => e);

    expect((error as AppError).code).toBe('UPSTREAM_UNAVAILABLE');
    expect(harness.sleeps).toEqual([100, 200]);
    expect(harness.fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not retry a 4xx that is not rate limiting', async () => {
    const harness = createHarness([errorResponse(403, 'FORBIDDEN')]);

    await expect(harness.client.get({ path: '/v1/ping' })).rejects.toBeInstanceOf(AppError);
    expect(harness.fetchMock).toHaveBeenCalledTimes(1);
    expect(harness.sleeps).toEqual([]);
  });

  it('retries a transport failure and then reports UPSTREAM_UNAVAILABLE', async () => {
    const failing = vi.fn(async () => {
      throw new TypeError('Network request failed');
    });
    const sleeps: number[] = [];
    const client = new ApiClient({
      baseUrl: 'https://api.example.test',
      appEnv: 'development',
      getAccessToken: () => 'token-1',
      fetch: failing as unknown as FetchLike,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      random: () => 0.5,
      retry: { maxAttempts: 2, baseDelayMs: 50 },
    });

    const error = await client.get({ path: '/v1/ping' }).catch((e: unknown) => e);

    expect((error as AppError).code).toBe('UPSTREAM_UNAVAILABLE');
    expect(failing).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([50]);
  });
});

describe('idempotency keys', () => {
  it('sends one on POST, PATCH and DELETE but not on GET', async () => {
    const harness = createHarness([
      jsonResponse(200, {}),
      jsonResponse(200, {}),
      new Response(null, { status: 204 }),
      jsonResponse(200, {}),
    ]);

    await harness.client.post({ path: '/v1/a', body: { a: 1 } });
    await harness.client.patch({ path: '/v1/a', body: { a: 1 } });
    await harness.client.delete({ path: '/v1/a' });
    await harness.client.get({ path: '/v1/a' });

    expect(headerOf(harness.fetchMock, 0, HEADER_IDEMPOTENCY_KEY)).toBe('idem-fixed');
    expect(headerOf(harness.fetchMock, 1, HEADER_IDEMPOTENCY_KEY)).toBe('idem-fixed');
    expect(headerOf(harness.fetchMock, 2, HEADER_IDEMPOTENCY_KEY)).toBe('idem-fixed');
    expect(headerOf(harness.fetchMock, 3, HEADER_IDEMPOTENCY_KEY)).toBeUndefined();
  });

  it('keeps the same key — and the same request id — across every retry', async () => {
    const harness = createHarness([
      errorResponse(503, 'UPSTREAM_UNAVAILABLE'),
      errorResponse(401, 'SESSION_EXPIRED'),
      jsonResponse(200, { ok: true }),
    ]);

    await harness.client.post({ path: '/v1/a', body: { a: 1 } });

    for (const call of [0, 1, 2]) {
      expect(headerOf(harness.fetchMock, call, HEADER_IDEMPOTENCY_KEY)).toBe('idem-fixed');
      expect(headerOf(harness.fetchMock, call, HEADER_REQUEST_ID)).toBe('req-fixed');
    }
    // The attempt counter still distinguishes them server-side.
    expect(headerOf(harness.fetchMock, 0, 'X-Attempt')).toBe('1');
    expect(headerOf(harness.fetchMock, 1, 'X-Attempt')).toBe('2');
  });

  it('prefers a caller-supplied key so a mutation survives an app restart', async () => {
    const harness = createHarness([jsonResponse(200, {})]);

    await harness.client.post({ path: '/v1/a', body: {}, idempotencyKey: 'caller-key' });

    expect(headerOf(harness.fetchMock, 0, HEADER_IDEMPOTENCY_KEY)).toBe('caller-key');
  });
});

describe('error mapping', () => {
  it('maps the shared envelope onto AppError, preserving code and fields', async () => {
    const harness = createHarness([
      errorResponse(422, 'VALIDATION_FAILED', 'Check the highlighted fields.', {
        fields: [{ path: 'radiusMeters', message: 'Must be at least 50 metres.' }],
      }),
    ]);

    const error = (await harness.client
      .post({ path: '/v1/a', body: {} })
      .catch((e: unknown) => e)) as AppError;

    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.status).toBe(422);
    expect(error.message).toBe('Check the highlighted fields.');
    expect(error.fields).toEqual([
      { path: 'radiusMeters', message: 'Must be at least 50 metres.' },
    ]);
  });

  it('maps an authorization denial to an opaque FORBIDDEN', async () => {
    const harness = createHarness([
      errorResponse(403, 'FORBIDDEN', 'You do not have access to this resource.'),
    ]);

    const error = (await harness.client
      .get({ path: '/v1/a' })
      .catch((e: unknown) => e)) as AppError;

    expect(error.code).toBe('FORBIDDEN');
    // Nothing in the error hints at whether the target exists or merely paused.
    expect(error.message).toBe('You do not have access to this resource.');
  });

  it('falls back to a status-derived code when the body is not an envelope', async () => {
    const harness = createHarness([new Response('<html>gateway blew up</html>', { status: 502 })]);

    const error = (await harness.client
      .get({ path: '/v1/a', retry: { maxAttempts: 1 } })
      .catch((e: unknown) => e)) as AppError;

    expect(error.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(error.message).not.toContain('gateway blew up');
  });

  it('rejects a success payload that violates the response schema', async () => {
    const { z } = await import('zod');
    const harness = createHarness([jsonResponse(200, { count: 'not-a-number' })]);

    const error = (await harness.client
      .get({ path: '/v1/a', schema: z.object({ count: z.number() }) })
      .catch((e: unknown) => e)) as AppError;

    expect(error.code).toBe('INTERNAL_ERROR');
  });

  it('returns undefined for 204 without trying to parse a body', async () => {
    const harness = createHarness([new Response(null, { status: 204 })]);
    await expect(harness.client.delete({ path: '/v1/a' })).resolves.toBeUndefined();
  });

  it('propagates a caller abort verbatim instead of wrapping it', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      controller.abort();
      const error = new Error('aborted');
      error.name = 'AbortError';
      void init;
      throw error;
    });
    const client = new ApiClient({
      baseUrl: 'https://api.example.test',
      appEnv: 'development',
      getAccessToken: () => 'token-1',
      fetch: fetchMock as unknown as FetchLike,
      sleep: async () => undefined,
    });

    const error = (await client
      .get({ path: '/v1/a', signal: controller.signal })
      .catch((e: unknown) => e)) as Error;

    expect(error).not.toBeInstanceOf(AppError);
    expect(error.name).toBe('AbortError');
  });

  it('turns its own deadline into a retryable timeout', async () => {
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const error = new Error('timed out');
            error.name = 'AbortError';
            reject(error);
          });
        }),
    );
    const client = new ApiClient({
      baseUrl: 'https://api.example.test',
      appEnv: 'development',
      getAccessToken: () => 'token-1',
      fetch: fetchMock as unknown as FetchLike,
      timeoutMs: 5,
      retry: { maxAttempts: 1 },
      sleep: async () => undefined,
    });

    const error = (await client.get({ path: '/v1/a' }).catch((e: unknown) => e)) as AppError;

    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(error.message).toContain('timed out');
  });
});

describe('privacy', () => {
  it('never writes a coordinate, a token or a URL query to the logger', async () => {
    const harness = createHarness([
      errorResponse(503, 'UPSTREAM_UNAVAILABLE'),
      jsonResponse(200, { acceptedCount: 1 }),
    ]);

    await harness.client.post({
      path: '/v1/locations/batch',
      query: { since: '2026-01-01T00:00:00.000Z' },
      body: {
        deviceId: 'device-1',
        events: [{ eventId: 'e1', latitude: LAT, longitude: LNG }],
      },
    });

    const serialized = JSON.stringify(harness.logs);
    expect(serialized).not.toContain('37.774');
    expect(serialized).not.toContain('122.419');
    expect(serialized).not.toContain('token-1');
    expect(serialized).not.toContain('latitude');
    // What it does log is enough to debug with.
    expect(serialized).toContain('/v1/locations/batch');
    expect(serialized).toContain('req-fixed');
  });

  it('logs the route template, not the interpolated path', async () => {
    const harness = createHarness([jsonResponse(200, {})]);

    await harness.client.get({
      path: '/v1/families/{familyId}/locations/current',
      params: { familyId: 'fam-secret-id' },
    });

    const serialized = JSON.stringify(harness.logs);
    expect(serialized).toContain('{familyId}');
    expect(serialized).not.toContain('fam-secret-id');
    expect(harness.fetchMock.mock.calls[0]?.[0]).toBe(
      'https://api.example.test/v1/families/fam-secret-id/locations/current',
    );
  });
});

describe('backoff maths', () => {
  it('is deterministic when random() is 0.5 and jitters symmetrically otherwise', () => {
    const policy = {
      baseDelayMs: 100,
      maxDelayMs: 5_000,
      multiplier: 2,
      jitterRatio: 0.5,
      maxAttempts: 5,
    };

    expect(computeBackoffDelayMs({ attempt: 1, policy, random: () => 0.5 })).toBe(100);
    expect(computeBackoffDelayMs({ attempt: 3, policy, random: () => 0.5 })).toBe(400);
    expect(computeBackoffDelayMs({ attempt: 1, policy, random: () => 0 })).toBe(50);
    expect(computeBackoffDelayMs({ attempt: 1, policy, random: () => 1 })).toBe(150);
  });

  it('caps at maxDelayMs', () => {
    const policy = {
      baseDelayMs: 100,
      maxDelayMs: 300,
      multiplier: 10,
      jitterRatio: 0,
      maxAttempts: 9,
    };
    expect(computeBackoffDelayMs({ attempt: 6, policy, random: () => 0.5 })).toBe(300);
  });

  it('parses both Retry-After forms', () => {
    const now = Date.parse('2026-01-01T00:00:00.000Z');
    expect(parseRetryAfter('30', now)).toBe(30_000);
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:30 GMT', now)).toBe(30_000);
    expect(parseRetryAfter('nonsense', now)).toBeNull();
    expect(parseRetryAfter(null, now)).toBeNull();
  });
});
