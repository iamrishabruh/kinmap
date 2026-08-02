import { beforeEach, describe, expect, it } from 'vitest';

import { ApiErrorSchema, LIMITS } from '@family/contracts';

import { authHeaders, createHarness, seedUser, userIdOf, type Harness } from './support/harness.js';

/**
 * End-to-end pipeline behaviour: one error envelope for everything, the payload
 * ceiling, and the correlation id that ties a user's complaint to a log line
 * without either of them describing what was being looked at.
 */

const JSON_HEADERS = { 'content-type': 'application/json' };

describe('error envelope', () => {
  let harness: Harness;
  const user = userIdOf(1);

  beforeEach(() => {
    harness = createHarness();
    seedUser(harness, { userId: user });
  });

  it('answers an unknown endpoint with the standard envelope', async () => {
    const response = await harness.call({
      method: 'GET',
      path: '/v1/does-not-exist',
      headers: authHeaders(user),
    });

    expect(response.statusCode).toBe(404);
    const envelope = ApiErrorSchema.parse(response.body);
    expect(envelope.error.code).toBe('NOT_FOUND');
    expect(envelope.error.requestId).toBe('gateway-request-id');
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('does not distinguish a wrong method from an unknown path', async () => {
    const unknownPath = await harness.call({
      method: 'GET',
      path: '/v1/nope',
      headers: authHeaders(user),
    });
    const wrongMethod = await harness.call({
      method: 'POST',
      path: '/v1/account',
      headers: { ...authHeaders(user), ...JSON_HEADERS },
      rawBody: '{}',
    });

    expect(wrongMethod.statusCode).toBe(unknownPath.statusCode);
    expect(ApiErrorSchema.parse(wrongMethod.body).error.code).toBe(
      ApiErrorSchema.parse(unknownPath.body).error.code,
    );
  });

  it('rejects a request with no bearer token', async () => {
    const response = await harness.call({ method: 'GET', path: '/v1/account' });

    expect(response.statusCode).toBe(401);
    expect(ApiErrorSchema.parse(response.body).error.code).toBe('UNAUTHENTICATED');
  });

  it('echoes a well-formed client request id', async () => {
    const response = await harness.call({
      method: 'GET',
      path: '/v1/account',
      headers: { ...authHeaders(user), 'x-request-id': 'client-supplied-id' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['x-request-id']).toBe('client-supplied-id');
  });

  it('reports validation failures with field paths and no echoed values', async () => {
    const response = await harness.call({
      method: 'PATCH',
      path: '/v1/account',
      headers: { ...authHeaders(user), ...JSON_HEADERS },
      rawBody: JSON.stringify({ locale: 'not-a-locale', unexpected: 'field' }),
    });

    expect(response.statusCode).toBe(422);
    const envelope = ApiErrorSchema.parse(response.body);
    expect(envelope.error.code).toBe('VALIDATION_FAILED');
    expect(envelope.error.fields?.map((field) => field.path)).toContain('unexpected');
    // The offending value never appears in the response.
    expect(JSON.stringify(envelope)).not.toContain('not-a-locale');
  });
});

describe('body handling', () => {
  let harness: Harness;
  const user = userIdOf(2);

  beforeEach(() => {
    harness = createHarness();
    seedUser(harness, { userId: user });
  });

  it('rejects a body larger than the platform ceiling before parsing it', async () => {
    // Deliberately not valid JSON: if this were parsed at all the failure would
    // be VALIDATION_FAILED, so the assertion proves the size check runs first.
    const oversized = 'x'.repeat(LIMITS.MAX_BATCH_PAYLOAD_BYTES + 1);

    const response = await harness.call({
      method: 'PATCH',
      path: '/v1/account',
      headers: { ...authHeaders(user), ...JSON_HEADERS },
      rawBody: oversized,
    });

    expect(response.statusCode).toBe(413);
    expect(ApiErrorSchema.parse(response.body).error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('measures the ceiling in bytes rather than characters', async () => {
    // Two-byte characters: half as many of them still exceeds the byte ceiling.
    const multiByte = 'é'.repeat(LIMITS.MAX_BATCH_PAYLOAD_BYTES / 2 + 1);

    const response = await harness.call({
      method: 'PATCH',
      path: '/v1/account',
      headers: { ...authHeaders(user), ...JSON_HEADERS },
      rawBody: multiByte,
    });

    expect(response.statusCode).toBe(413);
  });

  it('accepts a body exactly at the ceiling', async () => {
    const padding = 'a'.repeat(LIMITS.MAX_BATCH_PAYLOAD_BYTES - '{"displayName":""}'.length);
    const body = JSON.stringify({ displayName: padding });

    const response = await harness.call({
      method: 'PATCH',
      path: '/v1/account',
      headers: { ...authHeaders(user), ...JSON_HEADERS },
      rawBody: body,
    });

    // Too long for the display-name schema, but it got past the size gate —
    // which is the distinction being asserted.
    expect(response.statusCode).toBe(422);
  });

  it('turns malformed JSON into a validation failure, not a crash', async () => {
    const response = await harness.call({
      method: 'PATCH',
      path: '/v1/account',
      headers: { ...authHeaders(user), ...JSON_HEADERS },
      rawBody: '{"displayName": ',
    });

    expect(response.statusCode).toBe(422);
    expect(ApiErrorSchema.parse(response.body).error.code).toBe('VALIDATION_FAILED');
  });
});
