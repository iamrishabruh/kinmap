import * as Crypto from 'expo-crypto';

import { AppError, LIMITS, type FamilyId, type UserId } from '@family/contracts';
import {
  AcceptLiveSessionResponseSchema,
  CreateLiveSessionResponseSchema,
  ListFamilyMembersResponseSchema,
  ListLiveSessionsResponseSchema,
  RejectLiveSessionResponseSchema,
  StopLiveSessionResponseSchema,
  type LiveSession as WireLiveSession,
} from '@family/schemas';

import { clampLiveSessionSeconds } from '@/features/live/session-model';
import type { FamilyApi } from '@/features/query/api';
import type { LiveSession, LiveSessionStatus } from '@/features/query/types';
import { request } from '@/lib/api';

/**
 * The live-session slice of {@link FamilyApi}.
 *
 * A live session is a consent grant, not a data channel: it raises the target's
 * update rate for a bounded window *after* the target accepts. Nothing in this
 * module carries a coordinate — positions are read through the location routes,
 * which re-check membership and sharing on every call — and nothing here logs,
 * so there is no line for a session id, a family id or a position to reach.
 *
 * ---------------------------------------------------------------------------
 * THE DEPLOYED ROUTES, AND ONLY THOSE
 * ---------------------------------------------------------------------------
 *   `GET  /v1/live-sessions?familyId=…`               -> `ListLiveSessionsResponseSchema`
 *   `POST /v1/live-sessions`                          -> `CreateLiveSessionResponseSchema`
 *   `POST /v1/live-sessions/{sessionId}/accept`       -> `AcceptLiveSessionResponseSchema`
 *   `POST /v1/live-sessions/{sessionId}/reject`       -> `RejectLiveSessionResponseSchema`
 *   `POST /v1/live-sessions/{sessionId}/stop`         -> `StopLiveSessionResponseSchema`
 *   `GET  /v1/families/{familyId}/members`            -> `ListFamilyMembersResponseSchema`
 *
 * All six are in `API_ROUTES` (`infrastructure/stacks/api-stack.ts`); the first
 * five are served by `services/api/src/routes/live-sessions.ts` and the last by
 * `services/family-service`.
 *
 * **There is no `GET /v1/live-sessions/{sessionId}`.** `getLiveSession` is
 * therefore served by reading the caller's own session list for the owning
 * family and picking the row out of it — the list route answers only with
 * sessions the caller is a party to, which is exactly the authorization the
 * missing by-id route would have applied. The owning family is not in the
 * method's input, so it is remembered from whichever earlier response first
 * carried that session (a list, a request, a response, a stop). A session id
 * this process has never seen cannot be resolved at all and is refused rather
 * than guessed at.
 *
 * ---------------------------------------------------------------------------
 * STOPPING IS NEVER OPTIMISTIC
 * ---------------------------------------------------------------------------
 * `stopLiveSession` resolves with the row the *server* returned, after the
 * server returned it. It does not pre-write a STOPPED status, does not swallow
 * a failure, and does not fall back to a locally synthesised session. Somebody
 * tapping stop is withdrawing consent to be followed; telling them it is done
 * before the server agrees would be telling them something we do not know.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE WIRE DOES NOT CARRY (see the gaps reported with this module)
 * ---------------------------------------------------------------------------
 * `LiveSessionSchema` has no display names, no `startedAt` and no duration —
 * `projectLiveSession` in the API service drops the stored durations on
 * purpose. The view type needs all three, so:
 *   - names are joined from the family's member list (a real route, cached
 *     briefly) and fall back to a neutral label rather than to an empty string
 *     or an id, because an empty name is what turns a consent banner into
 *     "(nobody) is now following your location";
 *   - `startedAt` is `respondedAt` for every status except REJECTED, where
 *     `respondedAt` is the refusal and no session ever started;
 *   - `durationSeconds` is the granted window measured from the response
 *     itself (`expiresAt - startedAt`), and where the wire cannot express one —
 *     a request nobody has accepted yet — the platform ceiling, which is an
 *     upper bound. Overstating to the person being asked to consent is the safe
 *     direction; understating is not.
 */

/** Exactly the five methods this module owns. */
export type LiveSessionsApi = Pick<
  FamilyApi,
  | 'listLiveSessions'
  | 'getLiveSession'
  | 'requestLiveSession'
  | 'respondToLiveSession'
  | 'stopLiveSession'
>;

/** Display names for the members of one family, keyed by user id. */
export type DisplayNameDirectory = ReadonlyMap<UserId, string>;

export type LiveSessionsApiDependencies = {
  /**
   * Resolves the display names a session is rendered with. Injectable so the
   * composed `FamilyApi` can share one member fetch instead of two; the default
   * reads `GET /v1/families/{familyId}/members`.
   */
  loadDisplayNames?: (familyId: FamilyId, signal?: AbortSignal) => Promise<DisplayNameDirectory>;
};

/**
 * Shown when a session names somebody the member list did not (they left, or
 * the directory read failed). Honest and unambiguous: never a user id, never an
 * empty string, and never a name carried over from a different member.
 */
const UNKNOWN_MEMBER_NAME = 'A family member';

/**
 * How long a member directory is reused. Long enough that a session list
 * polling every ten seconds does not drag a member fetch along with it, short
 * enough that a rename or a departure surfaces quickly.
 */
const DIRECTORY_TTL_MS = 60_000;

const EMPTY_DIRECTORY: DisplayNameDirectory = new Map<UserId, string>();

const MILLISECONDS_PER_SECOND = 1000;

/**
 * Opaque, non-guessable idempotency key, derived from randomness only so it
 * cannot carry anything about the user or the session it accompanies.
 */
function newIdempotencyKey(): string {
  return Crypto.randomUUID();
}

function parseInstantMs(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * The wire's REQUESTED is the view's PENDING; every other status is the same
 * word on both sides. The exhaustive switch is what makes a new server status a
 * compile error here instead of an unhandled string in a countdown.
 */
function toViewStatus(status: WireLiveSession['status']): LiveSessionStatus {
  switch (status) {
    case 'REQUESTED':
      return 'PENDING';
    case 'ACTIVE':
      return 'ACTIVE';
    case 'REJECTED':
      return 'REJECTED';
    case 'STOPPED':
      return 'STOPPED';
    case 'EXPIRED':
      return 'EXPIRED';
    default: {
      const unreachable: never = status;
      return unreachable;
    }
  }
}

/**
 * The window this session runs for, in seconds.
 *
 * Measured from the response rather than echoed from the request: the server
 * may grant less than was asked for (the target can shorten it, remote
 * configuration can tighten the ceiling), and what the countdown must reflect
 * is what was granted. Clamped through the same helper the request path uses,
 * so a server that ever sent a window past the cap still cannot make this
 * client render one.
 */
function deriveDurationSeconds(session: WireLiveSession, startedAt: string | null): number {
  const expiresAtMs = parseInstantMs(session.expiresAt);
  const startMs = parseInstantMs(startedAt) ?? parseInstantMs(session.requestedAt);

  if (expiresAtMs !== null && startMs !== null && expiresAtMs > startMs) {
    return clampLiveSessionSeconds(Math.round((expiresAtMs - startMs) / MILLISECONDS_PER_SECOND));
  }

  // A request nobody has answered yet has no expiry on the wire at all. The
  // ceiling is the only bound that is certainly not an understatement.
  return LIMITS.MAX_LIVE_SESSION_SECONDS;
}

function toView(session: WireLiveSession, names: DisplayNameDirectory): LiveSession {
  // For a refusal, `respondedAt` is the moment of the "no" — not a start.
  const startedAt = session.status === 'REJECTED' ? null : session.respondedAt;

  return {
    sessionId: session.sessionId,
    familyId: session.familyId,
    requestedByUserId: session.requestedByUserId,
    requestedByDisplayName: names.get(session.requestedByUserId) ?? UNKNOWN_MEMBER_NAME,
    targetUserId: session.targetUserId,
    targetDisplayName: names.get(session.targetUserId) ?? UNKNOWN_MEMBER_NAME,
    status: toViewStatus(session.status),
    requestedAt: session.requestedAt,
    respondedAt: session.respondedAt,
    startedAt,
    expiresAt: session.expiresAt,
    endedAt: session.endedAt,
    durationSeconds: deriveDurationSeconds(session, startedAt),
    updateIntervalSeconds: session.updateIntervalSeconds,
  };
}

async function fetchDisplayNames(
  familyId: FamilyId,
  signal?: AbortSignal,
): Promise<DisplayNameDirectory> {
  const response = await request({
    method: 'GET',
    path: `/v1/families/${encodeURIComponent(familyId)}/members`,
    schema: ListFamilyMembersResponseSchema,
    signal,
  });

  const names = new Map<UserId, string>();
  for (const member of response.members) {
    names.set(member.userId, member.displayName);
  }
  return names;
}

export function createLiveSessionsApi(
  dependencies: LiveSessionsApiDependencies = {},
): LiveSessionsApi {
  const loadDisplayNames = dependencies.loadDisplayNames ?? fetchDisplayNames;

  const directories = new Map<FamilyId, { names: DisplayNameDirectory; fetchedAt: number }>();
  const directoriesInFlight = new Map<FamilyId, Promise<DisplayNameDirectory>>();

  /**
   * Which family a session belongs to, learned from responses that said so.
   *
   * This exists only because there is no by-id route; it is a routing detail,
   * never a substitute for the server's answer about the session itself.
   */
  const familyOfSession = new Map<string, FamilyId>();

  function remember(session: WireLiveSession): void {
    familyOfSession.set(session.sessionId, session.familyId);
  }

  /**
   * Names for a family, reused for {@link DIRECTORY_TTL_MS}.
   *
   * Never rejects. A directory read that fails must not take a session read
   * down with it: who is following whom, and until when, is the part that
   * matters, and it is already in hand by the time this is called.
   */
  async function namesFor(familyId: FamilyId, signal?: AbortSignal): Promise<DisplayNameDirectory> {
    const cached = directories.get(familyId);
    if (cached !== undefined && Date.now() - cached.fetchedAt < DIRECTORY_TTL_MS) {
      return cached.names;
    }

    const pending = directoriesInFlight.get(familyId);
    if (pending !== undefined) return pending;

    const fetching = loadDisplayNames(familyId, signal)
      .then((names) => {
        directories.set(familyId, { names, fetchedAt: Date.now() });
        return names;
      })
      .catch(() => cached?.names ?? EMPTY_DIRECTORY)
      .finally(() => {
        directoriesInFlight.delete(familyId);
      });

    directoriesInFlight.set(familyId, fetching);
    return fetching;
  }

  async function listForFamily(
    familyId: FamilyId,
    signal?: AbortSignal,
  ): Promise<WireLiveSession[]> {
    const response = await request({
      method: 'GET',
      path: '/v1/live-sessions',
      // The server answers with the caller's own sessions in this family only;
      // there is no parameter that could point it at somebody else's.
      query: { familyId },
      schema: ListLiveSessionsResponseSchema,
      signal,
    });

    for (const session of response.sessions) {
      remember(session);
    }
    // `maxConcurrentPerTarget` is dropped: the per-target limit is the server's
    // to enforce, and the view type does not carry it.
    return [...response.sessions];
  }

  return {
    async listLiveSessions(
      input: { familyId: FamilyId },
      signal?: AbortSignal,
    ): Promise<LiveSession[]> {
      const sessions = await listForFamily(input.familyId, signal);
      const names = await namesFor(input.familyId, signal);
      return sessions.map((session) => toView(session, names));
    },

    /**
     * One session, read through the family list because no by-id route exists.
     *
     * Terminal rows stay in the list until the server reaps them, so a session
     * that was just stopped or that expired still resolves — a poll that
     * started returning an error the moment a session ended would leave the
     * screen unable to say it had ended.
     */
    async getLiveSession(input: { sessionId: string }, signal?: AbortSignal): Promise<LiveSession> {
      const familyId = familyOfSession.get(input.sessionId);
      if (familyId === undefined) {
        // Not "no such session" — this client cannot address it. Guessing a
        // family here would mean asking about a session on behalf of a family
        // it may not belong to.
        throw new AppError('NOT_FOUND', 'That live session is not available on this device.');
      }

      const sessions = await listForFamily(familyId, signal);
      const found = sessions.find((session) => session.sessionId === input.sessionId);
      if (found === undefined) {
        throw new AppError('NOT_FOUND', 'That live session is no longer available.');
      }

      const names = await namesFor(familyId, signal);
      return toView(found, names);
    },

    async requestLiveSession(input: {
      familyId: FamilyId;
      targetUserId: UserId;
      durationSeconds: number;
    }): Promise<LiveSession> {
      const response = await request({
        method: 'POST',
        path: '/v1/live-sessions',
        body: {
          familyId: input.familyId,
          targetUserId: input.targetUserId,
          // Clamped again on the way out. The caller clamps, the server clamps,
          // and neither is trusted alone: a client that could ask for an
          // unbounded window is one bug away from indefinite tracking.
          requestedDurationSeconds: clampLiveSessionSeconds(input.durationSeconds),
          // `reason` is deliberately omitted. The request sheet does not ask for
          // one, and the server defaults it; asserting a reason the user never
          // gave would put words in their mouth in the target's prompt.
        },
        schema: CreateLiveSessionResponseSchema,
        // Required by this route: a retried request must not open a second
        // session against the same person.
        idempotencyKey: newIdempotencyKey(),
      });

      // `awaitingTargetConsent` is a literal `true` on this route and is not
      // re-asserted here: the session comes back REQUESTED, which is what the
      // view renders as PENDING, and nothing is shared until the target agrees.
      remember(response.session);
      const names = await namesFor(input.familyId);
      return toView(response.session, names);
    },

    /**
     * The target's answer. Accepting and refusing are different routes, so the
     * boolean picks a path rather than a payload.
     *
     * Neither body asserts anything the user did not: an accept grants the
     * window that was requested, and a refusal is silent about muting future
     * requests, which is a separate choice with its own control.
     */
    async respondToLiveSession(input: {
      sessionId: string;
      accept: boolean;
    }): Promise<LiveSession> {
      const encodedSessionId = encodeURIComponent(input.sessionId);
      const response = input.accept
        ? await request({
            method: 'POST',
            path: `/v1/live-sessions/${encodedSessionId}/accept`,
            body: {},
            schema: AcceptLiveSessionResponseSchema,
            idempotencyKey: newIdempotencyKey(),
          })
        : await request({
            method: 'POST',
            path: `/v1/live-sessions/${encodedSessionId}/reject`,
            body: {},
            schema: RejectLiveSessionResponseSchema,
            idempotencyKey: newIdempotencyKey(),
          });

      remember(response.session);
      const names = await namesFor(response.session.familyId);
      return toView(response.session, names);
    },

    /**
     * Ends a session, and resolves only once the server says it is ended.
     *
     * Either party may stop. The returned row is the server's, verbatim through
     * the schema — no optimistic STOPPED, no swallowed error, no local guess at
     * `endedAt`. If this rejects, the session is still running as far as anyone
     * can prove, and the caller is expected to say so.
     */
    async stopLiveSession(input: { sessionId: string }): Promise<LiveSession> {
      const response = await request({
        method: 'POST',
        path: `/v1/live-sessions/${encodeURIComponent(input.sessionId)}/stop`,
        body: {},
        schema: StopLiveSessionResponseSchema,
        idempotencyKey: newIdempotencyKey(),
      });

      remember(response.session);
      // Naming is best-effort and cannot fail this call; the withdrawal has
      // already taken effect server-side by the time we get here.
      const names = await namesFor(response.session.familyId);
      return toView(response.session, names);
    },
  };
}

/** The composed instance; `createLiveSessionsApi()` exists for tests that want a fresh one. */
export const liveSessionsApi: LiveSessionsApi = createLiveSessionsApi();
