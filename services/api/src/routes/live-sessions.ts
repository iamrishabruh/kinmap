import { isVisibleTo, liveSessionsEnabled, resolveEntitlements } from '@family/auth';
import {
  AppError,
  CONFIG_GUARDRAILS,
  LIMITS,
  opaqueAuthorizationError,
  type FamilyId,
  type UserId,
} from '@family/contracts';
import {
  AcceptLiveSessionRequestSchema,
  CreateLiveSessionRequestSchema,
  ListLiveSessionsQuerySchema,
  LiveSessionPathSchema,
  RejectLiveSessionRequestSchema,
  StopLiveSessionRequestSchema,
  type AcceptLiveSessionResponse,
  type CreateLiveSessionResponse,
  type ListLiveSessionsResponse,
  type RejectLiveSessionResponse,
  type StopLiveSessionResponse,
} from '@family/schemas';

import { validateBody, validateParams, validateQuery } from '../middleware/validation.js';
import { toAuthMembership, type MembershipRecord } from '../repositories/families.js';
import {
  isLiveSessionOpen,
  projectLiveSession,
  settleLiveSession,
  LIVE_SESSION_OPEN_STATUSES,
  type LiveSessionRecord,
  type LiveSessionServices,
  type LiveSessionsRepository,
  type SessionId,
} from '../repositories/live-sessions.js';
import { defineRoute, type RegisteredRoute } from '../router.js';
import type { ApiServices } from '../services.js';
import type { AnyRouteContext } from '../types.js';

import { requireAuth, writeAudit } from './shared.js';

/**
 * Live session endpoints.
 *
 * A live session is consent, granted twice over: the requester asks, and
 * nothing at all changes until the target accepts. Creating one therefore
 * produces a REQUESTED row and no increase in anybody's visibility — the
 * `awaitingTargetConsent` flag in the response is a literal `true` for exactly
 * that reason.
 *
 * Two rules shape everything below.
 *
 * The window is the server's to enforce. `LIMITS.MAX_LIVE_SESSION_SECONDS` caps
 * what may be asked for, what may be granted and what a stored row may claim,
 * and every read settles the row against that ceiling before answering — so a
 * session is never honoured past its deadline merely because the scheduled
 * expiry sweep has not reached it yet. Stopping is immediate for the same
 * reason: it is a conditional write to the row every reader consults.
 *
 * Denials are opaque. "No such session", "that session is not yours", "you are
 * not in that family" and "that person is not sharing with you" are one answer,
 * because a stalker must not be able to turn this surface into a directory of
 * who is in a family with whom.
 *
 * Nothing here reaches a coordinate. The elevated update rate a session buys is
 * consumed by the location service, which re-checks membership and sharing on
 * every read; this module moves ids, statuses and instants and nothing else.
 */

/** Which party to a session may invoke an operation. */
type Party = 'TARGET' | 'EITHER';

type EngineLimits = {
  /** Never above the platform ceiling; remote configuration may only tighten it. */
  readonly maxSeconds: number;
  readonly updateIntervalSeconds: number;
};

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

/**
 * The live-session store.
 *
 * Named here so this module depends on the repository rather than on the shape
 * of the container while the two are being wired together.
 */
function liveSessions(context: AnyRouteContext): LiveSessionsRepository {
  return (context.services as ApiServices & LiveSessionServices).liveSessions;
}

/**
 * Session bounds, from remote configuration but never above the contract.
 *
 * A remote document may make a session shorter or its updates less frequent; it
 * cannot make either more aggressive than `LIMITS` and `CONFIG_GUARDRAILS`
 * allow. With no document at all the answer is the most conservative one the
 * guardrails permit rather than the most permissive.
 */
async function engineLimits(context: AnyRouteContext): Promise<EngineLimits> {
  const configuration = await context.services.configuration.getEngineConfiguration();
  const engine = configuration?.engine;
  return {
    maxSeconds: Math.floor(
      Math.min(
        LIMITS.MAX_LIVE_SESSION_SECONDS,
        engine?.liveSessionMaxSeconds ?? LIMITS.MAX_LIVE_SESSION_SECONDS,
      ),
    ),
    updateIntervalSeconds: Math.round(
      clamp(
        engine?.liveSessionUpdateIntervalSeconds ??
          CONFIG_GUARDRAILS.liveSessionUpdateIntervalSeconds.max,
        CONFIG_GUARDRAILS.liveSessionUpdateIntervalSeconds.min,
        CONFIG_GUARDRAILS.liveSessionUpdateIntervalSeconds.max,
      ),
    ),
  };
}

/**
 * The caller's own active membership, or the one denial this surface has.
 *
 * "No such family", "you are not in it" and "that person is not in it" all
 * answer identically, so neither a family id nor a user id can be probed for
 * existence through this endpoint.
 */
async function requireActiveMembership(
  context: AnyRouteContext,
  familyId: FamilyId,
  userId: UserId,
): Promise<MembershipRecord> {
  const membership = await context.services.memberships.getMembershipRecord({ familyId, userId });
  if (membership === null || membership.status !== 'ACTIVE') {
    throw opaqueAuthorizationError(context.requestId);
  }
  return membership;
}

/**
 * Loads a session the caller is a party to.
 *
 * A session id is not a capability: it is checked against the two people the
 * row names, and anybody else — including a member of the same family — gets
 * the same answer as for an id that never existed.
 */
async function loadSession(
  context: AnyRouteContext,
  sessionId: SessionId,
  party: Party,
): Promise<LiveSessionRecord> {
  const auth = requireAuth(context);
  const record = await liveSessions(context).get(sessionId);
  if (record === null) {
    throw opaqueAuthorizationError(context.requestId);
  }
  const isTarget = record.targetUserId === auth.userId;
  const permitted =
    party === 'TARGET' ? isTarget : isTarget || record.requesterUserId === auth.userId;
  if (!permitted) {
    throw opaqueAuthorizationError(context.requestId);
  }
  return record;
}

/**
 * Closes a session that has run past its deadline, then returns what the caller
 * must be shown.
 *
 * The scheduled sweep is what guarantees lapsed rows are eventually tidied; this
 * is what guarantees the API never acts on one in the meantime. Losing the race
 * with the sweep is harmless — both writes are the same terminal state.
 */
async function settleOrExpire(
  context: AnyRouteContext,
  record: LiveSessionRecord,
): Promise<LiveSessionRecord> {
  const settled = settleLiveSession(record, context.now);
  if (settled.status === record.status) {
    return record;
  }
  const closed = await liveSessions(context).close({
    sessionId: record.sessionId,
    from: LIVE_SESSION_OPEN_STATUSES,
    status: 'EXPIRED',
    endedReason: 'EXPIRED',
    endedAt: settled.endedAt ?? context.now.toISOString(),
    now: context.now,
  });
  return closed ?? settled;
}

/**
 * The live-session entitlement, resolved per family.
 *
 * `subscriptions.getForUser` reads a row keyed by user id, and a family plan
 * produces one row for the purchaser. Asking it about anybody else in that
 * family returns null, which projects to FREE. `getSubscriptionForFamily` reads
 * the byFamily index instead, which is what the plan actually covers.
 */
async function assertFamilyMayUseLiveSessions(
  context: AnyRouteContext,
  familyId: FamilyId,
): Promise<void> {
  const subscription = await context.services.subscriptions.getSubscriptionForFamily({ familyId });
  const { entitlements } = resolveEntitlements(subscription);

  if (!liveSessionsEnabled(entitlements)) {
    throw new AppError('ENTITLEMENT_REQUIRED', 'This feature requires a subscription.');
  }
}

export const liveSessionRoutes: RegisteredRoute[] = [
  defineRoute({
    method: 'GET',
    path: '/v1/live-sessions',
    authRequired: true,
    // Deliberately ungated. Requesting a session is the paid capability; seeing
    // who has asked to watch you, and being able to answer, is a consent
    // control — and a consent control behind a paywall is not one. A free-plan
    // member can be the target of a session a paying relative started, and must
    // be able to see it.
    entitlement: null,
    rateLimit: 'GENERAL_READ',
    idempotencyRequired: false,
    async handler(context) {
      const auth = requireAuth(context);
      const query = validateQuery(ListLiveSessionsQuerySchema, context.request.query);
      await requireActiveMembership(context, query.familyId, auth.userId);

      // Both queries are keyed by the caller's own id, so a session between two
      // other members is not merely filtered out of the response — it is never
      // read. There is no parameter that could point this at somebody else.
      const asTarget = await liveSessions(context).listForTarget(auth.userId);
      const asRequester = await liveSessions(context).listForRequester(auth.userId);

      const unique = new Map<SessionId, LiveSessionRecord>();
      for (const record of [...asTarget, ...asRequester]) {
        unique.set(record.sessionId, record);
      }

      const sessions = [...unique.values()]
        .filter((record) => record.familyId === query.familyId)
        .map((record) => settleLiveSession(record, context.now))
        .filter((record) => query.status === undefined || record.status === query.status)
        .sort((left, right) => right.requestedAt.localeCompare(left.requestedAt))
        .map((record) => projectLiveSession(record));

      const response: ListLiveSessionsResponse = {
        sessions,
        maxConcurrentPerTarget: LIMITS.MAX_CONCURRENT_LIVE_SESSIONS_PER_TARGET,
      };
      return { statusCode: 200, body: response };
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/v1/live-sessions',
    authRequired: true,
    // Checked inside the handler rather than declared here.
    //
    // The pipeline's declarative gate resolves entitlements from the caller's
    // OWN subscription row, and a family plan has exactly one such row — the
    // member who bought it. Every other member of a paying family resolves to
    // FREE and would be refused a feature their family pays for. The family is
    // not known until the request body is parsed, so the check moves below.
    entitlement: null,
    rateLimit: 'ACCOUNT_MUTATION',
    idempotencyRequired: true,
    async handler(context) {
      const auth = requireAuth(context);
      const request = validateBody(CreateLiveSessionRequestSchema, context.body);
      const { services } = context;

      if (request.targetUserId === auth.userId) {
        // A session on yourself would burn the single per-target slot, and the
        // refusal is the same one a stranger receives.
        throw opaqueAuthorizationError(context.requestId);
      }

      await requireActiveMembership(context, request.familyId, auth.userId);
      const target = await requireActiveMembership(context, request.familyId, request.targetUserId);

      // Resolved from the FAMILY's subscription, so every member of a paying
      // family is entitled, not only whoever holds the card. Re-derived from the
      // stored row; a plan or receipt presented by the client is not an input.
      await assertFamilyMayUseLiveSessions(context, request.familyId);

      // PAUSED, DISABLED, PERMISSION_BLOCKED, NEVER_ENABLED and "hidden from
      // you specifically" are one answer: a request that could distinguish them
      // would report the target's privacy settings to the person they were set
      // against.
      if (
        target.sharingStatus !== 'SHARING' ||
        !isVisibleTo(toAuthMembership(target), auth.userId)
      ) {
        throw opaqueAuthorizationError(context.requestId);
      }

      const history = await liveSessions(context).listForTarget(request.targetUserId);
      if (
        history.some(
          (record) => record.muteFutureRequests && record.requesterUserId === auth.userId,
        )
      ) {
        // A mute the requester can detect is a mute they can work around, so it
        // is indistinguishable from every other denial here.
        throw opaqueAuthorizationError(context.requestId);
      }

      const open = history.filter((record) =>
        isLiveSessionOpen(settleLiveSession(record, context.now).status),
      );
      if (open.length >= LIMITS.MAX_CONCURRENT_LIVE_SESSIONS_PER_TARGET) {
        throw new AppError(
          'LIVE_SESSION_LIMIT',
          'This person already has a live session in progress.',
        );
      }

      const limits = await engineLimits(context);
      const requestedDurationSeconds = Math.min(
        request.requestedDurationSeconds,
        limits.maxSeconds,
      );
      const timestamp = context.now.toISOString();
      const record: LiveSessionRecord = {
        sessionId: services.newId(),
        familyId: request.familyId,
        requesterUserId: auth.userId,
        targetUserId: request.targetUserId,
        status: 'REQUESTED',
        reason: request.reason,
        requestedAt: timestamp,
        startedAt: timestamp,
        respondedAt: null,
        endedAt: null,
        endedReason: null,
        requestedDurationSeconds,
        grantedDurationSeconds: null,
        updateIntervalSeconds: limits.updateIntervalSeconds,
        // An unanswered request must not sit in somebody's inbox indefinitely,
        // and it may never outlive the platform ceiling. The same value is the
        // table's TTL, so the row is reaped once it can no longer matter.
        expiresAt: Math.floor(context.now.getTime() / 1000) + LIMITS.MAX_LIVE_SESSION_SECONDS,
        muteFutureRequests: false,
        updatedAt: timestamp,
      };
      await liveSessions(context).create(record);

      await writeAudit(context, {
        action: 'LIVE_SESSION_REQUESTED',
        targetUserId: request.targetUserId,
        familyId: request.familyId,
        metadata: {
          sessionId: record.sessionId,
          reason: record.reason,
          requestedDurationSeconds,
        },
      });

      const response: CreateLiveSessionResponse = {
        session: projectLiveSession(record),
        awaitingTargetConsent: true,
      };
      return { statusCode: 201, body: response };
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/v1/live-sessions/{sessionId}/accept',
    authRequired: true,
    // Answering is the target's, and only the target's, and it is never a paid
    // action: see the note on the list route.
    entitlement: null,
    rateLimit: 'ACCOUNT_MUTATION',
    idempotencyRequired: false,
    async handler(context) {
      const auth = requireAuth(context);
      const path = validateParams(LiveSessionPathSchema, context.params);
      // An empty body is the whole request on this route; a supplied one may
      // shorten the window.
      const request = validateBody(AcceptLiveSessionRequestSchema, context.body ?? {});

      const session = await settleOrExpire(
        context,
        await loadSession(context, path.sessionId, 'TARGET'),
      );
      if (session.status === 'EXPIRED') {
        throw new AppError('LIVE_SESSION_EXPIRED', 'This live session request has expired.');
      }
      if (session.status !== 'REQUESTED') {
        throw new AppError('CONFLICT', 'This live session has already been answered.');
      }

      const limits = await engineLimits(context);
      // Less than was asked for, never more — and never more than the platform
      // allows, whatever either party put in the request.
      const grantedDurationSeconds = Math.min(
        request.grantedDurationSeconds ?? session.requestedDurationSeconds,
        session.requestedDurationSeconds,
        limits.maxSeconds,
      );

      const activated = await liveSessions(context).activate({
        sessionId: session.sessionId,
        grantedDurationSeconds,
        // The window runs from the moment of consent, not from the moment of
        // the request, and the deadline is stored rather than recomputed.
        expiresAt: Math.floor(context.now.getTime() / 1000) + grantedDurationSeconds,
        now: context.now,
      });
      if (activated === null) {
        // Lost the race with a rejection or a stop between the read and the
        // write. Their answer stands.
        throw new AppError('CONFLICT', 'This live session has already been answered.');
      }

      await writeAudit(context, {
        action: 'LIVE_SESSION_ACCEPTED',
        targetUserId: auth.userId,
        familyId: activated.familyId,
        metadata: { sessionId: activated.sessionId, grantedDurationSeconds },
      });

      const response: AcceptLiveSessionResponse = { session: projectLiveSession(activated) };
      return { statusCode: 200, body: response };
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/v1/live-sessions/{sessionId}/reject',
    authRequired: true,
    entitlement: null,
    rateLimit: 'ACCOUNT_MUTATION',
    idempotencyRequired: false,
    async handler(context) {
      const auth = requireAuth(context);
      const path = validateParams(LiveSessionPathSchema, context.params);
      const request = validateBody(RejectLiveSessionRequestSchema, context.body ?? {});

      const session = await settleOrExpire(
        context,
        await loadSession(context, path.sessionId, 'TARGET'),
      );
      if (session.status === 'EXPIRED') {
        throw new AppError('LIVE_SESSION_EXPIRED', 'This live session request has expired.');
      }

      const rejected = await liveSessions(context).close({
        sessionId: session.sessionId,
        // A refusal may be repeated — a client retrying after a timeout must not
        // be told its "no" failed — but it may never undo an acceptance, so an
        // ACTIVE, STOPPED or EXPIRED session is not in the set.
        from: ['REQUESTED', 'REJECTED'],
        status: 'REJECTED',
        endedReason: 'TARGET_REJECTED',
        respondsToRequest: true,
        muteFutureRequests: request.muteFutureRequests,
        now: context.now,
      });
      if (rejected === null) {
        throw new AppError('CONFLICT', 'This live session has already been answered.');
      }

      if (session.status === 'REQUESTED') {
        await writeAudit(context, {
          action: 'LIVE_SESSION_REJECTED',
          targetUserId: auth.userId,
          familyId: rejected.familyId,
          // No reason field exists to record: a target may say no without
          // justifying it, and free text here would be a coercion vector.
          metadata: { sessionId: rejected.sessionId, muted: request.muteFutureRequests },
        });
      }

      const response: RejectLiveSessionResponse = { session: projectLiveSession(rejected) };
      return { statusCode: 200, body: response };
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/v1/live-sessions/{sessionId}/stop',
    authRequired: true,
    entitlement: null,
    rateLimit: 'ACCOUNT_MUTATION',
    idempotencyRequired: false,
    async handler(context) {
      const auth = requireAuth(context);
      const path = validateParams(LiveSessionPathSchema, context.params);
      validateBody(StopLiveSessionRequestSchema, context.body ?? {});

      // Either party may stop: the target withdraws consent, the requester no
      // longer needs it, and neither has to ask the other.
      const session = await settleOrExpire(
        context,
        await loadSession(context, path.sessionId, 'EITHER'),
      );
      if (!isLiveSessionOpen(session.status)) {
        // Already over. The caller wanted it stopped and it is stopped; a 409
        // here would make a retried withdrawal of consent look like a failure.
        const settled: StopLiveSessionResponse = { session: projectLiveSession(session) };
        return { statusCode: 200, body: settled };
      }

      const stopped = await liveSessions(context).close({
        sessionId: session.sessionId,
        from: LIVE_SESSION_OPEN_STATUSES,
        status: 'STOPPED',
        endedReason: session.targetUserId === auth.userId ? 'TARGET_STOPPED' : 'REQUESTER_STOPPED',
        now: context.now,
      });
      if (stopped === null) {
        // Somebody else closed it between the read and the write, which is the
        // outcome the caller asked for. Report what the row says now.
        const current = await liveSessions(context).get(session.sessionId);
        if (current === null) {
          throw opaqueAuthorizationError(context.requestId);
        }
        const raced: StopLiveSessionResponse = { session: projectLiveSession(current) };
        return { statusCode: 200, body: raced };
      }

      await writeAudit(context, {
        action: 'LIVE_SESSION_STOPPED',
        targetUserId: stopped.targetUserId,
        familyId: stopped.familyId,
        metadata: { sessionId: stopped.sessionId, endedReason: stopped.endedReason ?? 'UNKNOWN' },
      });

      const response: StopLiveSessionResponse = { session: projectLiveSession(stopped) };
      return { statusCode: 200, body: response };
    },
  }),
];
