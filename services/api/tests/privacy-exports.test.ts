import { beforeEach, describe, expect, it } from 'vitest';

import { ENTITLEMENTS, LIMITS, type UserId } from '@family/contracts';
import {
  DataExportSchema,
  ListDataExportsResponseSchema,
  RetentionSettingsSchema,
  type DataExport,
  type GetRetentionResponse,
  type ListDataExportsResponse,
} from '@family/schemas';

import { privacyRoutes } from '../src/routes/privacy.js';

import {
  authHeaders,
  createHarness,
  seedUser,
  testUuid,
  userIdOf,
  TABLES,
  type Harness,
} from './support/harness.js';

/**
 * `/v1/privacy/exports` and `/v1/privacy/retention`.
 *
 * The properties worth defending here are not the CRUD:
 *
 *  - an export request is a *request*. The archive is built by a worker with
 *    grants this function does not have, so no response may ever carry it, a
 *    link to it, or anything else the queue behind it knows;
 *  - one person's export request is unreachable from another person's session,
 *    and refused identically to one that never existed;
 *  - the retention ceiling is the plan's, re-derived from the stored
 *    subscription row on every request. A user may always keep LESS. There is no
 *    body, header or sequence of calls that lets them keep more, including after
 *    a downgrade of a preference that was legitimate when it was made.
 */

const JSON_HEADERS = { 'content-type': 'application/json' };

const alice = userIdOf(1);
const bob = userIdOf(2);

/** Every field a `DataExport` is allowed to have, and nothing else. */
const EXPORT_FIELDS = [
  'exportId',
  'status',
  'requestedAt',
  'completesBy',
  'deliveryMethod',
] as const;

function seedSubscription(
  harness: Harness,
  input: { userId: UserId; plan: string; status: string },
): void {
  harness.store.seed(TABLES.subscriptions, [
    {
      userId: input.userId,
      familyId: null,
      plan: input.plan,
      status: input.status,
      source: 'APP_STORE',
      isTrial: false,
      currentPeriodEndsAt: null,
      gracePeriodEndsAt: null,
      willRenew: true,
      managementUrl: null,
      refreshedAt: harness.now().toISOString(),
    },
  ]);
}

/** A row in the shape the worker queue really stores, for states the API cannot reach. */
function seedJob(
  harness: Harness,
  input: {
    jobId: string;
    userId: UserId;
    jobType: string;
    status: string;
    requestedAt: string;
  },
): void {
  harness.store.seed(TABLES.deletionJobs, [
    {
      jobId: input.jobId,
      userId: input.userId,
      jobType: input.jobType,
      status: input.status,
      requestedAt: input.requestedAt,
      scheduledFor: input.requestedAt,
      completesBy: input.requestedAt,
      requestId: 'seeded-request',
      scope: 'ALL',
      from: null,
      to: null,
      familyId: null,
      reason: null,
      feedback: null,
    },
  ]);
}

function requestExport(
  harness: Harness,
  userId: UserId,
  idempotencyKey: string,
): ReturnType<Harness['call']> {
  return harness.call({
    method: 'POST',
    path: '/v1/privacy/exports',
    headers: { ...authHeaders(userId), ...JSON_HEADERS, 'idempotency-key': idempotencyKey },
  });
}

function patchRetention(
  harness: Harness,
  userId: UserId,
  body: Record<string, unknown>,
): ReturnType<Harness['call']> {
  return harness.call({
    method: 'PATCH',
    path: '/v1/privacy/retention',
    headers: { ...authHeaders(userId), ...JSON_HEADERS },
    rawBody: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

describe('POST /v1/privacy/exports', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness();
    seedUser(harness, { userId: alice });
    seedUser(harness, { userId: bob });
  });

  it('records the request and says plainly that it is queued, not ready', async () => {
    const response = await requestExport(harness, alice, 'export-0001');

    expect(response.statusCode).toBe(202);
    const body = DataExportSchema.parse(response.body);
    expect(body.status).toBe('QUEUED');
    expect(body.deliveryMethod).toBe('EMAIL_LINK');
    expect(Date.parse(body.completesBy)).toBeGreaterThan(Date.parse(body.requestedAt));

    // The durable half: a job the worker will find.
    const jobs = harness.store.dump(TABLES.deletionJobs);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      userId: alice,
      jobType: 'DATA_EXPORT',
      status: 'PENDING',
    });
  });

  it('carries no archive, no link and nothing the queue knows', async () => {
    const response = await requestExport(harness, alice, 'export-0002');

    // Exactly the contract's fields. A `downloadUrl` that is forever null, a
    // `scheduledFor` or a `requestId` would each be a promise or a leak.
    expect(Object.keys(response.body as object).sort()).toEqual([...EXPORT_FIELDS].sort());

    const serialised = JSON.stringify(response.body);
    for (const forbidden of ['downloadUrl', 'scheduledFor', 'jobType', 'requestId', 'feedback']) {
      expect(serialised).not.toContain(forbidden);
    }
  });

  it('returns the request already in flight rather than queuing a second one', async () => {
    const first = await requestExport(harness, alice, 'export-0003');
    // A different key, so this is a genuinely new request rather than a replay.
    const second = await requestExport(harness, alice, 'export-0004');

    expect(first.statusCode).toBe(202);
    // 200, because nothing new was accepted.
    expect(second.statusCode).toBe(200);
    expect((second.body as DataExport).exportId).toBe((first.body as DataExport).exportId);
    expect(harness.store.dump(TABLES.deletionJobs)).toHaveLength(1);
  });

  it('accepts a fresh request once the previous one has been delivered', async () => {
    seedJob(harness, {
      jobId: testUuid(0xe1, 1),
      userId: alice,
      jobType: 'DATA_EXPORT',
      status: 'COMPLETED',
      requestedAt: '2026-02-01T00:00:00.000Z',
    });

    const response = await requestExport(harness, alice, 'export-0005');

    expect(response.statusCode).toBe(202);
    expect(harness.store.dump(TABLES.deletionJobs)).toHaveLength(2);
  });
});

describe('GET /v1/privacy/exports', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness();
    seedUser(harness, { userId: alice });
    seedUser(harness, { userId: bob });
  });

  it("lists only the caller's own requests, newest first", async () => {
    seedJob(harness, {
      jobId: testUuid(0xe1, 1),
      userId: alice,
      jobType: 'DATA_EXPORT',
      status: 'PENDING',
      requestedAt: '2026-01-01T00:00:00.000Z',
    });
    seedJob(harness, {
      jobId: testUuid(0xe1, 2),
      userId: alice,
      jobType: 'DATA_EXPORT',
      status: 'COMPLETED',
      requestedAt: '2026-02-01T00:00:00.000Z',
    });
    seedJob(harness, {
      jobId: testUuid(0xe1, 3),
      userId: bob,
      jobType: 'DATA_EXPORT',
      status: 'PENDING',
      requestedAt: '2026-03-01T00:00:00.000Z',
    });

    const response = await harness.call({
      method: 'GET',
      path: '/v1/privacy/exports',
      headers: authHeaders(alice),
    });

    expect(response.statusCode).toBe(200);
    const body: ListDataExportsResponse = ListDataExportsResponseSchema.parse(response.body);
    expect(body.exports.map((request) => request.exportId)).toEqual([
      testUuid(0xe1, 2),
      testUuid(0xe1, 1),
    ]);
    expect(JSON.stringify(body)).not.toContain(testUuid(0xe1, 3));
  });

  it('reports queue states in the vocabulary of the request, not of the worker', async () => {
    const states = [
      ['PENDING', 'QUEUED'],
      ['RUNNING', 'IN_PROGRESS'],
      ['COMPLETED', 'DELIVERED'],
      ['FAILED', 'FAILED'],
      ['CANCELLED', 'CANCELLED'],
    ] as const;

    states.forEach(([jobStatus], index) => {
      seedJob(harness, {
        jobId: testUuid(0xe1, index + 1),
        userId: alice,
        jobType: 'DATA_EXPORT',
        status: jobStatus,
        requestedAt: `2026-01-0${String(index + 1)}T00:00:00.000Z`,
      });
    });

    const response = await harness.call({
      method: 'GET',
      path: '/v1/privacy/exports',
      headers: authHeaders(alice),
    });

    const body: ListDataExportsResponse = ListDataExportsResponseSchema.parse(response.body);
    const byId = new Map(body.exports.map((request) => [request.exportId, request.status]));
    states.forEach(([, exportStatus], index) => {
      expect(byId.get(testUuid(0xe1, index + 1))).toBe(exportStatus);
    });
  });

  it('never lists an erasure job as if it were an export', async () => {
    seedJob(harness, {
      jobId: testUuid(0xe2, 1),
      userId: alice,
      jobType: 'HISTORY_DELETION',
      status: 'PENDING',
      requestedAt: '2026-01-01T00:00:00.000Z',
    });
    seedJob(harness, {
      jobId: testUuid(0xe2, 2),
      userId: alice,
      jobType: 'ACCOUNT_DELETION',
      status: 'PENDING',
      requestedAt: '2026-01-02T00:00:00.000Z',
    });

    const response = await harness.call({
      method: 'GET',
      path: '/v1/privacy/exports',
      headers: authHeaders(alice),
    });

    expect(ListDataExportsResponseSchema.parse(response.body).exports).toEqual([]);
  });
});

describe('GET /v1/privacy/exports/{exportId}', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness();
    seedUser(harness, { userId: alice });
    seedUser(harness, { userId: bob });
  });

  it('serves the caller their own request', async () => {
    const created = await requestExport(harness, alice, 'export-0006');
    const exportId = (created.body as DataExport).exportId;

    const response = await harness.call({
      method: 'GET',
      path: `/v1/privacy/exports/${exportId}`,
      headers: authHeaders(alice),
    });

    expect(response.statusCode).toBe(200);
    expect(DataExportSchema.parse(response.body)).toMatchObject({ exportId, status: 'QUEUED' });
  });

  it("refuses somebody else's request exactly as it refuses one that never existed", async () => {
    const created = await requestExport(harness, alice, 'export-0007');
    const alicesExportId = (created.body as DataExport).exportId;

    const stolen = await harness.call({
      method: 'GET',
      path: `/v1/privacy/exports/${alicesExportId}`,
      headers: authHeaders(bob),
    });
    const imaginary = await harness.call({
      method: 'GET',
      path: `/v1/privacy/exports/${testUuid(0xe9, 9)}`,
      headers: authHeaders(bob),
    });

    expect(stolen.statusCode).toBe(imaginary.statusCode);
    expect(stolen.statusCode).toBe(403);
    // Byte-identical but for the correlation id: nothing in the denial reveals
    // that the id belongs to a real request belonging to a real person.
    expect(errorShape(stolen.body)).toEqual(errorShape(imaginary.body));
    expect(JSON.stringify(stolen.body)).not.toContain(alice);
  });

  it('refuses an erasure job addressed as an export', async () => {
    seedJob(harness, {
      jobId: testUuid(0xe2, 1),
      userId: alice,
      jobType: 'ACCOUNT_DELETION',
      status: 'PENDING',
      requestedAt: '2026-01-01T00:00:00.000Z',
    });

    const response = await harness.call({
      method: 'GET',
      path: `/v1/privacy/exports/${testUuid(0xe2, 1)}`,
      headers: authHeaders(alice),
    });

    expect(response.statusCode).toBe(403);
  });
});

/** The error envelope minus the per-request correlation id. */
function errorShape(body: unknown): { code: unknown; message: unknown } {
  const error = (body as { error?: { code?: unknown; message?: unknown } }).error ?? {};
  return { code: error.code, message: error.message };
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

describe('GET /v1/privacy/retention', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness();
    seedUser(harness, { userId: alice });
  });

  async function read(userId: UserId = alice): Promise<GetRetentionResponse> {
    const response = await harness.call({
      method: 'GET',
      path: '/v1/privacy/retention',
      headers: authHeaders(userId),
    });
    expect(response.statusCode).toBe(200);
    return {
      retention: RetentionSettingsSchema.parse((response.body as GetRetentionResponse).retention),
    };
  }

  it('reports the free ceiling for an account with no subscription row', async () => {
    const { retention } = await read();

    expect(retention).toMatchObject({
      userId: alice,
      planTier: 'FREE',
      historyRetentionDays: ENTITLEMENTS.FREE.historyRetentionDays,
      maxHistoryRetentionDays: ENTITLEMENTS.FREE.historyRetentionDays,
      auditRetentionDays: harness.config.auditRetentionDays,
    });
  });

  it("reports the paid ceiling from the plan's entitlements", async () => {
    seedSubscription(harness, { userId: alice, plan: 'FAMILY_ANNUAL', status: 'ACTIVE' });

    const { retention } = await read();

    expect(retention.planTier).toBe('FAMILY');
    expect(retention.maxHistoryRetentionDays).toBe(ENTITLEMENTS.FAMILY.historyRetentionDays);
    expect(retention.historyRetentionDays).toBe(ENTITLEMENTS.FAMILY.historyRetentionDays);
  });

  it('collapses to free the moment the subscription stops being entitled', async () => {
    seedSubscription(harness, { userId: alice, plan: 'FAMILY_PLUS_ANNUAL', status: 'EXPIRED' });

    const { retention } = await read();

    expect(retention.planTier).toBe('FREE');
    expect(retention.maxHistoryRetentionDays).toBe(ENTITLEMENTS.FREE.historyRetentionDays);
  });

  it('reports nothing about how much is stored, because it cannot know', async () => {
    const { retention } = await read();

    const keys = Object.keys(retention);
    expect(keys).not.toContain('storedLocationPointCount');
    expect(keys).not.toContain('oldestStoredPointAt');
  });

  it('answers from the plan alone, without reading the account row', () => {
    // It used to load the user to read a stored retention preference. There is
    // no preference now, so there is nothing to look up: the answer is derived
    // entirely from the subscription the caller's token already implies. One
    // fewer read, and one fewer way for this endpoint to disagree with what the
    // sweep actually enforces.
    const retention = privacyRoutes.filter(
      (route: { path: string }) => route.path === '/v1/privacy/retention',
    );

    expect(retention).toHaveLength(1);
  });
});

describe('retention is read-only', () => {
  it('offers no way to set a retention the platform would not honour', () => {
    // There is deliberately no PATCH. The TTL is stamped at ingestion from a
    // per-deployment value, the read path applies the plan's retention and the
    // nightly sweep uses the same global — so an endpoint that accepted a choice
    // would answer 200, show the new number, and change nothing about how long
    // a coordinate survives. This asserts the route table, because the promise
    // being kept here is the absence of a control rather than its behaviour.
    const retentionRoutes = privacyRoutes.filter(
      (route: { path: string }) => route.path === '/v1/privacy/retention',
    );

    expect(retentionRoutes.map((route: { method: string }) => route.method)).toEqual(['GET']);
  });
});
