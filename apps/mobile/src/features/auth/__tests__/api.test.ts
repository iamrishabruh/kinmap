import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AppError } from '@family/contracts';

import { maskEmail, maskIdentifier, maskPhoneNumber, revokeSession, signIn } from '../api';
import { signInWithApple } from '../apple-sign-in';
import { resetCognitoConfig } from '../cognito/config';
import { SocialSignInCancelledError, SocialSignInUnavailableError } from '../types';

import { __setAvailable as setAppleAvailable } from './doubles/expo-apple-authentication';
import {
  __reset as resetBrowser,
  __respondWith as respondWith,
  lastAuthorizeUrl,
} from './doubles/expo-web-browser';
import {
  accessToken,
  challengeFor,
  REFRESH_TOKEN,
  type PoolAccount,
} from './support/cognito-server';
import { installFetch, type FetchHarness } from './support/fetch-harness';

const POOL_NAME = '3nqFKcB6x';
const SUB = '8f14e45f-ceea-467a-9e57-1a1f2c4d5b6e';

const ACCOUNT: PoolAccount = {
  userIdForSrp: SUB,
  password: 'correct horse battery staple 12',
  salt: BigInt('0xf3a1c8b2d94e5607'),
  serverSecret: BigInt('0x2f6b1e9c4d7a3058'),
};

const SESSION = {
  userId: SUB,
  accessToken: accessToken({ sub: SUB }),
  accessTokenExpiresAt: '2026-08-04T02:00:00.000Z',
  refreshToken: REFRESH_TOKEN,
  refreshTokenExpiresAt: '2026-09-01T00:00:00.000Z',
};

let harness: FetchHarness | null = null;

beforeEach(() => {
  resetCognitoConfig();
  resetBrowser();
  setAppleAvailable(true);
});

afterEach(() => {
  harness?.restore();
  harness = null;
});

describe('identifier masking', () => {
  it('keeps one leading character and the domain', () => {
    expect(maskEmail('someone@example.com')).toBe('s••••••@example.com');
  });

  it('never reveals how short a local part is', () => {
    // A two-character mask on a one-character local part would say so.
    expect(maskEmail('a@example.com')).toBe('a••@example.com');
  });

  it('refuses to guess at something that is not an address', () => {
    expect(maskEmail('not-an-address')).toBe('•••');
    expect(maskEmail('@example.com')).toBe('•••');
  });

  it('keeps only the last two digits of a number', () => {
    expect(maskPhoneNumber('+447700900123')).toBe('••• ••• 23');
  });

  it('dispatches on the identifier kind', () => {
    expect(maskIdentifier({ kind: 'EMAIL', email: 'someone@example.com' })).toBe(
      's••••••@example.com',
    );
    expect(maskIdentifier({ kind: 'PHONE', phoneNumber: '+447700900123' })).toBe('••• ••• 23');
  });
});

describe('signIn', () => {
  it('carries only the masked address into the challenge', async () => {
    // The full address is shown once, on the screen where it was typed. From
    // then on only the mask travels — including into the store that backs the
    // challenge screen.
    harness = installFetch(async (request) => {
      if (request.target === 'InitiateAuth') {
        return {
          status: 200,
          body: {
            ChallengeName: 'PASSWORD_VERIFIER',
            Session: 'session-1',
            ChallengeParameters: await challengeFor(ACCOUNT, POOL_NAME),
          },
        };
      }
      return {
        status: 200,
        body: {
          ChallengeName: 'SOFTWARE_TOKEN_MFA',
          Session: 'mfa-session-1',
          ChallengeParameters: { USER_ID_FOR_SRP: SUB },
        },
      };
    });

    const outcome = await signIn({ kind: 'EMAIL', email: 'someone@example.com' }, ACCOUNT.password);

    expect(outcome.kind).toBe('challenge');
    if (outcome.kind !== 'challenge') throw new Error('unreachable');
    expect(outcome.challenge.maskedIdentifier).toBe('s••••••@example.com');
    expect(JSON.stringify(outcome.challenge)).not.toContain('someone@example.com');
    expect(outcome.challenge.kind).toBe('MFA');
    expect(outcome.challenge.codeLength).toBe(6);
    expect(outcome.challenge.subjectId).toBe(SUB);
    // A time-based code has nothing to resend inside the challenge window.
    expect(outcome.challenge.resendAvailableAt).toBe(outcome.challenge.expiresAt);
  });
});

describe('revokeSession', () => {
  it("retires this device's refresh token by default", async () => {
    harness = installFetch(() => ({ status: 200, body: {} }));

    await revokeSession(SESSION, false);

    expect(harness.actions()).toEqual(['RevokeToken']);
    expect(harness.requests[0]?.json.Token).toBe(REFRESH_TOKEN);
    // The access token is not this call's credential and has no business here.
    expect(harness.requests[0]?.body).not.toContain(SESSION.accessToken);
  });

  it('ends every session when asked to, using the access token', async () => {
    harness = installFetch(() => ({ status: 200, body: {} }));

    await revokeSession(SESSION, true);

    expect(harness.actions()).toEqual(['GlobalSignOut']);
    expect(harness.requests[0]?.json.AccessToken).toBe(SESSION.accessToken);
  });
});

describe('signInWithApple', () => {
  it('will not start on a device that cannot do it', async () => {
    setAppleAvailable(false);

    await expect(signInWithApple()).rejects.toBeInstanceOf(SocialSignInUnavailableError);
  });

  it('reports a dismissed sheet as a cancellation rather than a failure', async () => {
    respondWith(() => ({ type: 'cancel' }));

    await expect(signInWithApple()).rejects.toBeInstanceOf(SocialSignInCancelledError);
  });

  it('asks Cognito for the Apple provider by its provisioned name', async () => {
    respondWith(() => ({ type: 'cancel' }));

    await signInWithApple().catch(() => undefined);

    expect(lastAuthorizeUrl()).toContain('identity_provider=SignInWithApple');
  });

  it('lets a service failure through as an AppError', async () => {
    respondWith(() => ({
      type: 'success',
      url: 'kinmap://auth/callback?state=wrong&code=x',
    }));

    await expect(signInWithApple()).rejects.toBeInstanceOf(AppError);
  });
});
