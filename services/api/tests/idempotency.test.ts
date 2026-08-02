import { beforeEach, describe, expect, it } from 'vitest';

import { ApiErrorSchema } from '@family/contracts';

import { REPLAY_HEADER } from '../src/middleware/idempotency.js';

import {
  authHeaders,
  createHarness,
  deviceIdOf,
  seedUser,
  userIdOf,
  type Harness,
} from './support/harness.js';

/**
 * Idempotency is what makes "retry on timeout" safe for a mobile client on a
 * flaky connection. These tests run against the in-memory DynamoDB fake, which
 * really evaluates `attribute_not_exists`, so the claim is genuinely conditional
 * rather than a stub that always says yes.
 */

const JSON_HEADERS = { 'content-type': 'application/json' };

function registerBody(deviceId: string): string {
  return JSON.stringify({
    deviceId,
    platform: 'IOS',
    osVersion: '18.2',
    appVersion: '1.0.0',
    appBuild: '100',
    modelIdentifier: 'iPhone16,2',
    locale: 'en',
    timeZone: 'Europe/London',
  });
}

describe('idempotency', () => {
  let harness: Harness;
  const user = userIdOf(1);
  const other = userIdOf(2);
  const device = deviceIdOf(1);

  beforeEach(() => {
    harness = createHarness();
    seedUser(harness, { userId: user });
    seedUser(harness, { userId: other });
  });

  it('requires a key on a route that declares one', async () => {
    const response = await harness.call({
      method: 'POST',
      path: '/v1/devices',
      headers: { ...authHeaders(user), ...JSON_HEADERS },
      rawBody: registerBody(device),
    });

    expect(response.statusCode).toBe(422);
    const envelope = ApiErrorSchema.parse(response.body);
    expect(envelope.error.fields?.map((field) => field.path)).toContain('idempotency-key');
  });

  it('replays the stored response for a repeated key', async () => {
    const headers = {
      ...authHeaders(user),
      ...JSON_HEADERS,
      'idempotency-key': 'client-key-0001',
    };

    const first = await harness.call({
      method: 'POST',
      path: '/v1/devices',
      headers,
      rawBody: registerBody(device),
    });
    const second = await harness.call({
      method: 'POST',
      path: '/v1/devices',
      headers,
      rawBody: registerBody(device),
    });

    expect(first.statusCode).toBe(201);
    expect(first.headers[REPLAY_HEADER]).toBeUndefined();

    expect(second.statusCode).toBe(201);
    expect(second.headers[REPLAY_HEADER]).toBe('true');
    // Byte-identical, not merely equivalent: the replay is the stored response,
    // not the handler running a second time.
    expect(second.body).toEqual(first.body);

    // And the effect happened exactly once.
    expect(harness.store.size('Devices')).toBe(1);
  });

  it('rejects the same key used for a different request', async () => {
    const headers = {
      ...authHeaders(user),
      ...JSON_HEADERS,
      'idempotency-key': 'client-key-0002',
    };

    await harness.call({
      method: 'POST',
      path: '/v1/devices',
      headers,
      rawBody: registerBody(device),
    });
    const conflicting = await harness.call({
      method: 'POST',
      path: '/v1/devices',
      headers,
      rawBody: registerBody(deviceIdOf(2)),
    });

    expect(conflicting.statusCode).toBe(409);
    expect(ApiErrorSchema.parse(conflicting.body).error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(harness.store.size('Devices')).toBe(1);
  });

  it('scopes keys to the caller, so two users may pick the same one', async () => {
    const key = 'shared-client-key';

    const first = await harness.call({
      method: 'POST',
      path: '/v1/devices',
      headers: { ...authHeaders(user), ...JSON_HEADERS, 'idempotency-key': key },
      rawBody: registerBody(device),
    });
    const second = await harness.call({
      method: 'POST',
      path: '/v1/devices',
      headers: { ...authHeaders(other), ...JSON_HEADERS, 'idempotency-key': key },
      rawBody: registerBody(deviceIdOf(2)),
    });

    expect(first.statusCode).toBe(201);
    // Not a conflict and not a replay: the other user's key is a different key.
    expect(second.statusCode).toBe(201);
    expect(second.headers[REPLAY_HEADER]).toBeUndefined();
    expect(harness.store.size('Devices')).toBe(2);
  });

  it('frees the key when the request fails, so a corrected retry works', async () => {
    const headers = {
      ...authHeaders(user),
      ...JSON_HEADERS,
      'idempotency-key': 'client-key-0003',
    };

    const failed = await harness.call({
      method: 'POST',
      path: '/v1/devices',
      headers,
      rawBody: JSON.stringify({ deviceId: device, platform: 'IOS' }),
    });
    expect(failed.statusCode).toBe(422);

    const retried = await harness.call({
      method: 'POST',
      path: '/v1/devices',
      headers,
      rawBody: registerBody(device),
    });

    expect(retried.statusCode).toBe(201);
    expect(retried.headers[REPLAY_HEADER]).toBeUndefined();
  });

  it('rejects a malformed idempotency key', async () => {
    const response = await harness.call({
      method: 'POST',
      path: '/v1/devices',
      headers: { ...authHeaders(user), ...JSON_HEADERS, 'idempotency-key': 'has spaces' },
      rawBody: registerBody(device),
    });

    expect(response.statusCode).toBe(422);
    expect(ApiErrorSchema.parse(response.body).error.code).toBe('VALIDATION_FAILED');
  });

  it('answers a request that is still in flight with a conflict', async () => {
    const key = `${user}#client-key-0004`;
    await harness.services.idempotency.claim({
      key,
      fingerprint: 'irrelevant',
      now: harness.now(),
    });

    const claim = await harness.services.idempotency.claim({
      key,
      fingerprint: 'irrelevant',
      now: harness.now(),
    });

    expect(claim.outcome).toBe('EXISTS');
    if (claim.outcome !== 'EXISTS') return;
    expect(claim.record.status).toBe('IN_PROGRESS');
  });
});
