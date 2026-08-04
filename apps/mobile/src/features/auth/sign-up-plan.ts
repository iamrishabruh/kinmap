import { BirthDateSchema, meetsSelfSignupMinimum } from '@family/contracts';
import { EmailSchema } from '@family/schemas';

import { type PolicyAcceptance } from '@/features/auth/cognito/sign-up';
import { type PolicyVersions } from '@/features/consent/versions';

/**
 * Everything the sign-up screen decides, with no renderer attached.
 *
 * Split out of `app/(auth)/sign-up.tsx` because that file said this logic
 * "must be inspectable without a renderer" and then sat somewhere the test
 * runner could not reach: the runner's root is `src/features/auth`, so nothing
 * under `app/` was ever executed by a test. The two rules this module holds up
 * — that a recorded consent is the consent that was displayed, and that an
 * account is not created below the minimum age — are exactly the kind that fail
 * silently, so they are now where they can be exercised.
 */

// ---------------------------------------------------------------------------
// Password policy
// ---------------------------------------------------------------------------

type PasswordRule = {
  readonly describe: string;
  readonly satisfied: (value: string) => boolean;
};

/**
 * Cognito's documented password symbol set. Written out rather than
 * approximated with "not a letter or a digit", because the pool rejects an
 * emoji as a symbol and a user told otherwise would be stuck in a loop with no
 * way to see why.
 */
const COGNITO_SYMBOL = /[\^$*.[\]{}()?"!@#%&/\\,><':;|_~`+=-]/u;

/**
 * Mirrors `passwordPolicy` in `infrastructure/stacks/identity-stack.ts`.
 *
 * Checked here, before the call, because the shared Cognito error mapper folds
 * `InvalidPasswordException` into "That email address and password do not match
 * an account". That wording is right on sign-in and nonsense on sign-up, and
 * the fix is not to teach the mapper a second context — it is to make sure the
 * pool never has to reject the password in the first place.
 */
const PASSWORD_RULES: readonly PasswordRule[] = [
  { describe: 'at least 12 characters', satisfied: (value) => value.length >= 12 },
  { describe: 'a lower-case letter', satisfied: (value) => /\p{Ll}/u.test(value) },
  { describe: 'an upper-case letter', satisfied: (value) => /\p{Lu}/u.test(value) },
  { describe: 'a number', satisfied: (value) => /\d/u.test(value) },
  { describe: 'a symbol', satisfied: (value) => COGNITO_SYMBOL.test(value) },
];

export const PASSWORD_REQUIREMENTS_HELPER =
  'At least 12 characters, including an upper-case letter, a lower-case letter, a number and a symbol.';

export function unmetPasswordRules(password: string): readonly string[] {
  return PASSWORD_RULES.filter((rule) => !rule.satisfied(password)).map((rule) => rule.describe);
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

export type SignUpBlocker =
  | 'POLICIES_UNAVAILABLE'
  | 'EMAIL_INVALID'
  | 'PASSWORD_WEAK'
  | 'PASSWORD_MISMATCH'
  | 'BIRTH_DATE_INCOMPLETE'
  | 'BIRTH_DATE_INVALID'
  | 'AGE_BELOW_MINIMUM';

export type SignUpPlan =
  | { readonly ready: false; readonly blocker: SignUpBlocker }
  | {
      readonly ready: true;
      readonly email: string;
      readonly password: string;
      readonly accepted: PolicyAcceptance;
      /** `YYYY-MM-DD`. Sent for the server-side gate; never stored on the account. */
      readonly birthDate: string;
    };

/**
 * Assembles `YYYY-MM-DD` from three separate fields.
 *
 * Three fields rather than one, and never a locale-formatted string: `03/04/11`
 * is three different dates in three different countries, and a date of birth
 * misread by a month can move somebody across the age boundary. Returns null
 * when the parts are not a real calendar date, which `BirthDateSchema` then
 * confirms — `2011-02-30` matches the shape and is not a date.
 */
export function composeBirthDate(parts: {
  readonly day: string;
  readonly month: string;
  readonly year: string;
}): string | null {
  const day = Number(parts.day.trim());
  const month = Number(parts.month.trim());
  const year = Number(parts.year.trim());

  if (!Number.isInteger(day) || !Number.isInteger(month) || !Number.isInteger(year)) return null;
  if (parts.year.trim().length !== 4) return null;

  const iso = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return BirthDateSchema.safeParse(iso).success ? iso : null;
}

/**
 * Turns what is on screen into either a refusal or the exact sign-up payload.
 *
 * Pure, and kept separate from the component for that reason: this is the
 * function that decides what a person is consenting to, and it must be
 * inspectable without a renderer. `shown` is the versions this render actually
 * put in front of the user — `null` when the documents could not be shown at
 * all — and it is checked FIRST, so a build that cannot display the terms never
 * even validates a form it has no right to submit.
 */
export function planSignUp(input: {
  readonly email: string;
  readonly password: string;
  readonly passwordAgain: string;
  readonly birth: { readonly day: string; readonly month: string; readonly year: string };
  readonly shown: PolicyVersions | null;
  /** Injected so the age boundary is testable and not clock-dependent. */
  readonly now?: Date;
}): SignUpPlan {
  if (input.shown === null) {
    return { ready: false, blocker: 'POLICIES_UNAVAILABLE' };
  }

  const email = input.email.trim();
  if (!EmailSchema.safeParse(email).success) {
    return { ready: false, blocker: 'EMAIL_INVALID' };
  }
  if (unmetPasswordRules(input.password).length > 0) {
    return { ready: false, blocker: 'PASSWORD_WEAK' };
  }
  if (input.password !== input.passwordAgain) {
    return { ready: false, blocker: 'PASSWORD_MISMATCH' };
  }

  // Age is checked LAST, after everything a person can usefully correct.
  //
  // The order matters: a refusal here ends the sign-up for this session, so it
  // must not be reachable by somebody who simply mistyped their email. Checking
  // it last means the only way to see it is to have submitted an otherwise
  // complete, valid form.
  const incomplete = [input.birth.day, input.birth.month, input.birth.year].some(
    (part) => part.trim() === '',
  );
  if (incomplete) {
    return { ready: false, blocker: 'BIRTH_DATE_INCOMPLETE' };
  }

  const birthDate = composeBirthDate(input.birth);
  if (birthDate === null) {
    return { ready: false, blocker: 'BIRTH_DATE_INVALID' };
  }
  if (!meetsSelfSignupMinimum(birthDate, input.now ?? new Date())) {
    return { ready: false, blocker: 'AGE_BELOW_MINIMUM' };
  }

  return {
    ready: true,
    email,
    password: input.password,
    birthDate,
    // Built from what was displayed, never re-read from the module. This is the
    // line that makes "the acceptance is the one the user saw" a property of
    // the code rather than a convention.
    accepted: {
      termsVersion: input.shown.termsVersion,
      privacyPolicyVersion: input.shown.privacyPolicyVersion,
    },
  };
}

function joinPhrases(phrases: readonly string[]): string {
  if (phrases.length <= 1) return phrases[0] ?? '';
  const last = phrases[phrases.length - 1] ?? '';
  return `${phrases.slice(0, -1).join(', ')} and ${last}`;
}

export function describeBlocker(blocker: SignUpBlocker, password: string): string {
  switch (blocker) {
    case 'POLICIES_UNAVAILABLE':
      return 'This version of Kinmap cannot show you the terms or the privacy policy, so it will not create an account. Please update the app.';
    case 'EMAIL_INVALID':
      return 'Enter an email address you can receive mail at — we send a confirmation code to it.';
    case 'PASSWORD_WEAK':
      return `Your password still needs ${joinPhrases(unmetPasswordRules(password))}.`;
    case 'PASSWORD_MISMATCH':
      return 'The two passwords do not match.';
    case 'BIRTH_DATE_INCOMPLETE':
      return 'Enter your date of birth — all three boxes.';
    case 'BIRTH_DATE_INVALID':
      return 'That is not a date. Check the day, month and year.';
    case 'AGE_BELOW_MINIMUM':
      // Deliberately does not name the threshold, and deliberately does not
      // invite another attempt. Saying "you must be 13" teaches the number to
      // type; the screen asked for a date without stating a cutoff precisely so
      // that the answer would be an age rather than a guess at the rule.
      return 'Kinmap cannot create an account for you.';
  }
}
