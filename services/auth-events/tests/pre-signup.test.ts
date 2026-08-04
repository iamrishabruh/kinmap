import { beforeEach, describe, expect, it } from 'vitest';

import { AppError } from '@family/contracts';

import { PRE_SIGN_UP_SOURCES } from '../src/events.js';
import { readTermsAcceptance } from '../src/triggers/pre-signup.js';

import {
  createHarness,
  currentAcceptance,
  preSignUpEvent,
  PRIVACY_VERSION,
  TERMS_VERSION,
  type Harness,
} from './support/harness.js';

/**
 * Pre sign-up is the gate on account creation. It has exactly three jobs, and
 * all of them are the kind that fail silently if nobody checks: refusing an
 * account with no current consent, refusing one below the minimum age, and
 * never auto-confirming one.
 */

describe('preSignUp', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness();
  });

  it('rejects a sign-up with no acceptance at all', async () => {
    await expect(harness.handle(preSignUpEvent({}))).rejects.toMatchObject({
      code: 'TERMS_ACCEPTANCE_REQUIRED',
    });
  });

  it('rejects an acceptance of a superseded terms version', async () => {
    const event = preSignUpEvent({
      validationData: { termsVersion: '2025-01-01', privacyPolicyVersion: PRIVACY_VERSION },
    });

    await expect(harness.handle(event)).rejects.toBeInstanceOf(AppError);
  });

  it('rejects an acceptance of a superseded privacy policy version', async () => {
    const event = preSignUpEvent({
      validationData: { termsVersion: TERMS_VERSION, privacyPolicyVersion: '2025-01-01' },
    });

    await expect(harness.handle(event)).rejects.toBeInstanceOf(AppError);
  });

  it('rejects an acceptance that names only one of the two documents', async () => {
    const event = preSignUpEvent({ validationData: { termsVersion: TERMS_VERSION } });

    await expect(harness.handle(event)).rejects.toBeInstanceOf(AppError);
  });

  it('accepts a current acceptance and does not auto-confirm', async () => {
    const event = preSignUpEvent({ validationData: currentAcceptance() });

    const result = await harness.handle(event);

    expect(result.response).toEqual({
      autoConfirmUser: false,
      autoVerifyEmail: false,
      autoVerifyPhone: false,
    });
  });

  it('never auto-confirms on any trigger source', async () => {
    for (const triggerSource of PRE_SIGN_UP_SOURCES) {
      const result = await harness.handle(
        preSignUpEvent({ triggerSource, validationData: currentAcceptance() }),
      );

      expect(result.response).toMatchObject({
        autoConfirmUser: false,
        autoVerifyEmail: false,
        autoVerifyPhone: false,
      });
    }
  });

  it('accepts the acceptance from clientMetadata when validationData is absent', async () => {
    const result = await harness.handle(preSignUpEvent({ clientMetadata: currentAcceptance() }));

    expect(result.response).toMatchObject({ autoConfirmUser: false });
  });

  it('does not create any record', async () => {
    await harness.handle(preSignUpEvent({ validationData: currentAcceptance() }));

    // The profile is created after confirmation, never before it.
    expect(harness.store.size('Users')).toBe(0);
  });
});

describe('the age gate', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness();
  });

  const withBirthDate = (birthDate: string | null) => {
    const data: Record<string, string> = {
      termsVersion: TERMS_VERSION,
      privacyPolicyVersion: PRIVACY_VERSION,
    };
    if (birthDate !== null) data['birthDate'] = birthDate;
    return preSignUpEvent({ validationData: data });
  };

  it('refuses an account when no date of birth is attested at all', async () => {
    // A client that omits the field is either out of date or calling Cognito's
    // public SignUp API directly, and neither is a reason to create an account.
    await expect(harness.handle(withBirthDate(null))).rejects.toMatchObject({
      code: 'AGE_REQUIREMENT_NOT_MET',
    });
  });

  it('refuses a self-attested age below the minimum', async () => {
    const twelve = new Date();
    twelve.setUTCFullYear(twelve.getUTCFullYear() - 12);

    await expect(
      harness.handle(withBirthDate(twelve.toISOString().slice(0, 10))),
    ).rejects.toMatchObject({ code: 'AGE_REQUIREMENT_NOT_MET' });
  });

  it('refuses a date that is not a real date rather than coercing it', async () => {
    for (const value of ['2011-02-30', 'not-a-date', '2011-2-3', '']) {
      await expect(harness.handle(withBirthDate(value)), value).rejects.toMatchObject({
        code: 'AGE_REQUIREMENT_NOT_MET',
      });
    }
  });

  it('refuses a birth date in the future', async () => {
    const future = new Date();
    future.setUTCFullYear(future.getUTCFullYear() + 1);

    await expect(
      harness.handle(withBirthDate(future.toISOString().slice(0, 10))),
    ).rejects.toMatchObject({ code: 'AGE_REQUIREMENT_NOT_MET' });
  });

  it('admits a teenager above the minimum', async () => {
    const fifteen = new Date();
    fifteen.setUTCFullYear(fifteen.getUTCFullYear() - 15);

    const result = await harness.handle(withBirthDate(fifteen.toISOString().slice(0, 10)));

    expect(result.response).toMatchObject({ autoConfirmUser: false });
  });

  it('says the same thing however the gate was failed', async () => {
    // Distinguishing "too young" from "no date" tells a caller which part to
    // vary, and the only thing to learn from a specific answer is which date
    // gets through.
    const messages: string[] = [];
    for (const value of [null, '2020-01-01', 'not-a-date']) {
      const error = await harness.handle(withBirthDate(value)).catch((thrown: unknown) => thrown);
      messages.push(error instanceof AppError ? error.message : String(error));
    }

    expect(new Set(messages).size).toBe(1);
  });

  it('never writes the attested date anywhere', async () => {
    const event = withBirthDate('1990-06-15');
    const result = await harness.handle(event);

    // The trigger compares and discards. A date of birth is a strong
    // identifier, and combined with location history a much stronger one.
    expect(JSON.stringify(result.response)).not.toContain('1990');
    expect(harness.store.size('Users')).toBe(0);
  });
});

describe('readTermsAcceptance', () => {
  it('prefers validationData over clientMetadata', () => {
    const acceptance = readTermsAcceptance(
      { termsVersion: 'from-validation' },
      { termsVersion: 'from-metadata', privacyPolicyVersion: 'p' },
    );

    expect(acceptance).toEqual({
      termsVersion: 'from-validation',
      privacyPolicyVersion: 'p',
    });
  });

  it('accepts the snake_case spelling as an alias', () => {
    const acceptance = readTermsAcceptance(
      { terms_version: 't', privacy_policy_version: 'p' },
      null,
    );

    expect(acceptance).toEqual({ termsVersion: 't', privacyPolicyVersion: 'p' });
  });

  it('treats a blank value as absent', () => {
    expect(readTermsAcceptance({ termsVersion: '   ' }, null)).toEqual({
      termsVersion: null,
      privacyPolicyVersion: null,
    });
  });
});
