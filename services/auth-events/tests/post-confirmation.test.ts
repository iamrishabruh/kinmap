import { beforeEach, describe, expect, it } from 'vitest';

import { AppError } from '@family/contracts';

import { PLACEHOLDER_DISPLAY_NAME } from '../src/profile.js';
import { EMAIL_CLAIM_PREFIX } from '../src/users-repository.js';

import {
  createHarness,
  postConfirmationEvent,
  testUuid,
  PRIVACY_VERSION,
  TERMS_VERSION,
  type Harness,
} from './support/harness.js';

/**
 * Post confirmation provisions the application profile. Cognito retries
 * triggers, so "runs twice" is the normal case rather than the edge case, and
 * the assertions below are mostly about that.
 */

const subject = testUuid(1);

describe('postConfirmation', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness();
  });

  it('creates a profile with the accepted policy versions recorded', async () => {
    await harness.handle(
      postConfirmationEvent({
        userAttributes: {
          sub: subject,
          email: 'Person@Example.test',
          email_verified: 'true',
          name: 'Alex Doe',
        },
      }),
    );

    const profile = harness.store.dump('Users').find((item) => item['userId'] === subject);

    expect(profile).toMatchObject({
      userId: subject,
      displayName: 'Alex Doe',
      displayNameIsPlaceholder: false,
      // Normalised on the way in, so a case-different address is the same one.
      email: 'person@example.test',
      emailVerified: true,
      status: 'ACTIVE',
      // A new account shares with nobody until somebody turns it on.
      sharingStatus: 'NEVER_ENABLED',
      acceptedTermsVersion: TERMS_VERSION,
      acceptedPrivacyPolicyVersion: PRIVACY_VERSION,
    });
  });

  it('indexes a keyed digest rather than the address', async () => {
    await harness.handle(
      postConfirmationEvent({
        userAttributes: { sub: subject, email: 'person@example.test', email_verified: 'true' },
      }),
    );

    const profile = harness.store.dump('Users').find((item) => item['userId'] === subject);
    const emailHash = profile?.['emailHash'];

    expect(typeof emailHash).toBe('string');
    expect(emailHash).not.toContain('person@example.test');
    expect(emailHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('claims the address so a second account cannot take it', async () => {
    await harness.handle(
      postConfirmationEvent({
        userAttributes: { sub: subject, email: 'person@example.test', email_verified: 'true' },
      }),
    );

    const claims = harness.store
      .dump('Users')
      .filter((item) => String(item['userId']).startsWith(EMAIL_CLAIM_PREFIX));

    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ ownerUserId: subject });
    // The claim must not appear in the byEmailHash index next to a real profile.
    expect(claims[0]).not.toHaveProperty('emailHash');
  });

  it('is idempotent when Cognito retries the same confirmation', async () => {
    const event = postConfirmationEvent({
      userAttributes: { sub: subject, email: 'person@example.test', email_verified: 'true' },
    });

    await harness.handle(event);
    await harness.handle(event);
    await harness.handle(event);

    // One profile and one claim, no matter how many deliveries.
    expect(harness.store.size('Users')).toBe(2);
    const outcomes = harness.logs
      .filter((record) => record['message'] === 'profile_provisioned')
      .map((record) => record['outcome']);
    expect(outcomes).toEqual(['CREATED', 'ALREADY_EXISTS', 'ALREADY_EXISTS']);
  });

  it('does not overwrite an existing profile on retry', async () => {
    await harness.handle(
      postConfirmationEvent({
        userAttributes: { sub: subject, email: 'person@example.test', name: 'Alex Doe' },
      }),
    );

    await harness.handle(
      postConfirmationEvent({
        userAttributes: { sub: subject, email: 'person@example.test', name: 'Someone Else' },
      }),
    );

    const profile = harness.store.dump('Users').find((item) => item['userId'] === subject);
    expect(profile).toMatchObject({ displayName: 'Alex Doe' });
  });

  it('refuses to attach an address that another account already claimed', async () => {
    await harness.handle(
      postConfirmationEvent({
        userAttributes: { sub: subject, email: 'person@example.test', email_verified: 'true' },
      }),
    );

    const impostor = postConfirmationEvent({
      userAttributes: { sub: testUuid(2), email: 'person@example.test', email_verified: 'true' },
    });

    await expect(harness.handle(impostor)).rejects.toMatchObject({ code: 'CONFLICT' });
    // The transaction is all-or-nothing: no half-created second profile.
    expect(
      harness.store.dump('Users').find((item) => item['userId'] === testUuid(2)),
    ).toBeUndefined();
  });

  it('handles a Sign in with Apple private relay address', async () => {
    await harness.handle(
      postConfirmationEvent({
        userName: 'SignInWithApple_001234.abcdef',
        userAttributes: {
          sub: subject,
          email: 'a1b2c3d4@privaterelay.appleid.com',
          email_verified: 'true',
          identities: JSON.stringify([
            { providerName: 'SignInWithApple', userId: '001234.abcdef' },
          ]),
        },
      }),
    );

    const profile = harness.store.dump('Users').find((item) => item['userId'] === subject);
    expect(profile).toMatchObject({
      isPrivateRelayEmail: true,
      identityProvider: 'APPLE',
      email: 'a1b2c3d4@privaterelay.appleid.com',
    });
  });

  it('uses a neutral placeholder when Apple supplies no name', async () => {
    await harness.handle(
      postConfirmationEvent({
        userName: 'SignInWithApple_001234.abcdef',
        userAttributes: {
          sub: subject,
          email: 'a1b2c3d4@privaterelay.appleid.com',
          email_verified: 'true',
        },
      }),
    );

    const profile = harness.store.dump('Users').find((item) => item['userId'] === subject);
    expect(profile).toMatchObject({
      displayName: PLACEHOLDER_DISPLAY_NAME,
      displayNameIsPlaceholder: true,
    });
    // The address is never used to invent a name for other members to see.
    expect(profile?.['displayName']).not.toContain('a1b2c3d4');
  });

  it('composes a name from given and family names when there is no full name', async () => {
    await harness.handle(
      postConfirmationEvent({
        userAttributes: {
          sub: subject,
          email: 'person@example.test',
          given_name: 'Alex',
          family_name: 'Doe',
        },
      }),
    );

    const profile = harness.store.dump('Users').find((item) => item['userId'] === subject);
    expect(profile).toMatchObject({ displayName: 'Alex Doe', displayNameIsPlaceholder: false });
  });

  it('creates a profile for a user with no address at all', async () => {
    await harness.handle(postConfirmationEvent({ userAttributes: { sub: subject } }));

    expect(harness.store.size('Users')).toBe(1);
    const profile = harness.store.dump('Users')[0];
    expect(profile).toMatchObject({ email: null, emailHash: null, isPrivateRelayEmail: false });
  });

  it('fails when the confirmed user has no usable subject', async () => {
    await expect(
      harness.handle(postConfirmationEvent({ userAttributes: { email: 'person@example.test' } })),
    ).rejects.toThrow(/no usable identifier/);
    expect(harness.store.size('Users')).toBe(0);
  });

  it('keeps the address and the name out of the log line', async () => {
    await harness.handle(
      postConfirmationEvent({
        userAttributes: { sub: subject, email: 'person@example.test', name: 'Alex Doe' },
      }),
    );

    const serialised = JSON.stringify(harness.logs);
    expect(serialised).not.toContain('person@example.test');
    expect(serialised).not.toContain('Alex Doe');
  });

  it('provisions on a forgot-password confirmation without duplicating', async () => {
    const attributes = { sub: subject, email: 'person@example.test', email_verified: 'true' };
    await harness.handle(postConfirmationEvent({ userAttributes: attributes }));

    await harness.handle(
      postConfirmationEvent({
        triggerSource: 'PostConfirmation_ConfirmForgotPassword',
        userAttributes: attributes,
      }),
    );

    expect(harness.store.dump('Users').filter((item) => item['userId'] === subject)).toHaveLength(
      1,
    );
  });
});

describe('AppError surfaces to Cognito', () => {
  it('carries a user-safe message and nothing else', async () => {
    const harness = createHarness();
    await harness.handle(
      postConfirmationEvent({
        userAttributes: { sub: subject, email: 'person@example.test', email_verified: 'true' },
      }),
    );

    const failure: AppError = await harness
      .handle(
        postConfirmationEvent({
          userAttributes: { sub: testUuid(3), email: 'person@example.test' },
        }),
      )
      .then(
        () => {
          throw new Error('Expected the second confirmation to be refused.');
        },
        (error: unknown) => error as AppError,
      );

    expect(failure).toBeInstanceOf(AppError);
    expect(failure.message).toBe('That email address is already in use.');
  });
});
