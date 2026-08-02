import * as AppleAuthentication from 'expo-apple-authentication';
import * as SecureStore from 'expo-secure-store';

import { createNoncePair } from './nonce';
import {
  SocialSignInCancelledError,
  SocialSignInUnavailableError,
  type SocialCredential,
} from './types';

/**
 * Sign in with Apple.
 *
 * Two Apple-specific behaviours drive everything in this file.
 *
 * 1. THE NAME IS RETURNED EXACTLY ONCE. `fullName` is populated on the first
 *    authorisation for a given Apple ID and is `null` on every subsequent one,
 *    forever, unless the user removes the app from their Apple ID settings. If
 *    the first sign-in's network call fails after Apple handed us the name, the
 *    name is gone. So it is stashed in the keychain, keyed by Apple's stable
 *    user identifier, the moment we receive it, and only cleared once the
 *    server has acknowledged it.
 *
 * 2. THE EMAIL MAY BE A RELAY ADDRESS. With Hide My Email, `email` is an
 *    `@privaterelay.appleid.com` forwarder — also first-authorisation-only. It
 *    is a perfectly good account identifier, but "check your email" copy has to
 *    change, so the fact is surfaced on the credential rather than re-derived
 *    later from a string comparison buried in a screen.
 */

const APPLE_PRIVATE_RELAY_DOMAIN = '@privaterelay.appleid.com';

const NAME_STASH_PREFIX = 'family.auth.appleName.';
const STASH_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainService: 'family-location.auth',
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

/** Apple's user identifier is opaque, but it identifies a person: keep it out of logs. */
function stashKey(appleUserId: string): string {
  // SecureStore keys must be alphanumeric/._- ; Apple ids contain dots already.
  return `${NAME_STASH_PREFIX}${appleUserId.replace(/[^A-Za-z0-9._-]/g, '')}`;
}

function composeDisplayName(
  fullName: AppleAuthentication.AppleAuthenticationFullName | null,
): string | null {
  if (fullName === null) return null;
  const parts = [fullName.givenName, fullName.familyName].filter(
    (part): part is string => typeof part === 'string' && part.trim().length > 0,
  );
  if (parts.length === 0) return null;
  // DisplayNameSchema caps at 80 characters.
  return parts.join(' ').trim().slice(0, 80);
}

async function stashDisplayName(appleUserId: string, displayName: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(stashKey(appleUserId), displayName, STASH_OPTIONS);
  } catch {
    // Best effort. Worst case the user re-types their name in settings.
  }
}

async function recallDisplayName(appleUserId: string): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(stashKey(appleUserId), STASH_OPTIONS);
  } catch {
    return null;
  }
}

/**
 * Called once the server has accepted the credential. Until then the stash is
 * the only copy of a name Apple will never hand over again.
 */
export async function clearStashedAppleDisplayName(appleUserId: string): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(stashKey(appleUserId), STASH_OPTIONS);
  } catch {
    // Nothing actionable.
  }
}

export async function isAppleSignInAvailable(): Promise<boolean> {
  try {
    return await AppleAuthentication.isAvailableAsync();
  } catch {
    return false;
  }
}

export type AppleSignInResult = {
  credential: SocialCredential;
  /** Apple's stable user id, needed to clear the name stash after success. */
  appleUserId: string;
};

export async function signInWithApple(): Promise<AppleSignInResult> {
  if (!(await isAppleSignInAvailable())) {
    throw new SocialSignInUnavailableError(
      'APPLE',
      'Sign in with Apple is not available on this device.',
    );
  }

  const nonce = await createNoncePair();

  let credential: AppleAuthentication.AppleAuthenticationCredential;
  try {
    credential = await AppleAuthentication.signInAsync({
      requestedScopes: [
        AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
        AppleAuthentication.AppleAuthenticationScope.EMAIL,
      ],
      nonce: nonce.hashed,
    });
  } catch (cause) {
    if (isAppleCancellation(cause)) {
      throw new SocialSignInCancelledError('APPLE');
    }
    throw new SocialSignInUnavailableError(
      'APPLE',
      'Sign in with Apple could not be completed. Please try again.',
    );
  }

  if (credential.identityToken === null) {
    throw new SocialSignInUnavailableError(
      'APPLE',
      'Apple did not return a sign-in token. Please try again.',
    );
  }

  const appleUserId = credential.user;

  // First authorisation: capture the name before anything can fail.
  const freshName = composeDisplayName(credential.fullName);
  if (freshName !== null) {
    await stashDisplayName(appleUserId, freshName);
  }
  const displayName = freshName ?? (await recallDisplayName(appleUserId));

  const email = credential.email;
  const isPrivateRelayEmail =
    typeof email === 'string' && email.toLowerCase().endsWith(APPLE_PRIVATE_RELAY_DOMAIN);

  return {
    appleUserId,
    credential: {
      provider: 'APPLE',
      identityToken: credential.identityToken,
      authorizationCode: credential.authorizationCode,
      nonce: nonce.raw,
      displayName,
      isPrivateRelayEmail,
    },
  };
}

function isAppleCancellation(cause: unknown): boolean {
  return (
    typeof cause === 'object' &&
    cause !== null &&
    'code' in cause &&
    (cause as { code?: unknown }).code === 'ERR_REQUEST_CANCELED'
  );
}
