import type { AgeBand } from '@family/contracts';

import type { PolicyVersions } from './versions';

/**
 * The consent gate.
 *
 * Pure, synchronous, and dependency-free so it can be exercised exhaustively in
 * tests and reused by the routing guard without pulling React or the network in
 * with it. The rule it encodes is simple and absolute: a signed-in user who has
 * not accepted the versions of the terms and privacy policy that shipped in
 * this binary, or who has never been asked their age, cannot reach any product
 * surface.
 *
 * AGE IS PART OF THIS GATE BECAUSE OF HOW FEDERATION WORKS. A native sign-up
 * attests a date of birth before the account exists — `pre-signup.ts` refuses it
 * otherwise. Sign in with Apple cannot: federation into a Cognito user pool runs
 * through the hosted UI's authorization-code grant, which carries no validation
 * data, so an Apple account arrives with no attestation at all. Left out of this
 * gate, Sign in with Apple would be a way around the only age check the platform
 * has. So an unattested account is pinned to the same screen, and answers there.
 */

/** What the server told us about this account's consent, if anything. */
export type ConsentRecord = {
  acceptedTermsVersion: string | null;
  acceptedPrivacyPolicyVersion: string | null;
  /**
   * The band a previously attested date of birth fell in.
   *
   * `null` is the gate — asked for and unanswered, which is where every
   * federated account starts. A band, any band, satisfies it, because the one
   * band that would not (`UNDER_13`) is never stored.
   *
   * `undefined` is NOT the gate: it means the server did not send the field,
   * i.e. an API that predates age bands. Gating on that would strand every user
   * behind a screen whose submission the older API rejects. See `AccountSchema`.
   */
  ageBand?: AgeBand | null;
};

export type ConsentReason =
  /** Brand-new account, or an account created before consent was recorded. */
  | 'NEVER_ACCEPTED'
  /** Accepted a policy at some point, but at least one document has moved on. */
  | 'VERSION_CHANGED'
  /** Documents are current; the account has simply never been asked its age. */
  | 'AGE_NOT_ATTESTED';

export type ConsentEvaluation = {
  /** True when the user must be routed to the acceptance screen. */
  acceptanceRequired: boolean;
  reason: ConsentReason | null;
  /** Which documents specifically are out of date. Drives the screen copy. */
  outdatedDocuments: readonly ConsentDocument[];
  /** True when the screen must also collect a date of birth. */
  ageAttestationRequired: boolean;
  required: PolicyVersions;
  accepted: ConsentRecord;
};

export type ConsentDocument = 'TERMS' | 'PRIVACY_POLICY';

const NEVER_ACCEPTED: ConsentRecord = {
  acceptedTermsVersion: null,
  acceptedPrivacyPolicyVersion: null,
  ageBand: null,
};

/**
 * Version comparison is exact equality, never ordering.
 *
 * A newer-looking string is not treated as satisfying an older requirement:
 * consent is to a specific document, and "the client claims it accepted
 * something later" is exactly the direction an attacker or a bad migration
 * would push. Anything that is not character-for-character the shipped version
 * re-prompts.
 */
function isSatisfied(accepted: string | null, required: string): boolean {
  return typeof accepted === 'string' && accepted === required;
}

export function evaluateConsent(
  record: ConsentRecord | null | undefined,
  required: PolicyVersions,
): ConsentEvaluation {
  const accepted = record ?? NEVER_ACCEPTED;

  const outdated: ConsentDocument[] = [];
  if (!isSatisfied(accepted.acceptedTermsVersion, required.termsVersion)) {
    outdated.push('TERMS');
  }
  if (!isSatisfied(accepted.acceptedPrivacyPolicyVersion, required.privacyPolicyVersion)) {
    outdated.push('PRIVACY_POLICY');
  }

  // `=== null` and not a falsy check: `undefined` is "the server has no opinion"
  // and must not gate. See `ConsentRecord.ageBand`.
  const ageAttestationRequired = accepted.ageBand === null;

  if (outdated.length === 0 && !ageAttestationRequired) {
    return {
      acceptanceRequired: false,
      reason: null,
      outdatedDocuments: [],
      ageAttestationRequired: false,
      required,
      accepted,
    };
  }

  const neverAccepted =
    accepted.acceptedTermsVersion === null && accepted.acceptedPrivacyPolicyVersion === null;

  return {
    acceptanceRequired: true,
    // Ordered by what the screen has to say. An account whose documents are
    // current and whose age is simply unknown is not being asked to re-consent
    // to anything, and telling it "we have updated our terms" would be a lie.
    reason:
      outdated.length === 0
        ? 'AGE_NOT_ATTESTED'
        : neverAccepted
          ? 'NEVER_ACCEPTED'
          : 'VERSION_CHANGED',
    outdatedDocuments: outdated,
    ageAttestationRequired,
    required,
    accepted,
  };
}

/**
 * The acceptance screen requires two independent, unchecked-by-default
 * affirmations. A single "I agree to everything" toggle is a dark pattern when
 * one of the documents governs continuous location collection, so the terms and
 * the privacy policy are consented to separately and neither is pre-ticked.
 */
export type ConsentSelection = {
  termsChecked: boolean;
  privacyChecked: boolean;
};

export const EMPTY_CONSENT_SELECTION: ConsentSelection = {
  termsChecked: false,
  privacyChecked: false,
};

export function canSubmitConsent(selection: ConsentSelection): boolean {
  return selection.termsChecked && selection.privacyChecked;
}

/** Human-readable label used in copy and in the acceptance audit trail. */
export function describeDocument(document: ConsentDocument): string {
  return document === 'TERMS' ? 'Terms of Service' : 'Privacy Policy';
}
