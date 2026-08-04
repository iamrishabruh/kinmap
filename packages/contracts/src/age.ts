import { z } from 'zod';

/**
 * Age, as far as this platform is willing to claim to know it.
 *
 * WHY THIS EXISTS. The product locates family members, and some of them are
 * children. Until this module the platform had no signal about age whatsoever:
 * an eight-year-old could create an account, be located continuously, and
 * nothing anywhere in the system would be different. That is not a compliance
 * gap so much as a design gap — a whole class of question (COPPA, GDPR Art. 8,
 * Apple's Kids Category, Google Play Families) cannot even be *asked* of a
 * system that does not model age at all.
 *
 * WHAT THIS IS NOT. This is self-attestation. A date typed into a form is not
 * verification, and nothing here should be read as a claim that the platform
 * knows anybody's age. It is the honest floor: the product asks, refuses the
 * answers it cannot lawfully serve, and records which band the answer fell in.
 * The unresolved legal questions are listed in `docs/privacy/privacy-policy.md`
 * §12 and are for counsel, not for this file.
 *
 * THREE DELIBERATE CHOICES.
 *
 *  1. **Bands are stored; birth dates are not.** A date of birth is a strong
 *     identifier and, combined with location history, a much stronger one. The
 *     platform needs to know which rules apply to somebody, which is a band, so
 *     the band is what is persisted and the date is discarded after the
 *     comparison. See {@link ageBandFor}.
 *  2. **The threshold is never shown before the answer.** A form that says
 *     "you must be 13" collects the number 13, not an age. The screen asks for
 *     a date with no hint of the cutoff — the "neutral age screen" that COPPA
 *     guidance describes — and the refusal comes afterwards.
 *  3. **Under-13 is refused, not accommodated.** Serving a child under 13
 *     lawfully requires verifiable parental consent, which is a specified
 *     process (16 CFR §312.5) and not something an invitation link satisfies.
 *     No such mechanism exists here, so the account is not created. Building it
 *     is a project, not a patch, and pretending an invitation is consent would
 *     be exactly the fabricated compliance this repository refuses to produce.
 */

/**
 * Below this, an account is not self-created. Not a legal conclusion — the
 * lowest age at which the platform has any defensible story at all, and the
 * threshold COPPA itself uses.
 */
export const MINIMUM_SELF_SIGNUP_AGE = 13;

/**
 * The granularity the platform keeps. Chosen so each band corresponds to a
 * different set of open questions rather than to a round number:
 *
 *  - `UNDER_13` — COPPA territory; refused at sign-up, so this band should only
 *    ever be produced transiently, during the check that rejects it.
 *  - `AGE_13_TO_15` — above the COPPA line but below the GDPR Art. 8 digital
 *    consent age in several EU member states, which varies between 13 and 16.
 *  - `AGE_16_TO_17` — a minor everywhere, above the consent age everywhere.
 *  - `ADULT` — 18 or over.
 */
export const AgeBandSchema = z.enum(['UNDER_13', 'AGE_13_TO_15', 'AGE_16_TO_17', 'ADULT']);
export type AgeBand = z.infer<typeof AgeBandSchema>;

/**
 * A calendar date of birth, `YYYY-MM-DD`.
 *
 * Validated as a real date rather than a shape: `2011-02-30` matches the
 * pattern and is not a date, and a birth date that silently becomes March 2nd
 * would move somebody across a band boundary.
 */
export const BirthDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u, 'Expected a date in YYYY-MM-DD form')
  .refine((value) => isRealCalendarDate(value), 'Not a real calendar date');

function isRealCalendarDate(value: string): boolean {
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  const asDate = new Date(Date.UTC(year, month - 1, day));
  return (
    asDate.getUTCFullYear() === year &&
    asDate.getUTCMonth() === month - 1 &&
    asDate.getUTCDate() === day
  );
}

/**
 * Whole years elapsed, by calendar — not by dividing a millisecond difference.
 *
 * Leap years make the arithmetic version wrong for people born on February 29th
 * and, more often, wrong by a day for anybody whose birthday is near the
 * boundary. Someone is 13 on their thirteenth birthday and not the day before,
 * and that is a comparison of calendar fields.
 *
 * `on` is passed in rather than read from the clock so the boundary is testable
 * and so the same input always produces the same band.
 */
export function ageInYears(birthDate: string, on: Date): number {
  const [year, month, day] = birthDate.split('-').map(Number) as [number, number, number];

  let age = on.getUTCFullYear() - year;
  const monthDelta = on.getUTCMonth() - (month - 1);
  if (monthDelta < 0 || (monthDelta === 0 && on.getUTCDate() < day)) {
    age -= 1;
  }
  return age;
}

/**
 * The band a birth date falls in.
 *
 * Callers persist the return value and discard the date. A negative age — a
 * birth date in the future — lands in `UNDER_13`, which is refused; treating an
 * impossible date as an adult would make the gate trivially bypassable.
 */
export function ageBandFor(birthDate: string, on: Date): AgeBand {
  const age = ageInYears(birthDate, on);
  if (age < MINIMUM_SELF_SIGNUP_AGE) return 'UNDER_13';
  if (age < 16) return 'AGE_13_TO_15';
  if (age < 18) return 'AGE_16_TO_17';
  return 'ADULT';
}

/** Whether an attested date clears {@link MINIMUM_SELF_SIGNUP_AGE}. */
export function meetsSelfSignupMinimum(birthDate: string, on: Date): boolean {
  return ageBandFor(birthDate, on) !== 'UNDER_13';
}

/** Whether the band is below the age of majority, for any of the three minor bands. */
export function isMinorBand(band: AgeBand): boolean {
  return band !== 'ADULT';
}
