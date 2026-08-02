import { CognitoJwtVerifier } from 'aws-jwt-verify';

import { AppError, DeviceIdSchema, UserIdSchema, type DeviceId } from '@family/contracts';

import { AccessTokenClaimsSchema, type AccessTokenClaims, type AuthContext } from './types.js';

/**
 * Cognito access-token verification (spec §18, step 1).
 *
 * Signature verification happens against the pool's published JWKS, which
 * `aws-jwt-verify` fetches and caches in-process. No token, claim value, or
 * JWKS material is ever logged here.
 */

/** Fixed, user-safe strings: an attacker learns nothing from which one appears. */
export const AUTH_ERROR_MESSAGES = {
  UNAUTHENTICATED: 'Authentication is required.',
  SESSION_EXPIRED: 'Your session has expired. Please sign in again.',
} as const;

export function unauthenticatedError(): AppError {
  return new AppError('UNAUTHENTICATED', AUTH_ERROR_MESSAGES.UNAUTHENTICATED);
}

export function sessionExpiredError(): AppError {
  return new AppError('SESSION_EXPIRED', AUTH_ERROR_MESSAGES.SESSION_EXPIRED);
}

/**
 * The seam between this package and `aws-jwt-verify`. Handlers depend on the
 * interface, so unit tests never need a live user pool.
 */
export interface TokenVerifier {
  verify(token: string): Promise<unknown>;
  /** Optional JWKS pre-fetch, used to avoid a cold-start fetch on the hot path. */
  hydrate?(): Promise<void>;
}

export type CognitoVerifierConfig = {
  userPoolId: string;
  /** App client id(s). Pass `null` only when the pool has a single client and you accept any. */
  clientId: string | string[] | null;
  /** Required OAuth scope(s), when the API is scope-gated. */
  scope?: string | string[];
  /** Seconds of clock skew tolerated on `exp`/`nbf`. */
  graceSeconds?: number;
};

/**
 * Builds a verifier bound to one Cognito user pool. Create it once per Lambda
 * container so the JWKS cache survives invocations.
 */
export function createCognitoAccessTokenVerifier(config: CognitoVerifierConfig): TokenVerifier {
  const verifier = CognitoJwtVerifier.create({
    userPoolId: config.userPoolId,
    tokenUse: 'access',
    clientId: config.clientId,
    scope: config.scope,
    graceSeconds: config.graceSeconds,
  });

  return {
    async verify(token: string): Promise<unknown> {
      return verifier.verify(token);
    },
    async hydrate(): Promise<void> {
      await verifier.hydrate();
    },
  };
}

export type VerifyAccessTokenOptions = {
  verifier: TokenVerifier;
  requestId: string;
  /**
   * Device id proven by another channel (for example a device-bound header the
   * API validated). Takes precedence over the `custom:device_id` claim.
   */
  deviceId?: string | null;
};

/**
 * Verifies a bearer access token and projects it into an {@link AuthContext}.
 *
 * @throws AppError SESSION_EXPIRED when the token has simply aged out, so the
 * client knows to refresh; AppError UNAUTHENTICATED for every other failure, so
 * a forged or foreign token yields no diagnostic detail.
 */
export async function verifyAccessToken(
  token: string,
  options: VerifyAccessTokenOptions,
): Promise<AuthContext> {
  if (typeof token !== 'string' || token.trim() === '') {
    throw unauthenticatedError();
  }

  let rawClaims: unknown;
  try {
    rawClaims = await options.verifier.verify(token);
  } catch (error) {
    throw isExpiredTokenError(error) ? sessionExpiredError() : unauthenticatedError();
  }

  const parsed = AccessTokenClaimsSchema.safeParse(rawClaims);
  if (!parsed.success) {
    throw unauthenticatedError();
  }
  const claims: AccessTokenClaims = parsed.data;

  // An id token presented as an access token must not be accepted: it carries
  // no scopes and is minted for a different audience.
  if (claims.token_use !== 'access') {
    throw unauthenticatedError();
  }

  const userId = UserIdSchema.safeParse(claims.sub);
  if (!userId.success) {
    throw unauthenticatedError();
  }

  return {
    userId: userId.data,
    deviceId: resolveDeviceId(claims, options.deviceId),
    tokenUse: 'access',
    claims,
    requestId: options.requestId,
  };
}

/**
 * `device_key` is deliberately ignored: it is Cognito's own tracking id, not a
 * row in our device registry, so it cannot satisfy the "registered device"
 * check.
 */
function resolveDeviceId(claims: AccessTokenClaims, override?: string | null): DeviceId | null {
  const candidate = override ?? claims['custom:device_id'];
  if (typeof candidate !== 'string') {
    return null;
  }
  const parsed = DeviceIdSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/**
 * Detected by name rather than `instanceof` so the check survives duplicated
 * copies of `aws-jwt-verify` in a hoisted workspace.
 */
export function isExpiredTokenError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const names = new Set([error.name, error.constructor.name]);
  return names.has('JwtExpiredError');
}
