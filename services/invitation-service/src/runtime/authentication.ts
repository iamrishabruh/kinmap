import {
  AccessTokenClaimsSchema,
  unauthenticatedError,
  resolveDeviceId,
  verifyAccessToken,
  type HeaderSource,
  type AuthContext,
  type TokenVerifier,
} from '@family/auth';
import { UserIdSchema } from '@family/contracts';

import { headerOf, requestIdOf, type HttpRequest } from './http.js';

/**
 * Request authentication (spec §18, step 1).
 *
 * Two paths, in priority order:
 *
 *  1. The HTTP API's Cognito JWT authorizer already verified the signature and
 *     forwarded the claims. Re-verifying in-process would be wasted latency, but
 *     the claims are still schema-parsed here — an authorizer misconfiguration
 *     must surface as UNAUTHENTICATED, not as an untyped `any` flowing into an
 *     authorization decision.
 *  2. No authorizer context (direct invocation, or a route that is deliberately
 *     integrated without one): the bearer token is verified against the pool.
 *
 * If neither is available the request is unauthenticated. There is no third path
 * — a handler can never assemble a principal from a header or a body.
 */

/** Gateway claims arrive as strings; these are numeric in the token itself. */
const NUMERIC_CLAIMS: readonly string[] = ['exp', 'iat', 'auth_time', 'nbf'];

export function normalizeGatewayClaims(raw: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...raw };
  for (const claim of NUMERIC_CLAIMS) {
    const value = normalized[claim];
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        normalized[claim] = parsed;
      }
    }
  }
  return normalized;
}

export function buildAuthContextFromClaims(
  rawClaims: Record<string, unknown>,
  requestId: string,
  headers?: HeaderSource,
): AuthContext {
  const parsed = AccessTokenClaimsSchema.safeParse(normalizeGatewayClaims(rawClaims));
  if (!parsed.success) {
    throw unauthenticatedError();
  }
  const claims = parsed.data;
  if (claims.token_use !== 'access') {
    // An id token carries no scopes and is minted for a different audience.
    throw unauthenticatedError();
  }
  const userId = UserIdSchema.safeParse(claims.sub);
  if (!userId.success) {
    throw unauthenticatedError();
  }

  return {
    userId: userId.data,
    deviceId: resolveDeviceId({ claims, headers }),
    tokenUse: 'access',
    claims,
    requestId,
  };
}

export type AuthenticationDeps = {
  /** Null when this service is only ever reached behind the JWT authorizer. */
  readonly verifier: TokenVerifier | null;
};

function bearerToken(event: HttpRequest): string | null {
  const authorization = headerOf(event, 'authorization');
  if (authorization === null) {
    return null;
  }
  const [scheme, ...rest] = authorization.split(' ');
  if (scheme === undefined || scheme.toLowerCase() !== 'bearer') {
    return null;
  }
  const token = rest.join(' ').trim();
  return token === '' ? null : token;
}

export async function authenticate(
  event: HttpRequest,
  deps: AuthenticationDeps,
): Promise<AuthContext> {
  const requestId = requestIdOf(event);

  const claims = event.requestContext?.authorizer?.jwt?.claims;
  if (claims !== undefined && claims !== null) {
    return buildAuthContextFromClaims(claims, requestId, event.headers);
  }

  const verifier = deps.verifier;
  const token = bearerToken(event);
  if (verifier === null || token === null) {
    throw unauthenticatedError();
  }

  const context = await verifyAccessToken(token, { verifier, requestId });
  return context.deviceId === null
    ? { ...context, deviceId: resolveDeviceId({ headers: event.headers }) }
    : context;
}
