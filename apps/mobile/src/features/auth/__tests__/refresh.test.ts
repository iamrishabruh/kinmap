import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AppError } from '@family/contracts';

import { resetCognitoConfig } from '../cognito/config';
import { ensureFreshAccessToken, refreshSession, resetRefreshState } from '../refresh';
import { loadStoredSession, saveStoredSession } from '../secure-token-storage';
import { useSessionStore } from '../session-store';
import type { StoredSession } from '../types';

import { __reset as resetSecureStore } from './doubles/expo-secure-store';
import { accessToken, idToken, REFRESH_TOKEN } from './support/cognito-server';
import { installFetch, type FetchHarness } from './support/fetch-harness';

/**
 * Refresh, against Cognito. The two properties the file exists to hold are
 * single flight and the transient/definitive split, so those are what is
 * asserted; both are safety properties, not conveniences.
 */

const SUB = '8f14e45f-ceea-467a-9e57-1a1f2c4d5b6e';
const ROTATED_REFRESH_TOKEN = 'b'.repeat(400);

let harness: FetchHarness | null = null;

function storedSession(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    userId: SUB,
    accessToken: accessToken({ sub: SUB, expiresAt: Math.floor(Date.now() / 1000) - 10 }),
    accessTokenExpiresAt: new Date(Date.now() - 10_000).toISOString(),
    refreshToken: REFRESH_TOKEN,
    refreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    ...overrides,
  };
}

function rotatedTokens(): Record<string, unknown> {
  return {
    AuthenticationResult: {
      AccessToken: accessToken({ sub: SUB, expiresAt: Math.floor(Date.now() / 1000) + 3600 }),
      IdToken: idToken({ sub: SUB, email: 'someone@example.com' }),
      RefreshToken: ROTATED_REFRESH_TOKEN,
      ExpiresIn: 3600,
    },
  };
}

async function seed(session: StoredSession): Promise<void> {
  await saveStoredSession(session);
  useSessionStore.getState().restoreFinished(session);
}

beforeEach(() => {
  resetCognitoConfig();
  resetRefreshState();
  resetSecureStore();
  useSessionStore.getState().reset('USER_REQUESTED');
});

afterEach(() => {
  harness?.restore();
  harness = null;
});

describe('refreshSession', () => {
  it('collapses concurrent callers into one request', async () => {
    // With refresh-token rotation on, a second in-flight refresh would retire
    // the winner's token and sign the user out on cold start.
    await seed(storedSession());
    harness = installFetch(() => ({ status: 200, body: rotatedTokens() }));

    const [first, second, third] = await Promise.all([
      refreshSession(),
      refreshSession(),
      refreshSession(),
    ]);

    expect(harness.requests).toHaveLength(1);
    expect(first?.accessToken).toBe(second?.accessToken);
    expect(second?.accessToken).toBe(third?.accessToken);
  });

  it('persists the rotated token to the keychain', async () => {
    await seed(storedSession());
    harness = installFetch(() => ({ status: 200, body: rotatedTokens() }));

    await refreshSession();

    const stored = await loadStoredSession();
    expect(stored?.refreshToken).toBe(ROTATED_REFRESH_TOKEN);
    expect(useSessionStore.getState().session?.refreshToken).toBe(ROTATED_REFRESH_TOKEN);
  });

  it('ends the session when the pool says the token is dead', async () => {
    await seed(storedSession());
    harness = installFetch(() => ({
      status: 400,
      body: { __type: 'NotAuthorizedException', message: 'Refresh Token has been revoked' },
    }));

    const result = await refreshSession();

    expect(result).toBeNull();
    // Dropped here so that even a caller that mishandles the null leaves
    // nothing usable on the device.
    expect(await loadStoredSession()).toBeNull();
  });

  it('does not sign the user out for being offline', async () => {
    // Being in a tunnel is not being signed out, and this is a safety product.
    await seed(storedSession());
    harness = installFetch(() => ({ transportFailure: true }));

    const failure = (await refreshSession().catch((cause: unknown) => cause)) as AppError;

    expect(failure).toBeInstanceOf(AppError);
    expect(failure.code).toBe('UPSTREAM_UNAVAILABLE');
    expect((await loadStoredSession())?.refreshToken).toBe(REFRESH_TOKEN);
    expect(useSessionStore.getState().session).not.toBeNull();
  });

  it('does not spend a round trip on a refresh token it can see is dead', async () => {
    await seed(storedSession({ refreshTokenExpiresAt: new Date(Date.now() - 1000).toISOString() }));
    harness = installFetch(() => ({ status: 200, body: rotatedTokens() }));

    expect(await refreshSession()).toBeNull();
    expect(harness.requests).toHaveLength(0);
    expect(await loadStoredSession()).toBeNull();
  });

  it('treats an unparseable expiry as expired rather than trusting it', async () => {
    await seed(storedSession({ refreshTokenExpiresAt: 'not a timestamp' }));
    harness = installFetch(() => ({ status: 200, body: rotatedTokens() }));

    expect(await refreshSession()).toBeNull();
    expect(harness.requests).toHaveLength(0);
  });

  it('releases the shared promise so a later attempt can retry', async () => {
    await seed(storedSession());
    harness = installFetch((_request, index) =>
      index === 0 ? { transportFailure: true } : { status: 200, body: rotatedTokens() },
    );

    await refreshSession().catch(() => undefined);
    const recovered = await refreshSession();

    expect(recovered?.refreshToken).toBe(ROTATED_REFRESH_TOKEN);
    expect(harness.requests).toHaveLength(2);
  });
});

describe('ensureFreshAccessToken', () => {
  it('returns the current token untouched when it is not near expiry', async () => {
    const session = storedSession({
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    await seed(session);
    harness = installFetch(() => ({ status: 200, body: rotatedTokens() }));

    expect(await ensureFreshAccessToken()).toBe(session.accessToken);
    expect(harness.requests).toHaveLength(0);
  });

  it('refreshes ahead of the boundary rather than racing it', async () => {
    // A token that expires in thirty seconds will be dead by the time a slow
    // request reaches the API.
    await seed(
      storedSession({ accessTokenExpiresAt: new Date(Date.now() + 30_000).toISOString() }),
    );
    harness = installFetch(() => ({ status: 200, body: rotatedTokens() }));

    const token = await ensureFreshAccessToken();

    expect(harness.requests).toHaveLength(1);
    expect(token).not.toBeNull();
  });

  it('returns null when there is no session at all', async () => {
    expect(await ensureFreshAccessToken()).toBeNull();
  });
});
