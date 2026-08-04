import { z } from 'zod';

import { AppError } from '@family/contracts';

import { cognitoConfig } from './config';
import { cognitoError, cognitoTransportError, COGNITO_ERROR_MESSAGES } from './errors';

/**
 * The transport for `cognito-idp`.
 *
 * A handful of unauthenticated JSON-1.1 calls — `InitiateAuth`,
 * `RespondToAuthChallenge`, `RevokeToken`, `GlobalSignOut` — against a public
 * app client with no secret. Nothing here signs a request, because there is
 * nothing to sign with, which is precisely why these four operations are the
 * only ones a mobile binary is allowed to make.
 *
 * NOTHING IN THIS FILE LOGS. Not the request, not the response, not the error.
 * Every field on the way in is a credential (a password claim, a refresh
 * token), every field on the way out is a token, and Cognito's own error
 * strings name the account. A breadcrumb here would be the single most
 * damaging line in the app.
 *
 * Responses are parsed against a schema before anything reaches state, on the
 * same principle `lib/api.ts` applies to our own API: an auth response is the
 * last place to trust a shape.
 */

const REQUEST_TIMEOUT_MS = 20_000;

const AMZ_TARGET_PREFIX = 'AWSCognitoIdentityProviderService';

export type CognitoAction =
  | 'InitiateAuth'
  | 'RespondToAuthChallenge'
  | 'RevokeToken'
  | 'GlobalSignOut'
  | 'SignUp'
  | 'ConfirmSignUp';

/** Cognito reports service errors in the body, frequently with a 400. */
const ServiceErrorSchema = z.object({
  __type: z.string().optional(),
  // Read so it can be discarded explicitly rather than by omission: this field
  // is the account-existence leak, and it must be visible in the code that it
  // is being dropped on purpose.
  message: z.string().optional(),
});

/**
 * The tokens Cognito issues.
 *
 * `RefreshToken` is optional: refresh-token rotation is enabled on this client,
 * so a refresh normally returns a new one, but the contract permits its
 * absence and the caller has to be able to carry the previous one forward.
 */
export const AuthenticationResultSchema = z.object({
  AccessToken: z.string().min(1),
  IdToken: z.string().min(1),
  RefreshToken: z.string().min(1).optional(),
  ExpiresIn: z.number().int().positive().optional(),
  TokenType: z.string().optional(),
});
export type AuthenticationResult = z.infer<typeof AuthenticationResultSchema>;

/**
 * `ChallengeParameters` is a free-form string map. It is typed as such rather
 * than narrowed per challenge, because a missing key must surface as a clear
 * failure at the point of use, not as a parse error attributed to the wrong
 * step of the flow.
 */
export const AuthResponseSchema = z.object({
  ChallengeName: z.string().optional(),
  /** Opaque challenge state. Short-lived, memory-only, never persisted. */
  Session: z.string().optional(),
  ChallengeParameters: z.record(z.string(), z.string()).optional(),
  AuthenticationResult: AuthenticationResultSchema.optional(),
});
export type AuthResponse = z.infer<typeof AuthResponseSchema>;

const EmptyResponseSchema = z.unknown();

async function post(action: CognitoAction, payload: unknown): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  try {
    return await fetch(cognitoConfig().idpEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': `${AMZ_TARGET_PREFIX}.${action}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return {};
  }
}

/**
 * Performs one Cognito call and parses the result.
 *
 * @throws AppError always — never a raw fetch or JSON error, so no caller has
 * to know that Cognito is the thing on the other end of the socket.
 */
export async function callCognito<TResponse>(
  action: CognitoAction,
  payload: unknown,
  schema: z.ZodType<TResponse>,
): Promise<TResponse> {
  let response: Response;
  try {
    response = await post(action, payload);
  } catch {
    // Includes the abort. Being offline is not being signed out, and the caller
    // distinguishes the two by the error code alone.
    throw cognitoTransportError();
  }

  const body = await readJson(response);

  if (!response.ok) {
    const parsed = ServiceErrorSchema.safeParse(body);
    // `parsed.data.message` is deliberately not read. See the file header.
    throw cognitoError(parsed.success ? (parsed.data.__type ?? '') : '', response.status);
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    // The body is not shown or logged: a response that failed validation is
    // exactly the kind of payload most likely to contain something sensitive.
    throw new AppError('INTERNAL_ERROR', COGNITO_ERROR_MESSAGES.INTERNAL);
  }
  return parsed.data;
}

export async function initiateAuth(payload: unknown): Promise<AuthResponse> {
  return callCognito('InitiateAuth', payload, AuthResponseSchema);
}

export async function respondToAuthChallenge(payload: unknown): Promise<AuthResponse> {
  return callCognito('RespondToAuthChallenge', payload, AuthResponseSchema);
}

/**
 * Revokes a refresh token and, because token revocation is enabled on the app
 * client, every access token that was issued from it.
 */
export async function revokeToken(refreshToken: string): Promise<void> {
  await callCognito(
    'RevokeToken',
    { Token: refreshToken, ClientId: cognitoConfig().clientId },
    EmptyResponseSchema,
  );
}

/** Signs the account out on every device. Authorised by the access token itself. */
export async function globalSignOut(accessToken: string): Promise<void> {
  await callCognito('GlobalSignOut', { AccessToken: accessToken }, EmptyResponseSchema);
}
