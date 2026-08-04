import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { TextInput } from 'react-native';

import { EmailSchema } from '@family/schemas';

import {
  Body,
  Button,
  Callout,
  Caption,
  Divider,
  Field,
  LinkButton,
  Screen,
  Stack,
  Subtitle,
  Title,
} from '@/components/ui';
import { signIn } from '@/features/auth/api';
import { isAppleSignInAvailable, signInWithApple } from '@/features/auth/apple-sign-in';
import { establishSession } from '@/features/auth/establish-session';
import { challengeRoute, ROUTES } from '@/features/auth/routing';
import { useSessionStore } from '@/features/auth/session-store';
import {
  SocialSignInCancelledError,
  SocialSignInUnavailableError,
  type SignOutReason,
} from '@/features/auth/types';
import { useLastSignOutReason } from '@/features/auth/use-session';
import { describeError } from '@/lib/api';

import { useAuthFlow } from './_layout';

/**
 * Sign in.
 *
 * ---------------------------------------------------------------------------
 * THIS SCREEN IS NOT AN ACCOUNT-EXISTENCE ORACLE
 * ---------------------------------------------------------------------------
 * `api.ts` explains why at length: for a location product, confirming that an
 * address has an account here is confirming that a named person can be found.
 * The pool, the error mapper and `signIn()` all collapse every credential-shaped
 * failure onto one fixed string, and this screen's only job is not to undo that.
 *
 * So there is exactly one error surface, it renders whatever `describeError`
 * returns, and nothing here branches on the failure to change the wording, the
 * screen, or which field is highlighted. The only checks made before the call
 * are about the *shape* of what was typed — an address that is not an address,
 * an empty password — which say nothing about any account.
 */

/**
 * Sign in with Apple is built and deliberately switched off.
 *
 * `identity-stack.ts` creates the `SignInWithApple` provider only when an Apple
 * secret ARN is supplied, and no environment has that secret yet, so the app
 * client's supported providers are Cognito alone. A live button would open the
 * hosted UI, Cognito would answer `invalid_request`, and the user would be shown
 * "Something went wrong on our side" — a button that always fails, blamed on us.
 *
 * It is rendered disabled with the reason next to it rather than hidden,
 * because someone who expects to sign in with Apple needs to be told that this
 * is not where their account is, not left wondering where the button went. It
 * is not rendered at all on a device that could never do Apple sign-in.
 *
 * Flipping this to `true` belongs in the same change that deploys the Apple
 * secret; `runAppleSignIn` below is the entire path and is already wired.
 * Annotated `boolean` rather than left as the literal `false` so that the
 * enabled branch stays type-checked.
 */
const APPLE_FEDERATION_CONFIGURED: boolean = false;

/**
 * Why the previous session ended, said once, on the screen the user was dropped
 * on. `USER_REQUESTED` is absent on purpose: they tapped sign out, they know.
 */
const SIGN_OUT_EXPLANATION: Partial<Record<SignOutReason, { title: string; message: string }>> = {
  SESSION_EXPIRED: {
    title: 'You were signed out',
    message:
      'Your session expired on this device, so Kinmap stopped sharing your location and signed you out. Sign in again to carry on.',
  },
  ACCOUNT_UNAVAILABLE: {
    title: 'You were signed out',
    message:
      'We could not use your account on this device, so Kinmap signed you out and stopped sharing your location. Sign in again, or contact support if this keeps happening.',
  },
};

export default function SignInScreen() {
  const router = useRouter();
  const { confirmedEmail, clearConfirmedEmail } = useAuthFlow();
  const setChallenge = useSessionStore((state) => state.setChallenge);
  const { reason: signOutReason, clear: clearSignOutReason } = useLastSignOutReason();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [revealPassword, setRevealPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [appleSupportedOnDevice, setAppleSupportedOnDevice] = useState(false);

  const passwordField = useRef<TextInput>(null);

  // Someone who has just confirmed their address should not have to type it
  // again. It came from this device, seconds ago, and never left memory.
  useEffect(() => {
    if (confirmedEmail !== null) {
      setEmail(confirmedEmail);
    }
  }, [confirmedEmail]);

  // Costs no prompt and reads no user data — it answers only "can this handset
  // do Sign in with Apple at all".
  useEffect(() => {
    let live = true;
    void isAppleSignInAvailable().then((available) => {
      if (live) setAppleSupportedOnDevice(available);
    });
    return () => {
      live = false;
    };
  }, []);

  const submit = useCallback(async () => {
    if (busy) return;
    setError(null);
    clearSignOutReason();
    clearConfirmedEmail();

    const address = email.trim();
    if (!EmailSchema.safeParse(address).success) {
      setError('Enter the email address you use for Kinmap.');
      return;
    }
    if (password.length === 0) {
      setError('Enter your password.');
      return;
    }

    setBusy(true);
    try {
      const outcome = await signIn({ kind: 'EMAIL', email: address }, password);

      if (outcome.kind === 'session') {
        // No navigation. Where a signed-in person belongs depends on their
        // consent state, their family membership and their onboarding progress
        // — none of which this screen can see. `establishSession` moves the
        // store, and the guard reads the account and decides (routing rules
        // 4-6).
        await establishSession(outcome.session);
        return;
      }

      // An incomplete sign-in is not a session. The destination comes from the
      // routing module's own `challengeRoute`, so this agrees with the guard
      // rather than competing with it.
      setChallenge(outcome.challenge);
      router.replace(challengeRoute(outcome.challenge));
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  }, [busy, clearConfirmedEmail, clearSignOutReason, email, password, router, setChallenge]);

  const runAppleSignIn = useCallback(async () => {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      await establishSession(await signInWithApple());
    } catch (cause) {
      if (cause instanceof SocialSignInCancelledError) {
        // Backing out of the sheet is a decision, not a failure.
        return;
      }
      setError(
        cause instanceof SocialSignInUnavailableError ? cause.message : describeError(cause),
      );
    } finally {
      setBusy(false);
    }
  }, [busy]);

  const signOutNotice = signOutReason === null ? undefined : SIGN_OUT_EXPLANATION[signOutReason];

  return (
    <Screen
      footer={
        <Stack gap="two">
          <Button
            accessibilityHint="Signs you in to Kinmap. Your location is not shared until you turn sharing on."
            busy={busy}
            label="Sign in"
            onPress={() => {
              void submit();
            }}
            testID="sign-in-submit"
          />
          <LinkButton
            accessibilityHint="Opens the screen for creating a new Kinmap account."
            label="New to Kinmap? Create an account"
            onPress={() => {
              router.push(ROUTES.signUp);
            }}
            testID="sign-in-create-account"
          />
        </Stack>
      }
      testID="sign-in"
    >
      <Stack gap="three">
        <Title>Sign in to Kinmap</Title>
        <Subtitle>
          Kinmap does not share your location with anyone until you turn sharing on, and signing in
          does not turn it on.
        </Subtitle>

        {signOutNotice ? (
          <Callout testID="sign-in-signed-out" title={signOutNotice.title} tone="warning">
            {signOutNotice.message}
          </Callout>
        ) : null}

        {confirmedEmail !== null ? (
          <Callout
            testID="sign-in-confirmed"
            title="Your email address is confirmed"
            tone="success"
          >
            Sign in to finish setting up your account.
          </Callout>
        ) : null}

        {error !== null ? (
          <Callout testID="sign-in-error" title="We could not sign you in" tone="danger">
            {error}
          </Callout>
        ) : null}

        <Field
          autoCapitalize="none"
          autoComplete="email"
          autoCorrect={false}
          inputMode="email"
          keyboardType="email-address"
          label="Email address"
          onChangeText={setEmail}
          onSubmitEditing={() => passwordField.current?.focus()}
          returnKeyType="next"
          testID="sign-in-email"
          textContentType="username"
          value={email}
        />

        <Field
          autoCapitalize="none"
          autoComplete="current-password"
          autoCorrect={false}
          label="Password"
          onChangeText={setPassword}
          onSubmitEditing={() => {
            void submit();
          }}
          ref={passwordField}
          returnKeyType="go"
          secureTextEntry={!revealPassword}
          testID="sign-in-password"
          textContentType="password"
          value={password}
        />

        <LinkButton
          accessibilityHint={
            revealPassword
              ? 'Hides your password again.'
              : 'Shows your password on screen so you can check it.'
          }
          label={revealPassword ? 'Hide password' : 'Show password'}
          onPress={() => {
            setRevealPassword((shown) => !shown);
          }}
          testID="sign-in-reveal-password"
        />

        <LinkButton
          accessibilityHint="Opens the screen for resetting a forgotten password."
          label="Forgot your password?"
          onPress={() => {
            router.push(ROUTES.forgotPassword);
          }}
          testID="sign-in-forgot-password"
        />

        {appleSupportedOnDevice ? (
          <>
            <Divider />
            <Button
              accessibilityHint={
                APPLE_FEDERATION_CONFIGURED
                  ? 'Opens Apple to sign you in, then returns to Kinmap.'
                  : 'Unavailable in this version of Kinmap. Sign in with your email address and password instead.'
              }
              disabled={!APPLE_FEDERATION_CONFIGURED}
              label="Sign in with Apple"
              onPress={() => {
                void runAppleSignIn();
              }}
              testID="sign-in-apple"
              variant="secondary"
            />
            {APPLE_FEDERATION_CONFIGURED ? null : (
              <Caption testID="sign-in-apple-unavailable">
                Sign in with Apple is not switched on yet, so this button does nothing for now.
                Kinmap accounts use an email address and a password. If you have not made one, use
                “Create an account” below.
              </Caption>
            )}
          </>
        ) : null}

        <Body>
          Kinmap is a location app, so we keep sign-in deliberately plain: no third-party trackers
          on this screen, and nothing about your device is recorded when you sign in.
        </Body>
      </Stack>
    </Screen>
  );
}
