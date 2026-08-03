import { beforeEach, describe, expect, it } from 'vitest';

import { ApiErrorSchema, LIMITS, type FamilyId, type UserId } from '@family/contracts';
import {
  AcceptLiveSessionResponseSchema,
  CreateLiveSessionResponseSchema,
  ListLiveSessionsResponseSchema,
  RejectLiveSessionResponseSchema,
  StopLiveSessionResponseSchema,
  type LiveSession,
} from '@family/schemas';
import { InMemoryDocumentClient, type Item, type TableDefinition } from '@family/test-utils';

import { createPipeline } from '../src/pipeline.js';
import {
  createLiveSessionsRepository,
  type LiveSessionServices,
} from '../src/repositories/live-sessions.js';
import { createRouter } from '../src/router.js';
import { liveSessionRoutes } from '../src/routes/live-sessions.js';
import type { ApiServices } from '../src/services.js';
import type { HttpMethod, HttpRequest } from '../src/types.js';

import {
  authHeaders,
  createFakeDocumentClient,
  createFakeVerifier,
  createHarness,
  familyIdOf,
  seedFamily,
  seedMembership,
  seedUser,
  userIdOf,
  TABLES,
  type Harness,
} from './support/harness.js';

/**
 * Live sessions, end to end through the real pipeline.
 *
 * The interesting assertions here are not the happy path. They are that the
 * platform's ten-minute ceiling holds however the request is phrased, that a
 * session stops being honoured the instant its deadline passes even though the
 * scheduled sweep has not run, that stopping takes effect on the very next
 * read, and that every way of being refused — wrong family, paused sharing,
 * somebody else's session, an id that never existed — produces one
 * indistinguishable answer.
 */

const JSON_HEADERS = { 'content-type': 'application/json' };

const LIVE_SESSIONS_TABLE = 'LiveSessions';

/**
 * Ana pays and does the asking; Ben is the person she asks to watch. Cara and
 * Dave are the rest of the family — close enough to see both of them and still
 * not parties to their session. The stranger is in a different family entirely.
 */
const ana = userIdOf(1);
const ben = userIdOf(2);
const cara = userIdOf(3);
const dave = userIdOf(4);
const stranger = userIdOf(9);
const family = familyIdOf(1);
const otherFamily = familyIdOf(2);

const TABLE_DEFINITIONS: TableDefinition[] = [
  {
    name: LIVE_SESSIONS_TABLE,
    keySchema: { partitionKey: 'sessionId' },
    indexes: {
      byTarget: { partitionKey: 'targetUserId', sortKey: 'startedAt' },
      byRequester: { partitionKey: 'requesterUserId', sortKey: 'startedAt' },
    },
  },
];

type LiveSessionHarness = Harness & {
  /** The LiveSessions store, kept separate so assertions can read the rows. */
  readonly liveSessions: InMemoryDocumentClient;
};

/**
 * The shared harness owns the users, memberships, subscriptions, audit trail
 * and clock this area reads. The LiveSessions table is declared here because no
 * other route touches it — which incidentally proves this repository does not
 * reach into anybody else's.
 */
function createLiveSessionHarness(): LiveSessionHarness {
  const harness = createHarness();
  const store = new InMemoryDocumentClient(TABLE_DEFINITIONS);

  const services: ApiServices & LiveSessionServices = {
    ...harness.services,
    liveSessions: createLiveSessionsRepository(
      createFakeDocumentClient(store),
      LIVE_SESSIONS_TABLE,
    ),
  };

  const pipeline = createPipeline({
    router: createRouter(liveSessionRoutes),
    services,
    logger: harness.logger,
    verifier: createFakeVerifier(),
  });

  return {
    ...harness,
    liveSessions: store,
    services,
    pipeline,
    async call(input: Partial<HttpRequest> & { method: HttpMethod; path: string }) {
      const response = await pipeline(harness.request(input));
      return {
        statusCode: response.statusCode,
        headers: response.headers,
        body: response.body === '' ? null : (JSON.parse(response.body) as unknown),
      };
    },
  };
}

function seedSubscription(
  harness: LiveSessionHarness,
  input: { userId: UserId; familyId: FamilyId; plan: string; status?: string },
): void {
  harness.store.seed(TABLES.subscriptions, [
    {
      userId: input.userId,
      familyId: input.familyId,
      plan: input.plan,
      status: input.status ?? 'ACTIVE',
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

type CallResult = { statusCode: number; headers: Record<string, string>; body: unknown };

let keyCounter = 0;

function requestSession(
  harness: LiveSessionHarness,
  input: {
    as?: UserId;
    familyId?: FamilyId;
    targetUserId?: UserId;
    requestedDurationSeconds?: number;
    reason?: string;
  } = {},
): Promise<CallResult> {
  keyCounter += 1;
  return harness.call({
    method: 'POST',
    path: '/v1/live-sessions',
    headers: {
      ...authHeaders(input.as ?? ana),
      ...JSON_HEADERS,
      'idempotency-key': `live-session-${String(keyCounter).padStart(4, '0')}`,
    },
    rawBody: JSON.stringify({
      familyId: input.familyId ?? family,
      targetUserId: input.targetUserId ?? ben,
      ...(input.requestedDurationSeconds === undefined
        ? {}
        : { requestedDurationSeconds: input.requestedDurationSeconds }),
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    }),
  });
}

function answer(
  harness: LiveSessionHarness,
  input: { sessionId: string; action: 'accept' | 'reject' | 'stop'; as: UserId; body?: unknown },
): Promise<CallResult> {
  return harness.call({
    method: 'POST',
    path: `/v1/live-sessions/${input.sessionId}/${input.action}`,
    headers: { ...authHeaders(input.as), ...JSON_HEADERS },
    rawBody: input.body === undefined ? null : JSON.stringify(input.body),
  });
}

function listSessions(
  harness: LiveSessionHarness,
  input: { as: UserId; familyId?: FamilyId; status?: string },
): Promise<CallResult> {
  return harness.call({
    method: 'GET',
    path: '/v1/live-sessions',
    headers: authHeaders(input.as),
    query: {
      familyId: input.familyId ?? family,
      ...(input.status === undefined ? {} : { status: input.status }),
    },
  });
}

/** The session in a create/accept/reject/stop response. */
function sessionOf(result: CallResult): LiveSession {
  const body = result.body as { session: LiveSession };
  return body.session;
}

function storedSession(harness: LiveSessionHarness, sessionId: string): Item {
  const row = harness.liveSessions.dump(LIVE_SESSIONS_TABLE).find((item) => {
    return item.sessionId === sessionId;
  });
  if (row === undefined) {
    throw new Error(`Expected a stored session ${sessionId}.`);
  }
  return row;
}

/** Requests a session and has Ben accept it, returning the ACTIVE session. */
async function runningSession(
  harness: LiveSessionHarness,
  grantedDurationSeconds?: number,
): Promise<LiveSession> {
  const created = sessionOf(await requestSession(harness));
  const accepted = await answer(harness, {
    sessionId: created.sessionId,
    action: 'accept',
    as: ben,
    body: grantedDurationSeconds === undefined ? {} : { grantedDurationSeconds },
  });
  expect(accepted.statusCode).toBe(200);
  return sessionOf(accepted);
}

function errorCode(result: CallResult): string {
  return ApiErrorSchema.parse(result.body).error.code;
}

function errorMessage(result: CallResult): string {
  return ApiErrorSchema.parse(result.body).error.message;
}

describe('live sessions', () => {
  let harness: LiveSessionHarness;

  beforeEach(() => {
    keyCounter = 0;
    harness = createLiveSessionHarness();

    for (const userId of [ana, ben, cara, dave, stranger]) {
      seedUser(harness, { userId });
    }
    seedFamily(harness, { familyId: family, ownerUserId: ana });
    seedMembership(harness, { familyId: family, userId: ana, role: 'OWNER' });
    seedMembership(harness, { familyId: family, userId: ben });
    seedMembership(harness, { familyId: family, userId: cara });
    seedMembership(harness, { familyId: family, userId: dave });

    seedFamily(harness, { familyId: otherFamily, ownerUserId: stranger });
    seedMembership(harness, { familyId: otherFamily, userId: stranger, role: 'OWNER' });

    // Ana pays. Ben, Cara and the stranger are on FREE, which is the point of
    // several of the tests below: consent controls are not a paid feature.
    seedSubscription(harness, { userId: ana, familyId: family, plan: 'FAMILY_MONTHLY' });
  });

  // -------------------------------------------------------------------------
  // Requesting
  // -------------------------------------------------------------------------

  it('creates a request that changes nothing until the target accepts', async () => {
    const response = await requestSession(harness);

    expect(response.statusCode).toBe(201);
    const body = CreateLiveSessionResponseSchema.parse(response.body);
    expect(body.awaitingTargetConsent).toBe(true);
    expect(body.session).toMatchObject({
      status: 'REQUESTED',
      requestedByUserId: ana,
      targetUserId: ben,
      familyId: family,
      respondedAt: null,
      endedAt: null,
      // Nothing is running yet, so there is nothing to count down.
      expiresAt: null,
    });
  });

  it('entitles every member of a paying family, not only the buyer', async () => {
    // Ana holds the family's subscription; Ben holds none of his own. Resolving
    // the entitlement from Ben's own row would refuse him a feature his family
    // pays for, which is how a family plan differs from a personal one.
    const response = await requestSession(harness, { as: ben, targetUserId: ana });

    expect(response.statusCode).toBe(201);
  });

  it('refuses a family with no entitled subscription at all', async () => {
    // The stranger's family has no plan and never did.
    seedUser(harness, { userId: dave });
    seedMembership(harness, { familyId: otherFamily, userId: dave });

    const response = await requestSession(harness, {
      as: stranger,
      targetUserId: dave,
      familyId: otherFamily,
    });

    expect(response.statusCode).toBe(402);
    expect(errorCode(response)).toBe('ENTITLEMENT_REQUIRED');
  });

  it('ignores a lapsed subscription even though a row exists', async () => {
    // A row on the unpaid family, expired. A lapsed row must not entitle, and
    // it must not shadow the fact that nobody in that family is paying.
    seedUser(harness, { userId: dave });
    seedMembership(harness, { familyId: otherFamily, userId: dave });
    seedSubscription(harness, {
      userId: stranger,
      familyId: otherFamily,
      plan: 'FAMILY_PLUS_ANNUAL',
      status: 'EXPIRED',
    });

    const response = await requestSession(harness, {
      as: stranger,
      targetUserId: dave,
      familyId: otherFamily,
    });

    expect(response.statusCode).toBe(402);
  });

  it('requires an idempotency key', async () => {
    const response = await harness.call({
      method: 'POST',
      path: '/v1/live-sessions',
      headers: { ...authHeaders(ana), ...JSON_HEADERS },
      rawBody: JSON.stringify({ familyId: family, targetUserId: ben }),
    });

    expect(response.statusCode).toBe(422);
    expect(ApiErrorSchema.parse(response.body).error.fields?.map((field) => field.path)).toContain(
      'idempotency-key',
    );
  });

  it('replays a retried request instead of opening a second session', async () => {
    const headers = {
      ...authHeaders(ana),
      ...JSON_HEADERS,
      'idempotency-key': 'live-session-retry',
    };
    const rawBody = JSON.stringify({ familyId: family, targetUserId: ben });

    const first = await harness.call({
      method: 'POST',
      path: '/v1/live-sessions',
      headers,
      rawBody,
    });
    const second = await harness.call({
      method: 'POST',
      path: '/v1/live-sessions',
      headers,
      rawBody,
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(harness.liveSessions.size(LIVE_SESSIONS_TABLE)).toBe(1);
  });

  it('refuses to ask for longer than the platform allows', async () => {
    const response = await requestSession(harness, {
      requestedDurationSeconds: LIMITS.MAX_LIVE_SESSION_SECONDS + 1,
    });

    expect(response.statusCode).toBe(422);
    expect(errorCode(response)).toBe('VALIDATION_FAILED');
  });

  it('records the ceiling as the deadline of an unanswered request', async () => {
    const created = sessionOf(await requestSession(harness));
    const row = storedSession(harness, created.sessionId);

    // A request nobody answers still ages out, and the row that carries it is
    // reaped with it: the TTL attribute is the same deadline.
    expect(row.expiresAt).toBe(
      Math.floor(harness.now().getTime() / 1000) + LIMITS.MAX_LIVE_SESSION_SECONDS,
    );
    expect(row.startedAt).toBe(harness.now().toISOString());
  });

  it('allows only one open session per target', async () => {
    const first = await requestSession(harness);
    expect(first.statusCode).toBe(201);

    seedSubscription(harness, { userId: cara, familyId: family, plan: 'FAMILY_MONTHLY' });
    const second = await requestSession(harness, { as: cara });

    expect(second.statusCode).toBe(409);
    expect(errorCode(second)).toBe('LIVE_SESSION_LIMIT');
  });

  it('frees the slot once the previous session has lapsed, without a sweep', async () => {
    await requestSession(harness);
    harness.advance(LIMITS.MAX_LIVE_SESSION_SECONDS * 1000 + 1);

    // Nothing has closed the first row — the scheduled sweep has not run — but
    // it is past its deadline, so it holds no slot.
    const second = await requestSession(harness);
    expect(second.statusCode).toBe(201);
  });

  // -------------------------------------------------------------------------
  // Accepting
  // -------------------------------------------------------------------------

  it('starts the window at the moment of consent, not the moment of the request', async () => {
    const created = sessionOf(await requestSession(harness, { requestedDurationSeconds: 300 }));
    harness.advance(120_000);

    const accepted = await answer(harness, {
      sessionId: created.sessionId,
      action: 'accept',
      as: ben,
      body: {},
    });

    const session = AcceptLiveSessionResponseSchema.parse(accepted.body).session;
    expect(session.status).toBe('ACTIVE');
    expect(session.expiresAt).toBe(new Date(harness.now().getTime() + 300_000).toISOString());
    expect(session.respondedAt).toBe(harness.now().toISOString());
  });

  it('lets the target grant less than was asked for, never more', async () => {
    const created = sessionOf(await requestSession(harness, { requestedDurationSeconds: 120 }));

    const accepted = await answer(harness, {
      sessionId: created.sessionId,
      action: 'accept',
      as: ben,
      body: { grantedDurationSeconds: LIMITS.MAX_LIVE_SESSION_SECONDS },
    });

    const session = sessionOf(accepted);
    // Asked for two minutes, so two minutes is the most that can be granted —
    // the target cannot hand out a longer window than was requested, and the
    // requester cannot obtain one by having the target overshoot.
    expect(session.expiresAt).toBe(new Date(harness.now().getTime() + 120_000).toISOString());
    expect(storedSession(harness, created.sessionId).grantedDurationSeconds).toBe(120);
  });

  it('never lets a session outlive the platform ceiling', async () => {
    const session = await runningSession(harness);
    const expiresAt = session.expiresAt;
    expect(expiresAt).not.toBeNull();

    const windowMs = Date.parse(expiresAt ?? '') - harness.now().getTime();
    expect(windowMs).toBeLessThanOrEqual(LIMITS.MAX_LIVE_SESSION_SECONDS * 1000);
  });

  it('refuses to accept after the request has lapsed, and closes the row', async () => {
    const created = sessionOf(await requestSession(harness));
    harness.advance(LIMITS.MAX_LIVE_SESSION_SECONDS * 1000 + 1);

    const accepted = await answer(harness, {
      sessionId: created.sessionId,
      action: 'accept',
      as: ben,
      body: {},
    });

    expect(accepted.statusCode).toBe(410);
    expect(errorCode(accepted)).toBe('LIVE_SESSION_EXPIRED');
    // The API does not wait for the sweep to make the row agree with the answer.
    expect(storedSession(harness, created.sessionId)).toMatchObject({
      status: 'EXPIRED',
      endedReason: 'EXPIRED',
    });
  });

  it('refuses a second acceptance', async () => {
    const session = await runningSession(harness);

    const again = await answer(harness, {
      sessionId: session.sessionId,
      action: 'accept',
      as: ben,
      body: {},
    });

    expect(again.statusCode).toBe(409);
    expect(errorCode(again)).toBe('CONFLICT');
  });

  it('does not let the requester accept on the target’s behalf', async () => {
    const created = sessionOf(await requestSession(harness));

    const accepted = await answer(harness, {
      sessionId: created.sessionId,
      action: 'accept',
      as: ana,
      body: {},
    });

    expect(accepted.statusCode).toBe(403);
    expect(storedSession(harness, created.sessionId).status).toBe('REQUESTED');
  });

  // -------------------------------------------------------------------------
  // Rejecting
  // -------------------------------------------------------------------------

  it('lets the target refuse, and records the refusal', async () => {
    const created = sessionOf(await requestSession(harness));

    const rejected = await answer(harness, {
      sessionId: created.sessionId,
      action: 'reject',
      as: ben,
      body: {},
    });

    expect(rejected.statusCode).toBe(200);
    expect(RejectLiveSessionResponseSchema.parse(rejected.body).session).toMatchObject({
      status: 'REJECTED',
      endedReason: 'TARGET_REJECTED',
    });

    const events = harness.store.dump(TABLES.auditEvents);
    expect(events.map((event) => event.action)).toEqual([
      'LIVE_SESSION_REQUESTED',
      'LIVE_SESSION_REJECTED',
    ]);
  });

  it('treats a retried refusal as the same refusal', async () => {
    const created = sessionOf(await requestSession(harness));

    const first = await answer(harness, {
      sessionId: created.sessionId,
      action: 'reject',
      as: ben,
      body: {},
    });
    const second = await answer(harness, {
      sessionId: created.sessionId,
      action: 'reject',
      as: ben,
      body: {},
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(sessionOf(second).status).toBe('REJECTED');
  });

  it('silently declines later requests once the target has muted the requester', async () => {
    const created = sessionOf(await requestSession(harness));
    await answer(harness, {
      sessionId: created.sessionId,
      action: 'reject',
      as: ben,
      body: { muteFutureRequests: true },
    });

    const again = await requestSession(harness);

    expect(again.statusCode).toBe(403);
    // Indistinguishable from every other refusal: a mute the requester can
    // detect is a mute they can work around.
    expect(errorMessage(again)).toBe('You do not have access to this resource.');
    expect(errorMessage(again)).not.toMatch(/mute|reject|declin/i);

    // The mute outlives the session it arrived with, so the row keeps no TTL.
    expect(storedSession(harness, created.sessionId).expiresAt).toBeUndefined();
  });

  it('does not let the requester refuse on the target’s behalf', async () => {
    const created = sessionOf(await requestSession(harness));

    const rejected = await answer(harness, {
      sessionId: created.sessionId,
      action: 'reject',
      as: ana,
      body: {},
    });

    expect(rejected.statusCode).toBe(403);
    expect(storedSession(harness, created.sessionId).status).toBe('REQUESTED');
  });

  it('refuses to reject a session that was already accepted', async () => {
    const session = await runningSession(harness);

    const rejected = await answer(harness, {
      sessionId: session.sessionId,
      action: 'reject',
      as: ben,
      body: {},
    });

    expect(rejected.statusCode).toBe(409);
    expect(storedSession(harness, session.sessionId).status).toBe('ACTIVE');
  });

  it('reports a lapsed request as expired rather than as answered', async () => {
    const created = sessionOf(await requestSession(harness));
    harness.advance(LIMITS.MAX_LIVE_SESSION_SECONDS * 1000 + 1);

    const rejected = await answer(harness, {
      sessionId: created.sessionId,
      action: 'reject',
      as: ben,
      body: {},
    });

    expect(rejected.statusCode).toBe(410);
    expect(errorCode(rejected)).toBe('LIVE_SESSION_EXPIRED');
  });

  // -------------------------------------------------------------------------
  // Stopping
  // -------------------------------------------------------------------------

  it('stops immediately when the target withdraws consent', async () => {
    const session = await runningSession(harness);

    const stopped = await answer(harness, {
      sessionId: session.sessionId,
      action: 'stop',
      as: ben,
    });

    expect(stopped.statusCode).toBe(200);
    expect(StopLiveSessionResponseSchema.parse(stopped.body).session).toMatchObject({
      status: 'STOPPED',
      endedReason: 'TARGET_STOPPED',
    });
    // The very next read, with no intervening step, sees it closed.
    const listed = ListLiveSessionsResponseSchema.parse(
      (await listSessions(harness, { as: ana })).body,
    );
    expect(listed.sessions[0]).toMatchObject({ status: 'STOPPED' });
  });

  it('lets the requester stop what they started', async () => {
    const session = await runningSession(harness);

    const stopped = await answer(harness, {
      sessionId: session.sessionId,
      action: 'stop',
      as: ana,
    });

    expect(sessionOf(stopped)).toMatchObject({
      status: 'STOPPED',
      endedReason: 'REQUESTER_STOPPED',
    });
  });

  it('accepts a stop with no body at all', async () => {
    const session = await runningSession(harness);

    const stopped = await harness.call({
      method: 'POST',
      path: `/v1/live-sessions/${session.sessionId}/stop`,
      headers: authHeaders(ben),
    });

    expect(stopped.statusCode).toBe(200);
    expect(sessionOf(stopped).status).toBe('STOPPED');
  });

  it('answers a repeated stop with the session, not a conflict', async () => {
    const session = await runningSession(harness);
    await answer(harness, { sessionId: session.sessionId, action: 'stop', as: ben });

    const again = await answer(harness, {
      sessionId: session.sessionId,
      action: 'stop',
      as: ben,
    });

    expect(again.statusCode).toBe(200);
    expect(sessionOf(again)).toMatchObject({ status: 'STOPPED', endedReason: 'TARGET_STOPPED' });
    // Exactly one stop happened, so exactly one was recorded.
    const events = harness.store.dump(TABLES.auditEvents);
    expect(events.filter((event) => event.action === 'LIVE_SESSION_STOPPED')).toHaveLength(1);
  });

  it('does not let a bystander stop somebody else’s session', async () => {
    const session = await runningSession(harness);

    // Cara is in the same family and can see both of them. She is still not a
    // party to this session.
    const stopped = await answer(harness, {
      sessionId: session.sessionId,
      action: 'stop',
      as: cara,
    });

    expect(stopped.statusCode).toBe(403);
    expect(storedSession(harness, session.sessionId).status).toBe('ACTIVE');
  });

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  it('returns only the sessions the caller is a party to', async () => {
    const mine = sessionOf(await requestSession(harness));
    // A session between two other people, in the same family and visible to
    // everyone in it. It is still none of Ana's business.
    seedSubscription(harness, { userId: cara, familyId: family, plan: 'FAMILY_MONTHLY' });
    const theirs = sessionOf(await requestSession(harness, { as: cara, targetUserId: dave }));

    const listed = ListLiveSessionsResponseSchema.parse(
      (await listSessions(harness, { as: ana })).body,
    );

    expect(listed.sessions.map((session) => session.sessionId)).toEqual([mine.sessionId]);
    expect(listed.maxConcurrentPerTarget).toBe(LIMITS.MAX_CONCURRENT_LIVE_SESSIONS_PER_TARGET);
    expect(theirs.sessionId).not.toBe(mine.sessionId);
  });

  it('reports a lapsed session as expired even before the sweep has run', async () => {
    const session = await runningSession(harness, 120);
    harness.advance(120_000 + 1);

    const listed = ListLiveSessionsResponseSchema.parse(
      (await listSessions(harness, { as: ben })).body,
    );

    expect(listed.sessions[0]).toMatchObject({
      sessionId: session.sessionId,
      status: 'EXPIRED',
      endedReason: 'EXPIRED',
    });
  });

  it('filters by status when asked', async () => {
    await requestSession(harness);

    const requested = ListLiveSessionsResponseSchema.parse(
      (await listSessions(harness, { as: ben, status: 'REQUESTED' })).body,
    );
    const active = ListLiveSessionsResponseSchema.parse(
      (await listSessions(harness, { as: ben, status: 'ACTIVE' })).body,
    );

    expect(requested.sessions).toHaveLength(1);
    expect(active.sessions).toHaveLength(0);
  });

  it('lets a free-plan target see and answer a session they did not pay for', async () => {
    const created = sessionOf(await requestSession(harness));

    // Ben has no subscription at all. Seeing who has asked to watch him, and
    // saying no, are consent controls rather than paid features.
    const listed = await listSessions(harness, { as: ben });
    expect(listed.statusCode).toBe(200);
    expect(ListLiveSessionsResponseSchema.parse(listed.body).sessions).toHaveLength(1);

    const rejected = await answer(harness, {
      sessionId: created.sessionId,
      action: 'reject',
      as: ben,
      body: {},
    });
    expect(rejected.statusCode).toBe(200);
  });

  // -------------------------------------------------------------------------
  // Opacity
  // -------------------------------------------------------------------------

  it('answers every kind of refusal identically', async () => {
    // A family the caller is not in.
    const foreignFamily = await requestSession(harness, {
      familyId: otherFamily,
      targetUserId: stranger,
    });
    // A person who is not in the named family.
    const foreignTarget = await requestSession(harness, { targetUserId: stranger });
    // Themselves.
    const self = await requestSession(harness, { targetUserId: ana });
    // A session id that never existed.
    const unknownSession = await answer(harness, {
      sessionId: userIdOf(42),
      action: 'stop',
      as: ana,
    });
    // A real session belonging to somebody else.
    const created = sessionOf(await requestSession(harness));
    const notMine = await answer(harness, {
      sessionId: created.sessionId,
      action: 'stop',
      as: cara,
    });

    for (const refusal of [foreignFamily, foreignTarget, self, unknownSession, notMine]) {
      expect(refusal.statusCode).toBe(403);
      expect(errorCode(refusal)).toBe('FORBIDDEN');
      expect(errorMessage(refusal)).toBe('You do not have access to this resource.');
    }
  });

  it('does not distinguish a paused target from a stranger', async () => {
    harness.store.seed(TABLES.familyMemberships, [
      {
        ...(storedMembership(harness, family, ben) as Record<string, unknown>),
        sharingStatus: 'PAUSED',
      },
    ]);

    const paused = await requestSession(harness);
    const strangerRefusal = await requestSession(harness, { targetUserId: stranger });

    expect(paused.statusCode).toBe(403);
    expect(errorMessage(paused)).toBe(errorMessage(strangerRefusal));
    expect(errorMessage(paused)).not.toMatch(/paus|sharing|family|member/i);
  });

  it('does not distinguish a target who hid from the requester', async () => {
    harness.store.seed(TABLES.familyMemberships, [
      {
        ...(storedMembership(harness, family, ben) as Record<string, unknown>),
        hiddenFromUserIds: [ana],
      },
    ]);

    const hidden = await requestSession(harness);

    expect(hidden.statusCode).toBe(403);
    expect(errorMessage(hidden)).toBe('You do not have access to this resource.');
  });

  it('refuses to list the sessions of a family the caller is not in', async () => {
    const listed = await listSessions(harness, { as: ana, familyId: otherFamily });

    expect(listed.statusCode).toBe(403);
    expect(errorMessage(listed)).toBe('You do not have access to this resource.');
  });

  // -------------------------------------------------------------------------
  // What never leaves the service
  // -------------------------------------------------------------------------

  it('records the audit trail in ids and scalars only', async () => {
    const session = await runningSession(harness);
    await answer(harness, { sessionId: session.sessionId, action: 'stop', as: ben });

    const events = harness.store.dump(TABLES.auditEvents);
    expect(events.map((event) => event.action)).toEqual([
      'LIVE_SESSION_REQUESTED',
      'LIVE_SESSION_ACCEPTED',
      'LIVE_SESSION_STOPPED',
    ]);

    for (const event of events) {
      const metadata = event.metadata as Record<string, unknown>;
      for (const value of Object.values(metadata)) {
        expect(['string', 'number', 'boolean']).toContain(typeof value);
      }
      // There is no coordinate in this domain and no shape here that could
      // carry one; the assertion is what keeps it that way.
      expect(Object.keys(metadata)).not.toContain('latitude');
      expect(Object.keys(metadata)).not.toContain('longitude');
      expect(event.targetUserId).toBe(ben);
    }
  });

  it('keeps every response and log line free of anything but ids', async () => {
    const session = await runningSession(harness);
    await answer(harness, { sessionId: session.sessionId, action: 'stop', as: ana });

    const serialised = JSON.stringify(harness.logs);
    expect(serialised).not.toMatch(/latitude|longitude|coordinate/i);
  });
});

/** The membership row as stored, so a test can re-seed it with one field changed. */
function storedMembership(harness: LiveSessionHarness, familyId: FamilyId, userId: UserId): Item {
  const row = harness.store
    .dump(TABLES.familyMemberships)
    .find((item) => item.familyId === familyId && item.userId === userId);
  if (row === undefined) {
    throw new Error('Expected a seeded membership.');
  }
  return row;
}
