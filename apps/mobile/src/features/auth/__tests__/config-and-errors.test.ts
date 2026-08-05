import { describe, expect, it } from 'vitest';

import { AppError } from '@family/contracts';

import { CognitoConfigurationError, resolveCognitoConfig } from '../cognito/config';
import { cognitoError, cognitoErrorType, COGNITO_ERROR_MESSAGES } from '../cognito/errors';

const DEPLOYED = {
  userPoolId: 'us-east-1_XXXXXXXXX',
  clientId: 'xxxxxxxxxxxxxxxxxxxxxxxxxx',
  domain: 'kinmap-development-000000000000',
};

describe('resolveCognitoConfig', () => {
  it('derives the region and pool name from the pool id', () => {
    // One source of the fact, not two: a separately configured AWS_REGION can
    // disagree with the pool id, and then nothing works for a reason nobody
    // can see.
    const config = resolveCognitoConfig(DEPLOYED);

    expect(config.region).toBe('us-east-1');
    expect(config.userPoolName).toBe('XXXXXXXXX');
    expect(config.idpEndpoint).toBe('https://cognito-idp.us-east-1.amazonaws.com/');
  });

  it('accepts the hosted UI as a prefix, a host, or a full URL', () => {
    const expected = 'https://kinmap-development-000000000000.auth.us-east-1.amazoncognito.com';

    expect(resolveCognitoConfig(DEPLOYED).hostedUiOrigin).toBe(expected);
    expect(
      resolveCognitoConfig({
        ...DEPLOYED,
        domain: 'kinmap-development-000000000000.auth.us-east-1.amazoncognito.com',
      }).hostedUiOrigin,
    ).toBe(expected);
    expect(resolveCognitoConfig({ ...DEPLOYED, domain: `${expected}/` }).hostedUiOrigin).toBe(
      expected,
    );
  });

  it('uses the redirect the app client actually registers', () => {
    // `identity-stack.ts` builds the callback list from the `kinmap` scheme. A
    // redirect_uri that is not on that list is rejected by the hosted UI before
    // the user sees anything.
    const config = resolveCognitoConfig(DEPLOYED);

    expect(config.redirectUri).toBe('kinmap://auth/callback');
    expect(config.signOutUri).toBe('kinmap://auth/signout');
  });

  it('names the environment variable to set, and never its value', () => {
    const failure = (() => {
      try {
        resolveCognitoConfig({ ...DEPLOYED, clientId: '  ' });
        return null;
      } catch (cause) {
        return cause as Error;
      }
    })();

    expect(failure).toBeInstanceOf(CognitoConfigurationError);
    expect(failure?.message).toContain('COGNITO_CLIENT_ID');
    expect(failure?.message).not.toContain(DEPLOYED.clientId);
  });

  it('rejects a pool id that is not one', () => {
    expect(() => resolveCognitoConfig({ ...DEPLOYED, userPoolId: 'XXXXXXXXX' })).toThrow(
      CognitoConfigurationError,
    );
  });
});

describe('cognitoErrorType', () => {
  it('reads both the bare and the namespaced form', () => {
    expect(cognitoErrorType('NotAuthorizedException')).toBe('NotAuthorizedException');
    expect(cognitoErrorType('com.amazon.coral.service#NotAuthorizedException')).toBe(
      'NotAuthorizedException',
    );
    expect(cognitoErrorType(undefined)).toBe('');
  });
});

describe('cognitoError', () => {
  it('collapses every credential-shaped failure onto one answer', () => {
    // Each of these, left alone, answers "does this address have an account".
    const names = [
      'NotAuthorizedException',
      'UserNotFoundException',
      'UserNotConfirmedException',
      'PasswordResetRequiredException',
    ];
    const answers = names.map((name) => cognitoError(name, 400));

    for (const answer of answers) {
      expect(answer.code).toBe('UNAUTHENTICATED');
      expect(answer.message).toBe(COGNITO_ERROR_MESSAGES.CREDENTIALS);
    }
  });

  it('distinguishes a wrong second factor, which discloses nothing new', () => {
    expect(cognitoError('CodeMismatchException', 400).message).toBe(
      COGNITO_ERROR_MESSAGES.MFA_CODE,
    );
    expect(cognitoError('ExpiredCodeException', 400).message).toBe(
      COGNITO_ERROR_MESSAGES.MFA_CODE_EXPIRED,
    );
  });

  it('carries a retry hint when throttled', () => {
    const throttled = cognitoError('TooManyRequestsException', 400);

    expect(throttled.code).toBe('RATE_LIMITED');
    expect(throttled.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("never surfaces a trigger Lambda's message", () => {
    // Trigger output is attacker-influencable and may contain anything at all.
    const failure = cognitoError('UserLambdaValidationException', 400);

    expect(failure.code).toBe('INTERNAL_ERROR');
    expect(failure.message).toBe(COGNITO_ERROR_MESSAGES.INTERNAL);
  });

  it('falls back on the status when the body has no type', () => {
    expect(cognitoError('', 503).code).toBe('UPSTREAM_UNAVAILABLE');
    expect(cognitoError('', 429).code).toBe('RATE_LIMITED');
    expect(cognitoError('', 400)).toBeInstanceOf(AppError);
  });

  it('only ever returns one of its own fixed strings', () => {
    const permitted = new Set<string>(Object.values(COGNITO_ERROR_MESSAGES));
    const names = [
      'NotAuthorizedException',
      'UserNotFoundException',
      'CodeMismatchException',
      'ExpiredCodeException',
      'TooManyRequestsException',
      'InvalidParameterException',
      'ResourceNotFoundException',
      'UnexpectedLambdaException',
      'SomethingNobodyHasSeenYet',
    ];

    for (const name of names) {
      expect(permitted.has(cognitoError(name, 400).message)).toBe(true);
    }
  });
});
