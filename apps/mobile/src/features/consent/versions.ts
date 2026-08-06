import { POLICY_VERSIONS } from '@family/contracts';

/**
 * The terms and privacy policy versions this build was written against.
 *
 * These are compile-time constants on purpose. A user consents to the documents
 * that shipped in the binary they are running, so the version the app compares
 * against must not be swappable over the air (spec §24: OTA updates may never
 * alter consent behaviour). Publishing a new policy is a store release.
 *
 * Format is `YYYY-MM-DD` — dated, not numbered, because the acceptance record
 * has to be legible in an audit or a subject access request without a lookup
 * table. `TermsVersionSchema` in @family/schemas bounds it to 1..32 chars.
 */

/*
 * Taken from @family/contracts rather than written here.
 *
 * These used to be their own literals, and they said `2026-05-01` while the
 * Cognito PreSignUp trigger's own literal said `2026-01-01`. The trigger
 * refuses a sign-up whose accepted versions are not current, so every attempt
 * to create an account failed — and the client rendered it as "Something went
 * wrong on our end", blaming the server for two files in this repository
 * disagreeing. A contracts test now asserts they cannot drift.
 *
 * Still compile-time constants, which is what mattered about them: a user
 * consents to the documents that shipped in the binary they are running, so
 * the version cannot be swappable over the air (spec §24).
 */
export const CURRENT_TERMS_VERSION = POLICY_VERSIONS.termsVersion;
export const CURRENT_PRIVACY_POLICY_VERSION = POLICY_VERSIONS.privacyPolicyVersion;

export type { PolicyVersions } from '@family/contracts';

export const CURRENT_POLICY_VERSIONS = POLICY_VERSIONS;

/**
 * Plain-language summary of what changed, shown above the re-acceptance
 * prompt. An empty list renders the generic "we updated our documents" copy.
 *
 * Never write "we've made some improvements" here. If a change widens what is
 * collected or who can see it, say so in the first bullet.
 */
export const POLICY_CHANGE_SUMMARY: readonly string[] = [
  'Clearer wording about exactly which family members can see your location.',
  'A new section describing how long location history is kept and how to delete it.',
  'No change to what we collect: nothing is shared unless you turn sharing on.',
];
