import { describe, expect, it } from 'vitest';

import { AppError } from '@family/contracts';

import { REFRESH_TOKEN_TTL_MS } from '../cognito/config';
import { toAuthSession } from '../cognito/session';

import { accessToken, idToken, REFRESH_TOKEN } from './support/cognito-server';

const SUB = '8f14e45f-ceea-467a-9e57-1a1f2c4d5b6e';

function result(overrides: Partial<Record<string, string | number>> = {}) {
  return {
    AccessToken: accessToken({ sub: SUB }),
    IdToken: idToken({ sub: SUB, email: 'someone@example.com' }),
    RefreshToken: REFRESH_TOKEN,
    ExpiresIn: 3600,
    ...overrides,
  } as Parameters<typeof toAuthSession>[0];
}

describe('toAuthSession', () => {
  it('takes the expiry from the token rather than from ExpiresIn', () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 900;
    const session = toAuthSession(
      result({ AccessToken: accessToken({ sub: SUB, expiresAt }), ExpiresIn: 3600 }),
    );

    expect(session.accessTokenExpiresAt).toBe(new Date(expiresAt * 1000).toISOString());
  });

  it('stores the access token and never the id token', () => {
    // The id token carries the email as a claim; there is no reason for a copy
    // of that to sit in the keychain beside the credentials.
    const bundle = result();
    const session = toAuthSession(bundle);

    expect(session.accessToken).toBe(bundle.AccessToken);
    expect(JSON.stringify(session)).not.toContain(bundle.IdToken);
  });

  it('refuses an id token presented as the bearer credential', () => {
    // Storing one would be rejected by the API with the same code an expired
    // session produces, and the refresh cycle would spin on a token that can
    // never work.
    expect(() =>
      toAuthSession(result({ AccessToken: accessToken({ sub: SUB, tokenUse: 'id' }) })),
    ).toThrow(AppError);
  });

  it('accepts whatever subject format the provider mints', () => {
    // Cognito issues UUIDv7 subjects today and issued v4 before that. A client
    // that insisted on one shape would reject every real session the moment the
    // provider moved — which is exactly what happened server-side, in three
    // places at once.
    for (const sub of [
      'f43894a8-70d1-70fa-858b-5d9c82879e32',
      '9b2f5c1e-4a3d-4f8b-9c2e-1a2b3c4d5e6f',
      'auth0|5f8a3b2c1d0e9f8a7b6c5d4e',
    ]) {
      expect(toAuthSession(result({ AccessToken: accessToken({ sub }) })).userId).toBe(sub);
    }
  });

  it('refuses a token with no subject at all', () => {
    expect(() => toAuthSession(result({ AccessToken: accessToken({ sub: '' }) }))).toThrow(
      AppError,
    );
  });

  it('refuses a token that is not a JWT without echoing it back', () => {
    const failure = (() => {
      try {
        toAuthSession(result({ AccessToken: 'definitely-not-a-jwt' }));
        return null;
      } catch (cause) {
        return cause as AppError;
      }
    })();

    expect(failure).toBeInstanceOf(AppError);
    expect(failure?.message).not.toContain('definitely-not-a-jwt');
  });

  it("dates a fresh refresh grant from the app client's validity", () => {
    const before = Date.now();
    const session = toAuthSession(result());
    const expiresAt = Date.parse(session.refreshTokenExpiresAt);

    expect(expiresAt).toBeGreaterThanOrEqual(before + REFRESH_TOKEN_TTL_MS - 5_000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + REFRESH_TOKEN_TTL_MS + 5_000);
  });

  it('never claims a session is new or that terms are outstanding', () => {
    // Both are re-derived from GET /v1/account on every launch, and Cognito has
    // no opinion about either. A client-asserted value would be a way past the
    // consent gate.
    const session = toAuthSession(result());

    expect(session.isNewUser).toBe(false);
    expect(session.termsAcceptanceRequired).toBeNull();
  });

  it('fails rather than inventing a refresh token when none is available', () => {
    const bundle = result();
    delete (bundle as Record<string, unknown>).RefreshToken;

    expect(() => toAuthSession(bundle)).toThrow(AppError);
  });
});
