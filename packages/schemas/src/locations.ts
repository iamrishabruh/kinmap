import { z } from 'zod';

import {
  DeviceIdSchema,
  EventIdSchema,
  FamilyIdSchema,
  FreshnessSchema,
  LIMITS,
  MotionStateSchema,
  PlaceIdSchema,
  TrackingStateSchema,
  UserIdSchema,
} from '@family/contracts';

import {
  CursorSchema,
  HiddenSharingStatusSchema,
  IsoDateTimeSchema,
  LocationPointSchema,
  PageInfoSchema,
  StrictDeviceLocationHealthSchema,
  StrictLocationEventSchema,
} from './common.js';

/**
 * Location endpoints.
 *
 * `POST /v1/locations/batch`
 * `GET  /v1/families/{familyId}/locations/current`
 * `GET  /v1/users/{userId}/locations/history`
 *
 * Read authorisation is server-side only: family membership AND the target's
 * sharing status. A caller who fails either check gets an opaque FORBIDDEN, so
 * the HIDDEN arms below exist for members who are visible in the family list
 * but have deliberately paused — never as a probe channel.
 */

const MILLISECONDS_PER_DAY = 86_400_000;

// ---------------------------------------------------------------------------
// Rejection reasons
//
// Shared with @family/validation. Every value is a coordinate-free, digit-free
// constant so it is safe to log, emit as a metric dimension, and return to the
// uploading device.
// ---------------------------------------------------------------------------

export const LocationRejectionReasonSchema = z.enum([
  'MALFORMED_EVENT',
  'COORDINATE_OUT_OF_RANGE',
  'ACCURACY_INVALID',
  'ACCURACY_OUT_OF_BOUNDS',
  'TIMESTAMP_MALFORMED',
  'TIMESTAMP_IN_FUTURE',
  'TIMESTAMP_TOO_OLD',
  'IMPLAUSIBLE_SPEED',
  'DUPLICATE_EVENT',
  'TRACKING_STATE_NOT_SHAREABLE',
  'SHARING_NOT_ACTIVE',
  'DEVICE_NOT_REGISTERED',
  'DEVICE_REVOKED',
]);
export type LocationRejectionReason = z.infer<typeof LocationRejectionReasonSchema>;

export const LOCATION_REJECTION_REASONS = LocationRejectionReasonSchema.options;

// ---------------------------------------------------------------------------
// POST /v1/locations/batch
// ---------------------------------------------------------------------------

export const LocationBatchRequestSchema = z
  .strictObject({
    deviceId: DeviceIdSchema,
    uploadedAt: IsoDateTimeSchema,
    events: z
      .array(StrictLocationEventSchema)
      .min(1)
      .max(LIMITS.MAX_EVENTS_PER_BATCH, 'Too many events in one batch.'),
    /** Piggy-backed diagnostics so the app does not need a second round trip. */
    health: StrictDeviceLocationHealthSchema.optional(),
    /** Remote-config version the device applied when capturing this batch. */
    configVersion: z.number().int().nonnegative().nullable().default(null),
  })
  .refine((batch) => batch.events.every((event) => event.deviceId === batch.deviceId), {
    message: 'Every event must belong to the uploading device.',
    path: ['events'],
  });
export type LocationBatchRequest = z.infer<typeof LocationBatchRequestSchema>;

export const RejectedLocationEventSchema = z.strictObject({
  eventId: EventIdSchema,
  reason: LocationRejectionReasonSchema,
});
export type RejectedLocationEvent = z.infer<typeof RejectedLocationEventSchema>;

export const LocationBatchResponseSchema = z.strictObject({
  acceptedCount: z.number().int().nonnegative(),
  rejectedCount: z.number().int().nonnegative(),
  /** Per-event outcome so the device can drop bad points instead of retrying. */
  rejected: z.array(RejectedLocationEventSchema),
  /** Highest sequence number durably stored; the device truncates below it. */
  highWaterMarkSequenceNumber: z.number().int().nonnegative().nullable(),
  serverTime: IsoDateTimeSchema,
  nextUploadAfterSeconds: z.number().int().positive(),
  /** Non-null when the device is running stale remote configuration. */
  configVersionAvailable: z.number().int().nonnegative().nullable(),
});
export type LocationBatchResponse = z.infer<typeof LocationBatchResponseSchema>;

// ---------------------------------------------------------------------------
// GET /v1/families/{familyId}/locations/current
// ---------------------------------------------------------------------------

export const FamilyLocationsPathSchema = z.strictObject({
  familyId: FamilyIdSchema,
});
export type FamilyLocationsPath = z.infer<typeof FamilyLocationsPathSchema>;

export const CurrentLocationsQuerySchema = z.strictObject({
  /** Restrict to specific members; omit for the whole family. */
  userIds: z.array(UserIdSchema).max(LIMITS.MAX_FAMILY_MEMBERS).optional(),
});
export type CurrentLocationsQuery = z.infer<typeof CurrentLocationsQuerySchema>;

/**
 * The single response shape that carries a coordinate. It is only constructible
 * with `sharingStatus: 'SHARING'`, so a paused member's position cannot be
 * represented in this type at all.
 */
export const VisibleMemberLocationSchema = z.strictObject({
  visibility: z.literal('VISIBLE'),
  userId: UserIdSchema,
  sharingStatus: z.literal('SHARING'),
  point: LocationPointSchema,
  freshness: FreshnessSchema,
  capturedAt: IsoDateTimeSchema,
  receivedAt: IsoDateTimeSchema,
  trackingState: TrackingStateSchema,
  motionState: MotionStateSchema,
  batteryLevel: z.number().min(0).max(1).nullable(),
  isCharging: z.boolean().nullable(),
  /** Resolved saved place when the point falls inside one; never an address. */
  placeId: PlaceIdSchema.nullable(),
  placeName: z.string().min(1).max(80).nullable(),
  /** Set while a live session is running against this member. */
  liveSessionExpiresAt: IsoDateTimeSchema.nullable(),
});
export type VisibleMemberLocation = z.infer<typeof VisibleMemberLocationSchema>;

/**
 * A member the caller may see in the family list but whose position is not
 * shared. Structurally has no coordinate field — and being strict, it rejects
 * one if a service ever tries to attach it.
 */
export const HiddenMemberLocationSchema = z.strictObject({
  visibility: z.literal('HIDDEN'),
  userId: UserIdSchema,
  sharingStatus: HiddenSharingStatusSchema,
  freshness: z.literal('UNKNOWN'),
  /** When sharing last stopped. Coarse, and null when it never started. */
  sharingChangedAt: IsoDateTimeSchema.nullable(),
});
export type HiddenMemberLocation = z.infer<typeof HiddenMemberLocationSchema>;

export const MemberCurrentLocationSchema = z.discriminatedUnion('visibility', [
  VisibleMemberLocationSchema,
  HiddenMemberLocationSchema,
]);
export type MemberCurrentLocation = z.infer<typeof MemberCurrentLocationSchema>;

export const CurrentLocationsResponseSchema = z.strictObject({
  familyId: FamilyIdSchema,
  generatedAt: IsoDateTimeSchema,
  members: z.array(MemberCurrentLocationSchema),
});
export type CurrentLocationsResponse = z.infer<typeof CurrentLocationsResponseSchema>;

// ---------------------------------------------------------------------------
// GET /v1/users/{userId}/locations/history
// ---------------------------------------------------------------------------

export const UserLocationHistoryPathSchema = z.strictObject({
  userId: UserIdSchema,
});
export type UserLocationHistoryPath = z.infer<typeof UserLocationHistoryPathSchema>;

export const LocationHistoryQuerySchema = z
  .strictObject({
    from: IsoDateTimeSchema,
    to: IsoDateTimeSchema,
    cursor: CursorSchema.nullable().default(null),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(LIMITS.MAX_HISTORY_PAGE_SIZE)
      .default(LIMITS.DEFAULT_HISTORY_PAGE_SIZE),
    /**
     * Optional scoping to one family the caller and target both belong to.
     * When omitted the server still authorises against every shared family —
     * it never widens the read, it only avoids a second round trip.
     */
    familyId: FamilyIdSchema.nullable().default(null),
  })
  .refine((query) => Date.parse(query.from) < Date.parse(query.to), {
    message: 'The start of the range must be before its end.',
    path: ['from'],
  })
  .refine(
    (query) =>
      Date.parse(query.to) - Date.parse(query.from) <=
      LIMITS.MAX_HISTORY_RANGE_DAYS * MILLISECONDS_PER_DAY,
    {
      message: 'The requested history range is longer than the maximum allowed window.',
      path: ['to'],
    },
  );
export type LocationHistoryQuery = z.infer<typeof LocationHistoryQuerySchema>;

export const LocationHistoryPointSchema = z.strictObject({
  eventId: EventIdSchema,
  point: LocationPointSchema,
  capturedAt: IsoDateTimeSchema,
  trackingState: TrackingStateSchema,
  motionState: MotionStateSchema,
  placeId: PlaceIdSchema.nullable(),
});
export type LocationHistoryPoint = z.infer<typeof LocationHistoryPointSchema>;

export const VisibleLocationHistoryResponseSchema = z.strictObject({
  visibility: z.literal('VISIBLE'),
  userId: UserIdSchema,
  familyId: FamilyIdSchema.nullable(),
  from: IsoDateTimeSchema,
  to: IsoDateTimeSchema,
  points: z.array(LocationHistoryPointSchema),
  page: PageInfoSchema,
  /** Plan-derived retention, so the client can explain a short window. */
  retentionDays: z.number().int().nonnegative(),
});
export type VisibleLocationHistoryResponse = z.infer<typeof VisibleLocationHistoryResponseSchema>;

/**
 * History for a member who is in the family but not sharing. `points` is typed
 * as an always-empty array (`never[]`), so no coordinate can be attached even
 * by mistake.
 */
export const HiddenLocationHistoryResponseSchema = z.strictObject({
  visibility: z.literal('HIDDEN'),
  userId: UserIdSchema,
  familyId: FamilyIdSchema.nullable(),
  from: IsoDateTimeSchema,
  to: IsoDateTimeSchema,
  sharingStatus: HiddenSharingStatusSchema,
  points: z.array(z.never()).max(0),
  page: PageInfoSchema,
  retentionDays: z.number().int().nonnegative(),
});
export type HiddenLocationHistoryResponse = z.infer<typeof HiddenLocationHistoryResponseSchema>;

export const LocationHistoryResponseSchema = z.discriminatedUnion('visibility', [
  VisibleLocationHistoryResponseSchema,
  HiddenLocationHistoryResponseSchema,
]);
export type LocationHistoryResponse = z.infer<typeof LocationHistoryResponseSchema>;
