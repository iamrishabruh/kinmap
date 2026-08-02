import { z } from 'zod';

/**
 * Canonical domain vocabulary. Every service, the mobile app, and the CDK app
 * derive their types from this module so that a rename here is a compile error
 * everywhere rather than a silent runtime mismatch.
 */

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

export const UserIdSchema = z.string().uuid();
export const FamilyIdSchema = z.string().uuid();
export const DeviceIdSchema = z.string().uuid();
export const PlaceIdSchema = z.string().uuid();
export const EventIdSchema = z.string().uuid();
export const SessionIdSchema = z.string().uuid();
export const InvitationIdSchema = z.string().uuid();

export type UserId = z.infer<typeof UserIdSchema>;
export type FamilyId = z.infer<typeof FamilyIdSchema>;
export type DeviceId = z.infer<typeof DeviceIdSchema>;
export type PlaceId = z.infer<typeof PlaceIdSchema>;

// ---------------------------------------------------------------------------
// Family roles (spec §17). Deliberately does NOT encode legal guardianship —
// the platform must not infer parent/child status from a role.
// ---------------------------------------------------------------------------

export const FamilyRoleSchema = z.enum(['OWNER', 'ADMIN', 'ADULT', 'MEMBER']);
export type FamilyRole = z.infer<typeof FamilyRoleSchema>;

/** Ordering used only for privilege comparison, never for legal inference. */
export const FAMILY_ROLE_RANK: Record<FamilyRole, number> = {
  OWNER: 4,
  ADMIN: 3,
  ADULT: 2,
  MEMBER: 1,
};

export const MembershipStatusSchema = z.enum(['ACTIVE', 'PENDING', 'REMOVED', 'LEFT', 'BLOCKED']);
export type MembershipStatus = z.infer<typeof MembershipStatusSchema>;

// ---------------------------------------------------------------------------
// Tracking state machine (spec §10)
// ---------------------------------------------------------------------------

export const TrackingStateSchema = z.enum([
  'DISABLED',
  'PERMISSION_REQUIRED',
  'STATIONARY',
  'PASSIVE',
  'WALKING',
  'TRANSIT',
  'LIVE',
  'LOW_BATTERY',
  'CRITICAL_BATTERY',
  'OFFLINE',
  'STALE',
]);
export type TrackingState = z.infer<typeof TrackingStateSchema>;

export const TRACKING_STATES = TrackingStateSchema.options;

/**
 * States in which the engine is permitted to persist and upload location.
 * DISABLED and PERMISSION_REQUIRED must never produce a stored coordinate.
 */
export const LOCATION_PRODUCING_STATES: readonly TrackingState[] = [
  'STATIONARY',
  'PASSIVE',
  'WALKING',
  'TRANSIT',
  'LIVE',
  'LOW_BATTERY',
  'CRITICAL_BATTERY',
];

export const MotionStateSchema = z.enum([
  'UNKNOWN',
  'STATIONARY',
  'WALKING',
  'RUNNING',
  'CYCLING',
  'AUTOMOTIVE',
]);
export type MotionState = z.infer<typeof MotionStateSchema>;

// ---------------------------------------------------------------------------
// Permissions and device health
// ---------------------------------------------------------------------------

export const LocationAuthorizationSchema = z.enum([
  'NOT_DETERMINED',
  'DENIED',
  'RESTRICTED',
  'WHEN_IN_USE',
  'ALWAYS',
]);
export type LocationAuthorization = z.infer<typeof LocationAuthorizationSchema>;

export const LocationPermissionStateSchema = z.object({
  authorization: LocationAuthorizationSchema,
  preciseLocationEnabled: z.boolean(),
  locationServicesEnabled: z.boolean(),
  notificationsEnabled: z.boolean(),
  /** iOS: Background App Refresh. Android: background-location grant. */
  backgroundRefreshEnabled: z.boolean(),
  /** Android only; null on iOS. */
  foregroundServicePermissionGranted: z.boolean().nullable().default(null),
  /** Android only: OEM battery optimisation is suppressing background work. */
  batteryOptimizationIgnored: z.boolean().nullable().default(null),
});
export type LocationPermissionState = z.infer<typeof LocationPermissionStateSchema>;

export const DeviceLocationHealthSchema = z.object({
  permission: LocationPermissionStateSchema,
  trackingState: TrackingStateSchema,
  batteryLevel: z.number().min(0).max(1).nullable(),
  isLowPowerMode: z.boolean(),
  isCharging: z.boolean().nullable(),
  pendingEventCount: z.number().int().nonnegative(),
  oldestPendingEventAt: z.string().datetime().nullable(),
  lastAcceptedAt: z.string().datetime().nullable(),
  lastUploadAttemptAt: z.string().datetime().nullable(),
  lastUploadError: z.string().nullable(),
  remoteConfigVersion: z.number().int().nonnegative().nullable(),
});
export type DeviceLocationHealth = z.infer<typeof DeviceLocationHealthSchema>;

// ---------------------------------------------------------------------------
// Location events (spec §11). Coordinates are plaintext ONLY on-device and in
// transit; the backend encrypts them at rest before persisting.
// ---------------------------------------------------------------------------

export const LatitudeSchema = z.number().min(-90).max(90);
export const LongitudeSchema = z.number().min(-180).max(180);

export const LocationEventSchema = z.object({
  eventId: EventIdSchema,
  deviceId: DeviceIdSchema,
  sequenceNumber: z.number().int().nonnegative(),
  latitude: LatitudeSchema,
  longitude: LongitudeSchema,
  altitude: z.number().optional(),
  horizontalAccuracy: z.number().nonnegative(),
  verticalAccuracy: z.number().nonnegative().optional(),
  heading: z.number().min(0).max(360).optional(),
  speed: z.number().optional(),
  batteryLevel: z.number().min(0).max(1).optional(),
  isLowPowerMode: z.boolean().optional(),
  motionState: MotionStateSchema.optional(),
  trackingMode: TrackingStateSchema,
  capturedAt: z.string().datetime(),
  createdAt: z.string().datetime(),
});
export type LocationEvent = z.infer<typeof LocationEventSchema>;

export const FreshnessSchema = z.enum(['LIVE', 'FRESH', 'RECENT', 'STALE', 'UNKNOWN']);
export type Freshness = z.infer<typeof FreshnessSchema>;

export const SharingStatusSchema = z.enum([
  'SHARING',
  'PAUSED',
  'DISABLED',
  'PERMISSION_BLOCKED',
  'NEVER_ENABLED',
]);
export type SharingStatus = z.infer<typeof SharingStatusSchema>;

// ---------------------------------------------------------------------------
// Saved places and geofencing
// ---------------------------------------------------------------------------

export const PlaceCategorySchema = z.enum(['HOME', 'WORK', 'SCHOOL', 'GYM', 'FAMILY', 'OTHER']);
export type PlaceCategory = z.infer<typeof PlaceCategorySchema>;

export const GeofenceTransitionSchema = z.enum(['ARRIVAL', 'DEPARTURE']);
export type GeofenceTransition = z.infer<typeof GeofenceTransitionSchema>;

export const SavedPlaceSchema = z.object({
  placeId: PlaceIdSchema,
  familyId: FamilyIdSchema,
  name: z.string().min(1).max(80),
  category: PlaceCategorySchema,
  latitude: LatitudeSchema,
  longitude: LongitudeSchema,
  radiusMeters: z.number().min(50).max(10_000),
  notifyOnArrival: z.boolean(),
  notifyOnDeparture: z.boolean(),
  createdBy: UserIdSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  schemaVersion: z.number().int().positive(),
});
export type SavedPlace = z.infer<typeof SavedPlaceSchema>;

// ---------------------------------------------------------------------------
// Subscriptions (spec §23)
// ---------------------------------------------------------------------------

export const PlanSchema = z.enum([
  'FREE',
  'FAMILY_MONTHLY',
  'FAMILY_ANNUAL',
  'FAMILY_PLUS_MONTHLY',
  'FAMILY_PLUS_ANNUAL',
]);
export type Plan = z.infer<typeof PlanSchema>;

export const PlanTierSchema = z.enum(['FREE', 'FAMILY', 'FAMILY_PLUS']);
export type PlanTier = z.infer<typeof PlanTierSchema>;

export const PLAN_TIER: Record<Plan, PlanTier> = {
  FREE: 'FREE',
  FAMILY_MONTHLY: 'FAMILY',
  FAMILY_ANNUAL: 'FAMILY',
  FAMILY_PLUS_MONTHLY: 'FAMILY_PLUS',
  FAMILY_PLUS_ANNUAL: 'FAMILY_PLUS',
};

export const SubscriptionStatusSchema = z.enum([
  'ACTIVE',
  'IN_GRACE_PERIOD',
  'IN_BILLING_RETRY',
  'EXPIRED',
  'CANCELLED',
  'REVOKED',
  'REFUNDED',
  'PAUSED',
]);
export type SubscriptionStatus = z.infer<typeof SubscriptionStatusSchema>;

/** Statuses that still grant paid entitlements. */
export const ENTITLED_SUBSCRIPTION_STATUSES: readonly SubscriptionStatus[] = [
  'ACTIVE',
  'IN_GRACE_PERIOD',
  'IN_BILLING_RETRY',
];

export type Entitlements = {
  tier: PlanTier;
  maxFamilies: number;
  maxMembersPerFamily: number;
  maxSavedPlaces: number;
  historyRetentionDays: number;
  liveSessionsEnabled: boolean;
  arrivalDepartureAlerts: boolean;
  prioritySupport: boolean;
};

/**
 * Server-authoritative entitlement table. The client may cache this but the API
 * must always re-derive it from the subscription record (spec §23).
 */
export const ENTITLEMENTS: Record<PlanTier, Entitlements> = {
  FREE: {
    tier: 'FREE',
    maxFamilies: 1,
    maxMembersPerFamily: 2,
    maxSavedPlaces: 1,
    historyRetentionDays: 0,
    liveSessionsEnabled: false,
    arrivalDepartureAlerts: true,
    prioritySupport: false,
  },
  FAMILY: {
    tier: 'FAMILY',
    maxFamilies: 1,
    maxMembersPerFamily: 6,
    maxSavedPlaces: 50,
    historyRetentionDays: 30,
    liveSessionsEnabled: true,
    arrivalDepartureAlerts: true,
    prioritySupport: false,
  },
  FAMILY_PLUS: {
    tier: 'FAMILY_PLUS',
    maxFamilies: 3,
    maxMembersPerFamily: 12,
    maxSavedPlaces: 200,
    historyRetentionDays: 30,
    liveSessionsEnabled: true,
    arrivalDepartureAlerts: true,
    prioritySupport: true,
  },
};

// ---------------------------------------------------------------------------
// Audit (spec §18) — every sensitive read is recorded.
// ---------------------------------------------------------------------------

export const AuditActionSchema = z.enum([
  'LOCATION_CURRENT_READ',
  'LOCATION_HISTORY_READ',
  'LIVE_SESSION_REQUESTED',
  'LIVE_SESSION_ACCEPTED',
  'LIVE_SESSION_REJECTED',
  'LIVE_SESSION_STOPPED',
  'SHARING_PAUSED',
  'SHARING_RESUMED',
  'MEMBER_REMOVED',
  'MEMBER_ROLE_CHANGED',
  'INVITATION_CREATED',
  'INVITATION_REVOKED',
  'INVITATION_ACCEPTED',
  'DEVICE_REGISTERED',
  'DEVICE_REVOKED',
  'HISTORY_DELETED',
  'ACCOUNT_DELETION_REQUESTED',
  'SUPPORT_ACCESS_GRANTED',
  'ABUSE_REPORTED',
  'USER_BLOCKED',
]);
export type AuditAction = z.infer<typeof AuditActionSchema>;

export const AuditEventSchema = z.object({
  auditId: z.string().uuid(),
  action: AuditActionSchema,
  actorUserId: UserIdSchema,
  targetUserId: UserIdSchema.nullable(),
  familyId: FamilyIdSchema.nullable(),
  /** Coarse only — never a precise coordinate (spec §20). */
  metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  occurredAt: z.string().datetime(),
  requestId: z.string(),
  sourceIpHash: z.string().nullable(),
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;

// ---------------------------------------------------------------------------
// Data migrations (spec §15)
// ---------------------------------------------------------------------------

export type DataMigration = {
  id: string;
  description: string;
  createdAt: string;
  apply: () => Promise<void>;
  verify: () => Promise<void>;
  rollback?: () => Promise<void>;
};

export const MigrationStatusSchema = z.enum([
  'PENDING',
  'RUNNING',
  'APPLIED',
  'VERIFIED',
  'FAILED',
  'ROLLED_BACK',
]);
export type MigrationStatus = z.infer<typeof MigrationStatusSchema>;

// ---------------------------------------------------------------------------
// Environments
// ---------------------------------------------------------------------------

export const AppEnvSchema = z.enum(['development', 'staging', 'production']);
export type AppEnv = z.infer<typeof AppEnvSchema>;
