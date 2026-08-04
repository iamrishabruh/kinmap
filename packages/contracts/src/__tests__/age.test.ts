import { describe, expect, it } from 'vitest';

import {
  ageBandFor,
  ageInYears,
  BirthDateSchema,
  isMinorBand,
  meetsSelfSignupMinimum,
  MINIMUM_SELF_SIGNUP_AGE,
} from '../age.js';

/**
 * The boundary is the whole point. A gate that is a day out either lets a
 * twelve-year-old through or refuses a thirteen-year-old, and both are the
 * failure this module exists to prevent.
 */

const on = (iso: string): Date => new Date(`${iso}T12:00:00.000Z`);

describe('ageInYears', () => {
  it('turns over on the birthday, not the day before', () => {
    expect(ageInYears('2013-06-15', on('2026-06-14'))).toBe(12);
    expect(ageInYears('2013-06-15', on('2026-06-15'))).toBe(13);
  });

  it('is right for a February 29th birth date in a non-leap year', () => {
    // Someone born on a leap day has a birthday in law on March 1st in most
    // jurisdictions; the arithmetic here treats February 29th as not-yet-passed
    // on February 28th, which is the conservative direction for a gate.
    expect(ageInYears('2012-02-29', on('2026-02-28'))).toBe(13);
    expect(ageInYears('2012-02-29', on('2026-03-01'))).toBe(14);
  });

  it('does not drift across leap years', () => {
    // The millisecond-division version of this function returns 12 here,
    // because thirteen years spanning four leap days is more than 13 * 365 days
    // by a margin that rounds the wrong way.
    expect(ageInYears('2013-01-01', on('2026-01-01'))).toBe(13);
  });
});

describe('ageBandFor', () => {
  it.each([
    ['2020-01-01', 'UNDER_13'],
    // One day short of the thirteenth birthday.
    ['2013-01-02', 'UNDER_13'],
    ['2013-01-01', 'AGE_13_TO_15'],
    ['2010-01-02', 'AGE_13_TO_15'],
    ['2010-01-01', 'AGE_16_TO_17'],
    ['2008-01-02', 'AGE_16_TO_17'],
    ['2008-01-01', 'ADULT'],
    ['1980-05-05', 'ADULT'],
  ])('places %s in %s', (birthDate, expected) => {
    expect(ageBandFor(birthDate, on('2026-01-01'))).toBe(expected);
  });

  it('treats a birth date in the future as under 13 rather than as an adult', () => {
    // A negative age must not fall through to ADULT: that would make the gate
    // bypassable by typing a date nobody could have been born on.
    expect(ageBandFor('2030-01-01', on('2026-01-01'))).toBe('UNDER_13');
    expect(meetsSelfSignupMinimum('2030-01-01', on('2026-01-01'))).toBe(false);
  });

  it('refuses exactly below the documented minimum and admits exactly at it', () => {
    const born = new Date(Date.UTC(2026 - MINIMUM_SELF_SIGNUP_AGE, 0, 1));
    const birthDate = born.toISOString().slice(0, 10);

    expect(meetsSelfSignupMinimum(birthDate, on('2025-12-31'))).toBe(false);
    expect(meetsSelfSignupMinimum(birthDate, on('2026-01-01'))).toBe(true);
  });
});

describe('BirthDateSchema', () => {
  it('accepts a real date', () => {
    expect(BirthDateSchema.safeParse('2010-02-28').success).toBe(true);
    expect(BirthDateSchema.safeParse('2012-02-29').success).toBe(true);
  });

  it('rejects a date that matches the shape but does not exist', () => {
    // `new Date('2011-02-30')` rolls forward to March 2nd, which would move
    // somebody a band without anything reporting that it happened.
    expect(BirthDateSchema.safeParse('2011-02-30').success).toBe(false);
    expect(BirthDateSchema.safeParse('2011-13-01').success).toBe(false);
  });

  it('rejects anything that is not a plain calendar date', () => {
    for (const value of ['2011-2-3', '11-02-03', '2011-02-03T00:00:00Z', '', 'yesterday']) {
      expect(BirthDateSchema.safeParse(value).success, value).toBe(false);
    }
  });
});

describe('isMinorBand', () => {
  it('counts every band below ADULT', () => {
    expect(isMinorBand('UNDER_13')).toBe(true);
    expect(isMinorBand('AGE_13_TO_15')).toBe(true);
    expect(isMinorBand('AGE_16_TO_17')).toBe(true);
    expect(isMinorBand('ADULT')).toBe(false);
  });
});
