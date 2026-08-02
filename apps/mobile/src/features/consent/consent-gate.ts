import type { PolicyVersions } from './versions';

/**
 * The consent gate.
 *
 * Pure, synchronous, and dependency-free so it can be exercised exhaustively in
 * tests and reused by the routing guard without pulling React or the network in
 * with it. The rule it encodes is simple and absolute: a signed-in user who has
 * not accepted the versions of the terms and privacy policy that shipped in
 * this binary cannot reach any product surface.
 */

/** What the server told us the user has accepted, if anything. */
export type ConsentRecord = {
  acceptedTermsVersion: string | null;
  acceptedPrivacyPolicyVersion: string | null;
};

export type ConsentReason =
  /** Brand-new account, or an account created before consent was recorded. */
  | 'NEVER_ACCEPTED'
  /** Accepted a policy at some point, but at least one document has moved on. */
  | 'VERSION_CHANGED';

export type ConsentEvaluation = {
  /** True when the user must be routed to the acceptance screen. */
  acceptanceRequired: boolean;
  reason: ConsentReason | null;
  /** Which documents specifically are out of date. Drives the screen copy. */
  outdatedDocuments: readonly ConsentDocument[];
  required: PolicyVersions;
  accepted: ConsentRecord;
};

export type ConsentDocument = 'TERMS' | 'PRIVACY_POLICY';

const NEVER_ACCEPTED: ConsentRecord = {
  acceptedTermsVersion: null,
  acceptedPrivacyPolicyVersion: null,
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

  if (outdated.length === 0) {
    return {
      acceptanceRequired: false,
      reason: null,
      outdatedDocuments: [],
      required,
      accepted,
    };
  }

  const neverAccepted =
    accepted.acceptedTermsVersion === null && accepted.acceptedPrivacyPolicyVersion === null;

  return {
    acceptanceRequired: true,
    reason: neverAccepted ? 'NEVER_ACCEPTED' : 'VERSION_CHANGED',
    outdatedDocuments: outdated,
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
