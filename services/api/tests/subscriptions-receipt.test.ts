import { beforeEach, describe, expect, it } from 'vitest';

import { ApiErrorSchema, type UserId } from '@family/contracts';
import { EntitlementsResponseSchema } from '@family/schemas';
import { InMemoryDocumentClient } from '@family/test-utils';

import { createPipeline } from '../src/pipeline.js';
import type { Item } from '../src/repositories/document-client.js';
import { createSubscriptionsRepository } from '../src/repositories/subscriptions.js';
import { createRouter } from '../src/router.js';
import { routes } from '../src/routes/index.js';
import type { ApiServices } from '../src/services.js';
import type { HttpMethod, HttpRequest } from '../src/types.js';

import {
  authHeaders,
  createFakeDocumentClient,
  createFakeVerifier,
  createHarness,
  userIdOf,
  TABLES,
} from './support/harness.js';

/**
 * `POST /v1/subscriptions/receipt`.
 *
 * The endpoint exists so a client does not have to wait for the provider's
 * webhook after a purchase, and the property under test is that waiting is still
 * exactly what happens: the receipt is parked for the worker that holds the
 * store credentials, and the body that comes back is derived from the stored
 * subscription row. Submitting a receipt for the most expensive plan in the
 * catalogue must not move a single entitlement.
 */

/**
 * The hand-off table, which the shared harness does not know about yet. These
 * tests build their own store for the two subscription tables and reuse the
 * harness for everything else — the same repositories, middleware and route
 * table the function runs.
 */
const RECEIPTS_TABLE = 'SubscriptionReceipts';

const JSON_HEADERS = { 'content-type': 'application/json' };

/** Long enough to satisfy the schema, and obvious in a diff if it ever leaks. */
const RECEIPT = 'MIIT-fake-app-store-receipt-payload-0000000001';
const OTHER_RECEIPT = 'MIIT-fake-app-store-receipt-payload-0000000002';

function submitBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    platform: 'IOS',
    receipt: RECEIPT,
    productId: 'com.kinmap.familyplus.annual',
    ...overrides,
  });
}

type Fixture = {
  readonly store: InMemoryDocumentClient;
  readonly logs: readonly unknown[];
  advance(ms: number): void;
  now(): Date;
  seedSubscription(input: { userId: UserId; plan: string; status: string }): void;
  receipts(): Item[];
  call(input: Partial<HttpRequest> & { method: HttpMethod; path: string }): Promise<{
    statusCode: number;
    headers: Record<string, string>;
    body: unknown;
  }>;
};

function createFixture(options: { receiptsWired?: boolean } = {}): Fixture {
  const base = createHarness();
  const store = new InMemoryDocumentClient([
    {
      name: TABLES.subscriptions,
      keySchema: { partitionKey: 'userId' },
      indexes: { byFamily: { partitionKey: 'familyId', sortKey: 'userId' } },
    },
    {
      name: RECEIPTS_TABLE,
      keySchema: { partitionKey: 'userId', sortKey: 'receiptFingerprint' },
      indexes: { byStatus: { partitionKey: 'status', sortKey: 'submittedAt' } },
    },
  ]);
  const client = createFakeDocumentClient(store);

  const services: ApiServices = {
    ...base.services,
    subscriptions: createSubscriptionsRepository(
      client,
      TABLES.subscriptions,
      options.receiptsWired === false ? null : RECEIPTS_TABLE,
    ),
  };
  const pipeline = createPipeline({
    router: createRouter(routes),
    services,
    logger: base.logger,
    verifier: createFakeVerifier(),
  });

  return {
    store,
    logs: base.logs,
    advance: (ms) => {
      base.advance(ms);
    },
    now: () => base.now(),
    seedSubscription(input) {
      store.seed(TABLES.subscriptions, [
        {
          userId: input.userId,
          familyId: null,
          plan: input.plan,
          status: input.status,
          source: 'APP_STORE',
          isTrial: false,
          currentPeriodEndsAt: null,
          gracePeriodEndsAt: null,
          willRenew: false,
          managementUrl: null,
          refreshedAt: base.now().toISOString(),
        },
      ]);
    },
    receipts: () => store.dump(RECEIPTS_TABLE),
    async call(input) {
      const response = await pipeline(base.request(input));
      return {
        statusCode: response.statusCode,
        headers: response.headers,
        body: response.body === '' ? null : (JSON.parse(response.body) as unknown),
      };
    },
  };
}

function headersFor(userId: UserId, key: string): Record<string, string> {
  return { ...authHeaders(userId), ...JSON_HEADERS, 'idempotency-key': key };
}

describe('POST /v1/subscriptions/receipt', () => {
  let fixture: Fixture;
  const user = userIdOf(1);
  const other = userIdOf(2);

  beforeEach(() => {
    fixture = createFixture();
  });

  it('parks the receipt and answers with the entitlements the server derives', async () => {
    const response = await fixture.call({
      method: 'POST',
      path: '/v1/subscriptions/receipt',
      headers: headersFor(user, 'receipt-key-0001'),
      rawBody: submitBody(),
    });

    // Accepted for verification, not verified.
    expect(response.statusCode).toBe(202);
    const body = EntitlementsResponseSchema.parse(response.body);
    expect(body.userId).toBe(user);
    // The client just presented a receipt for the top plan. It changed nothing.
    expect(body.plan).toBe('FREE');
    expect(body.tier).toBe('FREE');
    expect(body.entitlements.liveSessionsEnabled).toBe(false);
    expect(body.entitlements.historyRetentionDays).toBe(0);

    const [row] = fixture.receipts();
    expect(fixture.receipts()).toHaveLength(1);
    expect(row?.userId).toBe(user);
    expect(row?.status).toBe('PENDING');
    expect(row?.platform).toBe('IOS');
    expect(row?.productId).toBe('com.kinmap.familyplus.annual');
    expect(row?.submittedAt).toBe(fixture.now().toISOString());
    // Keyed by the receipt's digest, so the sort key is never the credential.
    expect(row?.receiptFingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(row?.receiptFingerprint).not.toBe(RECEIPT);
    // TTL'd: a store credential does not outlive the verification it is for.
    expect(typeof row?.expiresAt).toBe('number');
    expect(Number(row?.expiresAt)).toBeGreaterThan(Math.floor(fixture.now().getTime() / 1000));
  });

  it('re-derives from the stored row, so an expired subscription stays expired', async () => {
    fixture.seedSubscription({ userId: user, plan: 'FAMILY_PLUS_ANNUAL', status: 'EXPIRED' });

    const response = await fixture.call({
      method: 'POST',
      path: '/v1/subscriptions/receipt',
      headers: headersFor(user, 'receipt-key-0002'),
      rawBody: submitBody(),
    });

    expect(response.statusCode).toBe(202);
    const body = EntitlementsResponseSchema.parse(response.body);
    // The row's plan is reported as-is, but the tier collapses to FREE because
    // the status is not an entitled one — and the receipt does not override it.
    expect(body.plan).toBe('FAMILY_PLUS_ANNUAL');
    expect(body.tier).toBe('FREE');
    expect(body.entitlements.prioritySupport).toBe(false);
  });

  it('reports an entitlement the worker has already granted', async () => {
    fixture.seedSubscription({ userId: user, plan: 'FAMILY_ANNUAL', status: 'ACTIVE' });

    const response = await fixture.call({
      method: 'POST',
      path: '/v1/subscriptions/receipt',
      headers: headersFor(user, 'receipt-key-0003'),
      rawBody: submitBody(),
    });

    const body = EntitlementsResponseSchema.parse(response.body);
    expect(body.tier).toBe('FAMILY');
    expect(body.entitlements.liveSessionsEnabled).toBe(true);
  });

  it('keeps the receipt out of the response and out of every log line', async () => {
    const response = await fixture.call({
      method: 'POST',
      path: '/v1/subscriptions/receipt',
      headers: headersFor(user, 'receipt-key-0004'),
      rawBody: submitBody(),
    });

    expect(JSON.stringify(response.body)).not.toContain(RECEIPT);
    expect(JSON.stringify(fixture.logs)).not.toContain(RECEIPT);
    // Not even the digest, which is still derived from a credential.
    const fingerprint = String(fixture.receipts()[0]?.receiptFingerprint);
    expect(JSON.stringify(fixture.logs)).not.toContain(fingerprint);
    // The row is the one place it lives, because the worker has to read it.
    expect(fixture.receipts()[0]?.receipt).toBe(RECEIPT);
  });

  it('deduplicates on the receipt itself, not on the idempotency key', async () => {
    const first = await fixture.call({
      method: 'POST',
      path: '/v1/subscriptions/receipt',
      headers: headersFor(user, 'receipt-key-0005'),
      rawBody: submitBody(),
    });
    const submittedAt = fixture.now().toISOString();

    // A client that resubmits on every launch picks a fresh key each time.
    fixture.advance(60_000);
    const second = await fixture.call({
      method: 'POST',
      path: '/v1/subscriptions/receipt',
      headers: headersFor(user, 'receipt-key-0006'),
      rawBody: submitBody(),
    });

    expect(first.statusCode).toBe(202);
    // Indistinguishable from the first: the caller learns nothing about what the
    // worker is already holding.
    expect(second.statusCode).toBe(202);
    expect(fixture.receipts()).toHaveLength(1);
    // Still queued at its original position; a resubmission cannot re-order the
    // worker's sweep.
    expect(fixture.receipts()[0]?.submittedAt).toBe(submittedAt);
  });

  it('re-arms a receipt the worker has already ruled on', async () => {
    await fixture.call({
      method: 'POST',
      path: '/v1/subscriptions/receipt',
      headers: headersFor(user, 'receipt-key-0016'),
      rawBody: submitBody(),
    });

    // The worker verified it and rejected it — a sandbox receipt, say.
    const [ruled] = fixture.receipts();
    fixture.store.seed(RECEIPTS_TABLE, [{ ...ruled, status: 'REJECTED' }]);

    fixture.advance(60_000);
    const resubmitted = await fixture.call({
      method: 'POST',
      path: '/v1/subscriptions/receipt',
      headers: headersFor(user, 'receipt-key-0017'),
      rawBody: submitBody(),
    });

    expect(resubmitted.statusCode).toBe(202);
    // Queued again rather than left rejected forever: a store can change its
    // mind, and the client is entitled to ask again.
    expect(fixture.receipts()).toHaveLength(1);
    expect(fixture.receipts()[0]?.status).toBe('PENDING');
    expect(fixture.receipts()[0]?.submittedAt).toBe(fixture.now().toISOString());
  });

  it('treats a different receipt from the same user as a second submission', async () => {
    await fixture.call({
      method: 'POST',
      path: '/v1/subscriptions/receipt',
      headers: headersFor(user, 'receipt-key-0007'),
      rawBody: submitBody(),
    });
    await fixture.call({
      method: 'POST',
      path: '/v1/subscriptions/receipt',
      headers: headersFor(user, 'receipt-key-0008'),
      rawBody: submitBody({ receipt: OTHER_RECEIPT }),
    });

    expect(fixture.receipts()).toHaveLength(2);
  });

  it('keys submissions by the caller, so one account cannot touch another', async () => {
    await fixture.call({
      method: 'POST',
      path: '/v1/subscriptions/receipt',
      headers: headersFor(user, 'receipt-key-0009'),
      rawBody: submitBody(),
    });
    await fixture.call({
      method: 'POST',
      path: '/v1/subscriptions/receipt',
      headers: headersFor(other, 'receipt-key-0010'),
      rawBody: submitBody(),
    });

    const owners = fixture.receipts().map((row) => row['userId']);
    expect(owners).toHaveLength(2);
    expect(new Set(owners)).toEqual(new Set([user, other]));
  });

  it('requires an idempotency key, like every other mutation here', async () => {
    const response = await fixture.call({
      method: 'POST',
      path: '/v1/subscriptions/receipt',
      headers: { ...authHeaders(user), ...JSON_HEADERS },
      rawBody: submitBody(),
    });

    expect(response.statusCode).toBe(422);
    const envelope = ApiErrorSchema.parse(response.body);
    expect(envelope.error.fields?.map((field) => field.path)).toContain('idempotency-key');
    expect(fixture.receipts()).toHaveLength(0);
  });

  it('rejects an unauthenticated submission before it reaches the table', async () => {
    const response = await fixture.call({
      method: 'POST',
      path: '/v1/subscriptions/receipt',
      headers: { ...JSON_HEADERS, 'idempotency-key': 'receipt-key-0011' },
      rawBody: submitBody(),
    });

    expect(response.statusCode).toBe(401);
    expect(fixture.receipts()).toHaveLength(0);
  });

  it('rejects a malformed body without recording anything', async () => {
    const short = await fixture.call({
      method: 'POST',
      path: '/v1/subscriptions/receipt',
      headers: headersFor(user, 'receipt-key-0012'),
      rawBody: submitBody({ receipt: 'too-short' }),
    });
    const unknownPlatform = await fixture.call({
      method: 'POST',
      path: '/v1/subscriptions/receipt',
      headers: headersFor(user, 'receipt-key-0013'),
      rawBody: submitBody({ platform: 'WINDOWS_PHONE' }),
    });
    const extraField = await fixture.call({
      method: 'POST',
      path: '/v1/subscriptions/receipt',
      headers: headersFor(user, 'receipt-key-0014'),
      // A client may not smuggle in the plan it would like to have.
      rawBody: submitBody({ plan: 'FAMILY_PLUS_ANNUAL' }),
    });

    for (const response of [short, unknownPlatform, extraField]) {
      expect(response.statusCode).toBe(422);
      expect(ApiErrorSchema.parse(response.body).error.code).toBe('VALIDATION_FAILED');
    }
    expect(fixture.receipts()).toHaveLength(0);
    // And nothing echoed the value back.
    expect(JSON.stringify(short.body)).not.toContain('too-short');
  });

  it('fails closed when the hand-off table is not configured', async () => {
    const unwired = createFixture({ receiptsWired: false });

    const response = await unwired.call({
      method: 'POST',
      path: '/v1/subscriptions/receipt',
      headers: headersFor(user, 'receipt-key-0015'),
      rawBody: submitBody(),
    });

    // Never a 202 for a receipt nobody will ever verify.
    expect(response.statusCode).toBe(503);
    expect(ApiErrorSchema.parse(response.body).error.code).toBe('UPSTREAM_UNAVAILABLE');
  });

  it('leaves the entitlements read alone', async () => {
    fixture.seedSubscription({ userId: user, plan: 'FAMILY_MONTHLY', status: 'ACTIVE' });

    const response = await fixture.call({
      method: 'GET',
      path: '/v1/subscriptions/entitlements',
      headers: authHeaders(user),
    });

    expect(response.statusCode).toBe(200);
    expect(EntitlementsResponseSchema.parse(response.body).tier).toBe('FAMILY');
  });
});
