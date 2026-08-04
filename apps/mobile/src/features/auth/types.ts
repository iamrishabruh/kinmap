import { z } from 'zod';

import { AuthSessionSchema, OpaqueTokenSchema } from '@family/schemas';

/**
 * Client-side auth vocabulary.
 *
 * Response shapes are re-used from @family/schemas rather than redeclared. The
 * few types below exist only because they describe client state that never
 * crosses the wire.
 */

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/**
 * The credential bundle written to the device keychain. Deliberately a subset
 * of `AuthSession`: `isNewUser` and `termsAcceptanceRequired` are decisions the
 * server re-derives on every request, so caching them in secure storage would
 * only create a way for a stale device to skip the consent gate.
 */
export const StoredSessionSchema = z.object({
  userId: AuthSessionSchema.shape.userId,
  accessToken: OpaqueTokenSchema,
  accessTokenExpiresAt: AuthSessionSchema.shape.accessTokenExpiresAt,
  refreshToken: OpaqueTokenSchema,
  refreshTokenExpiresAt: AuthSessionSchema.shape.refreshTokenExpiresAt,
});
export type StoredSession = z.infer<typeof StoredSessionSchema>;

export type SessionStatus =
  /** Reading the keychain. The splash screen is still up; do not navigate. */
  | 'restoring'
  /** No usable credential on this device. */
  | 'unauthenticated'
  /** Credentials offered, but a second step is outstanding. Not a session. */
  | 'challenge'
  /** A usable access/refresh pair exists. */
  | 'authenticated';

// ---------------------------------------------------------------------------
// Challenges
// ---------------------------------------------------------------------------

/**
 * The pool's only interactive second step is a TOTP code: MFA is optional and
 * TOTP-only, because SMS recovery is a SIM-swap route into somebody's location
 * history. The passwordless-OTP, email-verification and account-recovery
 * challenges this union used to carry belonged to the retired `/v1/auth/*`
 * surface; Cognito services the equivalents itself, without an in-app
 * challenge screen.
 */
export type ChallengeKind = 'MFA';

/**
 * An in-flight challenge.
 *
 * `maskedIdentifier` is the only form of the address held here. The full
 * address is never persisted alongside a challenge, never put in a route param,
 * and never sent to telemetry.
 *
 * `challengeId` is Cognito's opaque challenge session. It is not a token and
 * grants nothing on its own, but it is credential-adjacent and short-lived: it
 * lives in the in-memory session store for the length of the challenge, is
 * never written to the keychain, and is never logged.
 */
export type PendingChallenge = {
  kind: ChallengeKind;
  challengeId: string;
  /**
   * The pool's own identifier for the account, echoed back when the challenge
   * is answered. Deliberately not the address the user typed.
   */
  subjectId: string;
  maskedIdentifier: string;
  expiresAt: string;
  resendAvailableAt: string;
  codeLength: number;
};

// ---------------------------------------------------------------------------
// Identity providers
// ---------------------------------------------------------------------------

export type SocialProvider = 'APPLE' | 'GOOGLE';

export type SocialCredential = {
  provider: SocialProvider;
  /** Provider-issued identity token. Verified server-side; never logged. */
  identityToken: string;
  authorizationCode: string | null;
  /** Raw nonce; the server compares its hash against the token's claim. */
  nonce: string;
  /**
   * Apple supplies a name on the FIRST authorisation only, and Google may omit
   * it entirely. Null means "server keeps whatever it already has".
   */
  displayName: string | null;
  /**
   * True when the provider returned a Hide-My-Email relay address. The account
   * still works, but "we emailed you" copy has to change, so the flag is
   * surfaced to the UI rather than inferred again later.
   */
  isPrivateRelayEmail: boolean;
};

/** Raised when the user backs out of a provider sheet. Never an error state. */
export class SocialSignInCancelledError extends Error {
  constructor(provider: SocialProvider) {
    super(`${provider} sign-in was cancelled.`);
    this.name = 'SocialSignInCancelledError';
  }
}

/** Raised when the provider is unusable on this device (no Play Services, etc). */
export class SocialSignInUnavailableError extends Error {
  readonly provider: SocialProvider;

  constructor(provider: SocialProvider, message: string) {
    super(message);
    this.name = 'SocialSignInUnavailableError';
    this.provider = provider;
  }
}

// ---------------------------------------------------------------------------
// Sign-out
// ---------------------------------------------------------------------------

export type SignOutReason =
  /** The user tapped sign out. */
  | 'USER_REQUESTED'
  /** Refresh failed or the server revoked the session. */
  | 'SESSION_EXPIRED'
  /** The account was deleted or suspended server-side. */
  | 'ACCOUNT_UNAVAILABLE';
