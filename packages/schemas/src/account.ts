import { z } from 'zod';

import { AgeBandSchema, BirthDateSchema, FamilyIdSchema, UserIdSchema } from '@family/contracts';

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
import { FamilyNameSchema } from './families.js';

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
  /**
   * The band the account holder's attested date of birth fell in, or null when
   * they have not been asked — which is every federated account until it clears
   * the acceptance screen, and every account created before the band existed.
   *
   * Returned on the owner's own read only, like `email`, and returned as a band
   * rather than a date because a date of birth is a strong identifier and beside
   * location history a much stronger one. The client needs this to know whether
   * to ask; nothing else keys off it yet.
   */
  ageBand: AgeBandSchema.nullable(),
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
    /**
     * Recording that this person accepted a specific version of the terms.
     *
     * It lives on the account rather than under `/v1/auth` because consent is a
     * fact about the person, not about a session, and because the account is
     * where it is read back from. There is no unauthenticated path to it: you
     * cannot accept terms on somebody else's behalf.
     */
    acceptedTermsVersion: TermsVersionSchema.optional(),
    /**
     * The other half of the same acceptance, and previously absent.
     *
     * The consent gate (`consent-gate.ts`) requires BOTH documents to match the
     * versions that shipped in the binary before it lets anybody through. Only
     * the terms version could be written, so an account whose privacy-policy
     * version was behind could never be brought up to date through the API at
     * all — the gate had no satisfying move. The two are refined below to travel
     * together, because one without the other only produces that same dead end
     * from the other side.
     */
    acceptedPrivacyPolicyVersion: TermsVersionSchema.optional(),
    /**
     * An attested date of birth, `YYYY-MM-DD`.
     *
     * Accepted here so a federated account can answer the age question it was
     * never asked: the hosted UI's authorization-code grant carries no date, so
     * Apple sign-in reaches the app with no attestation at all. The server bands
     * it, refuses anything below the minimum with the same opaque error the
     * sign-up trigger uses, stores the band, and discards the date. It is
     * write-only — no response ever echoes it back.
     */
    birthDate: BirthDateSchema.optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, {
    message: 'At least one field must be provided.',
  })
  .refine(
    (patch) =>
      (patch.acceptedTermsVersion === undefined) ===
      (patch.acceptedPrivacyPolicyVersion === undefined),
    {
      message: 'The terms version and the privacy policy version must be accepted together.',
      path: ['acceptedPrivacyPolicyVersion'],
    },
  );
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

// ---------------------------------------------------------------------------
// GET /v1/account/deletion/preview
// ---------------------------------------------------------------------------

/**
 * One family the caller owns, and what deleting their account does to it.
 *
 * `willBeDissolved` is the whole point of the row: "somebody else keeps this
 * family" and "this family goes with you" are different enough that a person is
 * entitled to know which one they are about to choose.
 */
export const DeletionPreviewFamilySchema = z.strictObject({
  familyId: FamilyIdSchema,
  name: FamilyNameSchema,
  /** Members still active in the family, the caller included. */
  memberCount: z.number().int().nonnegative(),
  /** True when nobody is left to inherit it, so the family goes too. */
  willBeDissolved: z.boolean(),
});
export type DeletionPreviewFamily = z.infer<typeof DeletionPreviewFamilySchema>;

/**
 * What `DELETE /v1/account` would destroy, told before it is destroyed.
 *
 * Every field is a count or a flag over the caller's own rows, and it is
 * computed from the same plan the deletion itself runs — a preview that
 * disagreed with the deletion would be worse than no preview at all.
 *
 * A count of rows is not a coordinate. Nothing here is derived from a stored
 * position, and the function that serves it holds no key with which one could
 * be read.
 */
export const AccountDeletionPreviewResponseSchema = z.strictObject({
  ownedFamilies: z.array(DeletionPreviewFamilySchema),
  /** Families the caller would leave without owning them. */
  memberFamilyCount: z.number().int().nonnegative(),
  /** Location rows that would be erased: counted, never read. */
  storedLocationPointCount: z.number().int().nonnegative(),
  /** Saved places that would be deleted rather than inherited by the family. */
  savedPlaceCount: z.number().int().nonnegative(),
  /** Devices that would be revoked; an already-revoked one is not a loss. */
  registeredDeviceCount: z.number().int().nonnegative(),
  /** Deleting the account does NOT cancel a store subscription. */
  hasActiveSubscription: z.boolean(),
  /**
   * Where the caller has to go to stop being billed. A promotional grant
   * collapses to `NONE`: there is no store, and nothing to cancel.
   */
  subscriptionStore: z.enum(['APP_STORE', 'PLAY_STORE', 'NONE']),
  /** Days between the request and the irreversible purge. */
  gracePeriodDays: z.number().int().positive(),
});
export type AccountDeletionPreviewResponse = z.infer<typeof AccountDeletionPreviewResponseSchema>;
