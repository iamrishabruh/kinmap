import { createContext, createElement, useContext, type ReactNode } from 'react';

import type { FamilyId, PlaceId, UserId } from '@family/contracts';

import type {
  AbuseCategory,
  AcceptInvitationResult,
  AssignableFamilyRole,
  AuthenticatedSession,
  CreatePlaceInput,
  DayHistory,
  EntitlementsView,
  FamilyDetail,
  FamilyMemberView,
  FamilySummary,
  Invitation,
  InvitationPreview,
  LiveSession,
  MemberLocation,
  RemoveMemberResult,
  ReportAccountResult,
  SavedPlace,
  SelfSharingState,
  TimelineEntry,
  UpdatePlaceInput,
} from '@/features/query/types';

/**
 * The transport contract the product surface depends on.
 *
 * Screens never talk to `fetch` directly; they talk to this interface through
 * React Query. That keeps three things true:
 *   1. every network call is cancellable via the AbortSignal React Query passes;
 *   2. the entire surface can be substituted in tests without a server;
 *   3. `@family/api-client` can be swapped in later by satisfying this type —
 *      structurally, so a mismatch is a compile error rather than a runtime one.
 */
export interface FamilyApi {
  // -- session -------------------------------------------------------------
  getSession(signal?: AbortSignal): Promise<AuthenticatedSession>;
  getEntitlements(signal?: AbortSignal): Promise<EntitlementsView>;

  // -- families and members ------------------------------------------------
  listFamilies(signal?: AbortSignal): Promise<FamilySummary[]>;
  getFamily(input: { familyId: FamilyId }, signal?: AbortSignal): Promise<FamilyDetail>;
  listMembers(input: { familyId: FamilyId }, signal?: AbortSignal): Promise<FamilyMemberView[]>;
  getMember(
    input: { familyId: FamilyId; userId: UserId },
    signal?: AbortSignal,
  ): Promise<FamilyMemberView>;
  updateMemberRole(input: {
    familyId: FamilyId;
    userId: UserId;
    role: AssignableFamilyRole;
  }): Promise<FamilyMemberView>;
  /**
   * Removing a member also drops their history for this family by default.
   * The caller MUST purge the local location cache for that member on success
   * (spec §35) — see `useRemoveMember`.
   */
  removeMember(input: {
    familyId: FamilyId;
    userId: UserId;
    deleteHistory: boolean;
  }): Promise<RemoveMemberResult>;
  leaveFamily(input: { familyId: FamilyId }): Promise<RemoveMemberResult>;
  blockUser(input: { familyId: FamilyId; userId: UserId }): Promise<RemoveMemberResult>;
  reportAccount(input: {
    familyId: FamilyId;
    userId: UserId;
    category: AbuseCategory;
    note: string | null;
  }): Promise<ReportAccountResult>;

  // -- locations -----------------------------------------------------------
  listCurrentLocations(
    input: { familyId: FamilyId },
    signal?: AbortSignal,
  ): Promise<MemberLocation[]>;
  getMemberLocation(
    input: { familyId: FamilyId; userId: UserId },
    signal?: AbortSignal,
  ): Promise<MemberLocation>;
  getMemberTimeline(
    input: { familyId: FamilyId; userId: UserId; limit: number },
    signal?: AbortSignal,
  ): Promise<TimelineEntry[]>;
  getDayHistory(
    input: { familyId: FamilyId; userId: UserId; day: string },
    signal?: AbortSignal,
  ): Promise<DayHistory>;

  // -- the caller's own sharing state --------------------------------------
  getSharingState(signal?: AbortSignal): Promise<SelfSharingState>;
  setSharingPaused(input: { paused: boolean }): Promise<SelfSharingState>;

  // -- saved places --------------------------------------------------------
  listPlaces(input: { familyId: FamilyId }, signal?: AbortSignal): Promise<SavedPlace[]>;
  getPlace(
    input: { familyId: FamilyId; placeId: PlaceId },
    signal?: AbortSignal,
  ): Promise<SavedPlace>;
  createPlace(input: CreatePlaceInput): Promise<SavedPlace>;
  updatePlace(input: UpdatePlaceInput): Promise<SavedPlace>;
  deletePlace(input: { familyId: FamilyId; placeId: PlaceId }): Promise<void>;

  // -- invitations ---------------------------------------------------------
  listInvitations(input: { familyId: FamilyId }, signal?: AbortSignal): Promise<Invitation[]>;
  createInvitation(input: { familyId: FamilyId; role: AssignableFamilyRole }): Promise<Invitation>;
  revokeInvitation(input: { familyId: FamilyId; invitationId: string }): Promise<void>;
  /** Read-only. Must never create a membership. */
  previewInvitation(input: { token: string }, signal?: AbortSignal): Promise<InvitationPreview>;
  /** The only call that creates a membership, and only from an explicit tap. */
  acceptInvitation(input: { token: string }): Promise<AcceptInvitationResult>;

  // -- live sessions -------------------------------------------------------
  listLiveSessions(input: { familyId: FamilyId }, signal?: AbortSignal): Promise<LiveSession[]>;
  getLiveSession(input: { sessionId: string }, signal?: AbortSignal): Promise<LiveSession>;
  requestLiveSession(input: {
    familyId: FamilyId;
    targetUserId: UserId;
    /** Clamped client-side before it is sent; also enforced server-side. */
    durationSeconds: number;
  }): Promise<LiveSession>;
  respondToLiveSession(input: { sessionId: string; accept: boolean }): Promise<LiveSession>;
  stopLiveSession(input: { sessionId: string }): Promise<LiveSession>;
}

const ApiContext = createContext<FamilyApi | null>(null);

export function ApiProvider({ api, children }: { api: FamilyApi; children: ReactNode }) {
  return createElement(ApiContext.Provider, { value: api }, children);
}

export function useApi(): FamilyApi {
  const api = useContext(ApiContext);
  if (api === null) {
    throw new Error('useApi() requires an <ApiProvider> above it in the tree.');
  }
  return api;
}
