import {
  unauthenticatedError,
  verifyAccessToken,
  type AuthContext,
  type TokenVerifier,
} from '@family/auth';
import { DeviceIdSchema } from '@family/contracts';

import type { HttpRequest } from '../types.js';

/**
 * Bearer-token authentication.
 *
 * API Gateway already validates the JWT against the user pool before the
 * function is invoked. This verifies it again, in-process, for two reasons: the
 * function must be safe if it is ever invoked by anything other than that
 * authorizer, and the verified claims are the only sanctioned way to obtain an
 * {@link AuthContext} — no handler is allowed to assemble one from a header.
 *
 * No token, claim value or failure detail is logged here. Callers see one of
 * two fixed messages, so a forged token yields no diagnostic.
 */

const BEARER_PREFIX = 'bearer ';

export function extractBearerToken(request: HttpRequest): string | null {
  const header = request.headers['authorization'];
  if (header === undefined) {
    return null;
  }
  if (!header.toLowerCase().startsWith(BEARER_PREFIX)) {
    return null;
  }
  const token = header.slice(BEARER_PREFIX.length).trim();
  return token === '' ? null : token;
}

/**
 * A device id proven by a header the client also binds its token to. It only
 * ever narrows access: `verifyAccessToken` still validates it, and an
 * unregistered id fails the authorization checker's device step.
 */
function extractDeviceId(request: HttpRequest): string | null {
  const header = request.headers['x-device-id'];
  if (header === undefined) {
    return null;
  }
  const parsed = DeviceIdSchema.safeParse(header);
  return parsed.success ? parsed.data : null;
}

export async function authenticate(input: {
  request: HttpRequest;
  verifier: TokenVerifier;
  requestId: string;
}): Promise<AuthContext> {
  const token = extractBearerToken(input.request);
  if (token === null) {
    throw unauthenticatedError();
  }
  return verifyAccessToken(token, {
    verifier: input.verifier,
    requestId: input.requestId,
    deviceId: extractDeviceId(input.request),
  });
}
