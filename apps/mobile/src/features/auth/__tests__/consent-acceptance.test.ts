import { describe, expect, it } from 'vitest';

import {
  canSubmitConsent,
  describeDocument,
  evaluateConsent,
  EMPTY_CONSENT_SELECTION,
} from '@/features/consent/consent-gate';
import { CURRENT_POLICY_VERSIONS, POLICY_CHANGE_SUMMARY } from '@/features/consent/versions';

/**
 * The contract behind `app/(auth)/terms-acceptance.tsx`.
 *
 * The screen decides what a person is agreeing to, so the decisions it makes
 * are pinned here rather than left to a reading of the JSX: that both boxes
 * start empty, that neither document can be agreed to by agreeing to the other,
 * that the version shown is the version submitted, and that the gate only opens
 * once BOTH documents are recorded against the account.
 *
 * That last one was not hypothetical, and it is now fixed in two places rather
 * than one. `PATCH /v1/account` accepted only `acceptedTermsVersion`, so an
 * account whose privacy-policy version had moved on could not be brought up to
 * date by anything this screen could send — it would agree, be told it was done,
 * and be asked again forever. Worse, the repository's update expression did not
 * list either acceptance field, so even the terms version was silently dropped
 * on the way to DynamoDB. Both are fixed; the request contract now refuses one
 * document without the other so the half-recorded state is unrepresentable.
 *
 * The gate also covers age, which is what makes Sign in with Apple safe: a
 * federated account arrives with no attestation, and without this it would walk
 * past the only age check the platform has.
 */

const ACCEPTED_EVERYTHING = {
  acceptedTermsVersion: CURRENT_POLICY_VERSIONS.termsVersion,
  acceptedPrivacyPolicyVersion: CURRENT_POLICY_VERSIONS.privacyPolicyVersion,
  ageBand: 'ADULT',
} as const;

describe('the acceptance screen starts from nothing', () => {
  it('pre-ticks neither box', () => {
    // A pre-ticked consent box is not consent, it is a default.
    expect(EMPTY_CONSENT_SELECTION.termsChecked).toBe(false);
    expect(EMPTY_CONSENT_SELECTION.privacyChecked).toBe(false);
    expect(canSubmitConsent(EMPTY_CONSENT_SELECTION)).toBe(false);
  });

  it('will not let one document stand in for the other', () => {
    // One governs the service; the other governs collecting somebody's
    // location continuously. Bundling them hides the second behind the first.
    expect(canSubmitConsent({ termsChecked: true, privacyChecked: false })).toBe(false);
    expect(canSubmitConsent({ termsChecked: false, privacyChecked: true })).toBe(false);
    expect(canSubmitConsent({ termsChecked: true, privacyChecked: true })).toBe(true);
  });
});

describe('what the screen says is out of date', () => {
  it('names the document that actually changed', () => {
    const evaluation = evaluateConsent(
      { ...ACCEPTED_EVERYTHING, acceptedPrivacyPolicyVersion: '2020-01-01' },
      CURRENT_POLICY_VERSIONS,
    );

    expect(evaluation.reason).toBe('VERSION_CHANGED');
    expect(evaluation.outdatedDocuments.map(describeDocument)).toEqual(['Privacy Policy']);
  });

  it('distinguishes a new account from a returning one, because the copy differs', () => {
    const fresh = evaluateConsent(
      { acceptedTermsVersion: null, acceptedPrivacyPolicyVersion: null, ageBand: null },
      CURRENT_POLICY_VERSIONS,
    );

    expect(fresh.reason).toBe('NEVER_ACCEPTED');
    expect(fresh.outdatedDocuments.map(describeDocument)).toEqual([
      'Terms of Service',
      'Privacy Policy',
    ]);
  });

  it('has something specific to say about what changed', () => {
    // "We have made some improvements" is not an acceptable line on a screen
    // that governs location collection, and App Review agrees.
    expect(POLICY_CHANGE_SUMMARY.length).toBeGreaterThan(0);
    for (const change of POLICY_CHANGE_SUMMARY) {
      expect(change.length).toBeGreaterThan(20);
    }
  });
});

describe('agreeing to what was shown is what clears the gate', () => {
  it('accepts exactly the versions the screen displays', () => {
    expect(evaluateConsent(ACCEPTED_EVERYTHING, CURRENT_POLICY_VERSIONS).acceptanceRequired).toBe(
      false,
    );
  });

  it('is not satisfied by a newer-looking version the client claims', () => {
    const evaluation = evaluateConsent(
      {
        acceptedTermsVersion: '2099-01-01',
        acceptedPrivacyPolicyVersion: '2099-01-01',
        ageBand: 'ADULT',
      },
      CURRENT_POLICY_VERSIONS,
    );

    expect(evaluation.acceptanceRequired).toBe(true);
  });

  it('stays shut until the privacy policy is recorded too', () => {
    // The screen asks for both, so recording only the terms leaves the user
    // pinned to a screen they have already answered.
    const termsOnly = evaluateConsent(
      { ...ACCEPTED_EVERYTHING, acceptedPrivacyPolicyVersion: null },
      CURRENT_POLICY_VERSIONS,
    );

    expect(termsOnly.acceptanceRequired).toBe(true);
    expect(termsOnly.outdatedDocuments).toEqual(['PRIVACY_POLICY']);
  });
});

describe('the age gate, which is the federated half of this screen', () => {
  it('holds an account that has never been asked, even with both documents current', () => {
    // This is precisely a Sign in with Apple account. The hosted UI's
    // authorization-code grant carries no date of birth, so the profile is
    // written with a null band, and if this gate did not exist federation would
    // be a way around the only age check the platform performs.
    const federated = evaluateConsent(
      { ...ACCEPTED_EVERYTHING, ageBand: null },
      CURRENT_POLICY_VERSIONS,
    );

    expect(federated.acceptanceRequired).toBe(true);
    expect(federated.ageAttestationRequired).toBe(true);
  });

  it('says the documents are fine when they are, so the copy does not claim a change', () => {
    // "We have updated our terms" would be untrue here, and a consent screen
    // that misstates why it is asking is not one anybody should trust.
    const federated = evaluateConsent(
      { ...ACCEPTED_EVERYTHING, ageBand: null },
      CURRENT_POLICY_VERSIONS,
    );

    expect(federated.reason).toBe('AGE_NOT_ATTESTED');
    expect(federated.outdatedDocuments).toEqual([]);
  });

  it('is satisfied by any band that can be stored', () => {
    // UNDER_13 is never persisted — it is refused at sign-up and refused again
    // by PATCH /v1/account — so every band that can reach this function clears
    // the gate, including the two minor bands.
    for (const ageBand of ['AGE_13_TO_15', 'AGE_16_TO_17', 'ADULT'] as const) {
      const evaluation = evaluateConsent(
        { ...ACCEPTED_EVERYTHING, ageBand },
        CURRENT_POLICY_VERSIONS,
      );

      expect(evaluation.acceptanceRequired, ageBand).toBe(false);
      expect(evaluation.ageAttestationRequired, ageBand).toBe(false);
    }
  });

  it('does NOT gate when the server never sent the field at all', () => {
    // An API that predates age bands. Treating absent as null would pin every
    // user behind a screen whose submission that API rejects as an unknown key,
    // locking everybody out of the product for the length of the rollout gap.
    // The app ships through the App Store and the API through CI; they cannot
    // land at the same instant, so both orders have to be survivable.
    const olderServer = evaluateConsent(
      {
        acceptedTermsVersion: CURRENT_POLICY_VERSIONS.termsVersion,
        acceptedPrivacyPolicyVersion: CURRENT_POLICY_VERSIONS.privacyPolicyVersion,
      },
      CURRENT_POLICY_VERSIONS,
    );

    expect(olderServer.acceptanceRequired).toBe(false);
    expect(olderServer.ageAttestationRequired).toBe(false);
  });

  it('asks for the date and the documents together when both are outstanding', () => {
    const brandNew = evaluateConsent(
      { acceptedTermsVersion: null, acceptedPrivacyPolicyVersion: null, ageBand: null },
      CURRENT_POLICY_VERSIONS,
    );

    expect(brandNew.reason).toBe('NEVER_ACCEPTED');
    expect(brandNew.ageAttestationRequired).toBe(true);
    expect(brandNew.outdatedDocuments).toHaveLength(2);
  });
});
