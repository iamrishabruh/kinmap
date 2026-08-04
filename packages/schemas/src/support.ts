import { z } from 'zod';

import { AppEnvSchema, DeviceIdSchema, FamilyIdSchema, UserIdSchema } from '@family/contracts';

import {
  AppVersionSchema,
  IsoDateTimeSchema,
  PlatformSchema,
  StrictDeviceLocationHealthSchema,
} from './common.js';

/**
 * Support, abuse and safety endpoints.
 *
 * `POST   /v1/support/tickets`
 * `GET    /v1/support/tickets`
 * `POST   /v1/support/access-grants`
 * `DELETE /v1/support/access-grants/{grantId}`
 * `POST   /v1/support/reports`
 * `POST   /v1/support/blocks`
 * `DELETE /v1/support/blocks/{userId}`
 *
 * Support staff never get standing access to a user's data. A time-boxed grant,
 * created by the user, is the only path — and it never includes coordinates.
 */

// ---------------------------------------------------------------------------
// POST /v1/support/tickets
// ---------------------------------------------------------------------------

export const SupportTopicSchema = z.enum([
  'LOCATION_NOT_UPDATING',
  'BATTERY_DRAIN',
  'NOTIFICATIONS',
  'INVITATION_PROBLEM',
  'BILLING',
  'ACCOUNT_ACCESS',
  'PRIVACY_QUESTION',
  'OTHER',
]);
export type SupportTopic = z.infer<typeof SupportTopicSchema>;

/**
 * Diagnostics attached to a ticket. Device health carries permissions, battery
 * and queue depth — no coordinates — so it is safe to hand to an agent.
 */
export const SupportDiagnosticsSchema = z.strictObject({
  deviceId: DeviceIdSchema,
  platform: PlatformSchema,
  osVersion: z.string().min(1).max(40),
  appVersion: AppVersionSchema,
  appBuild: z.string().min(1).max(40),
  environment: AppEnvSchema,
  health: StrictDeviceLocationHealthSchema,
  /** Client-side request ids the user hit; used to find server logs. */
  recentRequestIds: z.array(z.string().min(1).max(128)).max(20),
});
export type SupportDiagnostics = z.infer<typeof SupportDiagnosticsSchema>;

export const CreateSupportTicketRequestSchema = z.strictObject({
  topic: SupportTopicSchema,
  subject: z.string().min(1).max(120),
  body: z.string().min(1).max(4000),
  familyId: FamilyIdSchema.nullable().default(null),
  diagnostics: SupportDiagnosticsSchema.optional(),
});
export type CreateSupportTicketRequest = z.infer<typeof CreateSupportTicketRequestSchema>;

export const SupportTicketStatusSchema = z.enum(['OPEN', 'AWAITING_USER', 'RESOLVED', 'CLOSED']);
export type SupportTicketStatus = z.infer<typeof SupportTicketStatusSchema>;

export const SupportTicketSchema = z.strictObject({
  ticketId: z.string().uuid(),
  topic: SupportTopicSchema,
  subject: z.string().min(1).max(120),
  status: SupportTicketStatusSchema,
  priority: z.enum(['STANDARD', 'PRIORITY']),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type SupportTicket = z.infer<typeof SupportTicketSchema>;

export const CreateSupportTicketResponseSchema = z.strictObject({
  ticket: SupportTicketSchema,
});
export type CreateSupportTicketResponse = z.infer<typeof CreateSupportTicketResponseSchema>;

export const ListSupportTicketsResponseSchema = z.strictObject({
  tickets: z.array(SupportTicketSchema),
});
export type ListSupportTicketsResponse = z.infer<typeof ListSupportTicketsResponseSchema>;

// ---------------------------------------------------------------------------
// POST /v1/support/access-grants
// ---------------------------------------------------------------------------

/**
 * What the user is willing to let an agent see. There is intentionally no
 * option to grant location access: no support scope can reveal a coordinate.
 */
export const SupportAccessScopeSchema = z.enum([
  'ACCOUNT_METADATA',
  'DEVICE_HEALTH',
  'SUBSCRIPTION',
  'FAMILY_MEMBERSHIP',
]);
export type SupportAccessScope = z.infer<typeof SupportAccessScopeSchema>;

export const CreateSupportAccessGrantRequestSchema = z.strictObject({
  ticketId: z.string().uuid(),
  scopes: z.array(SupportAccessScopeSchema).min(1).max(4),
  /** Hard-capped so a grant cannot quietly become permanent. */
  durationMinutes: z.number().int().min(15).max(1440).default(60),
});
export type CreateSupportAccessGrantRequest = z.infer<typeof CreateSupportAccessGrantRequestSchema>;

export const SupportAccessGrantSchema = z.strictObject({
  grantId: z.string().uuid(),
  ticketId: z.string().uuid(),
  userId: UserIdSchema,
  scopes: z.array(SupportAccessScopeSchema),
  grantedAt: IsoDateTimeSchema,
  expiresAt: IsoDateTimeSchema,
  revokedAt: IsoDateTimeSchema.nullable(),
});
export type SupportAccessGrant = z.infer<typeof SupportAccessGrantSchema>;

export const CreateSupportAccessGrantResponseSchema = z.strictObject({
  grant: SupportAccessGrantSchema,
});
export type CreateSupportAccessGrantResponse = z.infer<
  typeof CreateSupportAccessGrantResponseSchema
>;

export const SupportAccessGrantPathSchema = z.strictObject({
  grantId: z.string().uuid(),
});
export type SupportAccessGrantPath = z.infer<typeof SupportAccessGrantPathSchema>;

export const RevokeSupportAccessGrantResponseSchema = z.strictObject({
  grantId: z.string().uuid(),
  revokedAt: IsoDateTimeSchema,
});
export type RevokeSupportAccessGrantResponse = z.infer<
  typeof RevokeSupportAccessGrantResponseSchema
>;

// ---------------------------------------------------------------------------
// POST /v1/support/reports  — abuse reporting
// ---------------------------------------------------------------------------

export const AbuseCategorySchema = z.enum([
  'UNWANTED_TRACKING',
  'HARASSMENT',
  'IMPERSONATION',
  'COERCED_SHARING',
  'UNDERAGE_MISUSE',
  'OTHER',
]);
export type AbuseCategory = z.infer<typeof AbuseCategorySchema>;

/**
 * The categories after which the reporter is shown safety resources.
 *
 * Both are reports where the person filing may be in danger from someone who
 * can currently see them, so the response carries a link to help rather than
 * only an acknowledgement.
 *
 * Declared here, once, and typed as `AbuseCategory` so a category that is
 * renamed or removed fails to compile. It previously existed as two separate
 * string literals — a `Set<string>` in `services/api` and a `readonly string[]`
 * in `services/family-service` — neither of which was checked against this
 * enum. A typo in either would have silently stopped the link appearing, and
 * the only symptom would have been its absence.
 */
export const SAFETY_RESOURCE_CATEGORIES: readonly AbuseCategory[] = [
  'UNWANTED_TRACKING',
  'COERCED_SHARING',
];

/** Whether a report of this category should surface safety resources. */
export function showsSafetyResources(category: AbuseCategory): boolean {
  return SAFETY_RESOURCE_CATEGORIES.includes(category);
}

export const ReportAbuseRequestSchema = z.strictObject({
  reportedUserId: UserIdSchema,
  familyId: FamilyIdSchema.nullable().default(null),
  category: AbuseCategorySchema,
  description: z.string().min(1).max(4000),
  /** Stop sharing with, and hide from, the reported user immediately. */
  blockImmediately: z.boolean().default(true),
  /** Leave the family in the same request, for a fast exit. */
  leaveFamily: z.boolean().default(false),
});
export type ReportAbuseRequest = z.infer<typeof ReportAbuseRequestSchema>;

/**
 * Never reveals whether an enforcement action was taken against the reported
 * user — that would let a reporter probe another account's state.
 */
export const ReportAbuseResponseSchema = z.strictObject({
  reportId: z.string().uuid(),
  submittedAt: IsoDateTimeSchema,
  blocked: z.boolean(),
  leftFamily: z.boolean(),
  /** Locale-aware safety resources, shown after an unwanted-tracking report. */
  safetyResourcesUrl: z.string().url().max(2048).nullable(),
});
export type ReportAbuseResponse = z.infer<typeof ReportAbuseResponseSchema>;

// ---------------------------------------------------------------------------
// POST /v1/support/blocks  |  DELETE /v1/support/blocks/{userId}
// ---------------------------------------------------------------------------

export const BlockUserRequestSchema = z.strictObject({
  blockedUserId: UserIdSchema,
  /** Remove every shared family relationship, not just visibility. */
  removeFromSharedFamilies: z.boolean().default(false),
});
export type BlockUserRequest = z.infer<typeof BlockUserRequestSchema>;

export const BlockSchema = z.strictObject({
  blockedUserId: UserIdSchema,
  blockedAt: IsoDateTimeSchema,
  removedFromSharedFamilies: z.boolean(),
});
export type Block = z.infer<typeof BlockSchema>;

export const BlockUserResponseSchema = z.strictObject({
  block: BlockSchema,
});
export type BlockUserResponse = z.infer<typeof BlockUserResponseSchema>;

export const BlockPathSchema = z.strictObject({
  userId: UserIdSchema,
});
export type BlockPath = z.infer<typeof BlockPathSchema>;

export const UnblockUserResponseSchema = z.strictObject({
  blockedUserId: UserIdSchema,
  unblockedAt: IsoDateTimeSchema,
});
export type UnblockUserResponse = z.infer<typeof UnblockUserResponseSchema>;
