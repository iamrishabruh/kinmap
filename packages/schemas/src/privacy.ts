import { z } from 'zod';

import {
  AuditActionSchema,
  FamilyIdSchema,
  PlanTierSchema,
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

// ---------------------------------------------------------------------------
// GET  /v1/privacy/exports
// POST /v1/privacy/exports
// GET  /v1/privacy/exports/{exportId}
//
// The right to a copy of one's own data, expressed as a request that is tracked
// rather than a download that is served.
//
// This API function is granted no access to any location table and none to the
// coordinate key, so it cannot assemble an archive and deliberately does not
// pretend to. Asking for an export records the request; a worker that does hold
// those grants builds the archive and mails a short-lived signed link. So these
// shapes carry the STATE of a request and never its contents: there is no field
// below an archive, a download URL, an address or a coordinate could travel in,
// and that is the point rather than an omission.
// ---------------------------------------------------------------------------

export const DataExportStatusSchema = z.enum([
  /** Recorded and durable, waiting for the worker. */
  'QUEUED',
  'IN_PROGRESS',
  /** The signed link has been mailed. The archive never returns through this API. */
  'DELIVERED',
  'FAILED',
  'CANCELLED',
]);
export type DataExportStatus = z.infer<typeof DataExportStatusSchema>;

export const DataExportSchema = z.strictObject({
  exportId: z.string().uuid(),
  status: DataExportStatusSchema,
  requestedAt: IsoDateTimeSchema,
  /** The deadline the worker is held to, not a promise that it is ready yet. */
  completesBy: IsoDateTimeSchema,
  /** Mailed as a short-lived signed link; never returned inline. */
  deliveryMethod: z.literal('EMAIL_LINK'),
});
export type DataExport = z.infer<typeof DataExportSchema>;

export const DataExportPathSchema = z.strictObject({
  exportId: z.string().uuid(),
});
export type DataExportPath = z.infer<typeof DataExportPathSchema>;

export const ListDataExportsResponseSchema = z.strictObject({
  /** Newest first. Only the caller's own requests are ever addressable. */
  exports: z.array(DataExportSchema),
});
export type ListDataExportsResponse = z.infer<typeof ListDataExportsResponseSchema>;

// ---------------------------------------------------------------------------
// GET /v1/privacy/retention
//
// How long this user's location history is kept. READ ONLY, deliberately.
//
// There is no per-user retention preference and no endpoint to set one, because
// nothing in the platform would honour it. The TTL is stamped at ingestion from
// a single per-deployment value, the read path applies the plan's retention, and
// the nightly sweep uses the same global. An endpoint that accepted a choice
// would return 200, the settings screen would show it, and the history would be
// kept exactly as long as before.
//
// A privacy control that reports something other than what is enforced is worse
// than no control at all, so this reports only what is enforced. Making it
// settable is a change to ingestion, the read path and the sweep — not to this
// schema.
//
// Also deliberately absent: a count of stored points or the age of the oldest.
// This service has no access to any location table, so it could only guess, and
// a privacy screen that guesses is worse than one that says nothing.
// ---------------------------------------------------------------------------

export const RetentionSettingsSchema = z.strictObject({
  userId: UserIdSchema,
  /** Re-derived from the stored subscription row on every read. */
  planTier: PlanTierSchema,
  /** What is actually applied, which today is exactly the plan's ceiling. */
  historyRetentionDays: z.number().int().nonnegative(),
  maxHistoryRetentionDays: z.number().int().nonnegative(),
  /**
   * Fixed by the platform and not user-tunable: the audit trail is the record of
   * who looked at this user, and someone with access to the account must not be
   * able to shorten the evidence.
   */
  auditRetentionDays: z.number().int().nonnegative(),
});
export type RetentionSettings = z.infer<typeof RetentionSettingsSchema>;

export const GetRetentionResponseSchema = z.strictObject({
  retention: RetentionSettingsSchema,
});
export type GetRetentionResponse = z.infer<typeof GetRetentionResponseSchema>;
