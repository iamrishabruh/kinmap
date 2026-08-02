import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';

import type { FamilyId, UserId } from '@family/contracts';

import { useNow } from '@/features/live/countdown';
import {
  clampLiveSessionSeconds,
  deriveLiveSessionView,
  pendingRequestsFor,
  sessionsTargeting,
  watchLiveSessionExpiry,
  type LiveSessionView,
} from '@/features/live/session-model';
import { useApi } from '@/features/query/api';
import { useLiveSession, useLiveSessions } from '@/features/query/hooks';
import { queryKeys } from '@/features/query/keys';
import type { LiveSession } from '@/features/query/types';

/**
 * Live-session behaviour.
 *
 * The 10-minute cap is applied here, on the way out, in addition to the
 * server's own enforcement: `clampLiveSessionSeconds` bounds what we are even
 * willing to ask for. A client that could request an unbounded session would be
 * one bug away from indefinite tracking, which is the exact thing this product
 * exists not to do.
 */

/** Rewrites a session in the cache as ended, without waiting for a refetch. */
function markSessionEnded(
  queryClient: QueryClient,
  sessionId: string,
  status: 'EXPIRED' | 'STOPPED',
): void {
  queryClient.setQueryData<LiveSession>(queryKeys.liveSession(sessionId), (previous) =>
    previous === undefined
      ? previous
      : { ...previous, status, endedAt: previous.endedAt ?? new Date().toISOString() },
  );
  void queryClient.invalidateQueries({ queryKey: queryKeys.root() });
}

export function useRequestLiveSession() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { familyId: FamilyId; targetUserId: UserId; durationSeconds: number }) =>
      api.requestLiveSession({
        familyId: input.familyId,
        targetUserId: input.targetUserId,
        // Client-side cap. The server clamps too; neither is trusted alone.
        durationSeconds: clampLiveSessionSeconds(input.durationSeconds),
      }),
    onSuccess: (session) => {
      queryClient.setQueryData(queryKeys.liveSession(session.sessionId), session);
      void queryClient.invalidateQueries({ queryKey: queryKeys.liveSessions(session.familyId) });
    },
  });
}

export function useRespondToLiveSession() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { sessionId: string; accept: boolean }) => api.respondToLiveSession(input),
    onSuccess: (session) => {
      queryClient.setQueryData(queryKeys.liveSession(session.sessionId), session);
      void queryClient.invalidateQueries({ queryKey: queryKeys.liveSessions(session.familyId) });
    },
  });
}

export function useStopLiveSession() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { sessionId: string }) => api.stopLiveSession(input),
    onSuccess: (session) => {
      queryClient.setQueryData(queryKeys.liveSession(session.sessionId), session);
      void queryClient.invalidateQueries({ queryKey: queryKeys.liveSessions(session.familyId) });
    },
    onError: (_error, input) => {
      // If the stop request fails we must not keep telling the located person
      // that they are still being followed on our say-so; force a refetch.
      void queryClient.invalidateQueries({ queryKey: queryKeys.liveSession(input.sessionId) });
    },
  });
}

/**
 * One session, with a view that expires on its own.
 *
 * `watchLiveSessionExpiry` fires at the exact expiry instant rather than at the
 * next poll, so the countdown hitting zero and the session being marked over
 * are the same event.
 */
export function useLiveSessionView(sessionId: string | null): {
  session: LiveSession | undefined;
  view: LiveSessionView | null;
  isPending: boolean;
  error: unknown;
} {
  const query = useLiveSession(sessionId);
  const queryClient = useQueryClient();
  const now = useNow(1000);
  const session = query.data;

  useEffect(() => {
    if (session === undefined) return;
    const watcher = watchLiveSessionExpiry(session, (id) => {
      markSessionEnded(queryClient, id, 'EXPIRED');
    });
    return () => watcher.stop();
  }, [session, queryClient]);

  const view = useMemo(
    () => (session === undefined ? null : deriveLiveSessionView(session, now)),
    [session, now],
  );

  return { session, view, isPending: query.isPending, error: query.error };
}

/**
 * Sessions in which the signed-in user is the person being located.
 *
 * This drives the persistent indicator. It is deliberately derived from the
 * family-wide session list rather than a dedicated endpoint, so a session can
 * never exist that the target's own app does not know about.
 */
export function useSessionsTargetingMe(
  familyId: FamilyId | null,
  myUserId: UserId | null,
): { active: LiveSession[]; pending: LiveSession[]; isPending: boolean } {
  const query = useLiveSessions(familyId);
  const now = useNow(1000);
  const sessions = useMemo(() => query.data ?? [], [query.data]);

  return useMemo(() => {
    if (myUserId === null) return { active: [], pending: [], isPending: query.isPending };
    return {
      active: sessionsTargeting(sessions, myUserId, now),
      pending: pendingRequestsFor(sessions, myUserId, now),
      isPending: query.isPending,
    };
  }, [sessions, myUserId, now, query.isPending]);
}

/** Active session observing a particular member, if any. */
export function useSessionObserving(
  familyId: FamilyId | null,
  targetUserId: UserId | null,
): LiveSession | null {
  const query = useLiveSessions(familyId);
  const now = useNow(1000);
  return useMemo(() => {
    if (targetUserId === null) return null;
    const found = (query.data ?? []).find(
      (session) =>
        session.targetUserId === targetUserId && deriveLiveSessionView(session, now).isActive,
    );
    return found ?? null;
  }, [query.data, targetUserId, now]);
}
