import { describe, expect, it } from 'vitest';

import {
  composeBirthDate,
  describeBlocker,
  planSignUp,
  unmetPasswordRules,
} from '../sign-up-plan.js';

/**
 * The sign-up decision.
 *
 * Two properties here are the kind that pass review and fail in production
 * without anything reporting it: that the consent recorded is the consent that
 * was shown, and that the age screen cannot be talked out of its answer. Both
 * were unreachable by any test until this logic moved out of the `.tsx`.
 */

const SHOWN = { termsVersion: '2026-01-01', privacyPolicyVersion: '2026-01-01' } as const;
const NOW = new Date('2026-08-04T12:00:00.000Z');

const form = (over: Partial<Parameters<typeof planSignUp>[0]> = {}) => ({
  email: 'ada@example.com',
  password: 'Sufficient1Password!',
  passwordAgain: 'Sufficient1Password!',
  birth: { day: '15', month: '6', year: '1990' },
  shown: SHOWN,
  now: NOW,
  ...over,
});

describe('planSignUp', () => {
  it('produces the payload the trigger requires', () => {
    const plan = planSignUp(form());

    expect(plan).toMatchObject({
      ready: true,
      email: 'ada@example.com',
      birthDate: '1990-06-15',
      accepted: { termsVersion: '2026-01-01', privacyPolicyVersion: '2026-01-01' },
    });
  });

  it('refuses to create an account when the policies could not be shown', () => {
    // Failing closed on a build problem beats recording an acceptance of a
    // document nobody could open.
    expect(planSignUp(form({ shown: null }))).toEqual({
      ready: false,
      blocker: 'POLICIES_UNAVAILABLE',
    });
  });

  it('records the versions it was given, never the module constants', () => {
    const plan = planSignUp(
      form({ shown: { termsVersion: 'shown-t', privacyPolicyVersion: 'shown-p' } }),
    );

    expect(plan).toMatchObject({
      accepted: { termsVersion: 'shown-t', privacyPolicyVersion: 'shown-p' },
    });
  });

  describe('the age gate', () => {
    it('refuses an attested age below the minimum', () => {
      expect(planSignUp(form({ birth: { day: '1', month: '1', year: '2020' } }))).toEqual({
        ready: false,
        blocker: 'AGE_BELOW_MINIMUM',
      });
    });

    it('admits somebody exactly on their thirteenth birthday', () => {
      // 2013-08-04 evaluated on 2026-08-04.
      expect(planSignUp(form({ birth: { day: '4', month: '8', year: '2013' } }))).toMatchObject({
        ready: true,
        birthDate: '2013-08-04',
      });
    });

    it('refuses them the day before it', () => {
      expect(planSignUp(form({ birth: { day: '5', month: '8', year: '2013' } }))).toEqual({
        ready: false,
        blocker: 'AGE_BELOW_MINIMUM',
      });
    });

    it('asks for the missing boxes rather than guessing', () => {
      expect(planSignUp(form({ birth: { day: '', month: '6', year: '1990' } }))).toEqual({
        ready: false,
        blocker: 'BIRTH_DATE_INCOMPLETE',
      });
    });

    it('rejects a date that does not exist instead of rolling it forward', () => {
      // `new Date('2011-02-30')` is March 2nd, which could move somebody across
      // the boundary with nothing reporting that it happened.
      expect(planSignUp(form({ birth: { day: '30', month: '2', year: '2011' } }))).toEqual({
        ready: false,
        blocker: 'BIRTH_DATE_INVALID',
      });
    });

    it('is checked after everything a person can usefully correct', () => {
      // The age refusal ends the sign-up, so it must not be reachable by
      // somebody who merely mistyped their email.
      const plan = planSignUp(
        form({ email: 'not-an-email', birth: { day: '1', month: '1', year: '2020' } }),
      );

      expect(plan).toEqual({ ready: false, blocker: 'EMAIL_INVALID' });
    });
  });
});

describe('composeBirthDate', () => {
  it('pads single-digit parts', () => {
    expect(composeBirthDate({ day: '5', month: '3', year: '1990' })).toBe('1990-03-05');
  });

  it('requires a four-digit year, so 90 is not 1990 or 2090', () => {
    expect(composeBirthDate({ day: '5', month: '3', year: '90' })).toBeNull();
  });

  it('returns null for anything that is not a real date', () => {
    for (const parts of [
      { day: '32', month: '1', year: '1990' },
      { day: '1', month: '13', year: '1990' },
      { day: 'x', month: '1', year: '1990' },
      { day: '', month: '', year: '' },
    ]) {
      expect(composeBirthDate(parts), JSON.stringify(parts)).toBeNull();
    }
  });
});

describe('describeBlocker', () => {
  it('never names the age threshold or invites another attempt', () => {
    const message = describeBlocker('AGE_BELOW_MINIMUM', '');

    // A screen that says "you must be 13" collects the number 13.
    expect(message).not.toMatch(/\d/u);
    expect(message.toLowerCase()).not.toContain('try again');
    expect(message.toLowerCase()).not.toContain('older');
  });

  it('says what is actually wrong with a weak password', () => {
    expect(describeBlocker('PASSWORD_WEAK', 'short')).toContain('at least 12 characters');
  });
});

describe('unmetPasswordRules', () => {
  it('is empty for a password the pool would accept', () => {
    expect(unmetPasswordRules('Sufficient1Password!')).toEqual([]);
  });

  it('names every unmet rule, not just the first', () => {
    expect(unmetPasswordRules('short').length).toBeGreaterThan(1);
  });
});
