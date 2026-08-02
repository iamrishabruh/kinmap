import * as Localization from 'expo-localization';
import { Platform as RNPlatform } from 'react-native';
import { z } from 'zod';

import {
  AcceptTermsResponseSchema,
  AcknowledgedResponseSchema,
  AccountSchema,
  AuthSessionSchema,
  GetAccountResponseSchema,
  StartOtpResponseSchema,
  UpdateAccountResponseSchema,
  type Account,
  type AuthIdentifier,
  type AuthSession,
  type Platform,
} from '@family/schemas';

import { env } from '@/config/env';
import type { PolicyVersions } from '@/features/consent/versions';
import { request } from '@/lib/api';

import type { PendingChallenge, SocialCredential } from './types';

/**
 * Auth and account endpoints.
 *
 * Every path and payload here comes from `@family/schemas`; nothing is invented
 * locally. Responses are parsed against the contract before any of it reaches
 * state — an auth response is the last place to trust a shape.
 */

// ---------------------------------------------------------------------------
// Request context
// ---------------------------------------------------------------------------

export function currentPlatform(): Platform {
  return RNPlatform.OS === 'ios' ? 'IOS' : 'ANDROID';
}

/** BCP 47, narrowed to the `xx` / `xx-XX` subset `LocaleSchema` accepts. */
export function currentLocale(): string {
  const locales = Localization.getLocales();
  const first = locales.length > 0 ? locales[0] : undefined;
  const language = (first?.languageCode ?? 'en').slice(0, 2).toLowerCase();
  const safeLanguage = /^[a-z]{2}$/.test(language) ? language : 'en';
  const region = first?.regionCode?.toUpperCase() ?? '';
  return /^[A-Z]{2}$/.test(region) ? `${safeLanguage}-${region}` : safeLanguage;
}

const IANA_TIME_ZONE = /^(?:UTC|[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){1,2})$/;

/** IANA identifier, falling back to UTC rather than sending something invalid. */
export function currentTimeZone(): string {
  const calendars = Localization.getCalendars();
  const fromCalendar = calendars.length > 0 ? calendars[0]?.timeZone : null;
  const candidate = fromCalendar ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
  return IANA_TIME_ZONE.test(candidate) ? candidate : 'UTC';
}

// ---------------------------------------------------------------------------
// Identifier masking
//
// The full address is shown once, on the screen where the user typed it. From
// then on only the mask travels: into state, into the "we sent a code to…"
// copy, and into nothing else. It is never a route param and never telemetry.
// ---------------------------------------------------------------------------

export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return '•••';
  const local = email.slice(0, at);
  const domain = email.slice(at);
  const head = local.slice(0, 1);
  return `${head}${'•'.repeat(Math.max(local.length - 1, 2))}${domain}`;
}

export function maskPhoneNumber(phoneNumber: string): string {
  const tail = phoneNumber.slice(-2);
  return `••• ••• ${tail}`;
}

export function maskIdentifier(identifier: AuthIdentifier): string {
  return identifier.kind === 'EMAIL'
    ? maskEmail(identifier.email)
    : maskPhoneNumber(identifier.phoneNumber);
}

// ---------------------------------------------------------------------------
// POST /v1/auth/otp/start
// ---------------------------------------------------------------------------

/**
 * Starts a one-time-code challenge.
 *
 * The response deliberately does not say whether the identifier already has an
 * account, so the UI must not either: both "sign in" and "create account" lead
 * to the identical "check your inbox" screen. Anything else turns this endpoint
 * into an account-existence oracle, which for a location product is a way to
 * confirm someone uses it.
 */
export async function startOtpChallenge(
  identifier: AuthIdentifier,
  kind: PendingChallenge['kind'] = 'OTP',
): Promise<PendingChallenge> {
  const response = await request({
    method: 'POST',
    path: '/v1/auth/otp/start',
    body: {
      identifier,
      locale: currentLocale(),
      platform: currentPlatform(),
      appVersion: env.appVersion,
    },
    schema: StartOtpResponseSchema,
    anonymous: true,
  });

  return {
    kind,
    challengeId: response.challengeId,
    maskedIdentifier: maskIdentifier(identifier),
    expiresAt: response.expiresAt,
    resendAvailableAt: response.resendAvailableAt,
    codeLength: response.codeLength,
  };
}

// ---------------------------------------------------------------------------
// POST /v1/auth/otp/verify
// ---------------------------------------------------------------------------

/**
 * A verified code either completes the sign-in or produces a further challenge
 * (step-up / second factor). Both arms are contract shapes: `AuthSession` and
 * `StartOtpResponse`. They cannot be confused for one another — both are strict
 * objects with disjoint required keys.
 */
const VerifyOutcomeSchema = z.union([
  AuthSessionSchema.transform((session) => ({ kind: 'session' as const, session })),
  StartOtpResponseSchema.transform((challenge) => ({ kind: 'challenge' as const, challenge })),
]);

export type VerifyOutcome =
  { kind: 'session'; session: AuthSession } | { kind: 'challenge'; challenge: PendingChallenge };

export async function verifyOtpCode(
  challenge: PendingChallenge,
  code: string,
): Promise<VerifyOutcome> {
  const outcome = await request({
    method: 'POST',
    path: '/v1/auth/otp/verify',
    body: {
      challengeId: challenge.challengeId,
      code,
      // No client-built device fingerprint. Device identity is established by
      // the separate, consented device-registration step; silently profiling
      // the handset during sign-in is exactly the behaviour this app rejects.
      deviceFingerprint: null,
    },
    schema: VerifyOutcomeSchema,
    anonymous: true,
  });

  if (outcome.kind === 'session') return outcome;

  return {
    kind: 'challenge',
    challenge: {
      // A challenge issued in response to a correct first code is a second
      // factor by definition.
      kind: 'MFA',
      challengeId: outcome.challenge.challengeId,
      maskedIdentifier: challenge.maskedIdentifier,
      expiresAt: outcome.challenge.expiresAt,
      resendAvailableAt: outcome.challenge.resendAvailableAt,
      codeLength: outcome.challenge.codeLength,
    },
  };
}

// ---------------------------------------------------------------------------
// POST /v1/auth/oauth/{provider}
// ---------------------------------------------------------------------------

export async function signInWithSocialCredential(
  credential: SocialCredential,
): Promise<AuthSession> {
  const path = credential.provider === 'APPLE' ? '/v1/auth/oauth/apple' : '/v1/auth/oauth/google';

  return request({
    method: 'POST',
    path,
    body: {
      provider: credential.provider,
      identityToken: credential.identityToken,
      authorizationCode: credential.authorizationCode,
      nonce: credential.nonce,
      displayName: credential.displayName,
      platform: currentPlatform(),
      appVersion: env.appVersion,
    },
    schema: AuthSessionSchema,
    anonymous: true,
  });
}

// ---------------------------------------------------------------------------
// POST /v1/auth/logout
// ---------------------------------------------------------------------------

export async function revokeSession(refreshToken: string, allDevices: boolean): Promise<void> {
  await request({
    method: 'POST',
    path: '/v1/auth/logout',
    body: { refreshToken, allDevices },
    schema: AcknowledgedResponseSchema,
    anonymous: true,
  });
}

// ---------------------------------------------------------------------------
// POST /v1/auth/terms
// ---------------------------------------------------------------------------

export async function acceptTerms(versions: PolicyVersions): Promise<void> {
  await request({
    method: 'POST',
    path: '/v1/auth/terms',
    body: {
      termsVersion: versions.termsVersion,
      privacyPolicyVersion: versions.privacyPolicyVersion,
      acceptedAt: new Date().toISOString(),
      timeZone: currentTimeZone(),
    },
    schema: AcceptTermsResponseSchema,
  });
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

export async function fetchAccount(): Promise<Account> {
  const response = await request({
    method: 'GET',
    path: '/v1/account',
    schema: GetAccountResponseSchema,
  });
  return response.account;
}

export async function updateDisplayName(displayName: string): Promise<Account> {
  const response = await request({
    method: 'PATCH',
    path: '/v1/account',
    body: { displayName },
    schema: UpdateAccountResponseSchema,
  });
  return response.account;
}

/**
 * Cancels a pending deletion. Signing in during the grace period is defined as
 * an intent to keep the account (spec §16), and the acceptance screen offers it
 * explicitly rather than resurrecting the account behind the user's back.
 */
export async function cancelAccountDeletion(): Promise<void> {
  await request({
    method: 'POST',
    path: '/v1/account/deletion/cancel',
    schema: z.object({
      userId: AccountSchema.shape.userId,
      status: z.literal('ACTIVE'),
      cancelledAt: AccountSchema.shape.createdAt,
    }),
  });
}
