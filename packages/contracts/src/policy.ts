/**
 * The versions of the terms and the privacy policy currently in force.
 *
 * ONE CONSTANT, BECAUSE TWO OF THEM BROKE ACCOUNT CREATION. The Cognito
 * PreSignUp trigger refuses any sign-up whose accepted versions are not the
 * current ones, and the app and the trigger each carried their own literal —
 * `2026-05-01` in `apps/mobile/src/features/consent/versions.ts`, `2026-01-01`
 * in `services/auth-events/src/env.ts`. Nothing compared them. Every attempt to
 * create an account failed with:
 *
 *   PreSignUp failed with error The current terms of service and privacy
 *   policy must be accepted before creating an account.
 *
 * which the client showed as "Something went wrong on our end" — a message that
 * blames the server for a mismatch between two files in this repository.
 *
 * Both sides now read these, and a test asserts they agree, so the two cannot
 * drift apart again.
 *
 * CHANGING A VERSION IS NOT A COSMETIC EDIT. The trigger compares what a client
 * sends against these, and the profile records what a user accepted. Raising a
 * version means every existing user must re-accept before they can sign in
 * again — which is the intended behaviour when a policy materially changes, and
 * an outage when it happens by accident. Change it only alongside the document
 * it describes.
 */
export const POLICY_VERSIONS = {
  termsVersion: '2026-05-01',
  privacyPolicyVersion: '2026-05-01',
} as const;

export type PolicyVersions = {
  readonly termsVersion: string;
  readonly privacyPolicyVersion: string;
};
