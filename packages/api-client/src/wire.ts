import { z } from 'zod';

import {
  DeviceIdSchema,
  EventIdSchema,
  FamilyIdSchema,
  FamilyRoleSchema,
  FreshnessSchema,
  LatitudeSchema,
  LocationEventSchema,
  LongitudeSchema,
  MembershipStatusSchema,
  PlaceCategorySchema,
  PlaceIdSchema,
  PlanSchema,
  PlanTierSchema,
  SavedPlaceSchema,
  SharingStatusSchema,
  SubscriptionStatusSchema,
  TrackingStateSchema,
  UserIdSchema,
  LIMITS,
  type Entitlements,
} from '@family/contracts';

/**
 * Wire shapes for the HTTP surface.
 *
 * Every field is either a schema imported from `@family/contracts` or a
 * composition of them — no domain vocabulary is redefined here, so renaming a
 * contract enum breaks this file at compile time rather than at runtime.
 */

// ---------------------------------------------------------------------------
// Location ingestion
// ---------------------------------------------------------------------------

export const LocationBatchRequestSchema = z.object({
  deviceId: DeviceIdSchema,
  events: z.array(LocationEventSchema).min(1).max(LIMITS.MAX_EVENTS_PER_BATCH),
});
export type LocationBatchRequest = z.infer<typeof LocationBatchRequestSchema>;

export const RejectedEventSchema = z.object({
  eventId: EventIdSchema,
  /** Sanitised acceptance-rule name, never the offending coordinate. */
  reason: z.string(),
});

export const LocationBatchResponseSchema = z.object({
  acceptedCount: z.number().int().nonnegative(),
  rejected: z.array(RejectedEventSchema),
  nextUploadAfterSeconds: z.number().int().nonnegative(),
  serverTime: z.string().datetime(),
});
export type LocationBatchResponse = z.infer<typeof LocationBatchResponseSchema>;

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * A member's position as the map screen needs it. Coordinates are nullable
 * because the server returns the row with `sharingStatus` set and the position
 * omitted whenever the viewer is not authorised — the client never infers
 * authorisation itself (spec §34).
 */
export const MemberLocationSchema = z.object({
  userId: UserIdSchema,
  familyId: FamilyIdSchema,
  sharingStatus: SharingStatusSchema,
  freshness: FreshnessSchema,
  trackingState: TrackingStateSchema.nullable(),
  latitude: LatitudeSchema.nullable(),
  longitude: LongitudeSchema.nullable(),
  horizontalAccuracy: z.number().nonnegative().nullable(),
  capturedAt: z.string().datetime().nullable(),
  batteryLevel: z.number().min(0).max(1).nullable(),
  isCharging: z.boolean().nullable(),
  /** Set when the fix resolves to a saved place, so the UI can say "at Home". */
  placeId: PlaceIdSchema.nullable(),
});
export type MemberLocation = z.infer<typeof MemberLocationSchema>;

export const CurrentLocationsResponseSchema = z.object({
  members: z.array(MemberLocationSchema),
  serverTime: z.string().datetime(),
});
export type CurrentLocationsResponse = z.infer<typeof CurrentLocationsResponseSchema>;

export const HistoryPointSchema = z.object({
  eventId: EventIdSchema,
  latitude: LatitudeSchema,
  longitude: LongitudeSchema,
  horizontalAccuracy: z.number().nonnegative(),
  capturedAt: z.string().datetime(),
  placeId: PlaceIdSchema.nullable(),
});

export const LocationHistoryResponseSchema = z.object({
  userId: UserIdSchema,
  points: z.array(HistoryPointSchema),
  nextCursor: z.string().nullable(),
});
export type LocationHistoryResponse = z.infer<typeof LocationHistoryResponseSchema>;

export const HistoryQuerySchema = z.object({
  from: z.string().datetime(),
  to: z.string().datetime(),
  pageSize: z.number().int().positive().max(LIMITS.MAX_HISTORY_PAGE_SIZE).optional(),
  cursor: z.string().optional(),
});
export type HistoryQuery = z.infer<typeof HistoryQuerySchema>;

// ---------------------------------------------------------------------------
// Saved places
// ---------------------------------------------------------------------------

export const SavedPlaceListResponseSchema = z.object({
  places: z.array(SavedPlaceSchema),
});
export type SavedPlaceListResponse = z.infer<typeof SavedPlaceListResponseSchema>;

export const CreateSavedPlaceRequestSchema = z.object({
  name: z.string().min(1).max(80),
  category: PlaceCategorySchema,
  latitude: LatitudeSchema,
  longitude: LongitudeSchema,
  radiusMeters: z.number().min(50).max(10_000),
  notifyOnArrival: z.boolean(),
  notifyOnDeparture: z.boolean(),
});
export type CreateSavedPlaceRequest = z.infer<typeof CreateSavedPlaceRequestSchema>;

export const UpdateSavedPlaceRequestSchema = CreateSavedPlaceRequestSchema.partial();
export type UpdateSavedPlaceRequest = z.infer<typeof UpdateSavedPlaceRequestSchema>;

// ---------------------------------------------------------------------------
// Sharing
// ---------------------------------------------------------------------------

export const SharingStateResponseSchema = z.object({
  userId: UserIdSchema,
  familyId: FamilyIdSchema,
  status: SharingStatusSchema,
  pausedUntil: z.string().datetime().nullable(),
  updatedAt: z.string().datetime(),
});
export type SharingStateResponse = z.infer<typeof SharingStateResponseSchema>;

export const PauseSharingRequestSchema = z.object({
  /** Null pauses indefinitely until the user resumes. */
  durationMinutes: z
    .number()
    .int()
    .positive()
    .max(24 * 60)
    .nullable(),
});
export type PauseSharingRequest = z.infer<typeof PauseSharingRequestSchema>;

// ---------------------------------------------------------------------------
// Family
// ---------------------------------------------------------------------------

export const FamilyMemberSchema = z.object({
  userId: UserIdSchema,
  displayName: z.string(),
  role: FamilyRoleSchema,
  status: MembershipStatusSchema,
  sharingStatus: SharingStatusSchema,
  joinedAt: z.string().datetime(),
});
export type FamilyMember = z.infer<typeof FamilyMemberSchema>;

export const FamilyResponseSchema = z.object({
  familyId: FamilyIdSchema,
  name: z.string(),
  members: z.array(FamilyMemberSchema),
  createdAt: z.string().datetime(),
});
export type FamilyResponse = z.infer<typeof FamilyResponseSchema>;

// ---------------------------------------------------------------------------
// Subscription
// ---------------------------------------------------------------------------

/**
 * Typed against the contract's `Entitlements` so a new entitlement flag is a
 * compile error here until the wire schema learns about it.
 */
export const EntitlementsSchema: z.ZodType<Entitlements> = z.object({
  tier: PlanTierSchema,
  maxFamilies: z.number().int().nonnegative(),
  maxMembersPerFamily: z.number().int().nonnegative(),
  maxSavedPlaces: z.number().int().nonnegative(),
  historyRetentionDays: z.number().int().nonnegative(),
  liveSessionsEnabled: z.boolean(),
  arrivalDepartureAlerts: z.boolean(),
  prioritySupport: z.boolean(),
});

export const SubscriptionResponseSchema = z.object({
  plan: PlanSchema,
  tier: PlanTierSchema,
  status: SubscriptionStatusSchema,
  entitlements: EntitlementsSchema,
  expiresAt: z.string().datetime().nullable(),
  autoRenewEnabled: z.boolean(),
});
export type SubscriptionResponse = z.infer<typeof SubscriptionResponseSchema>;

// ---------------------------------------------------------------------------
// Devices and health
// ---------------------------------------------------------------------------

export const RegisterDeviceRequestSchema = z.object({
  deviceId: DeviceIdSchema,
  platform: z.enum(['ios', 'android']),
  osVersion: z.string(),
  appVersion: z.string(),
  /** Opaque push handle; treated as a credential by the redaction layer. */
  pushToken: z.string().nullable(),
});
export type RegisterDeviceRequest = z.infer<typeof RegisterDeviceRequestSchema>;

export const RegisterDeviceResponseSchema = z.object({
  deviceId: DeviceIdSchema,
  registeredAt: z.string().datetime(),
  remoteConfigVersion: z.number().int().nonnegative(),
});
export type RegisterDeviceResponse = z.infer<typeof RegisterDeviceResponseSchema>;
