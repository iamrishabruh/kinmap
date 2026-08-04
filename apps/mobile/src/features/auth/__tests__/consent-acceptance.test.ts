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
 * That last one is not hypothetical. `PATCH /v1/account` currently accepts only
 * `acceptedTermsVersion` (`UpdateAccountRequestSchema`), so an account whose
 * privacy-policy version has moved on cannot be brought up to date by anything
 * this screen can send — it would agree, be told it is done, and be asked again.
 * The test states the requirement; the fix belongs in the schema and the API.
 */

const ACCEPTED_EVERYTHING = {
  acceptedTermsVersion: CURRENT_POLICY_VERSIONS.termsVersion,
  acceptedPrivacyPolicyVersion: CURRENT_POLICY_VERSIONS.privacyPolicyVersion,
};

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
      { acceptedTermsVersion: null, acceptedPrivacyPolicyVersion: null },
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
      { acceptedTermsVersion: '2099-01-01', acceptedPrivacyPolicyVersion: '2099-01-01' },
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
