import { z } from 'zod';

import { FamilyIdSchema, LIMITS, SessionIdSchema, UserIdSchema } from '@family/contracts';

import { IsoDateTimeSchema } from './common.js';

/**
 * Live session endpoints.
 *
 * `POST /v1/live-sessions`
 * `POST /v1/live-sessions/{sessionId}/accept`
 * `POST /v1/live-sessions/{sessionId}/reject`
 * `POST /v1/live-sessions/{sessionId}/stop`
 *
 * A live session is a *consent grant*, not a data channel: it raises the
 * target's update rate for a bounded window after the target explicitly
 * accepts. No response in this group carries a coordinate — positions are still
 * read through `/v1/families/{familyId}/locations/current`, which re-checks
 * membership and sharing status on every call.
 */

export const LiveSessionStatusSchema = z.enum([
  'REQUESTED',
  'ACTIVE',
  'REJECTED',
  'STOPPED',
  'EXPIRED',
]);
export type LiveSessionStatus = z.infer<typeof LiveSessionStatusSchema>;

export const LiveSessionEndReasonSchema = z.enum([
  'REQUESTER_STOPPED',
  'TARGET_STOPPED',
  'TARGET_REJECTED',
  'EXPIRED',
  'SHARING_PAUSED',
  'MEMBERSHIP_ENDED',
]);
export type LiveSessionEndReason = z.infer<typeof LiveSessionEndReasonSchema>;

/** Why the requester says they need it; shown verbatim to the target. */
export const LiveSessionReasonSchema = z.enum(['MEETING_UP', 'SAFETY_CHECK', 'TRAVEL', 'OTHER']);
export type LiveSessionReason = z.infer<typeof LiveSessionReasonSchema>;

// ---------------------------------------------------------------------------
// Resource
// ---------------------------------------------------------------------------

export const LiveSessionSchema = z.strictObject({
  sessionId: SessionIdSchema,
  familyId: FamilyIdSchema,
  requestedByUserId: UserIdSchema,
  targetUserId: UserIdSchema,
  status: LiveSessionStatusSchema,
  reason: LiveSessionReasonSchema,
  requestedAt: IsoDateTimeSchema,
  respondedAt: IsoDateTimeSchema.nullable(),
  /** Non-null only once ACTIVE. Always <= MAX_LIVE_SESSION_SECONDS from start. */
  expiresAt: IsoDateTimeSchema.nullable(),
  endedAt: IsoDateTimeSchema.nullable(),
  endedReason: LiveSessionEndReasonSchema.nullable(),
  updateIntervalSeconds: z.number().int().positive(),
});
export type LiveSession = z.infer<typeof LiveSessionSchema>;

export const LiveSessionPathSchema = z.strictObject({
  sessionId: SessionIdSchema,
});
export type LiveSessionPath = z.infer<typeof LiveSessionPathSchema>;

// ---------------------------------------------------------------------------
// POST /v1/live-sessions
// ---------------------------------------------------------------------------

export const CreateLiveSessionRequestSchema = z.strictObject({
  familyId: FamilyIdSchema,
  targetUserId: UserIdSchema,
  requestedDurationSeconds: z
    .number()
    .int()
    .min(60)
    .max(LIMITS.MAX_LIVE_SESSION_SECONDS)
    .default(LIMITS.MAX_LIVE_SESSION_SECONDS),
  reason: LiveSessionReasonSchema.default('OTHER'),
});
export type CreateLiveSessionRequest = z.infer<typeof CreateLiveSessionRequestSchema>;

export const CreateLiveSessionResponseSchema = z.strictObject({
  session: LiveSessionSchema,
  /** The target must accept before anything changes. Always REQUESTED here. */
  awaitingTargetConsent: z.literal(true),
});
export type CreateLiveSessionResponse = z.infer<typeof CreateLiveSessionResponseSchema>;

// ---------------------------------------------------------------------------
// POST /v1/live-sessions/{sessionId}/accept
// ---------------------------------------------------------------------------

export const AcceptLiveSessionRequestSchema = z.strictObject({
  /** The target may grant less time than was requested, never more. */
  grantedDurationSeconds: z.number().int().min(60).max(LIMITS.MAX_LIVE_SESSION_SECONDS).optional(),
});
export type AcceptLiveSessionRequest = z.infer<typeof AcceptLiveSessionRequestSchema>;

export const AcceptLiveSessionResponseSchema = z.strictObject({
  session: LiveSessionSchema,
});
export type AcceptLiveSessionResponse = z.infer<typeof AcceptLiveSessionResponseSchema>;

// ---------------------------------------------------------------------------
// POST /v1/live-sessions/{sessionId}/reject
// ---------------------------------------------------------------------------

/**
 * Rejection carries no reason field on purpose: a target must be able to say no
 * without justifying it, and a free-text reason would be a coercion vector.
 */
export const RejectLiveSessionRequestSchema = z.strictObject({
  /** Silently decline every future request from this requester. */
  muteFutureRequests: z.boolean().default(false),
});
export type RejectLiveSessionRequest = z.infer<typeof RejectLiveSessionRequestSchema>;

export const RejectLiveSessionResponseSchema = z.strictObject({
  session: LiveSessionSchema,
});
export type RejectLiveSessionResponse = z.infer<typeof RejectLiveSessionResponseSchema>;

// ---------------------------------------------------------------------------
// POST /v1/live-sessions/{sessionId}/stop
// ---------------------------------------------------------------------------

export const StopLiveSessionRequestSchema = z.strictObject({});
export type StopLiveSessionRequest = z.infer<typeof StopLiveSessionRequestSchema>;

export const StopLiveSessionResponseSchema = z.strictObject({
  session: LiveSessionSchema,
});
export type StopLiveSessionResponse = z.infer<typeof StopLiveSessionResponseSchema>;

// ---------------------------------------------------------------------------
// GET /v1/live-sessions
// ---------------------------------------------------------------------------

export const ListLiveSessionsQuerySchema = z.strictObject({
  familyId: FamilyIdSchema,
  status: LiveSessionStatusSchema.optional(),
});
export type ListLiveSessionsQuery = z.infer<typeof ListLiveSessionsQuerySchema>;

export const ListLiveSessionsResponseSchema = z.strictObject({
  sessions: z.array(LiveSessionSchema),
  maxConcurrentPerTarget: z
    .number()
    .int()
    .positive()
    .max(LIMITS.MAX_CONCURRENT_LIVE_SESSIONS_PER_TARGET),
});
export type ListLiveSessionsResponse = z.infer<typeof ListLiveSessionsResponseSchema>;
