import { CONFIG_GUARDRAILS, LIMITS, type UserId } from '@family/contracts';

import type { LiveSession, LiveSessionStatus } from '@/features/query/types';

/**
 * Live-session rules, expressed as pure functions so the cap is testable and
 * cannot drift between screens.
 *
 * THE TEN-MINUTE CAP IS ENFORCED TWICE.
 * The server owns expiry — a client that lies about time still gets cut off.
 * But the client must never *render* a session as running past the cap either,
 * because the countdown is the consent signal shown to the person being
 * located. If the phone's clock is wrong, or a malicious or buggy server sends
 * an `expiresAt` an hour out, `effectiveExpiryMs` clamps it back to
 * `startedAt + LIMITS.MAX_LIVE_SESSION_SECONDS`. The UI fails closed: it stops
 * sharing early rather than late.
 */

export const MAX_LIVE_SESSION_SECONDS = LIMITS.MAX_LIVE_SESSION_SECONDS;
export const MIN_LIVE_SESSION_SECONDS = CONFIG_GUARDRAILS.liveSessionMaxSeconds.min;

/** Durations offered in the request sheet. Never exceeds the hard cap. */
export const LIVE_SESSION_DURATION_CHOICES: readonly number[] = [5 * 60, MAX_LIVE_SESSION_SECONDS];

/** Clamps a requested duration into the allowed range before it is sent. */
export function clampLiveSessionSeconds(requestedSeconds: number): number {
  if (!Number.isFinite(requestedSeconds)) return MIN_LIVE_SESSION_SECONDS;
  const rounded = Math.floor(requestedSeconds);
  if (rounded < MIN_LIVE_SESSION_SECONDS) return MIN_LIVE_SESSION_SECONDS;
  if (rounded > MAX_LIVE_SESSION_SECONDS) return MAX_LIVE_SESSION_SECONDS;
  return rounded;
}

function parseIso(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * The moment this client will stop treating the session as live.
 *
 * Returns null when the session has no meaningful expiry yet (a request that
 * has not been accepted and carries no deadline).
 */
export function effectiveExpiryMs(session: LiveSession): number | null {
  const serverExpiry = parseIso(session.expiresAt);
  const startedAt = parseIso(session.startedAt) ?? parseIso(session.requestedAt);
  if (startedAt === null) return serverExpiry;
  const hardCap = startedAt + MAX_LIVE_SESSION_SECONDS * 1000;
  if (serverExpiry === null) return hardCap;
  return Math.min(serverExpiry, hardCap);
}

export type LiveSessionView = {
  sessionId: string;
  /** What this client will act on, which may be stricter than `session.status`. */
  status: LiveSessionStatus;
  isActive: boolean;
  isPending: boolean;
  /** True once the session has ended for any reason. */
  hasEnded: boolean;
  /** Whole seconds left, 0 when finished. Never negative, never above the cap. */
  remainingSeconds: number;
  /** 0..1, for a progress ring. 1 means finished. */
  elapsedFraction: number;
  expiresAtMs: number | null;
  /**
   * True when the client clamped a server expiry that ran past the hard cap.
   * Surfaced in diagnostics; a live session must never outlive the cap.
   */
  wasClampedToCap: boolean;
};

export function deriveLiveSessionView(session: LiveSession, nowMs: number): LiveSessionView {
  const expiresAtMs = effectiveExpiryMs(session);
  const serverExpiry = parseIso(session.expiresAt);
  const wasClampedToCap =
    serverExpiry !== null && expiresAtMs !== null && serverExpiry > expiresAtMs;

  const terminal: LiveSessionStatus[] = ['REJECTED', 'STOPPED', 'EXPIRED'];
  let status: LiveSessionStatus = session.status;

  if (!terminal.includes(status)) {
    if (status === 'ACTIVE') {
      // An ACTIVE session with no computable expiry is malformed. Fail closed.
      if (expiresAtMs === null || nowMs >= expiresAtMs) status = 'EXPIRED';
    } else if (status === 'PENDING') {
      if (expiresAtMs !== null && nowMs >= expiresAtMs) status = 'EXPIRED';
    }
  }

  const isActive = status === 'ACTIVE';
  const isPending = status === 'PENDING';
  const hasEnded = terminal.includes(status);

  const remainingSeconds =
    isActive && expiresAtMs !== null ? Math.max(0, Math.ceil((expiresAtMs - nowMs) / 1000)) : 0;

  const totalSeconds = clampLiveSessionSeconds(session.durationSeconds);
  const elapsedFraction = hasEnded
    ? 1
    : Math.min(1, Math.max(0, 1 - remainingSeconds / totalSeconds));

  return {
    sessionId: session.sessionId,
    status,
    isActive,
    isPending,
    hasEnded,
    remainingSeconds,
    elapsedFraction,
    expiresAtMs,
    wasClampedToCap,
  };
}

export type LiveSessionRole = 'TARGET' | 'REQUESTER' | 'OBSERVER';

export function liveSessionRoleFor(session: LiveSession, viewerUserId: UserId): LiveSessionRole {
  if (session.targetUserId === viewerUserId) return 'TARGET';
  if (session.requestedByUserId === viewerUserId) return 'REQUESTER';
  return 'OBSERVER';
}

/** Sessions that should still be shown as running. */
export function activeSessionsFor(sessions: readonly LiveSession[], nowMs: number): LiveSession[] {
  return sessions.filter((session) => deriveLiveSessionView(session, nowMs).isActive);
}

/** Sessions where the viewer is the one being located, and can stop it. */
export function sessionsTargeting(
  sessions: readonly LiveSession[],
  viewerUserId: UserId,
  nowMs: number,
): LiveSession[] {
  return activeSessionsFor(sessions, nowMs).filter(
    (session) => session.targetUserId === viewerUserId,
  );
}

export function pendingRequestsFor(
  sessions: readonly LiveSession[],
  viewerUserId: UserId,
  nowMs: number,
): LiveSession[] {
  return sessions.filter((session) => {
    const view = deriveLiveSessionView(session, nowMs);
    return view.isPending && session.targetUserId === viewerUserId;
  });
}

// ---------------------------------------------------------------------------
// Auto-expiry
// ---------------------------------------------------------------------------

export type ExpiryScheduler = {
  setTimeout: (handler: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
  now: () => number;
};

export const defaultScheduler: ExpiryScheduler = {
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => {
    clearTimeout(handle);
  },
  now: () => Date.now(),
};

export type ExpiryWatcher = { stop: () => void };

/**
 * Fires `onExpire` the moment the session's effective expiry passes, without
 * waiting for a poll. The countdown reaching zero and the session actually
 * ending have to be the same event — a UI that keeps saying "live" for another
 * 15 seconds while it waits for the server is telling the located person
 * something false.
 *
 * Fires immediately (synchronously) if the session is already past expiry.
 */
export function watchLiveSessionExpiry(
  session: LiveSession,
  onExpire: (sessionId: string) => void,
  scheduler: ExpiryScheduler = defaultScheduler,
): ExpiryWatcher {
  const view = deriveLiveSessionView(session, scheduler.now());
  if (view.hasEnded) {
    return { stop: () => undefined };
  }

  const expiresAtMs = view.expiresAtMs;
  if (expiresAtMs === null) {
    return { stop: () => undefined };
  }

  const delay = expiresAtMs - scheduler.now();
  if (delay <= 0) {
    onExpire(session.sessionId);
    return { stop: () => undefined };
  }

  let handle: ReturnType<typeof setTimeout> | null = scheduler.setTimeout(() => {
    handle = null;
    onExpire(session.sessionId);
  }, delay);

  return {
    stop: () => {
      if (handle !== null) {
        scheduler.clearTimeout(handle);
        handle = null;
      }
    },
  };
}
