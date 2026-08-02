import { z } from 'zod';

import {
  FamilyIdSchema,
  GeofenceTransitionSchema,
  PlaceIdSchema,
  SessionIdSchema,
  UserIdSchema,
} from '@family/contracts';

import { DisplayNameSchema, IsoDateTimeSchema } from './common.js';

/**
 * Notification endpoints.
 *
 * `GET   /v1/notifications/preferences`
 * `PATCH /v1/notifications/preferences`
 * `GET   /v1/notifications`
 * `POST  /v1/notifications/read`
 *
 * PUSH PAYLOAD RULE: a push notification leaves our infrastructure and passes
 * through APNs/FCM. `PushPayloadSchema` is strict and contains no latitude,
 * longitude, geohash, or address — only an event kind, actor/target ids, and a
 * saved place *name* the recipient already knows. Anything richer is fetched by
 * the app over an authenticated, authorised API call after the tap.
 */

export const NotificationKindSchema = z.enum([
  'ARRIVAL',
  'DEPARTURE',
  'LIVE_SESSION_REQUESTED',
  'LIVE_SESSION_ACCEPTED',
  'LIVE_SESSION_REJECTED',
  'LIVE_SESSION_ENDED',
  'MEMBER_JOINED',
  'MEMBER_LEFT',
  'INVITATION_ACCEPTED',
  'SHARING_PAUSED',
  'SHARING_RESUMED',
  'LOCATION_STALE',
  'PERMISSION_LOST',
  'BATTERY_CRITICAL',
  'SUBSCRIPTION_EXPIRING',
]);
export type NotificationKind = z.infer<typeof NotificationKindSchema>;

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

export const NotificationChannelPreferenceSchema = z.strictObject({
  push: z.boolean(),
  inApp: z.boolean(),
});
export type NotificationChannelPreference = z.infer<typeof NotificationChannelPreferenceSchema>;

export const QuietHoursSchema = z.strictObject({
  enabled: z.boolean(),
  /** Local wall-clock time in the member's device time zone. */
  startMinuteOfDay: z.number().int().min(0).max(1439),
  endMinuteOfDay: z.number().int().min(0).max(1439),
});
export type QuietHours = z.infer<typeof QuietHoursSchema>;

export const NotificationPreferencesSchema = z.strictObject({
  userId: UserIdSchema,
  arrivals: NotificationChannelPreferenceSchema,
  departures: NotificationChannelPreferenceSchema,
  liveSessions: NotificationChannelPreferenceSchema,
  membership: NotificationChannelPreferenceSchema,
  sharingChanges: NotificationChannelPreferenceSchema,
  deviceHealth: NotificationChannelPreferenceSchema,
  billing: NotificationChannelPreferenceSchema,
  quietHours: QuietHoursSchema,
  /** Per-family mute, so one noisy family does not silence the others. */
  mutedFamilyIds: z.array(FamilyIdSchema),
  mutedUserIds: z.array(UserIdSchema),
  updatedAt: IsoDateTimeSchema,
});
export type NotificationPreferences = z.infer<typeof NotificationPreferencesSchema>;

export const GetNotificationPreferencesResponseSchema = z.strictObject({
  preferences: NotificationPreferencesSchema,
});
export type GetNotificationPreferencesResponse = z.infer<
  typeof GetNotificationPreferencesResponseSchema
>;

export const UpdateNotificationPreferencesRequestSchema = z
  .strictObject({
    arrivals: NotificationChannelPreferenceSchema.optional(),
    departures: NotificationChannelPreferenceSchema.optional(),
    liveSessions: NotificationChannelPreferenceSchema.optional(),
    membership: NotificationChannelPreferenceSchema.optional(),
    sharingChanges: NotificationChannelPreferenceSchema.optional(),
    deviceHealth: NotificationChannelPreferenceSchema.optional(),
    billing: NotificationChannelPreferenceSchema.optional(),
    quietHours: QuietHoursSchema.optional(),
    mutedFamilyIds: z.array(FamilyIdSchema).max(16).optional(),
    mutedUserIds: z.array(UserIdSchema).max(64).optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, {
    message: 'At least one field must be provided.',
  });
export type UpdateNotificationPreferencesRequest = z.infer<
  typeof UpdateNotificationPreferencesRequestSchema
>;

export const UpdateNotificationPreferencesResponseSchema = GetNotificationPreferencesResponseSchema;
export type UpdateNotificationPreferencesResponse = z.infer<
  typeof UpdateNotificationPreferencesResponseSchema
>;

// ---------------------------------------------------------------------------
// Push payload (server -> APNs/FCM -> device)
// ---------------------------------------------------------------------------

/**
 * Deliberately coordinate-free. Strict, so a future contributor who tries to
 * attach `latitude` gets a parse failure in the unit tests rather than a silent
 * privacy regression in production.
 */
export const PushPayloadSchema = z.strictObject({
  kind: NotificationKindSchema,
  notificationId: z.string().uuid(),
  familyId: FamilyIdSchema.nullable(),
  /** Who the notification is about. Ids only; the app resolves the profile. */
  subjectUserId: UserIdSchema.nullable(),
  subjectDisplayName: DisplayNameSchema.nullable(),
  /** Saved place the recipient's own family authored — a name, never a point. */
  placeId: PlaceIdSchema.nullable(),
  placeName: z.string().min(1).max(80).nullable(),
  transition: GeofenceTransitionSchema.nullable(),
  liveSessionId: SessionIdSchema.nullable(),
  occurredAt: IsoDateTimeSchema,
  /** Deep link path within the app. Never carries query-string coordinates. */
  deepLinkPath: z
    .string()
    .max(256)
    .regex(/^\/[A-Za-z0-9/_-]*$/, 'Must be an in-app path without query parameters.')
    .nullable(),
});
export type PushPayload = z.infer<typeof PushPayloadSchema>;

// ---------------------------------------------------------------------------
// GET /v1/notifications
// ---------------------------------------------------------------------------

export const NotificationSchema = z.strictObject({
  notificationId: z.string().uuid(),
  kind: NotificationKindSchema,
  familyId: FamilyIdSchema.nullable(),
  subjectUserId: UserIdSchema.nullable(),
  placeId: PlaceIdSchema.nullable(),
  /** Pre-rendered, user-safe copy. Contains no coordinates. */
  title: z.string().min(1).max(120),
  body: z.string().min(1).max(300),
  occurredAt: IsoDateTimeSchema,
  readAt: IsoDateTimeSchema.nullable(),
});
export type Notification = z.infer<typeof NotificationSchema>;

export const ListNotificationsResponseSchema = z.strictObject({
  notifications: z.array(NotificationSchema),
  unreadCount: z.number().int().nonnegative(),
});
export type ListNotificationsResponse = z.infer<typeof ListNotificationsResponseSchema>;

export const MarkNotificationsReadRequestSchema = z.strictObject({
  notificationIds: z.array(z.string().uuid()).min(1).max(200),
});
export type MarkNotificationsReadRequest = z.infer<typeof MarkNotificationsReadRequestSchema>;

export const MarkNotificationsReadResponseSchema = z.strictObject({
  readCount: z.number().int().nonnegative(),
  unreadCount: z.number().int().nonnegative(),
});
export type MarkNotificationsReadResponse = z.infer<typeof MarkNotificationsReadResponseSchema>;
