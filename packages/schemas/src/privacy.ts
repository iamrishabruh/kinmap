import { z } from 'zod';

import {
  AuditActionSchema,
  FamilyIdSchema,
  SharingStatusSchema,
  UserIdSchema,
} from '@family/contracts';

import {
  CoarseGeohashSchema,
  CursorSchema,
  DisplayNameSchema,
  IsoDateTimeSchema,
  PageInfoSchema,
} from './common.js';

/**
 * Privacy endpoints.
 *
 * `GET    /v1/privacy/sharing`
 * `PATCH  /v1/privacy/sharing`
 * `DELETE /v1/privacy/history`
 * `GET    /v1/privacy/audit`
 *
 * These are the user's controls over their own data. Nothing here exposes
 * another member's position, and pausing takes effect immediately — the current
 * position becomes unreadable rather than frozen at its last value.
 */

// ---------------------------------------------------------------------------
// GET /v1/privacy/sharing
// ---------------------------------------------------------------------------

export const FamilySharingStateSchema = z.strictObject({
  familyId: FamilyIdSchema,
  familyName: z.string().min(1).max(80),
  status: SharingStatusSchema,
  /** Non-null while a timed pause is running. */
  pausedUntil: IsoDateTimeSchema.nullable(),
  changedAt: IsoDateTimeSchema,
});
export type FamilySharingState = z.infer<typeof FamilySharingStateSchema>;

export const SharingSettingsSchema = z.strictObject({
  userId: UserIdSchema,
  /** Master switch. When paused, every family is hidden regardless of scope. */
  globalStatus: SharingStatusSchema,
  globalPausedUntil: IsoDateTimeSchema.nullable(),
  families: z.array(FamilySharingStateSchema),
  updatedAt: IsoDateTimeSchema,
});
export type SharingSettings = z.infer<typeof SharingSettingsSchema>;

export const GetSharingSettingsResponseSchema = z.strictObject({
  sharing: SharingSettingsSchema,
});
export type GetSharingSettingsResponse = z.infer<typeof GetSharingSettingsResponseSchema>;

// ---------------------------------------------------------------------------
// PATCH /v1/privacy/sharing
// ---------------------------------------------------------------------------

export const SharingScopeSchema = z.enum(['GLOBAL', 'FAMILY']);
export type SharingScope = z.infer<typeof SharingScopeSchema>;

export const UpdateSharingRequestSchema = z
  .strictObject({
    scope: SharingScopeSchema,
    /** Required for FAMILY scope, forbidden for GLOBAL scope. */
    familyId: FamilyIdSchema.nullable().default(null),
    /** True resumes sharing; false pauses it. */
    sharing: z.boolean(),
    /**
     * Optional auto-resume instant for a timed pause ("pause for an hour").
     * Only meaningful when pausing; a resume clears it.
     */
    pauseUntil: IsoDateTimeSchema.nullable().default(null),
  })
  .refine((body) => (body.scope === 'FAMILY' ? body.familyId !== null : body.familyId === null), {
    message: 'A family must be identified for family-scoped changes only.',
    path: ['familyId'],
  })
  .refine((body) => !(body.sharing && body.pauseUntil !== null), {
    message: 'An auto-resume time cannot be set while resuming.',
    path: ['pauseUntil'],
  });
export type UpdateSharingRequest = z.infer<typeof UpdateSharingRequestSchema>;

export const UpdateSharingResponseSchema = z.strictObject({
  sharing: SharingSettingsSchema,
  /**
   * Members who could see this user before the change and now cannot. Ids only
   * — used by the client to render "3 people can no longer see you".
   */
  affectedViewerUserIds: z.array(UserIdSchema),
});
export type UpdateSharingResponse = z.infer<typeof UpdateSharingResponseSchema>;

// ---------------------------------------------------------------------------
// DELETE /v1/privacy/history
// ---------------------------------------------------------------------------

export const DeleteHistoryScopeSchema = z.enum(['ALL', 'RANGE', 'FAMILY']);
export type DeleteHistoryScope = z.infer<typeof DeleteHistoryScopeSchema>;

export const DeleteHistoryRequestSchema = z
  .strictObject({
    scope: DeleteHistoryScopeSchema.default('ALL'),
    /** Required for RANGE scope. */
    from: IsoDateTimeSchema.nullable().default(null),
    to: IsoDateTimeSchema.nullable().default(null),
    /** Required for FAMILY scope. */
    familyId: FamilyIdSchema.nullable().default(null),
    confirmation: z.literal('DELETE'),
  })
  .refine((body) => (body.scope === 'RANGE' ? body.from !== null && body.to !== null : true), {
    message: 'A start and end must be provided for a ranged deletion.',
    path: ['from'],
  })
  .refine(
    (body) => body.from === null || body.to === null || Date.parse(body.from) < Date.parse(body.to),
    {
      message: 'The start of the range must be before its end.',
      path: ['from'],
    },
  )
  .refine((body) => (body.scope === 'FAMILY' ? body.familyId !== null : true), {
    message: 'A family must be identified for family-scoped deletion.',
    path: ['familyId'],
  });
export type DeleteHistoryRequest = z.infer<typeof DeleteHistoryRequestSchema>;

export const DeleteHistoryResponseSchema = z.strictObject({
  userId: UserIdSchema,
  scope: DeleteHistoryScopeSchema,
  requestedAt: IsoDateTimeSchema,
  /** Deletion is asynchronous; poll or wait for the notification. */
  deletionJobId: z.string().uuid(),
  /** Best-effort estimate; the exact count is not exposed to avoid inference. */
  completesBy: IsoDateTimeSchema,
});
export type DeleteHistoryResponse = z.infer<typeof DeleteHistoryResponseSchema>;

// ---------------------------------------------------------------------------
// GET /v1/privacy/audit
//
// "Who looked at me, and when." The metadata is coarse by construction: a
// geohash no finer than six characters, never a raw point.
// ---------------------------------------------------------------------------

export const AuditLogEntrySchema = z.strictObject({
  auditId: z.string().uuid(),
  action: AuditActionSchema,
  actorUserId: UserIdSchema,
  actorDisplayName: DisplayNameSchema.nullable(),
  targetUserId: UserIdSchema.nullable(),
  familyId: FamilyIdSchema.nullable(),
  occurredAt: IsoDateTimeSchema,
  /** Coarse cell only, and only when the action had a location context. */
  coarseArea: CoarseGeohashSchema.nullable(),
});
export type AuditLogEntry = z.infer<typeof AuditLogEntrySchema>;

export const GetAuditLogQuerySchema = z
  .strictObject({
    from: IsoDateTimeSchema.nullable().default(null),
    to: IsoDateTimeSchema.nullable().default(null),
    action: AuditActionSchema.optional(),
    cursor: CursorSchema.nullable().default(null),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .refine(
    (query) =>
      query.from === null || query.to === null || Date.parse(query.from) < Date.parse(query.to),
    {
      message: 'The start of the range must be before its end.',
      path: ['from'],
    },
  );
export type GetAuditLogQuery = z.infer<typeof GetAuditLogQuerySchema>;

export const GetAuditLogResponseSchema = z.strictObject({
  entries: z.array(AuditLogEntrySchema),
  page: PageInfoSchema,
});
export type GetAuditLogResponse = z.infer<typeof GetAuditLogResponseSchema>;

// ---------------------------------------------------------------------------
// POST /v1/privacy/export
// ---------------------------------------------------------------------------

export const RequestDataExportResponseSchema = z.strictObject({
  exportJobId: z.string().uuid(),
  requestedAt: IsoDateTimeSchema,
  /** Emailed as a short-lived signed link; never returned inline. */
  deliveryMethod: z.literal('EMAIL_LINK'),
  completesBy: IsoDateTimeSchema,
});
export type RequestDataExportResponse = z.infer<typeof RequestDataExportResponseSchema>;
