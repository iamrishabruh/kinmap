import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { ENTITLEMENTS, type FamilyId, type PlaceId, type UserId } from '@family/contracts';

import { locationCacheStore } from '@/features/family/location-cache';
import { useApi } from '@/features/query/api';
import { queryKeys } from '@/features/query/keys';
import { CACHE_POLICIES } from '@/features/query/policies';
import type {
  AbuseCategory,
  AssignableFamilyRole,
  CreatePlaceInput,
  EntitlementsView,
  MemberLocation,
  UpdatePlaceInput,
} from '@/features/query/types';

/**
 * Every data hook the product surface uses.
 *
 * Two conventions matter here:
 *
 *   - A mutation that revokes access PURGES before it invalidates. Invalidation
 *     schedules a refetch; purging removes the data now. For anything that ends
 *     a consent relationship (remove, leave, block) the removal has to be the
 *     first thing that happens (spec §35).
 *
 *   - Location queries mirror into `locationCacheStore` so map rendering reads
 *     from one place and one purge empties it.
 */

// ---------------------------------------------------------------------------
// Session, entitlements, own sharing state
// ---------------------------------------------------------------------------

export function useSession() {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.session(),
    queryFn: ({ signal }) => api.getSession(signal),
    ...CACHE_POLICIES.session,
  });
}

export function useActiveFamilyId(): FamilyId | null {
  const session = useSession();
  return session.data?.activeFamilyId ?? null;
}

export function useEntitlements() {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.entitlements(),
    queryFn: ({ signal }) => api.getEntitlements(signal),
    ...CACHE_POLICIES.entitlements,
  });
}

/**
 * Entitlements with a safe fallback. Until the real answer arrives we assume
 * FREE, which is the least-privileged option: a paid surface never flashes open
 * before the server has confirmed it.
 */
export function useEffectiveEntitlements(): {
  view: EntitlementsView | undefined;
  historyRetentionDays: number;
  liveSessionsEnabled: boolean;
  maxSavedPlaces: number;
  maxMembers: number;
  isLoading: boolean;
} {
  const query = useEntitlements();
  const resolved = query.data?.entitlements ?? ENTITLEMENTS.FREE;
  return {
    view: query.data,
    historyRetentionDays: resolved.historyRetentionDays,
    liveSessionsEnabled: resolved.liveSessionsEnabled,
    maxSavedPlaces: resolved.maxSavedPlaces,
    maxMembers: resolved.maxMembersPerFamily,
    isLoading: query.isPending,
  };
}

export function useSharingState() {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.sharingState(),
    queryFn: ({ signal }) => api.getSharingState(signal),
    ...CACHE_POLICIES.sharingState,
  });
}

export function useSetSharingPaused() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { paused: boolean }) => api.setSharingPaused(input),
    onSuccess: (state) => {
      queryClient.setQueryData(queryKeys.sharingState(), state);
      // Everyone else's view of me changes too.
      void queryClient.invalidateQueries({ queryKey: queryKeys.families() });
    },
  });
}

// ---------------------------------------------------------------------------
// Families and members
// ---------------------------------------------------------------------------

export function useFamilies() {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.families(),
    queryFn: ({ signal }) => api.listFamilies(signal),
    ...CACHE_POLICIES.family,
  });
}

export function useFamily(familyId: FamilyId | null) {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.family(familyId ?? 'none'),
    queryFn: ({ signal }) => {
      if (familyId === null) throw new Error('familyId is required');
      return api.getFamily({ familyId }, signal);
    },
    enabled: familyId !== null,
    ...CACHE_POLICIES.family,
  });
}

export function useMembers(familyId: FamilyId | null) {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.members(familyId ?? 'none'),
    queryFn: ({ signal }) => {
      if (familyId === null) throw new Error('familyId is required');
      return api.listMembers({ familyId }, signal);
    },
    enabled: familyId !== null,
    ...CACHE_POLICIES.members,
  });
}

export function useMember(familyId: FamilyId | null, userId: UserId | null) {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.member(familyId ?? 'none', userId ?? 'none'),
    queryFn: ({ signal }) => {
      if (familyId === null || userId === null) throw new Error('familyId and userId are required');
      return api.getMember({ familyId, userId }, signal);
    },
    enabled: familyId !== null && userId !== null,
    ...CACHE_POLICIES.members,
  });
}

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

export function useCurrentLocations(familyId: FamilyId | null) {
  const api = useApi();
  const query = useQuery({
    queryKey: queryKeys.locations(familyId ?? 'none'),
    queryFn: ({ signal }) => {
      if (familyId === null) throw new Error('familyId is required');
      return api.listCurrentLocations({ familyId }, signal);
    },
    enabled: familyId !== null,
    ...CACHE_POLICIES.locations,
  });

  const locations: MemberLocation[] | undefined = query.data;
  useEffect(() => {
    if (familyId === null || locations === undefined) return;
    // Authoritative replacement: anyone missing from the response loses their
    // cached position on this device immediately.
    locationCacheStore.getState().replaceFamily(familyId, locations);
  }, [familyId, locations]);

  return query;
}

export function useMemberLocation(familyId: FamilyId | null, userId: UserId | null) {
  const api = useApi();
  const query = useQuery({
    queryKey: queryKeys.memberLocation(familyId ?? 'none', userId ?? 'none'),
    queryFn: ({ signal }) => {
      if (familyId === null || userId === null) throw new Error('familyId and userId are required');
      return api.getMemberLocation({ familyId, userId }, signal);
    },
    enabled: familyId !== null && userId !== null,
    ...CACHE_POLICIES.locations,
  });

  const location: MemberLocation | undefined = query.data;
  useEffect(() => {
    if (location === undefined) return;
    locationCacheStore.getState().upsert(location);
  }, [location]);

  return query;
}

export function useMemberTimeline(familyId: FamilyId | null, userId: UserId | null, limit = 25) {
  const api = useApi();
  return useQuery({
    queryKey: [...queryKeys.timeline(familyId ?? 'none', userId ?? 'none'), limit],
    queryFn: ({ signal }) => {
      if (familyId === null || userId === null) throw new Error('familyId and userId are required');
      return api.getMemberTimeline({ familyId, userId, limit }, signal);
    },
    enabled: familyId !== null && userId !== null,
    ...CACHE_POLICIES.timeline,
  });
}

/**
 * History is gated by entitlement BEFORE the request is made. When the plan has
 * no retention window the query never runs, so the screen shows a truthful
 * "no history on this plan" state instead of an eternal spinner.
 */
export function useDayHistory(
  familyId: FamilyId | null,
  userId: UserId | null,
  day: string | null,
  entitled: boolean,
) {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.history(familyId ?? 'none', userId ?? 'none', day ?? 'none'),
    queryFn: ({ signal }) => {
      if (familyId === null || userId === null || day === null) {
        throw new Error('familyId, userId and day are required');
      }
      return api.getDayHistory({ familyId, userId, day }, signal);
    },
    enabled: entitled && familyId !== null && userId !== null && day !== null,
    ...CACHE_POLICIES.history,
  });
}

// ---------------------------------------------------------------------------
// Saved places
// ---------------------------------------------------------------------------

export function usePlaces(familyId: FamilyId | null) {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.places(familyId ?? 'none'),
    queryFn: ({ signal }) => {
      if (familyId === null) throw new Error('familyId is required');
      return api.listPlaces({ familyId }, signal);
    },
    enabled: familyId !== null,
    ...CACHE_POLICIES.places,
  });
}

export function usePlace(familyId: FamilyId | null, placeId: PlaceId | null) {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.place(familyId ?? 'none', placeId ?? 'none'),
    queryFn: ({ signal }) => {
      if (familyId === null || placeId === null) throw new Error('familyId and placeId required');
      return api.getPlace({ familyId, placeId }, signal);
    },
    enabled: familyId !== null && placeId !== null,
    ...CACHE_POLICIES.places,
  });
}

function invalidatePlaces(queryClient: QueryClient, familyId: FamilyId): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.places(familyId) });
  void queryClient.invalidateQueries({ queryKey: queryKeys.family(familyId) });
}

export function useCreatePlace() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreatePlaceInput) => api.createPlace(input),
    onSuccess: (place) => invalidatePlaces(queryClient, place.familyId),
  });
}

export function useUpdatePlace() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdatePlaceInput) => api.updatePlace(input),
    onSuccess: (place) => {
      queryClient.setQueryData(queryKeys.place(place.familyId, place.placeId), place);
      invalidatePlaces(queryClient, place.familyId);
    },
  });
}

export function useDeletePlace() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { familyId: FamilyId; placeId: PlaceId }) => api.deletePlace(input),
    onSuccess: (_result, input) => {
      queryClient.removeQueries({ queryKey: queryKeys.place(input.familyId, input.placeId) });
      invalidatePlaces(queryClient, input.familyId);
    },
  });
}

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

export function useInvitations(familyId: FamilyId | null) {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.invitations(familyId ?? 'none'),
    queryFn: ({ signal }) => {
      if (familyId === null) throw new Error('familyId is required');
      return api.listInvitations({ familyId }, signal);
    },
    enabled: familyId !== null,
    ...CACHE_POLICIES.invitations,
  });
}

export function useCreateInvitation() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { familyId: FamilyId; role: AssignableFamilyRole }) =>
      api.createInvitation(input),
    onSuccess: (_invitation, input) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.invitations(input.familyId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.family(input.familyId) });
    },
  });
}

export function useRevokeInvitation() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { familyId: FamilyId; invitationId: string }) =>
      api.revokeInvitation(input),
    onSuccess: (_result, input) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.invitations(input.familyId) });
    },
  });
}

/**
 * Read-only preview of an invitation. Fetching this does NOT join anything —
 * membership is created only by `useAcceptInvitation`, from an explicit tap.
 */
export function useInvitationPreview(token: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.invitationPreview(token ?? 'none'),
    queryFn: ({ signal }) => {
      if (token === null) throw new Error('token is required');
      return api.previewInvitation({ token }, signal);
    },
    enabled: token !== null && token.length > 0,
    ...CACHE_POLICIES.invitationPreview,
  });
}

export function useAcceptInvitation() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { token: string }) => api.acceptInvitation(input),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.session() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.families() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.family(result.familyId) });
    },
  });
}

// ---------------------------------------------------------------------------
// Live sessions
// ---------------------------------------------------------------------------

export function useLiveSessions(familyId: FamilyId | null) {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.liveSessions(familyId ?? 'none'),
    queryFn: ({ signal }) => {
      if (familyId === null) throw new Error('familyId is required');
      return api.listLiveSessions({ familyId }, signal);
    },
    enabled: familyId !== null,
    ...CACHE_POLICIES.liveSession,
  });
}

export function useLiveSession(sessionId: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.liveSession(sessionId ?? 'none'),
    queryFn: ({ signal }) => {
      if (sessionId === null) throw new Error('sessionId is required');
      return api.getLiveSession({ sessionId }, signal);
    },
    enabled: sessionId !== null,
    ...CACHE_POLICIES.liveSession,
  });
}

// ---------------------------------------------------------------------------
// Membership mutations that end a consent relationship
// ---------------------------------------------------------------------------

export function useUpdateMemberRole() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { familyId: FamilyId; userId: UserId; role: AssignableFamilyRole }) =>
      api.updateMemberRole(input),
    onSuccess: (member) => {
      queryClient.setQueryData(queryKeys.member(member.familyId, member.userId), member);
      void queryClient.invalidateQueries({ queryKey: queryKeys.members(member.familyId) });
    },
  });
}

/**
 * Purges every trace of the removed member from this device before it does
 * anything else. Spec §35: a removed member's cached location must not survive
 * the removal, not even until the next poll.
 */
export function purgeMemberFromDevice(
  queryClient: QueryClient,
  familyId: FamilyId,
  userId: UserId,
): void {
  locationCacheStore.getState().purgeMember(familyId, userId);
  queryClient.removeQueries({ queryKey: queryKeys.memberLocation(familyId, userId) });
  queryClient.removeQueries({ queryKey: queryKeys.timeline(familyId, userId) });
  queryClient.removeQueries({ queryKey: queryKeys.historyRoot(familyId, userId) });
  queryClient.removeQueries({ queryKey: queryKeys.member(familyId, userId) });
}

export function useRemoveMember() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { familyId: FamilyId; userId: UserId; deleteHistory?: boolean }) =>
      api.removeMember({
        familyId: input.familyId,
        userId: input.userId,
        deleteHistory: input.deleteHistory ?? true,
      }),
    onSuccess: (result) => {
      purgeMemberFromDevice(queryClient, result.familyId, result.userId);
      void queryClient.invalidateQueries({ queryKey: queryKeys.members(result.familyId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.locations(result.familyId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.family(result.familyId) });
    },
  });
}

export function useLeaveFamily() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { familyId: FamilyId }) => api.leaveFamily(input),
    onSuccess: (result) => {
      // Leaving ends the relationship in both directions: drop the whole family.
      locationCacheStore.getState().purgeFamily(result.familyId);
      queryClient.removeQueries({ queryKey: queryKeys.family(result.familyId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.families() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.session() });
    },
  });
}

export function useBlockUser() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { familyId: FamilyId; userId: UserId }) => api.blockUser(input),
    onSuccess: (result) => {
      // A block is device-wide: the blocked person must not remain cached in
      // any family this device knows about.
      locationCacheStore.getState().purgeMemberEverywhere(result.userId);
      purgeMemberFromDevice(queryClient, result.familyId, result.userId);
      void queryClient.invalidateQueries({ queryKey: queryKeys.members(result.familyId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.locations(result.familyId) });
    },
  });
}

export function useReportAccount() {
  const api = useApi();
  return useMutation({
    mutationFn: (input: {
      familyId: FamilyId;
      userId: UserId;
      category: AbuseCategory;
      note: string | null;
    }) => api.reportAccount(input),
  });
}
