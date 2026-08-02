import { z } from 'zod';

import { UserIdSchema } from '@family/contracts';

import {
  AppVersionSchema,
  DisplayNameSchema,
  EmailSchema,
  IsoDateTimeSchema,
  LocaleSchema,
  PhoneNumberSchema,
  PlatformSchema,
  TermsVersionSchema,
  TimeZoneSchema,
} from './common.js';

/**
 * Authentication endpoints.
 *
 * `POST   /v1/auth/otp/start`
 * `POST   /v1/auth/otp/verify`
 * `POST   /v1/auth/oauth/apple`
 * `POST   /v1/auth/oauth/google`
 * `POST   /v1/auth/refresh`
 * `POST   /v1/auth/logout`
 *
 * Tokens, OTP codes and provider identity tokens are credentials: they are
 * never echoed back beyond the issuing response and never logged.
 */

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

export const AuthIdentifierSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('EMAIL'), email: EmailSchema }),
  z.strictObject({ kind: z.literal('PHONE'), phoneNumber: PhoneNumberSchema }),
]);
export type AuthIdentifier = z.infer<typeof AuthIdentifierSchema>;

/** Six-digit one-time code. Never logged, never included in an error message. */
export const OtpCodeSchema = z.string().regex(/^\d{6}$/, 'Must be a six-digit code.');

export const OpaqueTokenSchema = z.string().min(16).max(4096);

export const AuthChallengeIdSchema = z.string().min(16).max(128);

// ---------------------------------------------------------------------------
// POST /v1/auth/otp/start
// ---------------------------------------------------------------------------

export const StartOtpRequestSchema = z.strictObject({
  identifier: AuthIdentifierSchema,
  locale: LocaleSchema.default('en'),
  platform: PlatformSchema,
  appVersion: AppVersionSchema,
});
export type StartOtpRequest = z.infer<typeof StartOtpRequestSchema>;

/**
 * Deliberately does not reveal whether the identifier already has an account —
 * account existence is not probeable.
 */
export const StartOtpResponseSchema = z.strictObject({
  challengeId: AuthChallengeIdSchema,
  expiresAt: IsoDateTimeSchema,
  resendAvailableAt: IsoDateTimeSchema,
  codeLength: z.number().int().positive(),
});
export type StartOtpResponse = z.infer<typeof StartOtpResponseSchema>;

// ---------------------------------------------------------------------------
// POST /v1/auth/otp/verify
// ---------------------------------------------------------------------------

export const VerifyOtpRequestSchema = z.strictObject({
  challengeId: AuthChallengeIdSchema,
  code: OtpCodeSchema,
  deviceFingerprint: z.string().min(8).max(128).nullable().default(null),
});
export type VerifyOtpRequest = z.infer<typeof VerifyOtpRequestSchema>;

// ---------------------------------------------------------------------------
// POST /v1/auth/oauth/apple  |  POST /v1/auth/oauth/google
// ---------------------------------------------------------------------------

export const OAuthProviderSchema = z.enum(['APPLE', 'GOOGLE']);
export type OAuthProvider = z.infer<typeof OAuthProviderSchema>;

export const OAuthSignInRequestSchema = z.strictObject({
  provider: OAuthProviderSchema,
  /** Provider-issued identity token. Verified server-side; never logged. */
  identityToken: OpaqueTokenSchema,
  authorizationCode: OpaqueTokenSchema.nullable().default(null),
  nonce: z.string().min(8).max(128),
  /** Apple only supplies a name on first authorisation. */
  displayName: DisplayNameSchema.nullable().default(null),
  platform: PlatformSchema,
  appVersion: AppVersionSchema,
});
export type OAuthSignInRequest = z.infer<typeof OAuthSignInRequestSchema>;

export const OAuthSignInPathSchema = z.strictObject({
  provider: z.enum(['apple', 'google']),
});
export type OAuthSignInPath = z.infer<typeof OAuthSignInPathSchema>;

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export const AuthSessionSchema = z.strictObject({
  userId: UserIdSchema,
  accessToken: OpaqueTokenSchema,
  accessTokenExpiresAt: IsoDateTimeSchema,
  refreshToken: OpaqueTokenSchema,
  refreshTokenExpiresAt: IsoDateTimeSchema,
  /** True when the caller must complete onboarding before using the API. */
  isNewUser: z.boolean(),
  /** Set when the accepted terms version is behind the current one. */
  termsAcceptanceRequired: TermsVersionSchema.nullable(),
});
export type AuthSession = z.infer<typeof AuthSessionSchema>;

export const VerifyOtpResponseSchema = AuthSessionSchema;
export type VerifyOtpResponse = z.infer<typeof VerifyOtpResponseSchema>;

export const OAuthSignInResponseSchema = AuthSessionSchema;
export type OAuthSignInResponse = z.infer<typeof OAuthSignInResponseSchema>;

// ---------------------------------------------------------------------------
// POST /v1/auth/refresh
// ---------------------------------------------------------------------------

export const RefreshSessionRequestSchema = z.strictObject({
  refreshToken: OpaqueTokenSchema,
});
export type RefreshSessionRequest = z.infer<typeof RefreshSessionRequestSchema>;

export const RefreshSessionResponseSchema = AuthSessionSchema;
export type RefreshSessionResponse = z.infer<typeof RefreshSessionResponseSchema>;

// ---------------------------------------------------------------------------
// POST /v1/auth/logout
// ---------------------------------------------------------------------------

export const LogoutRequestSchema = z.strictObject({
  refreshToken: OpaqueTokenSchema,
  /** Revoke every session for the user, not just this device. */
  allDevices: z.boolean().default(false),
});
export type LogoutRequest = z.infer<typeof LogoutRequestSchema>;

// ---------------------------------------------------------------------------
// Terms acceptance (POST /v1/auth/terms)
// ---------------------------------------------------------------------------

export const AcceptTermsRequestSchema = z.strictObject({
  termsVersion: TermsVersionSchema,
  privacyPolicyVersion: TermsVersionSchema,
  acceptedAt: IsoDateTimeSchema,
  timeZone: TimeZoneSchema,
});
export type AcceptTermsRequest = z.infer<typeof AcceptTermsRequestSchema>;

export const AcceptTermsResponseSchema = z.strictObject({
  termsVersion: TermsVersionSchema,
  privacyPolicyVersion: TermsVersionSchema,
  acceptedAt: IsoDateTimeSchema,
});
export type AcceptTermsResponse = z.infer<typeof AcceptTermsResponseSchema>;
