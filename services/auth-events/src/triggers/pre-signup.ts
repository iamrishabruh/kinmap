import { AppError, BirthDateSchema, meetsSelfSignupMinimum } from '@family/contracts';

import type { AuthEventsConfig } from '../env.js';
import type { ClientMetadata, PreSignUpEvent } from '../events.js';

/**
 * Pre sign-up.
 *
 * Three rules, all of which have to hold for *every* trigger source:
 *
 *  1. **No account is created without a current terms and privacy acceptance.**
 *     Consent to be located is the product's whole premise, so an account that
 *     predates the current policy version is not created and then chased — it is
 *     refused, with a code the client turns into "please review and accept".
 *  2. **No account is created without an attested date of birth that clears the
 *     minimum age.** The platform previously had no age signal at all, which
 *     meant a child of any age could be located continuously and nothing in the
 *     system would differ. Enforced here rather than in the client because a
 *     client-side gate is a suggestion — `SignUp` is a public Cognito API and
 *     anyone can call it directly.
 *  3. **Nothing is auto-confirmed.** `autoConfirmUser` is set to false
 *     explicitly rather than left undefined, and so are both auto-verify flags.
 *     Auto-confirming would let somebody create an account against an address
 *     they do not control, and in this product an unverified address is a
 *     recovery channel into somebody's location history.
 *
 * The date of birth is compared and discarded. It is never written to the user
 * pool, never logged, and never returned — the platform keeps the band, which
 * is what any rule actually turns on, and not the identifier.
 */

/** Accepted spellings for the acceptance keys, in precedence order. */
const TERMS_KEYS = ['termsVersion', 'terms_version'] as const;
const PRIVACY_KEYS = ['privacyPolicyVersion', 'privacy_policy_version'] as const;
const BIRTH_DATE_KEYS = ['birthDate', 'birth_date', 'birthdate'] as const;

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

/**
 * One sentence for every rejection: absent, malformed, and too young all
 * produce this.
 *
 * Distinguishing them would tell a caller which part of the gate to vary, and
 * the only useful thing to learn from "you are too young" is that a different
 * date gets through. It also keeps the message from confirming that a
 * particular date was read as a particular age.
 */
export function ageRequirementNotMetError(): AppError {
  return new AppError(
    'AGE_REQUIREMENT_NOT_MET',
    'This account cannot be created. Kinmap is not available to everyone who tries to sign up.',
  );
}

/**
 * Whether the attested date of birth clears the minimum.
 *
 * Absent or unparseable is refused rather than waved through: a client that
 * omits the field is either out of date or bypassing the screen, and neither is
 * a reason to create the account.
 *
 * `now` is injected so the boundary is testable, and because a trigger that
 * reads the clock is one that behaves differently on a birthday.
 */
export function clearsMinimumAge(
  validationData: ClientMetadata | null | undefined,
  clientMetadata: ClientMetadata | null | undefined,
  now: Date,
): boolean {
  const attested = firstValue(BIRTH_DATE_KEYS, validationData, clientMetadata);
  if (attested === null) {
    return false;
  }

  const parsed = BirthDateSchema.safeParse(attested);
  if (!parsed.success) {
    return false;
  }

  return meetsSelfSignupMinimum(parsed.data, now);
}

export function handlePreSignUp(
  event: PreSignUpEvent,
  config: AuthEventsConfig,
  now: Date = new Date(),
): PreSignUpEvent {
  const acceptance = readTermsAcceptance(
    event.request.validationData,
    event.request.clientMetadata,
  );
  if (!isAcceptanceCurrent(acceptance, config)) {
    throw termsAcceptanceRequiredError();
  }

  if (!clearsMinimumAge(event.request.validationData, event.request.clientMetadata, now)) {
    throw ageRequirementNotMetError();
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
