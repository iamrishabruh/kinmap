import * as Localization from 'expo-localization';
import { Platform as RNPlatform } from 'react-native';
import { z } from 'zod';

import {
  AcceptTermsResponseSchema,
  AccountSchema,
  GetAccountResponseSchema,
  UpdateAccountResponseSchema,
  type Account,
  type AuthIdentifier,
  type AuthSession,
  type Platform,
} from '@family/schemas';

import type { PolicyVersions } from '@/features/consent/versions';
import { request } from '@/lib/api';

import { CHALLENGE_SESSION_TTL_MS } from './cognito/config';
import { globalSignOut, revokeToken } from './cognito/idp-client';
import {
  answerMfaChallenge,
  signInWithPassword,
  type CognitoSignInOutcome,
} from './cognito/password-auth';
import type { PendingChallenge, StoredSession } from './types';

/**
 * Auth and account endpoints.
 *
 * TOKENS DO NOT COME FROM THE API. There is no `/v1/auth/*` and there never
 * will be: the comment above `API_ROUTES` in `infrastructure/stacks/api-stack.ts`
 * says so, and the deployed route table matches. Sign-in, refresh and
 * revocation go to the Cognito user pool directly (see `./cognito`), and the
 * API only ever verifies the access token that comes back. Everything below the
 * account divider still goes through `request()`, and every path and payload
 * there comes from `@family/schemas`; nothing is invented locally. Responses
 * are parsed against the contract before any of it reaches state — an auth
 * response is the last place to trust a shape.
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
// Sign-in (Cognito, SRP)
// ---------------------------------------------------------------------------

/** The pool's sign-in alias is `email`; phone sign-in is not configured. */
export type EmailIdentifier = Extract<AuthIdentifier, { kind: 'EMAIL' }>;

export type SignInOutcome =
  { kind: 'session'; session: AuthSession } | { kind: 'challenge'; challenge: PendingChallenge };

/** Software-token MFA is six digits. */
const MFA_CODE_LENGTH = 6;

function toPendingChallenge(
  outcome: Extract<CognitoSignInOutcome, { kind: 'mfa' }>,
  maskedIdentifier: string,
): PendingChallenge {
  const expiresAt = new Date(Date.now() + CHALLENGE_SESSION_TTL_MS).toISOString();
  return {
    // A challenge issued in response to a correct password is a second factor
    // by definition.
    kind: 'MFA',
    challengeId: outcome.challenge.session,
    subjectId: outcome.challenge.userIdForSrp,
    maskedIdentifier,
    expiresAt,
    // A time-based code from an authenticator app has nothing to resend, so the
    // resend affordance is never offered inside this challenge's lifetime.
    resendAvailableAt: expiresAt,
    codeLength: MFA_CODE_LENGTH,
  };
}

/**
 * Signs in with an email address and a password.
 *
 * THIS MUST NOT BECOME AN ACCOUNT-EXISTENCE ORACLE. The response deliberately
 * does not say whether the address has an account, so the UI must not either:
 * a failed sign-in and a sign-in against an address nobody has registered lead
 * to the identical screen and the identical wording. Anything else turns this
 * into a way to confirm that a given person uses a location product, which for
 * this product is a way to confirm where to look for them.
 *
 * Three things hold that property up, and all three have to stay:
 * `PreventUserExistenceErrors` is enabled on the pool, so Cognito answers an
 * unknown address with a decoy salt and `SRP_B` and fails at the same step;
 * `cognito/errors.ts` collapses every credential-shaped failure onto one fixed
 * string and never repeats Cognito's own; and nothing here inspects the failure
 * to decide which screen to show.
 *
 * No client-built device fingerprint is sent. Device identity is established by
 * the separate, consented device-registration step; silently profiling the
 * handset during sign-in is exactly the behaviour this app rejects. It is also
 * why the Cognito device-tracking handshake is never completed — see
 * `cognito/password-auth.ts`.
 */
export async function signIn(
  identifier: EmailIdentifier,
  password: string,
): Promise<SignInOutcome> {
  const outcome = await signInWithPassword(identifier.email, password);
  if (outcome.kind === 'session') {
    return { kind: 'session', session: outcome.session };
  }
  return { kind: 'challenge', challenge: toPendingChallenge(outcome, maskIdentifier(identifier)) };
}

/**
 * Answers an outstanding second-factor challenge.
 *
 * Failures here may be specific — "that code is not right" — because the caller
 * has already proved the password. Nothing is disclosed that they did not
 * already know.
 */
export async function submitMfaCode(
  challenge: PendingChallenge,
  code: string,
): Promise<SignInOutcome> {
  const outcome = await answerMfaChallenge(
    { session: challenge.challengeId, userIdForSrp: challenge.subjectId },
    code,
  );
  if (outcome.kind === 'session') {
    return { kind: 'session', session: outcome.session };
  }
  return { kind: 'challenge', challenge: toPendingChallenge(outcome, challenge.maskedIdentifier) };
}

// ---------------------------------------------------------------------------
// Revocation
// ---------------------------------------------------------------------------

/**
 * Ends the session server-side.
 *
 * Two different calls, because they need different credentials and have
 * different blast radii. `RevokeToken` retires this device's refresh token and,
 * because token revocation is enabled on the app client, every access token
 * issued from it. `GlobalSignOut` ends every session the account has anywhere,
 * and is authorised by the access token rather than the refresh token — which
 * is why the whole stored session is passed in rather than one string.
 *
 * Neither is allowed to be the thing that makes signing out fail: the caller
 * has already destroyed the local credentials before this runs.
 */
export async function revokeSession(session: StoredSession, allDevices: boolean): Promise<void> {
  if (allDevices) {
    await globalSignOut(session.accessToken);
    return;
  }
  await revokeToken(session.refreshToken);
}

// ---------------------------------------------------------------------------
// Terms acceptance
// ---------------------------------------------------------------------------

/**
 * Records that this person accepted a specific version of the terms.
 *
 * It is a PATCH on the account, not a POST to `/v1/auth/terms`. Consent is a
 * fact about the person rather than about a session, the account is where it is
 * read back from, and `/v1/auth/*` is a surface this API deliberately does not
 * expose — nobody should be able to accept terms without being signed in as the
 * person accepting them.
 */
export async function acceptTerms(versions: PolicyVersions): Promise<void> {
  await request({
    method: 'PATCH',
    path: '/v1/account',
    body: { acceptedTermsVersion: versions.termsVersion },
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
