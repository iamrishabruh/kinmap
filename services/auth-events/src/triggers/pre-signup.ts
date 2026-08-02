import { AppError } from '@family/contracts';

import type { AuthEventsConfig } from '../env.js';
import type { ClientMetadata, PreSignUpEvent } from '../events.js';

/**
 * Pre sign-up.
 *
 * Two rules, both of which have to hold for *every* trigger source:
 *
 *  1. **No account is created without a current terms and privacy acceptance.**
 *     Consent to be located is the product's whole premise, so an account that
 *     predates the current policy version is not created and then chased — it is
 *     refused, with a code the client turns into "please review and accept".
 *  2. **Nothing is auto-confirmed.** `autoConfirmUser` is set to false
 *     explicitly rather than left undefined, and so are both auto-verify flags.
 *     Auto-confirming would let somebody create an account against an address
 *     they do not control, and in this product an unverified address is a
 *     recovery channel into somebody's location history.
 */

/** Accepted spellings for the acceptance keys, in precedence order. */
const TERMS_KEYS = ['termsVersion', 'terms_version'] as const;
const PRIVACY_KEYS = ['privacyPolicyVersion', 'privacy_policy_version'] as const;

export type TermsAcceptance = {
  readonly termsVersion: string | null;
  readonly privacyPolicyVersion: string | null;
};

export function termsAcceptanceRequiredError(): AppError {
  return new AppError(
    'TERMS_ACCEPTANCE_REQUIRED',
    'The current terms of service and privacy policy must be accepted before creating an account.',
  );
}

/**
 * Reads the acceptance from the client's `validationData` (what `SignUp`
 * carries) falling back to `clientMetadata`. Both are attacker-controllable, so
 * the value is only ever compared against the server's own version — it is never
 * stored as an assertion of what the user saw.
 */
export function readTermsAcceptance(
  validationData: ClientMetadata | null | undefined,
  clientMetadata: ClientMetadata | null | undefined,
): TermsAcceptance {
  return {
    termsVersion: firstValue(TERMS_KEYS, validationData, clientMetadata),
    privacyPolicyVersion: firstValue(PRIVACY_KEYS, validationData, clientMetadata),
  };
}

function firstValue(
  keys: readonly string[],
  ...sources: ReadonlyArray<ClientMetadata | null | undefined>
): string | null {
  for (const source of sources) {
    if (source === null || source === undefined) {
      continue;
    }
    for (const key of keys) {
      const value = source[key];
      if (value !== undefined && value.trim() !== '') {
        return value.trim();
      }
    }
  }
  return null;
}

export function isAcceptanceCurrent(
  acceptance: TermsAcceptance,
  config: AuthEventsConfig,
): boolean {
  return (
    acceptance.termsVersion === config.termsVersion &&
    acceptance.privacyPolicyVersion === config.privacyPolicyVersion
  );
}

export function handlePreSignUp(event: PreSignUpEvent, config: AuthEventsConfig): PreSignUpEvent {
  const acceptance = readTermsAcceptance(
    event.request.validationData,
    event.request.clientMetadata,
  );
  if (!isAcceptanceCurrent(acceptance, config)) {
    throw termsAcceptanceRequiredError();
  }

  return {
    ...event,
    response: {
      ...event.response,
      // Explicit, on every path. A federated sign-up is confirmed by its
      // provider; nothing here needs to — or may — shortcut verification.
      autoConfirmUser: false,
      autoVerifyEmail: false,
      autoVerifyPhone: false,
    },
  };
}
