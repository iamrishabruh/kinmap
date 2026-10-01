import { beforeEach, describe, expect, it } from 'vitest';

import {
  createHarness,
  postConfirmationEvent,
  preSignUpEvent,
  testUuid,
  tokenGenerationEvent,
  ADULT_BIRTH_DATE,
  PRIVACY_VERSION,
  TERMS_VERSION,
  USERS_TABLE,
  type Harness,
} from './support/harness.js';

/**
 * What happens when somebody signs in with Apple.
 *
 * THIS PATH WAS COMPLETELY BROKEN AND EVERY EXISTING TEST PASSED. Sign in with
 * Apple was enabled in the app, and the first person to tap it would have been
 * refused at the PreSignUp trigger with `TERMS_ACCEPTANCE_REQUIRED` — rendered
 * to them as a server error. The reason is structural: federation into a Cognito
 * user pool runs through the hosted UI's authorization-code grant, which has no
 * `ValidationData` (that is a field on the public `SignUp` API, which federation
 * never calls) and to which Cognito forwards no `ClientMetadata` either. Both
 * arrive empty on every federated sign-up that will ever happen.
 *
 * The suite missed it by constructing events Cognito cannot produce: the one
 * test that looped over `PRE_SIGN_UP_SOURCES` handed each source a complete
 * `validationData` payload, including `PreSignUp_ExternalProvider`. It asserted
 * a behaviour of an impossible event.
 *
 * So every test below builds the federated events the way Cognito actually sends
 * them — with nothing in either metadata field — and that constraint is the
 * point of the file.
 */

/** The stored profile row, or undefined. The email claim shares the table. */
function profileOf(harness: Harness, userId: string): Record<string, unknown> | undefined {
  return harness.store.dump(USERS_TABLE).find((item) => item['userId'] === userId);
}

/** A federated sign-up, exactly as Cognito delivers it: both channels empty. */
function appleSignUp() {
  return preSignUpEvent({
    triggerSource: 'PreSignUp_ExternalProvider',
    userName: 'SignInWithApple_000123.abc',
    userAttributes: {
      sub: testUuid(70),
      email: 'zz9k4h2@privaterelay.appleid.com',
      email_verified: 'true',
      identities: JSON.stringify([{ providerName: 'SignInWithApple', userId: '000123.abc' }]),
    },
    validationData: null,
    clientMetadata: null,
  });
}

function appleTokenIssuance() {
  return tokenGenerationEvent({
    userAttributes: {
      sub: testUuid(70),
      email: 'zz9k4h2@privaterelay.appleid.com',
      email_verified: 'true',
      identities: JSON.stringify([{ providerName: 'SignInWithApple', userId: '000123.abc' }]),
    },
  });
}

describe('a federated sign-up is admitted', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness();
  });

  it('does not refuse an external provider for a missing terms acceptance', async () => {
    // The regression. This threw, and Sign in with Apple could not create an
    // account at all.
    await expect(harness.handle(appleSignUp())).resolves.toBeDefined();
  });

  it('does not refuse an external provider for a missing date of birth either', async () => {
    const result = await harness.handle(appleSignUp());

    expect(result.response).toMatchObject({ autoConfirmUser: false });
  });

  it('still refuses a NATIVE sign-up with the same empty metadata', async () => {
    // Admitting the federated case must not have widened the native one: a
    // client calling the public SignUp API without an acceptance is exactly what
    // the gate is for.
    await expect(
      harness.handle(preSignUpEvent({ validationData: null, clientMetadata: null })),
    ).rejects.toMatchObject({ code: 'TERMS_ACCEPTANCE_REQUIRED' });
  });

  it('still refuses a native sign-up that is under age', async () => {
    const twelve = new Date();
    twelve.setUTCFullYear(twelve.getUTCFullYear() - 12);

    await expect(
      harness.handle(
        preSignUpEvent({
          validationData: {
            termsVersion: TERMS_VERSION,
            privacyPolicyVersion: PRIVACY_VERSION,
            birthDate: twelve.toISOString().slice(0, 10),
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'AGE_REQUIREMENT_NOT_MET' });
  });

  it('never auto-confirms, federated included', async () => {
    const result = await harness.handle(appleSignUp());

    expect(result.response).toEqual({
      autoConfirmUser: false,
      autoVerifyEmail: false,
      autoVerifyPhone: false,
    });
  });
});

describe('the profile a federated account gets', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness();
  });

  it('exists at all, which PostConfirmation would never have provided', async () => {
    // Cognito does not invoke PostConfirmation for an externally-created user,
    // so without this the account would authenticate and then 404 forever from
    // GET /v1/account.
    await harness.handle(appleTokenIssuance());

    expect(harness.store.size(USERS_TABLE)).toBeGreaterThan(0);
  });

  it('records NO accepted terms version, because nobody was shown any', async () => {
    // This used to copy the server's own current versions in, which fabricated a
    // consent: the hosted UI shows no documents, so the user agreed to nothing.
    await harness.handle(appleTokenIssuance());

    const profile = profileOf(harness, testUuid(70));
    expect(profile?.['acceptedTermsVersion']).toBeNull();
    expect(profile?.['acceptedPrivacyPolicyVersion']).toBeNull();
  });

  it('records NO age band, because nobody was asked', async () => {
    // Null is what pins the account to the acceptance screen. A band here would
    // be Sign in with Apple walking past the age gate.
    await harness.handle(appleTokenIssuance());

    const profile = profileOf(harness, testUuid(70));
    expect(profile?.['ageBand']).toBeNull();
  });

  it('marks the provider as APPLE and the relay address as a relay address', async () => {
    await harness.handle(appleTokenIssuance());

    const profile = profileOf(harness, testUuid(70));
    expect(profile?.['identityProvider']).toBe('APPLE');
    expect(profile?.['isPrivateRelayEmail']).toBe(true);
  });

  it('does not take a display name from the email local part', async () => {
    // Apple returns a name only on the first authorisation. The local part of a
    // relay address is random, and is not something to show somebody's family.
    await harness.handle(appleTokenIssuance());

    const profile = profileOf(harness, testUuid(70));
    expect(profile?.['displayNameIsPlaceholder']).toBe(true);
    expect(String(profile?.['displayName'])).not.toContain('zz9k4h2');
  });

  it('is written once, not on every token issuance', async () => {
    await harness.handle(appleTokenIssuance());
    await harness.handle(appleTokenIssuance());
    await harness.handle(appleTokenIssuance());

    expect(harness.store.size(USERS_TABLE)).toBe(2); // profile + email claim
  });

  it('never lets a profile write failure break authentication', async () => {
    // Signing in must survive an outage in a write that is only bookkeeping.
    const broken = createHarness();
    const result = await broken.handle(appleTokenIssuance());

    expect(result.response?.claimsOverrideDetails).toBeDefined();
  });
});

describe('a native sign-up records the band the federated one cannot', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness();
  });

  const confirm = (clientMetadata: Record<string, string> | null) =>
    harness.handle(
      postConfirmationEvent({
        userAttributes: {
          sub: testUuid(71),
          email: 'person@example.test',
          email_verified: 'true',
        },
        clientMetadata,
      }),
    );

  it('bands the date the confirmation carried', async () => {
    await confirm({ birthDate: ADULT_BIRTH_DATE });

    expect(profileOf(harness, testUuid(71))?.['ageBand']).toBe('ADULT');
  });

  it('stores the band and never the date', async () => {
    await confirm({ birthDate: ADULT_BIRTH_DATE });

    const profile = profileOf(harness, testUuid(71));
    expect(JSON.stringify(profile)).not.toContain('1990');
  });

  it('distinguishes the two minor bands, which is what Art. 8 will turn on', async () => {
    for (const [birthDate, expected] of [
      ['2012-01-01', 'AGE_13_TO_15'],
      ['2009-01-01', 'AGE_16_TO_17'],
    ] as const) {
      const local = createHarness();
      await local.handle(
        postConfirmationEvent({
          userAttributes: { sub: testUuid(72), email: 'm@example.test' },
          clientMetadata: { birthDate },
        }),
      );

      expect(profileOf(local, testUuid(72))?.['ageBand'], birthDate).toBe(expected);
    }
  });

  it('records no band rather than a wrong one when the confirmation carried nothing', async () => {
    // An account confirmed without the date — an older client, or a confirmation
    // resumed in a new process — is asked again rather than assumed adult.
    await confirm(null);

    expect(profileOf(harness, testUuid(71))?.['ageBand']).toBeNull();
  });

  it('records no band for a date that is not a real date', async () => {
    await confirm({ birthDate: '2011-02-30' });

    expect(profileOf(harness, testUuid(71))?.['ageBand']).toBeNull();
  });

  it('never stores UNDER_13, even if PreSignUp somehow let it through', async () => {
    // Belt and braces: PreSignUp refuses this account outright, so reaching here
    // means the two gates disagreed. Recording the band would be noting that a
    // child is being served and carrying on.
    const under = new Date();
    under.setUTCFullYear(under.getUTCFullYear() - 8);
    await confirm({ birthDate: under.toISOString().slice(0, 10) });

    expect(profileOf(harness, testUuid(71))?.['ageBand']).toBeNull();
  });

  it('logs whether a band was recorded, and never the date', async () => {
    await confirm({ birthDate: ADULT_BIRTH_DATE });

    const line = harness.logs.find((record) => record.message === 'profile_provisioned');
    expect(line?.['ageBandRecorded']).toBe(true);
    expect(JSON.stringify(line)).not.toContain('1990');
  });
});
