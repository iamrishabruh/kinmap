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
 * Pre sign-up is the gate on account creation. It has exactly two jobs, and
 * both of them are the kind that fail silently if nobody checks: refusing an
 * account with no current consent, and never auto-confirming one.
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
