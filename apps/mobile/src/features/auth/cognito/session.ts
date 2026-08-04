import { z } from 'zod';

import { AppError, UserIdSchema } from '@family/contracts';
import { AuthSessionSchema, type AuthSession } from '@family/schemas';

import { REFRESH_TOKEN_TTL_MS } from './config';
import { fromBase64, utf8Decode } from './encoding';
import { COGNITO_ERROR_MESSAGES } from './errors';
import type { AuthenticationResult } from './idp-client';

/**
 * Cognito's token bundle, projected onto the app's `AuthSession` contract.
 *
 * The API verifies the ACCESS token (`packages/auth`'s
 * `createCognitoAccessTokenVerifier`, `tokenUse: 'access'`), so that is what
 * becomes `accessToken`. The id token is read for nothing and kept for nothing:
 * it carries the user's email as a claim, and there is no reason for a copy of
 * that to sit in the keychain next to the tokens.
 *
 * The access token's payload IS decoded here, without verifying its signature.
 * That is safe because nothing security-relevant is decided from it: the claims
 * are used to key local storage and to know when to refresh, and every actual
 * authorization decision is made server-side against a signature-verified
 * token. A forged token would simply be rejected on the first request.
 */

/**
 * The claims this client reads. `token_use` is checked so an id token can never
 * be stored as the bearer credential — it would be rejected by the API with the
 * same code an expired session produces, and the refresh cycle would then spin
 * on a token that can never work.
 */
const AccessClaimsSchema = z.object({
  sub: z.string(),
  exp: z.number().int().positive(),
  token_use: z.literal('access'),
});

function decodeJwtPayload(token: string): unknown {
  const segments = token.split('.');
  const payload = segments.length === 3 ? segments[1] : undefined;
  if (payload === undefined) {
    throw new AppError('INTERNAL_ERROR', COGNITO_ERROR_MESSAGES.INTERNAL);
  }
  try {
    return JSON.parse(utf8Decode(fromBase64(payload))) as unknown;
  } catch {
    // The token is not echoed into the error. It is a live credential.
    throw new AppError('INTERNAL_ERROR', COGNITO_ERROR_MESSAGES.INTERNAL);
  }
}

/**
 * What a refresh keeps from the session it replaces.
 *
 * Both fields exist because of refresh-token rotation, which is enabled on this
 * app client with a 60-second retry grace period:
 *
 *  - `refreshToken` covers the case where Cognito answers without a new one.
 *  - `refreshTokenExpiresAt` is carried forward rather than recomputed. A
 *    rotation replaces the token, not the grant behind it, so extending the
 *    expiry on every refresh would let the client believe in a session the pool
 *    has already ended — and the client would then skip the round trip that
 *    would have told it otherwise.
 */
export type RefreshCarryForward = {
  readonly refreshToken: string;
  readonly refreshTokenExpiresAt: string;
};

/**
 * @throws AppError INTERNAL_ERROR when the pool returns something that is not a
 * usable session. Never includes any part of the token in the message.
 */
export function toAuthSession(
  result: AuthenticationResult,
  carryForward?: RefreshCarryForward,
): AuthSession {
  const claims = AccessClaimsSchema.safeParse(decodeJwtPayload(result.AccessToken));
  if (!claims.success) {
    throw new AppError('INTERNAL_ERROR', COGNITO_ERROR_MESSAGES.INTERNAL);
  }

  const userId = UserIdSchema.safeParse(claims.data.sub);
  if (!userId.success) {
    throw new AppError('INTERNAL_ERROR', COGNITO_ERROR_MESSAGES.INTERNAL);
  }

  const refreshToken = result.RefreshToken ?? carryForward?.refreshToken;
  if (refreshToken === undefined) {
    throw new AppError('INTERNAL_ERROR', COGNITO_ERROR_MESSAGES.INTERNAL);
  }

  const refreshTokenExpiresAt =
    carryForward?.refreshTokenExpiresAt ??
    new Date(Date.now() + REFRESH_TOKEN_TTL_MS).toISOString();

  // Parsed rather than cast. `AuthSessionSchema` is a strict object, so a shape
  // that drifted from the contract fails here instead of reaching the keychain.
  const parsed = AuthSessionSchema.safeParse({
    userId: userId.data,
    accessToken: result.AccessToken,
    // The `exp` claim rather than `ExpiresIn`: the token states its own expiry,
    // and a clock that agrees with the issuer beats one that agrees with the
    // moment the response happened to be parsed.
    accessTokenExpiresAt: new Date(claims.data.exp * 1000).toISOString(),
    refreshToken,
    refreshTokenExpiresAt,
    // Both of these are decisions the server re-derives from `GET /v1/account`
    // on every launch. `establishSession` deliberately does not persist them,
    // and Cognito has no opinion about either, so they are stated as the
    // no-op values rather than guessed at from the token.
    isNewUser: false,
    termsAcceptanceRequired: null,
  });

  if (!parsed.success) {
    throw new AppError('INTERNAL_ERROR', COGNITO_ERROR_MESSAGES.INTERNAL);
  }
  return parsed.data;
}
