import { z } from 'zod';

import {
  AuditActionSchema,
  DeviceIdSchema,
  FamilyIdSchema,
  PlanSchema,
  PlanTierSchema,
  SharingStatusSchema,
  SubscriptionStatusSchema,
  TrackingStateSchema,
  UserIdSchema,
} from '@family/contracts';

/**
 * Wire contracts for the endpoints backing the settings, privacy and billing
 * surface.
 *
 * WHY THESE LIVE HERE
 * -------------------
 * `@family/schemas` owns the canonical request/response shapes, but its barrel
 * (`src/index.ts`) is not published yet, so importing it would not compile.
 * Every field below is deliberately built from `@family/contracts` primitives —
 * the enums, ids and limits are never re-spelled locally — so that when the
 * schemas barrel lands, this module can be deleted and its imports repointed
 * without a single shape changing. Anything that IS re-spelled here (display
 * names, timestamps) is a scalar with no domain meaning.
 *
 * PRIVACY INVARIANT
 * -----------------
 * Not one schema in this file carries a latitude, a longitude, an accuracy
 * radius, a place coordinate or a street address. The settings surface renders
 * *who*, *when* and *why* — never *where*. The map is the only place in the
 * product allowed to hold a coordinate, and it does not read from here.
 */

// ---------------------------------------------------------------------------
// Shared scalars
// ---------------------------------------------------------------------------

const IsoDateTime = z.string().datetime();
const DisplayName = z.string().min(1).max(80);
const AvatarUrl = z.string().url().max(2048);

/** Opaque, server-issued pagination cursor. Never parsed on the client. */
const Cursor = z.string().min(1).max(512);

export const PageInfoSchema = z.object({
  nextCursor: Cursor.nullable(),
  hasMore: z.boolean(),
});
export type PageInfo = z.infer<typeof PageInfoSchema>;

// ---------------------------------------------------------------------------
// GET /v1/privacy/audit — "who has seen my location"
// ---------------------------------------------------------------------------

/**
 * The audit actions that answer "did somebody look at where I am?". Derived
 * from the contract enum, so an action added upstream is a compile error here
 * rather than a row that silently never renders.
 */
export const LOCATION_ACCESS_ACTIONS = [
  'LOCATION_CURRENT_READ',
  'LOCATION_HISTORY_READ',
  'LIVE_SESSION_REQUESTED',
  'LIVE_SESSION_ACCEPTED',
  'LIVE_SESSION_REJECTED',
  'LIVE_SESSION_STOPPED',
] as const satisfies ReadonlyArray<z.infer<typeof AuditActionSchema>>;

export type LocationAccessAction = (typeof LOCATION_ACCESS_ACTIONS)[number];

/**
 * Why the actor was looking. Coarse and enumerated: free text could be used to
 * smuggle a place name or an address past the privacy review.
 */
export const AuditAccessReasonSchema = z.enum([
  'OPENED_FAMILY_MAP',
  'OPENED_MEMBER_CARD',
  'ARRIVAL_ALERT',
  'DEPARTURE_ALERT',
  'LIVE_SESSION',
  'HISTORY_REVIEW',
  'SUPPORT_INVESTIGATION',
  'AUTOMATED_SAFETY_CHECK',
]);
export type AuditAccessReason = z.infer<typeof AuditAccessReasonSchema>;

/** What the actor actually received. A blocked attempt is still shown. */
export const AuditAccessOutcomeSchema = z.enum([
  'LOCATION_SHOWN',
  'BLOCKED_PAUSED',
  'BLOCKED_NOT_SHARING',
  'BLOCKED_NOT_AUTHORISED',
]);
export type AuditAccessOutcome = z.infer<typeof AuditAccessOutcomeSchema>;

export const PrivacyAuditEntrySchema = z.object({
  auditId: z.string().uuid(),
  action: AuditActionSchema,
  /** Null when the platform itself acted (scheduled alert, retention job). */
  actorUserId: UserIdSchema.nullable(),
  actorDisplayName: DisplayName,
  actorAvatarUrl: AvatarUrl.nullable(),
  familyId: FamilyIdSchema.nullable(),
  familyName: z.string().min(1).max(80).nullable(),
  reason: AuditAccessReasonSchema,
  outcome: AuditAccessOutcomeSchema,
  occurredAt: IsoDateTime,
  /** Quotable by the user to support without leaking anything. */
  requestId: z.string().min(1).max(128),
});
export type PrivacyAuditEntry = z.infer<typeof PrivacyAuditEntrySchema>;

export const PrivacyAuditPageSchema = z.object({
  entries: z.array(PrivacyAuditEntrySchema),
  pageInfo: PageInfoSchema,
  /** How far back the audit trail itself is retained, in days. */
  auditRetentionDays: z.number().int().nonnegative(),
});
export type PrivacyAuditPage = z.infer<typeof PrivacyAuditPageSchema>;

// ---------------------------------------------------------------------------
// GET /v1/sharing  ·  PATCH /v1/sharing  ·  POST /v1/sharing/pause|resume
// ---------------------------------------------------------------------------

export const MemberSharingRuleSchema = z.object({
  familyId: FamilyIdSchema,
  familyName: z.string().min(1).max(80),
  memberUserId: UserIdSchema,
  memberDisplayName: DisplayName,
  memberAvatarUrl: AvatarUrl.nullable(),
  /** Whether *this* member may see me. The user controls this per person. */
  visibleToMember: z.boolean(),
  /** Whether that member currently shares back. Informational, not a control. */
  memberSharesWithMe: z.boolean(),
  updatedAt: IsoDateTime,
});
export type MemberSharingRule = z.infer<typeof MemberSharingRuleSchema>;

export const SharingSettingsSchema = z.object({
  /** The master switch. False means no family member can see me anywhere. */
  sharingEnabled: z.boolean(),
  status: SharingStatusSchema,
  /** Set while paused; null otherwise. Null with status PAUSED = paused until resumed. */
  pausedUntil: IsoDateTime.nullable(),
  pausedAt: IsoDateTime.nullable(),
  /** Per-person visibility, flattened across every family the user belongs to. */
  memberRules: z.array(MemberSharingRuleSchema),
  updatedAt: IsoDateTime,
});
export type SharingSettings = z.infer<typeof SharingSettingsSchema>;

export const UpdateSharingRequestSchema = z.object({
  sharingEnabled: z.boolean().optional(),
  memberRules: z
    .array(
      z.object({
        familyId: FamilyIdSchema,
        memberUserId: UserIdSchema,
        visibleToMember: z.boolean(),
      }),
    )
    .optional(),
});
export type UpdateSharingRequest = z.infer<typeof UpdateSharingRequestSchema>;

export const PauseSharingRequestSchema = z.object({
  /** Null pauses indefinitely — the user must come back and resume. */
  durationMinutes: z
    .number()
    .int()
    .positive()
    .max(24 * 60)
    .nullable(),
});
export type PauseSharingRequest = z.infer<typeof PauseSharingRequestSchema>;

// ---------------------------------------------------------------------------
// GET /v1/devices  ·  DELETE /v1/devices/{deviceId}
// ---------------------------------------------------------------------------

export const DevicePlatformSchema = z.enum(['IOS', 'ANDROID']);
export const DeviceStatusSchema = z.enum(['ACTIVE', 'INACTIVE', 'REVOKED']);

export const RegisteredDeviceSchema = z.object({
  deviceId: DeviceIdSchema,
  platform: DevicePlatformSchema,
  osVersion: z.string(),
  appVersion: z.string(),
  modelIdentifier: z.string(),
  deviceName: z.string().nullable(),
  status: DeviceStatusSchema,
  pushTokenRegistered: z.boolean(),
  trackingState: TrackingStateSchema,
  registeredAt: IsoDateTime,
  /** Last API contact, not a location time. */
  lastSeenAt: IsoDateTime.nullable(),
  isCurrentDevice: z.boolean(),
});
export type RegisteredDevice = z.infer<typeof RegisteredDeviceSchema>;

export const ListDevicesResponseSchema = z.object({
  devices: z.array(RegisteredDeviceSchema),
});
export type ListDevicesResponse = z.infer<typeof ListDevicesResponseSchema>;

export const RevokeDeviceResponseSchema = z.object({
  deviceId: DeviceIdSchema,
  status: z.literal('REVOKED'),
  revokedAt: IsoDateTime,
  /** Queued points on that device are discarded, never uploaded after revoke. */
  discardedPendingEvents: z.boolean(),
});
export type RevokeDeviceResponse = z.infer<typeof RevokeDeviceResponseSchema>;

// ---------------------------------------------------------------------------
// GET /v1/notifications/preferences  ·  PATCH /v1/notifications/preferences
// ---------------------------------------------------------------------------

export const NotificationCategorySchema = z.enum([
  'ARRIVAL_DEPARTURE',
  'LIVE_SESSION_REQUEST',
  'SHARING_STATE_CHANGED',
  'FAMILY_MEMBERSHIP',
  'DEVICE_SECURITY',
  'LOW_BATTERY',
  'PRODUCT_NEWS',
]);
export type NotificationCategory = z.infer<typeof NotificationCategorySchema>;

/** "HH:MM" in the user's own time zone. */
export const LocalTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Must be a 24-hour HH:MM time.');

export const QuietHoursSchema = z.object({
  enabled: z.boolean(),
  startsAt: LocalTimeSchema,
  endsAt: LocalTimeSchema,
  /**
   * Safety-critical categories still break through. Silencing a live-session
   * request or a device-security alert would let quiet hours be weaponised.
   */
  allowCriticalAlerts: z.boolean(),
});
export type QuietHours = z.infer<typeof QuietHoursSchema>;

export const NotificationPreferencesSchema = z.object({
  categories: z.record(NotificationCategorySchema, z.boolean()),
  quietHours: QuietHoursSchema,
  timeZone: z.string().min(3).max(64),
  updatedAt: IsoDateTime,
});
export type NotificationPreferences = z.infer<typeof NotificationPreferencesSchema>;

/**
 * Categories are patched as an explicit list rather than a partial map so the
 * request is unambiguous: an absent category means "leave it alone", never
 * "turn it off".
 */
export const UpdateNotificationPreferencesRequestSchema = z.object({
  categories: z
    .array(
      z.object({
        category: NotificationCategorySchema,
        enabled: z.boolean(),
      }),
    )
    .optional(),
  quietHours: QuietHoursSchema.optional(),
});
export type UpdateNotificationPreferencesRequest = z.infer<
  typeof UpdateNotificationPreferencesRequestSchema
>;

// ---------------------------------------------------------------------------
// Data and history
// ---------------------------------------------------------------------------

export const DataRetentionSummarySchema = z.object({
  /** 0 on FREE: nothing is kept beyond the last known position. */
  historyRetentionDays: z.number().int().nonnegative(),
  auditRetentionDays: z.number().int().nonnegative(),
  /** Coarse counts only — never the points themselves. */
  storedLocationPointCount: z.number().int().nonnegative(),
  oldestStoredPointAt: IsoDateTime.nullable(),
  lastHistoryDeletionAt: IsoDateTime.nullable(),
});
export type DataRetentionSummary = z.infer<typeof DataRetentionSummarySchema>;

export const DeleteHistoryRequestSchema = z.object({
  confirmation: z.literal('DELETE'),
  /** Null deletes everything the user has stored. */
  familyId: FamilyIdSchema.nullable(),
});
export type DeleteHistoryRequest = z.infer<typeof DeleteHistoryRequestSchema>;

export const DeleteHistoryResponseSchema = z.object({
  deletedPointCount: z.number().int().nonnegative(),
  deletedAt: IsoDateTime,
});
export type DeleteHistoryResponse = z.infer<typeof DeleteHistoryResponseSchema>;

export const DataExportStatusSchema = z.enum(['PENDING', 'READY', 'FAILED', 'EXPIRED']);

export const DataExportSchema = z.object({
  exportId: z.string().uuid(),
  status: DataExportStatusSchema,
  requestedAt: IsoDateTime,
  /** Signed, short-lived, single-use. Null until the export is READY. */
  downloadUrl: z.string().url().max(2048).nullable(),
  expiresAt: IsoDateTime.nullable(),
});
export type DataExport = z.infer<typeof DataExportSchema>;

// ---------------------------------------------------------------------------
// DELETE /v1/account (spec §16)
// ---------------------------------------------------------------------------

export const AccountDeletionReasonSchema = z.enum([
  'NO_LONGER_NEEDED',
  'PRIVACY_CONCERN',
  'TOO_EXPENSIVE',
  'SWITCHING_APP',
  'BATTERY_USAGE',
  'OTHER',
]);
export type AccountDeletionReason = z.infer<typeof AccountDeletionReasonSchema>;

export const DeleteAccountRequestSchema = z.object({
  /** Typed confirmation so a mis-routed request cannot destroy an account. */
  confirmation: z.literal('DELETE'),
  reason: AccountDeletionReasonSchema,
  feedback: z.string().max(1000).nullable(),
});
export type DeleteAccountRequest = z.infer<typeof DeleteAccountRequestSchema>;

export const DeleteAccountResponseSchema = z.object({
  userId: UserIdSchema,
  status: z.literal('PENDING_DELETION'),
  requestedAt: IsoDateTime,
  /** Hard purge time. Signing in before this cancels the deletion. */
  scheduledPurgeAt: IsoDateTime,
  gracePeriodDays: z.number().int().positive(),
  affectedFamilyIds: z.array(FamilyIdSchema),
});
export type DeleteAccountResponse = z.infer<typeof DeleteAccountResponseSchema>;

/**
 * Everything the user must be told BEFORE the confirm button unlocks. Computed
 * server-side because only the server knows what the user owns.
 */
export const AccountDeletionPreviewSchema = z.object({
  ownedFamilies: z.array(
    z.object({
      familyId: FamilyIdSchema,
      name: z.string().min(1).max(80),
      memberCount: z.number().int().nonnegative(),
      /** True when the family is dissolved rather than handed over. */
      willBeDissolved: z.boolean(),
    }),
  ),
  memberFamilyCount: z.number().int().nonnegative(),
  storedLocationPointCount: z.number().int().nonnegative(),
  savedPlaceCount: z.number().int().nonnegative(),
  registeredDeviceCount: z.number().int().nonnegative(),
  /** Store subscriptions are NOT cancelled by deleting the account. */
  hasActiveSubscription: z.boolean(),
  subscriptionStore: z.enum(['APP_STORE', 'PLAY_STORE', 'NONE']),
  gracePeriodDays: z.number().int().positive(),
});
export type AccountDeletionPreview = z.infer<typeof AccountDeletionPreviewSchema>;

// ---------------------------------------------------------------------------
// GET /v1/subscriptions/entitlements — the ONLY authority on what a user has
// ---------------------------------------------------------------------------

export const ServerEntitlementsSchema = z.object({
  tier: PlanTierSchema,
  plan: PlanSchema,
  status: SubscriptionStatusSchema,
  /** Null on FREE, or when the store has not reported a renewal date. */
  renewsAt: IsoDateTime.nullable(),
  expiresAt: IsoDateTime.nullable(),
  willRenew: z.boolean(),
  isInGracePeriod: z.boolean(),
  store: z.enum(['APP_STORE', 'PLAY_STORE', 'PROMOTIONAL', 'NONE']),
  /** Echoed so the client can tell a stale cache from a stale server view. */
  evaluatedAt: IsoDateTime,
});
export type ServerEntitlements = z.infer<typeof ServerEntitlementsSchema>;

export const SyncSubscriptionRequestSchema = z.object({
  /** RevenueCat app user id, so the server can reconcile out of band. */
  revenueCatAppUserId: z.string().min(1).max(256),
});
export type SyncSubscriptionRequest = z.infer<typeof SyncSubscriptionRequestSchema>;

// ---------------------------------------------------------------------------
// Support and abuse reporting
// ---------------------------------------------------------------------------

export const SupportTopicSchema = z.enum([
  'LOCATION_NOT_UPDATING',
  'BATTERY_USAGE',
  'NOTIFICATIONS',
  'BILLING',
  'ACCOUNT_ACCESS',
  'FAMILY_MANAGEMENT',
  'PRIVACY_QUESTION',
  'OTHER',
]);
export type SupportTopic = z.infer<typeof SupportTopicSchema>;

export const CreateSupportTicketRequestSchema = z.object({
  topic: SupportTopicSchema,
  message: z.string().min(10).max(4000),
  /**
   * Opt-in, and explicitly labelled in the UI. Contains device health and app
   * version only; `buildDiagnosticsAttachment` strips everything else.
   */
  includeDiagnostics: z.boolean(),
  diagnostics: z
    .object({
      appVersion: z.string().max(40),
      platform: DevicePlatformSchema,
      osVersion: z.string().max(40),
      trackingState: TrackingStateSchema,
      pendingEventCount: z.number().int().nonnegative(),
      permissionSummary: z.string().max(200),
    })
    .nullable(),
});
export type CreateSupportTicketRequest = z.infer<typeof CreateSupportTicketRequestSchema>;

export const SupportTicketSchema = z.object({
  ticketId: z.string().uuid(),
  topic: SupportTopicSchema,
  status: z.enum(['OPEN', 'IN_PROGRESS', 'RESOLVED']),
  createdAt: IsoDateTime,
  /** Higher tiers get a faster promise; shown so the user knows what to expect. */
  firstResponseTargetHours: z.number().int().positive(),
});
export type SupportTicket = z.infer<typeof SupportTicketSchema>;

/*
 * ABUSE REPORTING DOES NOT LIVE HERE.
 *
 * This module used to declare a second, incompatible abuse contract: the
 * categories `ADDED_WITHOUT_CONSENT`, `COERCED_TO_SHARE` and `CHILD_SAFETY`,
 * none of which `POST /v1/support/reports` accepts, and a response shape
 * (`sharingStopped`, `userBlocked`, `reviewTargetHours`) the endpoint has never
 * returned. Every report sent through it would have been rejected by the strict
 * enum on the way in, and if one had somehow been accepted the response would
 * have failed to parse on the way out.
 *
 * Nothing called it, so nothing broke — it was a working-looking path that had
 * never run. Removed rather than corrected, because there should be one report
 * path and there already is: `familyApi.reportAccount`, which uses
 * `AbuseCategorySchema` from `@family/schemas` — the schema the deployed API
 * validates against.
 */
