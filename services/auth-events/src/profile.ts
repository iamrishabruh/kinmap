import { createHmac } from 'node:crypto';

import { IdentitySubjectSchema, type UserId } from '@family/contracts';

import type { UserAttributes } from './events.js';

/**
 * Building an application profile out of whatever the identity provider gave us.
 *
 * Two cases drive the shape of this module:
 *
 *  - **Sign in with Apple private relay.** The address is a real, deliverable
 *    `@privaterelay.appleid.com` mailbox, but its local part is random and it
 *    can be switched off by the user at any time. It is stored and flagged, and
 *    it is never used to derive anything a human sees.
 *  - **Apple supplies no name.** Apple returns a name only on the very first
 *    authorisation, so a returning user — or one who declined to share it —
 *    arrives with nothing. The profile gets a neutral placeholder and a flag so
 *    onboarding can ask, rather than a name derived from the email address:
 *    the local part of somebody's address is not something to show their family.
 */

export const PRIVATE_RELAY_DOMAIN = '@privaterelay.appleid.com';

/** Deliberately generic. Never derived from an email address or a username. */
export const PLACEHOLDER_DISPLAY_NAME = 'Family member';

export const IDENTITY_PROVIDERS = ['COGNITO', 'APPLE', 'GOOGLE', 'OTHER'] as const;
export type IdentityProvider = (typeof IDENTITY_PROVIDERS)[number];

export type UserProfileRecord = {
  readonly userId: UserId;
  readonly displayName: string;
  /** True while the name is the placeholder, so onboarding knows to ask. */
  readonly displayNameIsPlaceholder: boolean;
  readonly avatarUrl: null;
  readonly email: string | null;
  readonly emailVerified: boolean;
  /** Keyed digest backing the `byEmailHash` index; never the address itself. */
  readonly emailHash: string | null;
  readonly isPrivateRelayEmail: boolean;
  readonly phoneNumber: null;
  readonly locale: string;
  readonly timeZone: string;
  readonly status: 'ACTIVE';
  readonly identityProvider: IdentityProvider;
  readonly acceptedTermsVersion: string | null;
  readonly acceptedPrivacyPolicyVersion: string | null;
  readonly sharingStatus: 'NEVER_ENABLED';
  readonly sharingPausedUntil: null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly scheduledPurgeAt: null;
};

export function isPrivateRelayEmail(email: string | null): boolean {
  return email !== null && email.toLowerCase().endsWith(PRIVATE_RELAY_DOMAIN);
}

/**
 * Normalises then keys the address. HMAC rather than a bare digest: a plain
 * SHA-256 of an email address is trivially reversed from a wordlist, and this
 * value sits in a global secondary index.
 */
export function hashEmail(email: string | null, secret: string): string | null {
  if (email === null || email.trim() === '') {
    return null;
  }
  return createHmac('sha256', secret).update(email.trim().toLowerCase(), 'utf8').digest('hex');
}

/**
 * Reads the provider out of the `identities` attribute Cognito writes when an
 * account is federated, falling back to the username prefix the hosted UI uses.
 */
export function resolveIdentityProvider(
  attributes: UserAttributes,
  userName: string,
): IdentityProvider {
  const identities = attributes['identities'];
  if (identities !== undefined && identities !== '') {
    const name = firstProviderName(identities);
    if (name !== null) {
      return normaliseProvider(name);
    }
  }
  const separator = userName.indexOf('_');
  if (separator > 0) {
    return normaliseProvider(userName.slice(0, separator));
  }
  return 'COGNITO';
}

function firstProviderName(identities: string): string | null {
  try {
    const parsed: unknown = JSON.parse(identities);
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    const first = entries[0];
    if (first !== null && typeof first === 'object') {
      const providerName = (first as { providerName?: unknown }).providerName;
      if (typeof providerName === 'string' && providerName !== '') {
        return providerName;
      }
    }
    return null;
  } catch {
    // A malformed attribute is not worth failing a sign-up over; the username
    // prefix is checked next and the provider is metadata either way.
    return null;
  }
}

function normaliseProvider(name: string): IdentityProvider {
  const upper = name.toUpperCase();
  if (upper === 'SIGNINWITHAPPLE' || upper === 'APPLE') {
    return 'APPLE';
  }
  if (upper === 'GOOGLE') {
    return 'GOOGLE';
  }
  if (upper === 'COGNITO') {
    return 'COGNITO';
  }
  return 'OTHER';
}

/** Trims and rejects a name that is only whitespace or a bare placeholder. */
export function resolveDisplayName(candidates: ReadonlyArray<string | undefined>): {
  displayName: string;
  isPlaceholder: boolean;
} {
  for (const candidate of candidates) {
    const trimmed = candidate?.trim() ?? '';
    if (trimmed !== '') {
      return { displayName: trimmed.slice(0, 80), isPlaceholder: false };
    }
  }
  return { displayName: PLACEHOLDER_DISPLAY_NAME, isPlaceholder: true };
}

export type BuildProfileInput = {
  readonly attributes: UserAttributes;
  readonly userName: string;
  readonly emailHashSecret: string;
  readonly termsVersion: string | null;
  readonly privacyPolicyVersion: string | null;
  readonly now: Date;
};

export class InvalidPrincipalError extends Error {
  constructor() {
    super('The confirmed user has no usable identifier.');
    this.name = 'InvalidPrincipalError';
  }
}

export function buildUserProfile(input: BuildProfileInput): UserProfileRecord {
  const subject = IdentitySubjectSchema.safeParse(input.attributes['sub']);
  if (!subject.success) {
    // Without a stable subject there is no key to write. Failing here is right:
    // a profile written under a guessed id is worse than no profile.
    throw new InvalidPrincipalError();
  }

  const email = normaliseEmail(input.attributes['email']);
  const { displayName, isPlaceholder } = resolveDisplayName([
    input.attributes['name'],
    joinNames(input.attributes['given_name'], input.attributes['family_name']),
    input.attributes['nickname'],
  ]);
  const timestamp = input.now.toISOString();

  return {
    userId: subject.data,
    displayName,
    displayNameIsPlaceholder: isPlaceholder,
    avatarUrl: null,
    email,
    emailVerified: input.attributes['email_verified'] === 'true',
    emailHash: hashEmail(email, input.emailHashSecret),
    isPrivateRelayEmail: isPrivateRelayEmail(email),
    phoneNumber: null,
    locale: normaliseLocale(input.attributes['locale']),
    timeZone: 'UTC',
    status: 'ACTIVE',
    identityProvider: resolveIdentityProvider(input.attributes, input.userName),
    acceptedTermsVersion: input.termsVersion,
    acceptedPrivacyPolicyVersion: input.privacyPolicyVersion,
    // A brand-new account shares with nobody until the user turns it on. There
    // is no state in which sharing is on before somebody chose it.
    sharingStatus: 'NEVER_ENABLED',
    sharingPausedUntil: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    scheduledPurgeAt: null,
  };
}

function normaliseEmail(email: string | undefined): string | null {
  const trimmed = email?.trim() ?? '';
  return trimmed === '' ? null : trimmed.toLowerCase();
}

function joinNames(given: string | undefined, family: string | undefined): string | undefined {
  const parts = [given?.trim(), family?.trim()].filter(
    (part): part is string => part !== undefined && part !== '',
  );
  return parts.length === 0 ? undefined : parts.join(' ');
}

/** Falls back to `en` rather than rejecting an unfamiliar tag at sign-up. */
function normaliseLocale(locale: string | undefined): string {
  const candidate = locale?.trim() ?? '';
  return /^[a-z]{2}(?:-[A-Z]{2})?$/.test(candidate) ? candidate : 'en';
}
