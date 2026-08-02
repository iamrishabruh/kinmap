import { z } from 'zod';

import { FamilyIdSchema, UserIdSchema } from '@family/contracts';

import {
  AvatarUrlSchema,
  DisplayNameSchema,
  EmailSchema,
  IsoDateTimeSchema,
  LocaleSchema,
  PhoneNumberSchema,
  TermsVersionSchema,
  TimeZoneSchema,
} from './common.js';

/**
 * Account endpoints.
 *
 * `GET    /v1/account`
 * `PATCH  /v1/account`
 * `DELETE /v1/account`
 */

export const AccountStatusSchema = z.enum(['ACTIVE', 'PENDING_DELETION', 'SUSPENDED']);
export type AccountStatus = z.infer<typeof AccountStatusSchema>;

// ---------------------------------------------------------------------------
// GET /v1/account
// ---------------------------------------------------------------------------

export const AccountSchema = z.strictObject({
  userId: UserIdSchema,
  displayName: DisplayNameSchema,
  avatarUrl: AvatarUrlSchema.nullable(),
  /** Present only for the account owner's own profile read. */
  email: EmailSchema.nullable(),
  phoneNumber: PhoneNumberSchema.nullable(),
  locale: LocaleSchema,
  timeZone: TimeZoneSchema,
  status: AccountStatusSchema,
  familyIds: z.array(FamilyIdSchema),
  acceptedTermsVersion: TermsVersionSchema.nullable(),
  acceptedPrivacyPolicyVersion: TermsVersionSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  /** Set once a deletion is scheduled; null otherwise. */
  scheduledPurgeAt: IsoDateTimeSchema.nullable(),
});
export type Account = z.infer<typeof AccountSchema>;

export const GetAccountResponseSchema = z.strictObject({
  account: AccountSchema,
});
export type GetAccountResponse = z.infer<typeof GetAccountResponseSchema>;

// ---------------------------------------------------------------------------
// PATCH /v1/account
// ---------------------------------------------------------------------------

export const UpdateAccountRequestSchema = z
  .strictObject({
    displayName: DisplayNameSchema.optional(),
    avatarUrl: AvatarUrlSchema.nullable().optional(),
    locale: LocaleSchema.optional(),
    timeZone: TimeZoneSchema.optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, {
    message: 'At least one field must be provided.',
  });
export type UpdateAccountRequest = z.infer<typeof UpdateAccountRequestSchema>;

export const UpdateAccountResponseSchema = GetAccountResponseSchema;
export type UpdateAccountResponse = z.infer<typeof UpdateAccountResponseSchema>;

// ---------------------------------------------------------------------------
// DELETE /v1/account
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

export const DeleteAccountRequestSchema = z.strictObject({
  /** Typed confirmation so a mis-routed request cannot destroy an account. */
  confirmation: z.literal('DELETE'),
  reason: AccountDeletionReasonSchema.default('OTHER'),
  /** Free text is stored for product research; it is never required. */
  feedback: z.string().max(1000).nullable().default(null),
});
export type DeleteAccountRequest = z.infer<typeof DeleteAccountRequestSchema>;

export const DeleteAccountResponseSchema = z.strictObject({
  userId: UserIdSchema,
  status: z.literal('PENDING_DELETION'),
  requestedAt: IsoDateTimeSchema,
  /** Hard purge time. Sign-in before this cancels the deletion. */
  scheduledPurgeAt: IsoDateTimeSchema,
  gracePeriodDays: z.number().int().positive(),
  /** Families the user owned and must hand over or that will be dissolved. */
  affectedFamilyIds: z.array(FamilyIdSchema),
});
export type DeleteAccountResponse = z.infer<typeof DeleteAccountResponseSchema>;

// ---------------------------------------------------------------------------
// POST /v1/account/deletion/cancel
// ---------------------------------------------------------------------------

export const CancelAccountDeletionResponseSchema = z.strictObject({
  userId: UserIdSchema,
  status: z.literal('ACTIVE'),
  cancelledAt: IsoDateTimeSchema,
});
export type CancelAccountDeletionResponse = z.infer<typeof CancelAccountDeletionResponseSchema>;
