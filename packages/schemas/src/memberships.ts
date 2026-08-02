import { z } from 'zod';

import {
  FamilyIdSchema,
  FamilyRoleSchema,
  MembershipStatusSchema,
  SharingStatusSchema,
  UserIdSchema,
} from '@family/contracts';

import {
  AvatarUrlSchema,
  BooleanQueryParamSchema,
  DisplayNameSchema,
  IsoDateTimeSchema,
} from './common.js';

/**
 * Membership endpoints.
 *
 * `GET    /v1/families/{familyId}/members`
 * `GET    /v1/families/{familyId}/members/{userId}`
 * `PATCH  /v1/families/{familyId}/members/{userId}`
 * `DELETE /v1/families/{familyId}/members/{userId}`
 *
 * Membership responses never carry a coordinate — only the *status* of sharing.
 * Reading a member's position always goes through the location endpoints, which
 * are separately authorised.
 */

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export const FamilyMembersPathSchema = z.strictObject({
  familyId: FamilyIdSchema,
});
export type FamilyMembersPath = z.infer<typeof FamilyMembersPathSchema>;

export const FamilyMemberPathSchema = z.strictObject({
  familyId: FamilyIdSchema,
  userId: UserIdSchema,
});
export type FamilyMemberPath = z.infer<typeof FamilyMemberPathSchema>;

// ---------------------------------------------------------------------------
// GET /v1/families/{familyId}/members[/{userId}]
// ---------------------------------------------------------------------------

export const FamilyMemberSchema = z.strictObject({
  userId: UserIdSchema,
  familyId: FamilyIdSchema,
  displayName: DisplayNameSchema,
  avatarUrl: AvatarUrlSchema.nullable(),
  role: FamilyRoleSchema,
  status: MembershipStatusSchema,
  /** Status only. A PAUSED member has no readable position anywhere. */
  sharingStatus: SharingStatusSchema,
  /** True when this member's sharing state is visible to the caller. */
  sharingWithCaller: z.boolean(),
  deviceCount: z.number().int().nonnegative(),
  /** Last time the member's device contacted the API, not a location time. */
  lastSeenAt: IsoDateTimeSchema.nullable(),
  joinedAt: IsoDateTimeSchema.nullable(),
  invitedByUserId: UserIdSchema.nullable(),
  updatedAt: IsoDateTimeSchema,
});
export type FamilyMember = z.infer<typeof FamilyMemberSchema>;

export const ListFamilyMembersQuerySchema = z.strictObject({
  /** Defaults to the members a client actually renders. */
  status: MembershipStatusSchema.default('ACTIVE'),
  includeRemoved: BooleanQueryParamSchema.default(false),
});
export type ListFamilyMembersQuery = z.infer<typeof ListFamilyMembersQuerySchema>;

export const ListFamilyMembersResponseSchema = z.strictObject({
  familyId: FamilyIdSchema,
  members: z.array(FamilyMemberSchema),
});
export type ListFamilyMembersResponse = z.infer<typeof ListFamilyMembersResponseSchema>;

export const GetFamilyMemberResponseSchema = z.strictObject({
  member: FamilyMemberSchema,
});
export type GetFamilyMemberResponse = z.infer<typeof GetFamilyMemberResponseSchema>;

// ---------------------------------------------------------------------------
// PATCH /v1/families/{familyId}/members/{userId}
// ---------------------------------------------------------------------------

/**
 * OWNER is not assignable here — ownership moves only through the explicit
 * transfer endpoint so it can require a second confirmation.
 */
export const AssignableFamilyRoleSchema = FamilyRoleSchema.exclude(['OWNER']);
export type AssignableFamilyRole = z.infer<typeof AssignableFamilyRoleSchema>;

export const UpdateFamilyMemberRequestSchema = z
  .strictObject({
    role: AssignableFamilyRoleSchema.optional(),
    /** Only BLOCKED / ACTIVE are settable; removal uses DELETE. */
    status: MembershipStatusSchema.extract(['ACTIVE', 'BLOCKED']).optional(),
    /** An admin may rename a member's card in this family only. */
    displayName: DisplayNameSchema.optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, {
    message: 'At least one field must be provided.',
  });
export type UpdateFamilyMemberRequest = z.infer<typeof UpdateFamilyMemberRequestSchema>;

export const UpdateFamilyMemberResponseSchema = GetFamilyMemberResponseSchema;
export type UpdateFamilyMemberResponse = z.infer<typeof UpdateFamilyMemberResponseSchema>;

// ---------------------------------------------------------------------------
// DELETE /v1/families/{familyId}/members/{userId}
// ---------------------------------------------------------------------------

export const RemoveFamilyMemberQuerySchema = z.strictObject({
  /** Also purge the removed member's history for this family. */
  deleteHistory: BooleanQueryParamSchema.default(true),
});
export type RemoveFamilyMemberQuery = z.infer<typeof RemoveFamilyMemberQuerySchema>;

export const RemoveFamilyMemberResponseSchema = z.strictObject({
  familyId: FamilyIdSchema,
  userId: UserIdSchema,
  status: MembershipStatusSchema.extract(['REMOVED', 'LEFT']),
  removedAt: IsoDateTimeSchema,
  historyDeleted: z.boolean(),
});
export type RemoveFamilyMemberResponse = z.infer<typeof RemoveFamilyMemberResponseSchema>;

// ---------------------------------------------------------------------------
// POST /v1/families/{familyId}/members/{userId}/transfer-ownership
// ---------------------------------------------------------------------------

export const TransferFamilyOwnershipRequestSchema = z.strictObject({
  confirmation: z.literal('TRANSFER'),
});
export type TransferFamilyOwnershipRequest = z.infer<typeof TransferFamilyOwnershipRequestSchema>;

export const TransferFamilyOwnershipResponseSchema = z.strictObject({
  familyId: FamilyIdSchema,
  previousOwnerUserId: UserIdSchema,
  newOwnerUserId: UserIdSchema,
  transferredAt: IsoDateTimeSchema,
});
export type TransferFamilyOwnershipResponse = z.infer<typeof TransferFamilyOwnershipResponseSchema>;
