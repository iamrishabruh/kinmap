import { describe, expect, it } from 'vitest';

import { POLICY_VERSIONS } from '@family/contracts';

import {
  CURRENT_POLICY_VERSIONS,
  CURRENT_PRIVACY_POLICY_VERSION,
  CURRENT_TERMS_VERSION,
} from '../../consent/versions';

/**
 * The app and the Cognito PreSignUp trigger each carried their own literal —
 * 2026-05-01 here and 2026-01-01 in the trigger — and nothing compared them.
 * The trigger refuses a sign-up whose accepted versions are not current, so
 * account creation failed for everybody, and the client reported it as
 * "Something went wrong on our end".
 *
 * This lives in the app rather than in @family/contracts because contracts must
 * not import the app: doing so put a file outside its rootDir and broke its
 * build. The dependency only points one way.
 */
describe('policy versions', () => {
  it('come from the contract, so they cannot drift from the trigger', () => {
    expect(CURRENT_TERMS_VERSION).toBe(POLICY_VERSIONS.termsVersion);
    expect(CURRENT_PRIVACY_POLICY_VERSION).toBe(POLICY_VERSIONS.privacyPolicyVersion);
    expect(CURRENT_POLICY_VERSIONS).toEqual(POLICY_VERSIONS);
  });

  it('are dated, so an acceptance record is legible without a lookup table', () => {
    for (const value of Object.values(CURRENT_POLICY_VERSIONS)) {
      expect(value).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    }
  });
});
