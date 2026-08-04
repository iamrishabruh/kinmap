import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AppError } from '@family/contracts';

import { resetCognitoConfig } from '../cognito/config';
import {
  authorizeUrl,
  createPkcePair,
  HostedSignInCancelledError,
  parseRedirect,
  signInWithHostedProvider,
} from '../cognito/hosted-ui';

import {
  __reset as resetBrowser,
  __respondWith as respondWith,
  lastAuthorizeUrl,
} from './doubles/expo-web-browser';
import {
  accessToken,
  bytesBase64Url,
  idToken,
  REFRESH_TOKEN,
  sha256,
  textBytes,
} from './support/cognito-server';
import { installFetch, type FetchHarness } from './support/fetch-harness';

/**
 * The federated flow. A Cognito user pool has no API that takes a provider
 * identity token, so Sign in with Apple is the hosted UI's authorization-code
 * grant with PKCE, and these are the properties that make that safe.
 */

const SUB = '8f14e45f-ceea-467a-9e57-1a1f2c4d5b6e';

let harness: FetchHarness | null = null;

function redirectFor(url: string, extra: Record<string, string>): string {
  const state = new URL(url).searchParams.get('state') ?? '';
  const query = Object.entries({ state, ...extra })
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&');
  return `kinmap://auth/callback?${query}`;
}

beforeEach(() => {
  resetCognitoConfig();
  resetBrowser();
});

afterEach(() => {
  harness?.restore();
  harness = null;
});

describe('createPkcePair', () => {
  it('derives the challenge as the S256 of the verifier', async () => {
    const pkce = await createPkcePair();
    const expected = bytesBase64Url(await sha256(textBytes(pkce.verifier)));

    expect(pkce.challenge).toBe(expected);
  });

  it("produces a verifier inside RFC 7636's length bounds, unpadded", async () => {
    const pkce = await createPkcePair();

    expect(pkce.verifier.length).toBeGreaterThanOrEqual(43);
    expect(pkce.verifier.length).toBeLessThanOrEqual(128);
    expect(pkce.verifier).not.toContain('=');
    expect(pkce.verifier).toMatch(/^[A-Za-z0-9\-_]+$/u);
  });

  it('never reuses a verifier', async () => {
    const first = await createPkcePair();
    const second = await createPkcePair();

    expect(first.verifier).not.toBe(second.verifier);
  });
});

describe('authorizeUrl', () => {
  it('pins the provider, the redirect and the challenge method', () => {
    const url = new URL(authorizeUrl('SignInWithApple', 'challenge-value', 'state-value'));

    expect(url.origin).toBe(
      'https://kinmap-development-000000000000.auth.us-east-1.amazoncognito.com',
    );
    expect(url.pathname).toBe('/oauth2/authorize');
    expect(url.searchParams.get('identity_provider')).toBe('SignInWithApple');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('redirect_uri')).toBe('kinmap://auth/callback');
    expect(url.searchParams.get('scope')).toBe('openid email profile');
  });

  it('carries no secret and no verifier', () => {
    // The verifier is the thing that stays on the device; putting it in the
    // authorize URL would defeat the entire point of PKCE.
    const url = authorizeUrl('SignInWithApple', 'challenge-value', 'state-value');

    expect(url).not.toContain('client_secret');
    expect(url).not.toContain('code_verifier');
  });
});

describe('parseRedirect', () => {
  it('reads the query without depending on a URL polyfill', () => {
    expect(parseRedirect('kinmap://auth/callback?code=abc&state=xyz')).toEqual({
      code: 'abc',
      state: 'xyz',
    });
  });

  it('decodes escapes and stops at the fragment', () => {
    expect(parseRedirect('kinmap://cb?a=one%20two&b=x#frag')).toEqual({ a: 'one two', b: 'x' });
  });

  it('yields nothing for a redirect it cannot parse', () => {
    expect(parseRedirect('kinmap://auth/callback')).toEqual({});
    expect(parseRedirect('kinmap://cb?a=%')).toEqual({});
  });
});

describe('signInWithHostedProvider', () => {
  it('exchanges the code for a session', async () => {
    respondWith((url) => ({
      type: 'success',
      url: redirectFor(url, { code: 'auth-code-1' }),
    }));
    harness = installFetch(() => ({
      status: 200,
      body: {
        access_token: accessToken({ sub: SUB }),
        id_token: idToken({ sub: SUB, email: 'relay@privaterelay.appleid.com' }),
        refresh_token: REFRESH_TOKEN,
        expires_in: 3600,
        token_type: 'Bearer',
      },
    }));

    const session = await signInWithHostedProvider('SignInWithApple');

    expect(session.userId).toBe(SUB);
    expect(harness.requests[0]?.url).toContain('/oauth2/token');
    expect(harness.requests[0]?.form.grant_type).toBe('authorization_code');
    expect(harness.requests[0]?.form.code).toBe('auth-code-1');
    expect(harness.requests[0]?.form.code_verifier).toBeTruthy();
    expect(harness.requests[0]?.form.client_secret).toBeUndefined();
  });

  it('sends the verifier that matches the challenge it advertised', async () => {
    respondWith((url) => ({
      type: 'success',
      url: redirectFor(url, { code: 'auth-code-1' }),
    }));
    harness = installFetch(() => ({
      status: 200,
      body: {
        access_token: accessToken({ sub: SUB }),
        id_token: idToken({ sub: SUB, email: 'a@b.c' }),
        refresh_token: REFRESH_TOKEN,
      },
    }));

    await signInWithHostedProvider('SignInWithApple');

    const advertised = new URL(lastAuthorizeUrl()).searchParams.get('code_challenge');
    const verifier = harness.requests[0]?.form.code_verifier ?? '';
    expect(bytesBase64Url(await sha256(textBytes(verifier)))).toBe(advertised);
  });

  it('refuses a redirect whose state it did not issue', async () => {
    // Without this check an attacker-supplied redirect could inject their own
    // authorization code and land the victim in the attacker's account.
    respondWith(() => ({
      type: 'success',
      url: 'kinmap://auth/callback?code=attacker-code&state=not-the-one',
    }));
    harness = installFetch(() => ({ status: 200, body: {} }));

    await expect(signInWithHostedProvider('SignInWithApple')).rejects.toBeInstanceOf(AppError);
    expect(harness.requests).toHaveLength(0);
  });

  it('treats a dismissed browser as a cancellation, not an error', async () => {
    respondWith(() => ({ type: 'cancel' }));

    await expect(signInWithHostedProvider('SignInWithApple')).rejects.toBeInstanceOf(
      HostedSignInCancelledError,
    );
  });

  it('treats a declined authorisation as a cancellation', async () => {
    respondWith((url) => ({
      type: 'success',
      url: redirectFor(url, { error: 'access_denied' }),
    }));

    await expect(signInWithHostedProvider('SignInWithApple')).rejects.toBeInstanceOf(
      HostedSignInCancelledError,
    );
  });

  it("never surfaces the provider's error description", async () => {
    // `error_description` is free text controlled by the identity provider.
    respondWith((url) => ({
      type: 'success',
      url: redirectFor(url, {
        error: 'invalid_request',
        error_description:
          'Identity provider SignInWithApple does not exist for someone@example.com',
      }),
    }));

    const failure = (await signInWithHostedProvider('SignInWithApple').catch(
      (cause: unknown) => cause,
    )) as AppError;

    expect(failure).toBeInstanceOf(AppError);
    expect(failure.message).not.toContain('someone@example.com');
    expect(failure.message).not.toContain('SignInWithApple');
  });

  it("reports a used or expired code without repeating the token endpoint's wording", async () => {
    respondWith((url) => ({
      type: 'success',
      url: redirectFor(url, { code: 'auth-code-1' }),
    }));
    harness = installFetch(() => ({
      status: 400,
      body: {
        error: 'invalid_grant',
        error_description: 'Authorization code has already been consumed by someone@example.com',
      },
    }));

    const failure = (await signInWithHostedProvider('SignInWithApple').catch(
      (cause: unknown) => cause,
    )) as AppError;

    expect(failure.code).toBe('UNAUTHENTICATED');
    expect(failure.message).not.toContain('someone@example.com');
  });
});
