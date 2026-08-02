import { describe, expect, it } from 'vitest';

import { AppError } from '@family/contracts';

import {
  AUTH_ERROR_MESSAGES,
  isExpiredTokenError,
  verifyAccessToken,
  type TokenVerifier,
} from '../src/index.js';

const USER_ID = 'b1000000-0000-4000-8000-000000000001';
const DEVICE_ID = 'c1000000-0000-4000-8000-000000000001';
const REQUEST_ID = 'req-token-0001';

const VALID_CLAIMS = {
  sub: USER_ID,
  token_use: 'access',
  iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_test',
  exp: 4_102_444_800,
  iat: 1_754_136_000,
  client_id: 'app-client',
  scope: 'aws.cognito.signin.user.admin',
  username: USER_ID,
};

function verifierReturning(claims: unknown): TokenVerifier {
  return {
    verify: () => Promise.resolve(claims),
  };
}

function verifierThrowing(error: Error): TokenVerifier {
  return {
    verify: () => Promise.reject(error),
  };
}

/** Mirrors the shape of the real library's error without importing it. */
class JwtExpiredError extends Error {
  constructor() {
    super('Token expired at 2026-08-02T00:00:00.000Z');
    this.name = 'JwtExpiredError';
  }
}

async function captureAuthError(operation: Promise<unknown>): Promise<AppError> {
  try {
    await operation;
  } catch (error) {
    if (error instanceof AppError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected verification to fail');
}

describe('verifyAccessToken', () => {
  it('projects verified claims into an AuthContext', async () => {
    const auth = await verifyAccessToken('token', {
      verifier: verifierReturning({ ...VALID_CLAIMS, 'custom:device_id': DEVICE_ID }),
      requestId: REQUEST_ID,
    });

    expect(auth).toMatchObject({
      userId: USER_ID,
      deviceId: DEVICE_ID,
      tokenUse: 'access',
      requestId: REQUEST_ID,
    });
    expect(auth.claims.sub).toBe(USER_ID);
    expect(auth.claims.client_id).toBe('app-client');
  });

  it('keeps unknown claims rather than silently dropping them', async () => {
    const auth = await verifyAccessToken('token', {
      verifier: verifierReturning({ ...VALID_CLAIMS, 'custom:tenant': 'eu' }),
      requestId: REQUEST_ID,
    });

    expect(auth.claims['custom:tenant']).toBe('eu');
  });

  it('has no device binding when the claim is absent', async () => {
    const auth = await verifyAccessToken('token', {
      verifier: verifierReturning(VALID_CLAIMS),
      requestId: REQUEST_ID,
    });

    expect(auth.deviceId).toBeNull();
  });

  it('ignores a device claim that is not one of our device ids', async () => {
    const auth = await verifyAccessToken('token', {
      verifier: verifierReturning({
        ...VALID_CLAIMS,
        // Cognito's own device tracking id: not a row in our device registry.
        device_key: 'us-east-1_2f0a5e6b-1111-2222-3333-444455556666',
        'custom:device_id': 'not-a-uuid',
      }),
      requestId: REQUEST_ID,
    });

    expect(auth.deviceId).toBeNull();
  });

  it('prefers an explicitly proven device id over the claim', async () => {
    const auth = await verifyAccessToken('token', {
      verifier: verifierReturning({
        ...VALID_CLAIMS,
        'custom:device_id': 'c1000000-0000-4000-8000-00000000ffff',
      }),
      requestId: REQUEST_ID,
      deviceId: DEVICE_ID,
    });

    expect(auth.deviceId).toBe(DEVICE_ID);
  });

  it('reports an expired token as a refreshable session', async () => {
    const error = await captureAuthError(
      verifyAccessToken('token', {
        verifier: verifierThrowing(new JwtExpiredError()),
        requestId: REQUEST_ID,
      }),
    );

    expect(error.code).toBe('SESSION_EXPIRED');
    expect(error.status).toBe(401);
    expect(error.message).toBe(AUTH_ERROR_MESSAGES.SESSION_EXPIRED);
    // The library's message embeds a timestamp; ours must not echo it.
    expect(error.message).not.toContain('2026-08-02');
  });

  const rejections: ReadonlyArray<{ name: string; claims: unknown }> = [
    { name: 'an id token', claims: { ...VALID_CLAIMS, token_use: 'id' } },
    { name: 'a non-uuid subject', claims: { ...VALID_CLAIMS, sub: 'admin' } },
    { name: 'a missing subject', claims: { ...VALID_CLAIMS, sub: undefined } },
    { name: 'an unknown token_use', claims: { ...VALID_CLAIMS, token_use: 'refresh' } },
    { name: 'a missing issuer', claims: { ...VALID_CLAIMS, iss: undefined } },
    { name: 'a non-object payload', claims: 'not-a-jwt-payload' },
    { name: 'a null payload', claims: null },
  ];

  for (const rejection of rejections) {
    it(`rejects ${rejection.name}`, async () => {
      const error = await captureAuthError(
        verifyAccessToken('token', {
          verifier: verifierReturning(rejection.claims),
          requestId: REQUEST_ID,
        }),
      );

      expect(error.code).toBe('UNAUTHENTICATED');
      expect(error.message).toBe(AUTH_ERROR_MESSAGES.UNAUTHENTICATED);
    });
  }

  it('rejects an empty token without calling the verifier', async () => {
    let called = false;
    const verifier: TokenVerifier = {
      verify: () => {
        called = true;
        return Promise.resolve(VALID_CLAIMS);
      },
    };

    const error = await captureAuthError(
      verifyAccessToken('   ', { verifier, requestId: REQUEST_ID }),
    );

    expect(error.code).toBe('UNAUTHENTICATED');
    expect(called).toBe(false);
  });

  it('never echoes the token or a signature failure detail', async () => {
    const error = await captureAuthError(
      verifyAccessToken('eyJhbGciOiJIUzI1NiJ9.super-secret.signature', {
        verifier: verifierThrowing(
          new Error('Signature invalid for eyJhbGciOiJIUzI1NiJ9.super-secret.signature'),
        ),
        requestId: REQUEST_ID,
      }),
    );

    expect(error.message).not.toContain('super-secret');
    expect(error.message).toBe(AUTH_ERROR_MESSAGES.UNAUTHENTICATED);
  });
});

describe('isExpiredTokenError', () => {
  it('recognises the library error by name', () => {
    expect(isExpiredTokenError(new JwtExpiredError())).toBe(true);
  });

  it('does not treat other failures as expiry', () => {
    expect(isExpiredTokenError(new Error('boom'))).toBe(false);
    expect(isExpiredTokenError('boom')).toBe(false);
    expect(isExpiredTokenError(null)).toBe(false);
  });
});
