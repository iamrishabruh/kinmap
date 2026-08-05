import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AppError } from '@family/contracts';

import { resetCognitoConfig } from '../cognito/config';
import { answerMfaChallenge, refreshTokens, signInWithPassword } from '../cognito/password-auth';

import {
  accessToken,
  challengeFor,
  expectedSignature,
  idToken,
  REFRESH_TOKEN,
  type PoolAccount,
} from './support/cognito-server';
import { installFetch, type CapturedRequest, type FetchHarness } from './support/fetch-harness';

/**
 * The password flow, driven against a stand-in for the deployed pool that
 * verifies the password claim the way Cognito does.
 */

const POOL_NAME = 'XXXXXXXXX';
const SUB = '8f14e45f-ceea-467a-9e57-1a1f2c4d5b6e';

const ACCOUNT: PoolAccount = {
  userIdForSrp: SUB,
  password: 'correct horse battery staple 12',
  salt: BigInt('0xf3a1c8b2d94e5607'),
  serverSecret: BigInt('0x2f6b1e9c4d7a3058'),
};

/** Cognito's real wording. It must never reach the caller. */
const COGNITO_LEAKY_MESSAGE = 'User someone@example.com does not exist.';

let harness: FetchHarness | null = null;

function tokens(): Record<string, unknown> {
  return {
    AuthenticationResult: {
      AccessToken: accessToken({ sub: SUB }),
      IdToken: idToken({ sub: SUB, email: 'someone@example.com' }),
      RefreshToken: REFRESH_TOKEN,
      ExpiresIn: 3600,
      TokenType: 'Bearer',
    },
  };
}

/**
 * A pool that answers the SRP challenge honestly and then checks the claim.
 * `accepts` is what makes the "unknown address" case indistinguishable: the
 * challenge is issued either way and only the verification differs.
 */
function poolResponder(options: { accepts: boolean; mfa?: boolean }) {
  return async (request: CapturedRequest) => {
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
    if (request.target === 'RespondToAuthChallenge') {
      const responses = request.json.ChallengeResponses as Record<string, string>;
      const initiate = harness?.requests[0]?.json.AuthParameters as Record<string, string>;
      const srpA = initiate?.SRP_A ?? '';
      const valid =
        options.accepts &&
        responses.PASSWORD_CLAIM_SIGNATURE ===
          (await expectedSignature(ACCOUNT, POOL_NAME, srpA, responses.TIMESTAMP ?? ''));
      if (!valid) {
        return {
          status: 400,
          body: { __type: 'NotAuthorizedException', message: COGNITO_LEAKY_MESSAGE },
        };
      }
      if (options.mfa === true) {
        return {
          status: 200,
          body: {
            ChallengeName: 'SOFTWARE_TOKEN_MFA',
            Session: 'mfa-session-1',
            ChallengeParameters: { USER_ID_FOR_SRP: SUB },
          },
        };
      }
      return { status: 200, body: tokens() };
    }
    return { status: 400, body: { __type: 'InvalidParameterException' } };
  };
}

beforeEach(() => {
  resetCognitoConfig();
});

afterEach(() => {
  harness?.restore();
  harness = null;
});

describe('signInWithPassword', () => {
  it('completes the SRP handshake and returns a session', async () => {
    harness = installFetch(poolResponder({ accepts: true }));

    const outcome = await signInWithPassword('someone@example.com', ACCOUNT.password);

    expect(outcome.kind).toBe('session');
    if (outcome.kind !== 'session') throw new Error('unreachable');
    expect(outcome.session.userId).toBe(SUB);
    expect(outcome.session.accessToken).toContain('.');
    expect(harness.actions()).toEqual(['InitiateAuth', 'RespondToAuthChallenge']);
  });

  it('never puts the password on the wire', async () => {
    harness = installFetch(poolResponder({ accepts: true }));

    await signInWithPassword('someone@example.com', ACCOUNT.password);

    for (const request of harness.requests) {
      expect(request.body).not.toContain(ACCOUNT.password);
    }
  });

  it("answers the challenge as the pool's own user id, not the typed address", async () => {
    harness = installFetch(poolResponder({ accepts: true }));

    await signInWithPassword('someone@example.com', ACCOUNT.password);

    const responses = harness.requests[1]?.json.ChallengeResponses as Record<string, string>;
    expect(responses.USERNAME).toBe(SUB);
    expect(harness.requests[1]?.body).not.toContain('someone@example.com');
  });

  it('never confirms the device', async () => {
    // Remembering a handset would let later sign-ins skip a factor, and it is
    // a consented decision this flow is not the place to make.
    harness = installFetch(poolResponder({ accepts: true }));

    await signInWithPassword('someone@example.com', ACCOUNT.password);

    expect(harness.actions()).not.toContain('ConfirmDevice');
  });

  it('fails identically for a wrong password and an address with no account', async () => {
    // The account-existence property, asserted end to end. If these two ever
    // diverge — different code, different message, different shape — the pool
    // becomes a way to confirm that a given person uses a location product.
    harness = installFetch(poolResponder({ accepts: false }));
    const wrongPassword = await signInWithPassword('someone@example.com', 'not the password').catch(
      (cause: unknown) => cause,
    );
    harness.restore();

    harness = installFetch(poolResponder({ accepts: false }));
    const unknownAddress = await signInWithPassword('nobody@example.com', ACCOUNT.password).catch(
      (cause: unknown) => cause,
    );

    expect(wrongPassword).toBeInstanceOf(AppError);
    expect(unknownAddress).toBeInstanceOf(AppError);
    const first = wrongPassword as AppError;
    const second = unknownAddress as AppError;
    expect(second.code).toBe(first.code);
    expect(second.message).toBe(first.message);
  });

  it('never repeats the message Cognito sent', async () => {
    harness = installFetch(poolResponder({ accepts: false }));

    const failure = await signInWithPassword('someone@example.com', 'wrong').catch(
      (cause: unknown) => cause,
    );

    expect(failure).toBeInstanceOf(AppError);
    expect((failure as AppError).message).not.toContain('someone@example.com');
    expect((failure as AppError).message).not.toBe(COGNITO_LEAKY_MESSAGE);
  });

  it('surfaces a second factor as a challenge rather than a failure', async () => {
    harness = installFetch(poolResponder({ accepts: true, mfa: true }));

    const outcome = await signInWithPassword('someone@example.com', ACCOUNT.password);

    expect(outcome.kind).toBe('mfa');
    if (outcome.kind !== 'mfa') throw new Error('unreachable');
    expect(outcome.challenge.session).toBe('mfa-session-1');
    expect(outcome.challenge.userIdForSrp).toBe(SUB);
  });

  it('refuses a challenge this pool cannot issue rather than half-handling it', async () => {
    harness = installFetch(() => ({
      status: 200,
      body: { ChallengeName: 'NEW_PASSWORD_REQUIRED', Session: 's' },
    }));

    await expect(signInWithPassword('someone@example.com', 'x')).rejects.toBeInstanceOf(AppError);
  });

  it('reports being offline as unavailable, not as a rejected credential', async () => {
    harness = installFetch(() => ({ transportFailure: true }));

    const failure = (await signInWithPassword('someone@example.com', 'x').catch(
      (cause: unknown) => cause,
    )) as AppError;

    expect(failure.code).toBe('UPSTREAM_UNAVAILABLE');
  });
});

describe('answerMfaChallenge', () => {
  it('exchanges a code for a session', async () => {
    harness = installFetch(() => ({ status: 200, body: tokens() }));

    const outcome = await answerMfaChallenge(
      { session: 'mfa-session-1', userIdForSrp: SUB },
      '123456',
    );

    expect(outcome.kind).toBe('session');
    const responses = harness.requests[0]?.json.ChallengeResponses as Record<string, string>;
    expect(responses.SOFTWARE_TOKEN_MFA_CODE).toBe('123456');
    expect(harness.requests[0]?.json.Session).toBe('mfa-session-1');
  });

  it('says a wrong code is wrong', async () => {
    // Allowed to be specific: the password is already proven, so nothing is
    // disclosed that the caller did not already know.
    harness = installFetch(() => ({
      status: 400,
      body: { __type: 'CodeMismatchException', message: COGNITO_LEAKY_MESSAGE },
    }));

    const failure = (await answerMfaChallenge(
      { session: 'mfa-session-1', userIdForSrp: SUB },
      '000000',
    ).catch((cause: unknown) => cause)) as AppError;

    expect(failure.code).toBe('VALIDATION_FAILED');
    expect(failure.message).toContain('code');
    expect(failure.message).not.toContain('someone@example.com');
  });
});

describe('refreshTokens', () => {
  const carryForward = {
    refreshToken: REFRESH_TOKEN,
    refreshTokenExpiresAt: '2026-09-01T00:00:00.000Z',
  };

  it('sends only the refresh token', async () => {
    harness = installFetch(() => ({ status: 200, body: tokens() }));

    await refreshTokens(carryForward);

    expect(harness.requests[0]?.json.AuthFlow).toBe('REFRESH_TOKEN_AUTH');
    expect(harness.requests[0]?.json.AuthParameters).toEqual({ REFRESH_TOKEN });
  });

  it('keeps the previous refresh token when a rotation omits one', async () => {
    const body = tokens();
    const result = body.AuthenticationResult as Record<string, unknown>;
    delete result.RefreshToken;
    harness = installFetch(() => ({ status: 200, body }));

    const session = await refreshTokens(carryForward);

    expect(session.refreshToken).toBe(REFRESH_TOKEN);
  });

  it('does not extend the refresh grant on rotation', async () => {
    // A rotation replaces the token, not the grant behind it. Extending the
    // expiry here would let the client skip the round trip that would have
    // told it the session was over.
    harness = installFetch(() => ({ status: 200, body: tokens() }));

    const session = await refreshTokens(carryForward);

    expect(session.refreshTokenExpiresAt).toBe(carryForward.refreshTokenExpiresAt);
  });
});
