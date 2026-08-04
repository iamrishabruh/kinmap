import * as WebBrowser from 'expo-web-browser';
import { z } from 'zod';

import { AppError } from '@family/contracts';
import type { AuthSession } from '@family/schemas';

import { randomBytes, sha256 } from '@/features/location/crypto/digest';

import { cognitoConfig } from './config';
import { toBase64Url, toHex, utf8Encode } from './encoding';
import { cognitoError, cognitoTransportError, COGNITO_ERROR_MESSAGES } from './errors';
import { AuthenticationResultSchema } from './idp-client';
import { toAuthSession } from './session';

/**
 * Federated sign-in through the Cognito hosted UI.
 *
 * WHY A BROWSER AND NOT THE NATIVE APPLE CREDENTIAL. A Cognito USER POOL has no
 * API that accepts a provider identity token. Federation to a user pool happens
 * only through `/oauth2/authorize`, and the tokens the API's JWT authorizer
 * accepts are the pool's own. `expo-apple-authentication` returns an Apple
 * identity token — genuinely useful, and genuinely not exchangeable for a
 * Cognito session by any call that exists. (The identity-pool APIs that do take
 * one return IAM credentials, which this API cannot authenticate.) So the
 * federated flow is the authorization-code grant, and the native sheet is used
 * for the one thing only it can do: telling us whether to offer the button at
 * all.
 *
 * PKCE, NOT A CLIENT SECRET. The app client is public because a mobile binary
 * cannot keep a secret. The code verifier is generated per attempt, never
 * leaves the device, and the challenge that does leave is a SHA-256 of it — so
 * an authorization code intercepted from the redirect is worthless without the
 * process that asked for it.
 *
 * EPHEMERAL BROWSER SESSION. The authentication session is opened without
 * access to the device's shared cookie jar. It costs the user a confirmation
 * they might otherwise have been able to skip, and it buys the property this
 * product cannot do without: no signed-in identity-provider session is left
 * behind on the device. On a shared or handed-over phone, the next person to
 * tap "Continue with Apple" must not land inside the previous person's account
 * — and it also means signing out never has to open a browser to undo
 * something, which is what lets `signOut` stay non-blocking and unfailable.
 */

const USE_EPHEMERAL_BROWSER_SESSION = true;

/** RFC 7636 §4.1: 43–128 characters. 32 bytes of entropy renders as 43. */
const CODE_VERIFIER_BYTES = 32;
const STATE_BYTES = 16;

const TOKEN_REQUEST_TIMEOUT_MS = 20_000;

/**
 * Provider names are fixed by Cognito and must match the `providerName` in
 * `identity-stack.ts` exactly.
 */
export type HostedProvider = 'SignInWithApple' | 'Google';

/** Raised when the user backs out of the browser. Never an error state. */
export class HostedSignInCancelledError extends Error {
  constructor() {
    super('Sign-in was cancelled.');
    this.name = 'HostedSignInCancelledError';
  }
}

const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  id_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().int().positive().optional(),
  token_type: z.string().optional(),
});

const TokenErrorSchema = z.object({
  error: z.string().optional(),
  // Read so it is visibly discarded. OAuth error descriptions are free text
  // from the provider and can name the account.
  error_description: z.string().optional(),
});

export type PkcePair = {
  readonly verifier: string;
  readonly challenge: string;
};

export async function createPkcePair(): Promise<PkcePair> {
  const verifier = toBase64Url(randomBytes(CODE_VERIFIER_BYTES));
  const challenge = toBase64Url(await sha256(utf8Encode(verifier)));
  return { verifier, challenge };
}

function encode(value: string): string {
  // `encodeURIComponent` leaves `!'()*` alone; RFC 3986 wants them escaped.
  return encodeURIComponent(value).replace(
    /[!'()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function authorizeUrl(provider: HostedProvider, challenge: string, state: string): string {
  const config = cognitoConfig();
  const query = [
    'response_type=code',
    `client_id=${encode(config.clientId)}`,
    `redirect_uri=${encode(config.redirectUri)}`,
    // Exactly the scopes the app client allows. Nothing here asks the provider
    // for anything beyond an identity.
    `scope=${encode('openid email profile')}`,
    `state=${encode(state)}`,
    `code_challenge=${encode(challenge)}`,
    'code_challenge_method=S256',
    `identity_provider=${encode(provider)}`,
  ].join('&');
  return `${config.hostedUiOrigin}/oauth2/authorize?${query}`;
}

/**
 * Reads the query parameters off the redirect.
 *
 * Hand-parsed rather than routed through `URL`/`URLSearchParams`: those are
 * polyfills in this runtime with a history of partial implementations, and a
 * silently mis-parsed `state` here would mean the CSRF check passes when it
 * should not.
 */
export function parseRedirect(url: string): Record<string, string> {
  const separator = url.indexOf('?');
  if (separator < 0) return {};
  const query = url.slice(separator + 1).split('#')[0] ?? '';
  const values: Record<string, string> = {};
  for (const pair of query.split('&')) {
    if (pair.length === 0) continue;
    const equals = pair.indexOf('=');
    const key = equals < 0 ? pair : pair.slice(0, equals);
    const value = equals < 0 ? '' : pair.slice(equals + 1);
    try {
      values[decodeURIComponent(key)] = decodeURIComponent(value.replace(/\+/gu, ' '));
    } catch {
      // A malformed escape means the redirect is not one we produced.
      return {};
    }
  }
  return values;
}

/**
 * Constant-time-ish equality for the `state` echo. The values are the same
 * length by construction, so this only has to avoid an early return.
 */
function statesMatch(expected: string, actual: string): boolean {
  if (expected.length !== actual.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected.charCodeAt(index) ^ actual.charCodeAt(index);
  }
  return difference === 0;
}

async function exchangeCode(code: string, verifier: string): Promise<AuthSession> {
  const config = cognitoConfig();
  const body = [
    'grant_type=authorization_code',
    `client_id=${encode(config.clientId)}`,
    `code=${encode(code)}`,
    `redirect_uri=${encode(config.redirectUri)}`,
    `code_verifier=${encode(verifier)}`,
  ].join('&');

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, TOKEN_REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${config.hostedUiOrigin}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: controller.signal,
    });
  } catch {
    throw cognitoTransportError();
  } finally {
    clearTimeout(timer);
  }

  let payload: unknown;
  try {
    payload = (await response.json()) as unknown;
  } catch {
    throw new AppError('INTERNAL_ERROR', COGNITO_ERROR_MESSAGES.INTERNAL);
  }

  if (!response.ok) {
    const parsed = TokenErrorSchema.safeParse(payload);
    // `error_description` is deliberately not read. See the schema comment.
    const reason = parsed.success ? (parsed.data.error ?? '') : '';
    if (reason === 'invalid_grant') {
      // The code was already used, expired, or belongs to another attempt.
      throw new AppError('UNAUTHENTICATED', COGNITO_ERROR_MESSAGES.CHALLENGE_EXPIRED);
    }
    throw cognitoError(reason, response.status);
  }

  const tokens = TokenResponseSchema.safeParse(payload);
  if (!tokens.success) {
    throw new AppError('INTERNAL_ERROR', COGNITO_ERROR_MESSAGES.INTERNAL);
  }

  const result = AuthenticationResultSchema.safeParse({
    AccessToken: tokens.data.access_token,
    IdToken: tokens.data.id_token,
    ...(tokens.data.refresh_token === undefined ? {} : { RefreshToken: tokens.data.refresh_token }),
    ...(tokens.data.expires_in === undefined ? {} : { ExpiresIn: tokens.data.expires_in }),
  });
  if (!result.success) {
    throw new AppError('INTERNAL_ERROR', COGNITO_ERROR_MESSAGES.INTERNAL);
  }
  return toAuthSession(result.data);
}

/**
 * Runs the whole authorization-code grant for one provider.
 *
 * @throws HostedSignInCancelledError when the user dismisses the browser.
 * @throws AppError for everything else.
 */
export async function signInWithHostedProvider(provider: HostedProvider): Promise<AuthSession> {
  const config = cognitoConfig();
  const pkce = await createPkcePair();
  const state = toHex(randomBytes(STATE_BYTES));

  let result: WebBrowser.WebBrowserAuthSessionResult;
  try {
    result = await WebBrowser.openAuthSessionAsync(
      authorizeUrl(provider, pkce.challenge, state),
      config.redirectUri,
      { preferEphemeralSession: USE_EPHEMERAL_BROWSER_SESSION },
    );
  } catch {
    throw cognitoTransportError();
  }

  if (result.type !== 'success') {
    // 'cancel', 'dismiss' and 'locked' are all the user closing the sheet.
    throw new HostedSignInCancelledError();
  }

  const parameters = parseRedirect(result.url);

  const echoed = parameters.state ?? '';
  if (!statesMatch(state, echoed)) {
    // Someone handed us a redirect we did not ask for. The value is not
    // included in the error, and nothing is retried automatically.
    throw new AppError('UNAUTHENTICATED', COGNITO_ERROR_MESSAGES.CHALLENGE_EXPIRED);
  }

  const failure = parameters.error;
  if (failure !== undefined) {
    if (failure === 'access_denied') {
      throw new HostedSignInCancelledError();
    }
    // `error_description` in the redirect is provider-controlled free text and
    // is never surfaced. `invalid_request` here is what an environment without
    // the provider configured returns.
    throw new AppError('INTERNAL_ERROR', COGNITO_ERROR_MESSAGES.INTERNAL);
  }

  const code = parameters.code;
  if (code === undefined || code.length === 0) {
    throw new AppError('INTERNAL_ERROR', COGNITO_ERROR_MESSAGES.INTERNAL);
  }

  return exchangeCode(code, pkce.verifier);
}
