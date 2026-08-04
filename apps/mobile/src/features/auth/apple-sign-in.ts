import * as AppleAuthentication from 'expo-apple-authentication';

import type { AuthSession } from '@family/schemas';

import { HostedSignInCancelledError, signInWithHostedProvider } from './cognito/hosted-ui';
import { SocialSignInCancelledError, SocialSignInUnavailableError } from './types';

/**
 * Sign in with Apple.
 *
 * WHERE THE APPLE CREDENTIAL WENT. This used to call
 * `AppleAuthentication.signInAsync` and post the resulting identity token to
 * `/v1/auth/oauth/apple`. That endpoint is gone and is not coming back, and the
 * token cannot simply be redirected at Cognito instead: a Cognito USER POOL has
 * no API that accepts a provider identity token. Federation into a user pool
 * happens only through the hosted UI's authorization-code grant, which is what
 * `identity-stack.ts` provisions — a `SignInWithApple` provider, the `kinmap://`
 * callback, and PKCE on a public client. So the exchange runs there, and this
 * module keeps the two Apple-specific facts that still matter.
 *
 * 1. THE NAME IS RETURNED EXACTLY ONCE. `fullName` is populated on the first
 *    authorisation for a given Apple ID and is `null` on every subsequent one,
 *    forever, unless the user removes the app from their Apple ID settings.
 *    Nothing downstream may depend on it being present — which is why the
 *    Cognito provider in `identity-stack.ts` maps only `sub` and `email`, and
 *    why the display name is asked for in the app, on a screen the user can
 *    return to, rather than captured from a one-shot value that a failed
 *    network call would destroy. There is no name to stash any more, and
 *    therefore no keychain entry keyed by an Apple user id to keep either.
 *
 * 2. THE EMAIL MAY BE A RELAY ADDRESS. With Hide My Email, the address Apple
 *    releases is an `@privaterelay.appleid.com` forwarder — also
 *    first-authorisation-only. It is a perfectly good account identifier, and
 *    the app never needs to know which kind it got: it does not send mail, and
 *    the one place the distinction would have changed the copy ("check your
 *    email") no longer exists, because Cognito owns verification and recovery.
 *    Treating a relay address as second-class is exactly the behaviour Apple
 *    forbids, so nothing here inspects it.
 *
 * The native module is still imported, for the one thing only it can answer:
 * whether this device can do Sign in with Apple at all. Asking it costs no
 * prompt and no user data.
 */

/**
 * Cognito's provider name for Sign in with Apple. Fixed by Cognito, and must
 * match `APPLE_PROVIDER_NAME` in `infrastructure/stacks/identity-stack.ts`.
 */
const APPLE_PROVIDER = 'SignInWithApple';

export async function isAppleSignInAvailable(): Promise<boolean> {
  try {
    return await AppleAuthentication.isAvailableAsync();
  } catch {
    return false;
  }
}

/**
 * Runs the whole Apple sign-in and returns a live Cognito session.
 *
 * @throws SocialSignInCancelledError   when the user dismisses the sheet.
 * @throws SocialSignInUnavailableError when the device cannot do it at all.
 * @throws AppError                     for network and service failures.
 */
export async function signInWithApple(): Promise<AuthSession> {
  if (!(await isAppleSignInAvailable())) {
    throw new SocialSignInUnavailableError(
      'APPLE',
      'Sign in with Apple is not available on this device.',
    );
  }

  try {
    return await signInWithHostedProvider(APPLE_PROVIDER);
  } catch (cause) {
    if (cause instanceof HostedSignInCancelledError) {
      throw new SocialSignInCancelledError('APPLE');
    }
    throw cause;
  }
}
