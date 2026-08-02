import { z } from 'zod';

import { FamilyIdSchema, PlanTierSchema, UserIdSchema } from '@family/contracts';

import { IsoDateTimeSchema, TimeZoneSchema } from './common.js';
import { FamilyMemberSchema } from './memberships.js';

/**
 * Family endpoints.
 *
 * `POST   /v1/families`
 * `GET    /v1/families`
 * `GET    /v1/families/{familyId}`
 * `PATCH  /v1/families/{familyId}`
 */

export const FamilyNameSchema = z.string().min(1).max(80);

export const FamilyPathSchema = z.strictObject({
  familyId: FamilyIdSchema,
});
export type FamilyPath = z.infer<typeof FamilyPathSchema>;

// ---------------------------------------------------------------------------
// Family resource
// ---------------------------------------------------------------------------

export const FamilySchema = z.strictObject({
  familyId: FamilyIdSchema,
  name: FamilyNameSchema,
  ownerUserId: UserIdSchema,
  timeZone: TimeZoneSchema,
  memberCount: z.number().int().nonnegative(),
  activeMemberCount: z.number().int().nonnegative(),
  pendingInvitationCount: z.number().int().nonnegative(),
  savedPlaceCount: z.number().int().nonnegative(),
  /** Derived server-side from the owner's subscription, never client-claimed. */
  planTier: PlanTierSchema,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  schemaVersion: z.number().int().positive(),
});
export type Family = z.infer<typeof FamilySchema>;

// ---------------------------------------------------------------------------
// POST /v1/families
// ---------------------------------------------------------------------------

export const CreateFamilyRequestSchema = z.strictObject({
  name: FamilyNameSchema,
  timeZone: TimeZoneSchema,
});
export type CreateFamilyRequest = z.infer<typeof CreateFamilyRequestSchema>;

export const CreateFamilyResponseSchema = z.strictObject({
  family: FamilySchema,
  /** The creator's own membership, always OWNER. */
  membership: FamilyMemberSchema,
});
export type CreateFamilyResponse = z.infer<typeof CreateFamilyResponseSchema>;

// ---------------------------------------------------------------------------
// GET /v1/families
// ---------------------------------------------------------------------------

export const ListFamiliesResponseSchema = z.strictObject({
  families: z.array(FamilySchema),
});
export type ListFamiliesResponse = z.infer<typeof ListFamiliesResponseSchema>;

// ---------------------------------------------------------------------------
// GET /v1/families/{familyId}
// ---------------------------------------------------------------------------

export const GetFamilyResponseSchema = z.strictObject({
  family: FamilySchema,
  members: z.array(FamilyMemberSchema),
  /** The caller's own role, so the client can gate UI without re-deriving it. */
  callerRole: FamilyMemberSchema.shape.role,
});
export type GetFamilyResponse = z.infer<typeof GetFamilyResponseSchema>;

// ---------------------------------------------------------------------------
// PATCH /v1/families/{familyId}
// ---------------------------------------------------------------------------

export const UpdateFamilyRequestSchema = z
  .strictObject({
    name: FamilyNameSchema.optional(),
    timeZone: TimeZoneSchema.optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, {
    message: 'At least one field must be provided.',
  });
export type UpdateFamilyRequest = z.infer<typeof UpdateFamilyRequestSchema>;

export const UpdateFamilyResponseSchema = z.strictObject({
  family: FamilySchema,
});
export type UpdateFamilyResponse = z.infer<typeof UpdateFamilyResponseSchema>;
