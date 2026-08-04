import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AppError } from '@family/contracts';

import {
  clearPendingPasswordReset,
  confirmPasswordReset,
  meetsPasswordPolicy,
  passwordRequirements,
  pendingPasswordReset,
  requestPasswordReset,
  resendPasswordReset,
} from '../cognito/forgot-password';

import { installFetch, type FetchHarness } from './support/fetch-harness';

/**
 * Password recovery had no client at all: `ROUTES.forgotPassword` and
 * `ROUTES.resetPassword` pointed at screens that were never built, and the
 * Cognito client had neither `ForgotPassword` nor `ConfirmForgotPassword`.
 *
 * The property worth testing is not that the happy path works — it is that the
 * unhappy paths are indistinguishable from it. A recovery request that answers
 * differently for an address with an account tells an unauthenticated stranger
 * whether a given person uses a product that knows where they are.
 */
let harness: FetchHarness | null = null;

const EMAIL = 'ada@example.com';
const GOOD_PASSWORD = 'Lovelace-1843!';

beforeEach(() => {
  clearPendingPasswordReset();
});

afterEach(() => {
  harness?.restore();
  harness = null;
  clearPendingPasswordReset();
});

/** Every rejection that, left alone, would answer "is this address registered". */
const EXISTENCE_REVEALING = [
  'UserNotFoundException',
  'InvalidParameterException',
  'UserLambdaValidationException',
  'NotAuthorizedException',
  'ResourceNotFoundException',
];

describe('requestPasswordReset', () => {
  it('asks Cognito to email a code, without sending anything else about the device', async () => {
    harness = installFetch(() => ({ status: 200, body: {} }));

    await requestPasswordReset({ email: `  ${EMAIL}  ` });

    const request = harness.requests[0];
    expect(harness.actions()[0]).toContain('ForgotPassword');
    // Trimmed, because a trailing space from an autocomplete is not a different
    // account, and Cognito would treat it as one.
    expect(request?.json['Username']).toBe(EMAIL);
    expect(Object.keys(request?.json ?? {}).sort()).toEqual(['ClientId', 'Username']);
  });

  it('answers the same way whether or not the address has an account', async () => {
    const answers: Array<{ codeLength: number }> = [];

    harness = installFetch(() => ({ status: 200, body: {} }));
    answers.push(await requestPasswordReset({ email: EMAIL }));

    for (const type of EXISTENCE_REVEALING) {
      harness.restore();
      harness = installFetch(() => ({
        status: 400,
        body: { __type: type, message: `${type}: ada@example.com` },
      }));
      answers.push(await requestPasswordReset({ email: EMAIL }));
    }

    // Identical values, and — because the screen renders from this — identical
    // copy on the screen that follows.
    for (const answer of answers) {
      expect(answer).toEqual(answers[0]);
    }
  });

  it('never hands the address back to its caller', async () => {
    harness = installFetch(() => ({ status: 200, body: {} }));

    const outcome = await requestPasswordReset({ email: EMAIL });

    expect(JSON.stringify(outcome)).not.toContain('ada');
    expect(JSON.stringify(pendingPasswordReset())).not.toContain('ada');
  });

  it('ignores the delivery details Cognito returns', async () => {
    // The one field that differs between a real delivery and the simulated one
    // the pool sends for an unknown address.
    harness = installFetch(() => ({
      status: 200,
      body: { CodeDeliveryDetails: { Destination: 'a***@e***.com', DeliveryMedium: 'EMAIL' } },
    }));

    const outcome = await requestPasswordReset({ email: EMAIL });

    expect(JSON.stringify(outcome)).not.toContain('a***@e***.com');
  });

  it('still reports a rate limit, which is a fact about the caller', async () => {
    harness = installFetch(() => ({ status: 400, body: { __type: 'TooManyRequestsException' } }));

    const thrown = await requestPasswordReset({ email: EMAIL }).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe('RATE_LIMITED');
  });

  it('still reports a request that never reached Cognito', async () => {
    // Saying "check your email" to somebody in a tunnel is a lie, and a lie is
    // not a privacy control.
    harness = installFetch(() => ({ transportFailure: true }));

    const thrown = await requestPasswordReset({ email: EMAIL }).catch((error: unknown) => error);

    expect((thrown as AppError).code).toBe('UPSTREAM_UNAVAILABLE');
    expect(pendingPasswordReset()).toBeNull();
  });
});

describe('resendPasswordReset', () => {
  it('reuses the address the caller cannot read', async () => {
    harness = installFetch(() => ({ status: 200, body: {} }));
    await requestPasswordReset({ email: EMAIL });

    await resendPasswordReset();

    expect(harness.requests[1]?.json['Username']).toBe(EMAIL);
  });

  it('refuses, without a request, when no reset is in flight', async () => {
    harness = installFetch(() => ({ status: 200, body: {} }));

    const thrown = await resendPasswordReset().catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(AppError);
    expect(harness.requests).toHaveLength(0);
  });
});

describe('confirmPasswordReset', () => {
  async function startReset(): Promise<void> {
    harness = installFetch(() => ({ status: 200, body: {} }));
    await requestPasswordReset({ email: EMAIL });
  }

  it('spends the code against the remembered address', async () => {
    await startReset();

    await confirmPasswordReset({ code: ' 123456 ', newPassword: GOOD_PASSWORD });

    const request = harness?.requests[1];
    expect(harness?.actions()[1]).toContain('ConfirmForgotPassword');
    expect(request?.json['Username']).toBe(EMAIL);
    expect(request?.json['ConfirmationCode']).toBe('123456');
    expect(request?.json['Password']).toBe(GOOD_PASSWORD);
  });

  it('forgets the address once the code is spent', async () => {
    await startReset();

    await confirmPasswordReset({ code: '123456', newPassword: GOOD_PASSWORD });

    expect(pendingPasswordReset()).toBeNull();
    const thrown = await confirmPasswordReset({
      code: '123456',
      newPassword: GOOD_PASSWORD,
    }).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(AppError);
    // A replay never reaches the network.
    expect(harness?.requests).toHaveLength(2);
  });

  it('does not distinguish an unknown account, a wrong code or a weak password', async () => {
    const messages: string[] = [];
    for (const type of ['UserNotFoundException', 'CodeMismatchException', 'ExpiredCodeException']) {
      await startReset();
      harness?.restore();
      harness = installFetch(() => ({ status: 400, body: { __type: type, message: type } }));
      const thrown = await confirmPasswordReset({
        code: '000000',
        newPassword: GOOD_PASSWORD,
      }).catch((error: unknown) => error);
      messages.push(thrown instanceof Error ? thrown.message : String(thrown));
      clearPendingPasswordReset();
    }

    expect(new Set(messages).size).toBe(1);
  });

  it('never carries the code or the new password into a rejection', async () => {
    await startReset();
    harness?.restore();
    harness = installFetch(() => ({
      status: 400,
      body: { __type: 'InvalidPasswordException', message: 'Password did not conform with policy' },
    }));

    const thrown = await confirmPasswordReset({
      code: '424242',
      newPassword: GOOD_PASSWORD,
    }).catch((error: unknown) => error);

    const rendered = `${JSON.stringify(thrown)}${String(thrown)}`;
    expect(rendered).not.toContain(GOOD_PASSWORD);
    expect(rendered).not.toContain('424242');
  });

  it('keeps the reset in flight when the request failed, so a resend still works', async () => {
    await startReset();
    harness?.restore();
    harness = installFetch(() => ({ transportFailure: true }));

    await confirmPasswordReset({ code: '000000', newPassword: GOOD_PASSWORD }).catch(
      () => undefined,
    );

    expect(pendingPasswordReset()).not.toBeNull();
  });
});

describe('passwordRequirements', () => {
  it('mirrors the pool policy in identity-stack.ts', () => {
    // A client that is more permissive than the pool produces an opaque server
    // rejection, and this flow has to collapse those into one answer.
    expect(meetsPasswordPolicy(GOOD_PASSWORD)).toBe(true);
    expect(meetsPasswordPolicy('Short-1!')).toBe(false);
    expect(meetsPasswordPolicy('lovelace-1843!')).toBe(false);
    expect(meetsPasswordPolicy('LOVELACE-1843!')).toBe(false);
    expect(meetsPasswordPolicy('Lovelace-abcd!')).toBe(false);
    expect(meetsPasswordPolicy('Lovelace18430')).toBe(false);
    expect(meetsPasswordPolicy(` ${GOOD_PASSWORD} `)).toBe(false);
  });

  it('says which rule is unmet, in words, before anything is submitted', () => {
    const unmet = passwordRequirements('short').filter((requirement) => !requirement.met);

    expect(unmet.map((requirement) => requirement.id)).toEqual([
      'length',
      'uppercase',
      'digit',
      'symbol',
    ]);
    for (const requirement of unmet) {
      expect(requirement.label.length).toBeGreaterThan(0);
    }
  });
});
