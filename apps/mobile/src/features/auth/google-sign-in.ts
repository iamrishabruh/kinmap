import {
  GoogleSignin,
  isErrorWithCode,
  isSuccessResponse,
  statusCodes,
} from '@react-native-google-signin/google-signin';
import { Platform } from 'react-native';

import { hasEnv, requireEnv } from '@/config/env';

import { createNoncePair } from './nonce';
import {
  SocialSignInCancelledError,
  SocialSignInUnavailableError,
  type SocialCredential,
} from './types';

/**
 * Google sign-in.
 *
 * TWO CLIENT IDS, BOTH REQUIRED. `iosClientId` is the native iOS OAuth client
 * that presents the sheet; `webClientId` is the client the ID token is issued
 * *for* (its `aud` claim), and is what the backend validates against. Android
 * has no separate id in `configure()` — its client is resolved from the signing
 * certificate — but it still needs `webClientId` to receive an ID token at all.
 * Omitting `webClientId` yields a sign-in that appears to work and produces a
 * token the server will always reject, so both are required on both platforms.
 */

let configured = false;

export function isGoogleSignInConfigured(): boolean {
  return hasEnv('googleWebClientId') && (Platform.OS !== 'ios' || hasEnv('googleIosClientId'));
}

function configureOnce(): void {
  if (configured) return;
  GoogleSignin.configure({
    webClientId: requireEnv('googleWebClientId'),
    ...(Platform.OS === 'ios' ? { iosClientId: requireEnv('googleIosClientId') } : {}),
    // Only what an account needs. No Drive, no contacts, no calendar — a
    // location app asking for extra Google scopes would be indefensible.
    scopes: ['openid', 'email', 'profile'],
    // We never act on the user's behalf against Google APIs, so we do not want
    // a refresh token and do not ask for offline access.
    offlineAccess: false,
  });
  configured = true;
}

/** Test seam. */
export function resetGoogleSignInConfiguration(): void {
  configured = false;
}

export async function signInWithGoogle(): Promise<SocialCredential> {
  if (!isGoogleSignInConfigured()) {
    throw new SocialSignInUnavailableError(
      'GOOGLE',
      'Google sign-in is not configured in this build.',
    );
  }

  configureOnce();

  if (Platform.OS === 'android') {
    try {
      await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
    } catch {
      throw new SocialSignInUnavailableError(
        'GOOGLE',
        'Google Play services is unavailable or out of date on this device.',
      );
    }
  }

  // The Google Sign-In SDK does not let us set the ID token's `nonce` claim, so
  // this nonce binds the request to our own endpoint rather than to the token:
  // the server records it against the sign-in attempt and rejects a replay.
  // Token authenticity itself is established by signature and audience checks
  // against `webClientId`, server-side.
  const nonce = await createNoncePair();

  try {
    const response = await GoogleSignin.signIn();

    if (!isSuccessResponse(response)) {
      throw new SocialSignInCancelledError('GOOGLE');
    }

    const idToken = response.data.idToken;
    if (typeof idToken !== 'string' || idToken.length === 0) {
      throw new SocialSignInUnavailableError(
        'GOOGLE',
        'Google did not return a sign-in token. Please try again.',
      );
    }

    const givenName = response.data.user.name ?? null;

    return {
      provider: 'GOOGLE',
      identityToken: idToken,
      authorizationCode: response.data.serverAuthCode ?? null,
      nonce: nonce.raw,
      displayName: givenName === null ? null : givenName.trim().slice(0, 80) || null,
      // Google has no equivalent of Hide My Email; the address is real.
      isPrivateRelayEmail: false,
    };
  } catch (cause) {
    if (
      cause instanceof SocialSignInCancelledError ||
      cause instanceof SocialSignInUnavailableError
    ) {
      throw cause;
    }
    if (isErrorWithCode(cause)) {
      switch (cause.code) {
        case statusCodes.SIGN_IN_CANCELLED:
          throw new SocialSignInCancelledError('GOOGLE');
        case statusCodes.IN_PROGRESS:
          throw new SocialSignInUnavailableError(
            'GOOGLE',
            'A Google sign-in is already in progress.',
          );
        case statusCodes.PLAY_SERVICES_NOT_AVAILABLE:
          throw new SocialSignInUnavailableError(
            'GOOGLE',
            'Google Play services is unavailable or out of date on this device.',
          );
        default:
          break;
      }
    }
    throw new SocialSignInUnavailableError(
      'GOOGLE',
      'Google sign-in could not be completed. Please try again.',
    );
  }
}

/**
 * Clears the native Google session so the account chooser appears next time.
 * Called from sign-out: leaving the previous account silently selected on a
 * shared device is how the wrong person ends up in a family.
 */
export async function signOutFromGoogle(): Promise<void> {
  try {
    if (!configured) return;
    await GoogleSignin.signOut();
  } catch {
    // Non-fatal: our own session is already gone by this point.
  }
}
