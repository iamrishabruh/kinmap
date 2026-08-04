import { afterEach, describe, expect, it } from 'vitest';

import { confirmSignUp, signUpWithPassword } from '../cognito/sign-up';

import { installFetch, type FetchHarness } from './support/fetch-harness';

/**
 * Sign-up did not exist in this client at all: a route constant pointing at a
 * screen that was never built, and an API layer calling `/v1/auth/otp/start`,
 * which the deployed API has never declared. There was no way to become a user.
 *
 * The property that matters most is the consent metadata. The pool's PreSignUp
 * trigger refuses an account without it —
 *
 *   PreSignUp failed with error The current terms of service and privacy policy
 *   must be accepted before creating an account.
 *
 * — so a client that forgot it would fail every registration.
 */
let harness: FetchHarness | null = null;

afterEach(() => {
  harness?.restore();
  harness = null;
});

const ACCEPTED = { termsVersion: '2026-01-01', privacyPolicyVersion: '2026-01-01' } as const;
/** An adult's date. The age gate has its own tests; these are about consent. */
const ADULT_BIRTH_DATE = '1990-06-15';

describe('signUpWithPassword', () => {
  it('sends the accepted policy versions the PreSignUp trigger requires', async () => {
    harness = installFetch(() => ({
      status: 200,
      body: { UserSub: 'f43894a8-70d1-70fa-858b-5d9c82879e32', UserConfirmed: false },
    }));

    await signUpWithPassword({
      email: 'ada@example.com',
      password: 'a-long-enough-password',
      accepted: ACCEPTED,
      birthDate: ADULT_BIRTH_DATE,
    });

    const request = harness.requests[0];
    const validation = request?.json['ValidationData'] as Array<{ Name: string; Value: string }>;
    const metadata = request?.json['ClientMetadata'] as Record<string, string>;

    expect(validation).toEqual(
      expect.arrayContaining([
        { Name: 'termsVersion', Value: '2026-01-01' },
        { Name: 'privacyPolicyVersion', Value: '2026-01-01' },
      ]),
    );
    // Sent both ways deliberately: the trigger reads validation data first and
    // falls back to client metadata, and which arrives depends on the flow.
    expect(metadata?.['termsVersion']).toBe('2026-01-01');
  });

  it('reports the destination Cognito masked, never the address typed', async () => {
    harness = installFetch(() => ({
      status: 200,
      body: {
        UserSub: 'f43894a8-70d1-70fa-858b-5d9c82879e32',
        UserConfirmed: false,
        CodeDeliveryDetails: { Destination: 'a***@e***.com', DeliveryMedium: 'EMAIL' },
      },
    }));

    const outcome = await signUpWithPassword({
      email: 'ada@example.com',
      password: 'a-long-enough-password',
      accepted: ACCEPTED,
      birthDate: ADULT_BIRTH_DATE,
    });

    expect(outcome.codeSentTo).toBe('a***@e***.com');
    expect(outcome.confirmed).toBe(false);
  });

  it('never carries the password into a rejection', async () => {
    harness = installFetch(() => ({
      status: 400,
      body: { __type: 'InvalidPasswordException', message: 'Password did not conform with policy' },
    }));

    const thrown = await signUpWithPassword({
      email: 'ada@example.com',
      password: 'super-secret-value',
      accepted: ACCEPTED,
      birthDate: ADULT_BIRTH_DATE,
    }).catch((error: unknown) => error);

    expect(JSON.stringify(thrown) + String(thrown)).not.toContain('super-secret-value');
  });
});

describe('confirmSignUp', () => {
  it('confirms an account with the emailed code', async () => {
    harness = installFetch(() => ({ status: 200, body: {} }));

    await confirmSignUp({ email: 'ada@example.com', code: '123456' });

    expect(harness.actions()[0]).toContain('ConfirmSignUp');
  });

  it('does not distinguish an unknown account from a wrong code', async () => {
    // Either answer would turn this into an account-existence oracle, which for
    // a location product is a way to confirm somebody uses it.
    const messages: string[] = [];
    for (const type of ['UserNotFoundException', 'CodeMismatchException']) {
      harness?.restore();
      harness = installFetch(() => ({ status: 400, body: { __type: type, message: type } }));
      const thrown = await confirmSignUp({ email: 'ada@example.com', code: '000000' }).catch(
        (error: unknown) => error,
      );
      messages.push(thrown instanceof Error ? thrown.message : String(thrown));
    }

    expect(messages[0]).toBe(messages[1]);
  });
});
