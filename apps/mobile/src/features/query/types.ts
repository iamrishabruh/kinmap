import type {
  Entitlements,
  FamilyId,
  FamilyRole,
  Freshness,
  MembershipStatus,
  PlaceCategory,
  PlaceId,
  Plan,
  PlanTier,
  SavedPlace,
  SharingStatus,
  SubscriptionStatus,
  TrackingState,
  UserId,
} from '@family/contracts';

/**
 * Client-side view models.
 *
 * These mirror the wire schemas in `@family/schemas` field for field. They are
 * declared locally because the mobile app must compile against the vocabulary in
 * `@family/contracts` alone; when `@family/schemas` exports a barrel these types
 * should be replaced by `z.infer` of the response schemas and this file deleted.
 *
 * ---------------------------------------------------------------------------
 * THE PRIVACY INVARIANT OF THIS FILE
 * ---------------------------------------------------------------------------
 * Exactly one type below carries a latitude/longitude: `LocationPoint`. It is
 * reachable from exactly three places:
 *   - `VisibleMemberLocation`, whose `sharingStatus` is the literal 'SHARING';
 *   - `HistorySegment.path`, which is fed straight into a map polyline;
 *   - `SavedPlace` (from the contract), which is a place the family chose.
 *
 * A member who paused, disabled, or lost permission is represented by
 * `HiddenMemberLocation`, which has NO positional field at all. This is a
 * structural guarantee: there is no way to render a paused member's position
 * because the type system never hands you one (spec §19, §35).
 */

// ---------------------------------------------------------------------------
// Session and entitlements
// ---------------------------------------------------------------------------

export type AuthenticatedSession = {
  userId: UserId;
  displayName: string;
  /** Null until the user has created or joined a family. */
  activeFamilyId: FamilyId | null;
  familyIds: FamilyId[];
};

export type EntitlementsView = {
  plan: Plan;
  tier: PlanTier;
  status: SubscriptionStatus;
  entitlements: Entitlements;
};

// ---------------------------------------------------------------------------
// Families and members
// ---------------------------------------------------------------------------

export type FamilySummary = {
  familyId: FamilyId;
  name: string;
  ownerUserId: UserId;
  timeZone: string;
  memberCount: number;
  activeMemberCount: number;
  pendingInvitationCount: number;
  savedPlaceCount: number;
  planTier: PlanTier;
};

export type FamilyMemberView = {
  userId: UserId;
  familyId: FamilyId;
  displayName: string;
  avatarUrl: string | null;
  role: FamilyRole;
  status: MembershipStatus;
  /** Status only. A PAUSED member has no readable position anywhere. */
  sharingStatus: SharingStatus;
  /** Whether this member currently shares with the signed-in caller. */
  sharingWithCaller: boolean;
  deviceCount: number;
  /** Last API contact, NOT a location time. */
  lastSeenAt: string | null;
  joinedAt: string | null;
  invitedByUserId: UserId | null;
};

export type FamilyDetail = {
  family: FamilySummary;
  members: FamilyMemberView[];
  callerRole: FamilyRole;
};

/** `AssignableFamilyRole` in the wire schema: OWNER moves only via transfer. */
export type AssignableFamilyRole = Exclude<FamilyRole, 'OWNER'>;

export type RemoveMemberResult = {
  familyId: FamilyId;
  userId: UserId;
  status: Extract<MembershipStatus, 'REMOVED' | 'LEFT'>;
  removedAt: string;
  historyDeleted: boolean;
};

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

/** The one and only response-side carrier of a precise position. */
export type LocationPoint = {
  latitude: number;
  longitude: number;
  horizontalAccuracy: number;
  altitude: number | null;
  heading: number | null;
  speed: number | null;
};

export type VisibleMemberLocation = {
  visibility: 'VISIBLE';
  userId: UserId;
  familyId: FamilyId;
  sharingStatus: Extract<SharingStatus, 'SHARING'>;
  point: LocationPoint;
  capturedAt: string;
  trackingState: TrackingState;
  batteryLevel: number | null;
  isCharging: boolean | null;
  isLowPowerMode: boolean;
  /** Resolved saved place if the point falls inside one; a name, not a position. */
  placeId: PlaceId | null;
  placeName: string | null;
  /** True while a live session is streaming this member. */
  liveSessionId: string | null;
};

export type HiddenMemberLocation = {
  visibility: 'HIDDEN';
  userId: UserId;
  familyId: FamilyId;
  sharingStatus: Exclude<SharingStatus, 'SHARING'>;
  /** When the member last changed their sharing state. Never a location time. */
  statusChangedAt: string | null;
};

export type MemberLocation = VisibleMemberLocation | HiddenMemberLocation;

export function isVisibleLocation(
  location: MemberLocation | undefined,
): location is VisibleMemberLocation {
  return location !== undefined && location.visibility === 'VISIBLE';
}

/** The signed-in user's own sharing state, as shown on the settings screen. */
export type SelfSharingState = {
  sharingStatus: SharingStatus;
  trackingState: TrackingState;
  /** Mirrors the OS state so the UI can explain *why* sharing is not working. */
  permissionBlocked: boolean;
  backgroundRefreshEnabled: boolean;
  preciseLocationEnabled: boolean;
  notificationsEnabled: boolean;
  batteryLevel: number | null;
  isLowPowerMode: boolean;
  lastUploadAt: string | null;
  pendingEventCount: number;
  updatedAt: string;
};

// ---------------------------------------------------------------------------
// Timeline and history
// ---------------------------------------------------------------------------

export type TimelineEntryKind =
  | 'ARRIVED'
  | 'DEPARTED'
  | 'MOVING'
  | 'STATIONARY'
  | 'SHARING_PAUSED'
  | 'SHARING_RESUMED'
  | 'LIVE_SESSION_STARTED'
  | 'LIVE_SESSION_ENDED'
  | 'PERMISSION_LOST';

/**
 * A timeline row carries NO coordinates — only a place name the family already
 * chose to save, or a plain motion description.
 */
export type TimelineEntry = {
  entryId: string;
  kind: TimelineEntryKind;
  occurredAt: string;
  placeId: PlaceId | null;
  placeName: string | null;
  /** Pre-formatted, coordinate-free detail from the server. */
  detail: string | null;
};

export type HistorySegmentKind = 'STATIONARY' | 'MOVING';

export type HistorySegment = {
  segmentId: string;
  kind: HistorySegmentKind;
  startedAt: string;
  endedAt: string;
  placeId: PlaceId | null;
  placeName: string | null;
  distanceMeters: number;
  /** Route geometry. Rendered as a map polyline and nowhere else. */
  path: LocationPoint[];
};

export type DayHistory = {
  day: string;
  userId: UserId;
  familyId: FamilyId;
  segments: HistorySegment[];
  /** True when the day is inside retention but genuinely has no stored points. */
  isEmptyDay: boolean;
};

// ---------------------------------------------------------------------------
// Saved places
// ---------------------------------------------------------------------------

export type PlaceDraft = {
  name: string;
  category: PlaceCategory;
  latitude: number;
  longitude: number;
  radiusMeters: number;
  notifyOnArrival: boolean;
  notifyOnDeparture: boolean;
};

export type CreatePlaceInput = PlaceDraft & { familyId: FamilyId };
export type UpdatePlaceInput = Partial<PlaceDraft> & { familyId: FamilyId; placeId: PlaceId };

export type { SavedPlace };

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

export type Invitation = {
  invitationId: string;
  familyId: FamilyId;
  role: AssignableFamilyRole;
  createdByUserId: UserId;
  createdAt: string;
  expiresAt: string;
  redeemedAt: string | null;
  revokedAt: string | null;
  /** Share link. Sensitive: never logged, never persisted to disk. */
  shareUrl: string;
};

/**
 * What a recipient sees BEFORE joining. Fetching a preview must not create a
 * membership — that happens only on an explicit accept (spec §17).
 */
export type InvitationPreview = {
  familyId: FamilyId;
  familyName: string;
  invitedByDisplayName: string;
  /** The role that will be granted if the invitation is accepted. */
  role: AssignableFamilyRole;
  memberCount: number;
  expiresAt: string;
  /** Names only, so the recipient knows who will be able to see them. */
  memberDisplayNames: string[];
  /** Server-authored, human-readable disclosure of what joining shares. */
  disclosures: string[];
  status: 'VALID' | 'EXPIRED' | 'ALREADY_USED' | 'REVOKED' | 'INVALID';
};

export type AcceptInvitationResult = {
  familyId: FamilyId;
  userId: UserId;
  role: FamilyRole;
  joinedAt: string;
};

// ---------------------------------------------------------------------------
// Live sessions
// ---------------------------------------------------------------------------

export type LiveSessionStatus = 'PENDING' | 'ACTIVE' | 'REJECTED' | 'STOPPED' | 'EXPIRED';

export type LiveSession = {
  sessionId: string;
  familyId: FamilyId;
  /** The person who asked to follow. */
  requestedByUserId: UserId;
  requestedByDisplayName: string;
  /** The person being located. */
  targetUserId: UserId;
  targetDisplayName: string;
  status: LiveSessionStatus;
  requestedAt: string;
  respondedAt: string | null;
  startedAt: string | null;
  /** Server-issued hard expiry. Always <= LIMITS.MAX_LIVE_SESSION_SECONDS out. */
  expiresAt: string | null;
  endedAt: string | null;
  durationSeconds: number;
  updateIntervalSeconds: number;
};

// ---------------------------------------------------------------------------
// Safety
// ---------------------------------------------------------------------------

export type AbuseCategory =
  'UNWANTED_TRACKING' | 'HARASSMENT' | 'IMPERSONATION' | 'UNDERAGE_MISUSE' | 'OTHER';

export type ReportAccountResult = { reportId: string; submittedAt: string };

// ---------------------------------------------------------------------------
// Freshness re-export so map consumers need one import
// ---------------------------------------------------------------------------

export type { Freshness };
