import { z } from 'zod';

import { FamilyIdSchema, InvitationIdSchema, LIMITS, UserIdSchema } from '@family/contracts';

import { DisplayNameSchema, IsoDateTimeSchema, TermsVersionSchema } from './common.js';
import { AssignableFamilyRoleSchema, FamilyMemberSchema } from './memberships.js';

/**
 * Invitation endpoints.
 *
 * `POST   /v1/families/{familyId}/invitations`
 * `DELETE /v1/families/{familyId}/invitations/{invitationId}`
 * `POST   /v1/invitations/{token}/accept`
 *
 * The raw token is a bearer credential granting family membership. It is
 * returned exactly once, at creation, and must never be logged, echoed in an
 * error, or included in any list/read response — only its hashed handle is
 * stored server-side.
 */

/** URL-safe token, sized so it cannot be brute-forced. */
export const InvitationTokenSchema = z
  .string()
  .min(22)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, 'Must be a URL-safe token.');
export type InvitationToken = z.infer<typeof InvitationTokenSchema>;

export const InvitationStatusSchema = z.enum(['PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED']);
export type InvitationStatus = z.infer<typeof InvitationStatusSchema>;

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export const FamilyInvitationsPathSchema = z.strictObject({
  familyId: FamilyIdSchema,
});
export type FamilyInvitationsPath = z.infer<typeof FamilyInvitationsPathSchema>;

export const FamilyInvitationPathSchema = z.strictObject({
  familyId: FamilyIdSchema,
  invitationId: InvitationIdSchema,
});
export type FamilyInvitationPath = z.infer<typeof FamilyInvitationPathSchema>;

export const AcceptInvitationPathSchema = z.strictObject({
  token: InvitationTokenSchema,
});
export type AcceptInvitationPath = z.infer<typeof AcceptInvitationPathSchema>;

// ---------------------------------------------------------------------------
// Invitation resource (token-free)
// ---------------------------------------------------------------------------

export const InvitationSchema = z.strictObject({
  invitationId: InvitationIdSchema,
  familyId: FamilyIdSchema,
  role: AssignableFamilyRoleSchema,
  status: InvitationStatusSchema,
  /** Optional human label such as "Grandma's phone". Never an email address. */
  label: z.string().min(1).max(60).nullable(),
  createdByUserId: UserIdSchema,
  createdAt: IsoDateTimeSchema,
  expiresAt: IsoDateTimeSchema,
  redemptionCount: z.number().int().nonnegative(),
  maxRedemptions: z.number().int().positive(),
  acceptedByUserId: UserIdSchema.nullable(),
  acceptedAt: IsoDateTimeSchema.nullable(),
  revokedAt: IsoDateTimeSchema.nullable(),
});
export type Invitation = z.infer<typeof InvitationSchema>;

// ---------------------------------------------------------------------------
// POST /v1/families/{familyId}/invitations
// ---------------------------------------------------------------------------

export const CreateInvitationRequestSchema = z.strictObject({
  role: AssignableFamilyRoleSchema.default('MEMBER'),
  label: z.string().min(1).max(60).nullable().default(null),
  expiresInHours: z
    .number()
    .int()
    .min(1)
    .max(LIMITS.INVITATION_TTL_HOURS)
    .default(LIMITS.INVITATION_TTL_HOURS),
  maxRedemptions: z
    .number()
    .int()
    .min(1)
    .max(LIMITS.MAX_INVITATION_REDEMPTIONS)
    .default(LIMITS.MAX_INVITATION_REDEMPTIONS),
});
export type CreateInvitationRequest = z.infer<typeof CreateInvitationRequestSchema>;

/**
 * The only response in the whole API that carries a raw invitation token. The
 * caller is expected to hand it straight to the share sheet and discard it.
 */
export const CreateInvitationResponseSchema = z.strictObject({
  invitation: InvitationSchema,
  token: InvitationTokenSchema,
  /** Universal link embedding the token. Treat as a secret; never log it. */
  inviteUrl: z.string().url().max(2048),
});
export type CreateInvitationResponse = z.infer<typeof CreateInvitationResponseSchema>;

// ---------------------------------------------------------------------------
// GET /v1/families/{familyId}/invitations
// ---------------------------------------------------------------------------

export const ListInvitationsQuerySchema = z.strictObject({
  status: InvitationStatusSchema.default('PENDING'),
});
export type ListInvitationsQuery = z.infer<typeof ListInvitationsQuerySchema>;

export const ListInvitationsResponseSchema = z.strictObject({
  familyId: FamilyIdSchema,
  invitations: z.array(InvitationSchema),
  activeCount: z.number().int().nonnegative(),
  maxActive: z.number().int().positive(),
});
export type ListInvitationsResponse = z.infer<typeof ListInvitationsResponseSchema>;

// ---------------------------------------------------------------------------
// DELETE /v1/families/{familyId}/invitations/{invitationId}
// ---------------------------------------------------------------------------

export const RevokeInvitationResponseSchema = z.strictObject({
  invitationId: InvitationIdSchema,
  familyId: FamilyIdSchema,
  status: z.literal('REVOKED'),
  revokedAt: IsoDateTimeSchema,
});
export type RevokeInvitationResponse = z.infer<typeof RevokeInvitationResponseSchema>;

// ---------------------------------------------------------------------------
// POST /v1/invitations/{token}/accept
// ---------------------------------------------------------------------------

export const AcceptInvitationRequestSchema = z.strictObject({
  /** Set on first join so the family sees a name rather than a blank card. */
  displayName: DisplayNameSchema.nullable().default(null),
  acceptedTermsVersion: TermsVersionSchema,
  /**
   * Joining a family does not start sharing. The member opts in explicitly,
   * either here or later from settings; the default is off.
   */
  startSharingImmediately: z.boolean().default(false),
});
export type AcceptInvitationRequest = z.infer<typeof AcceptInvitationRequestSchema>;

export const AcceptInvitationResponseSchema = z.strictObject({
  familyId: FamilyIdSchema,
  familyName: z.string().min(1).max(80),
  membership: FamilyMemberSchema,
  acceptedAt: IsoDateTimeSchema,
});
export type AcceptInvitationResponse = z.infer<typeof AcceptInvitationResponseSchema>;

// ---------------------------------------------------------------------------
// GET /v1/invitations/{token}  — pre-join preview
// ---------------------------------------------------------------------------

/**
 * Shown before the user commits to joining. Intentionally minimal: it reveals
 * only what a person holding the link already knows, and never member lists,
 * emails, or any location data.
 */
export const PreviewInvitationResponseSchema = z.strictObject({
  familyName: z.string().min(1).max(80),
  invitedByDisplayName: DisplayNameSchema,
  role: AssignableFamilyRoleSchema,
  expiresAt: IsoDateTimeSchema,
  memberCount: z.number().int().nonnegative(),
});
export type PreviewInvitationResponse = z.infer<typeof PreviewInvitationResponseSchema>;
