import { useRouter } from 'expo-router';
import { useCallback, useState } from 'react';

import {
  Body,
  Button,
  Callout,
  Caption,
  Field,
  Screen,
  Stack,
  Subtitle,
  Title,
} from '@/components/ui';
import { submitMfaCode } from '@/features/auth/api';
import { establishSession } from '@/features/auth/establish-session';
import { ROUTES } from '@/features/auth/routing';
import { useSessionStore } from '@/features/auth/session-store';
import { useSession } from '@/features/auth/use-session';
import { describeError } from '@/lib/api';

/**
 * The second factor: a TOTP code from an authenticator app.
 *
 * ---------------------------------------------------------------------------
 * THIS SCREEN IS ALLOWED TO BE SPECIFIC
 * ---------------------------------------------------------------------------
 * Everywhere else on the auth surface, a failure is deliberately vague, because
 * a precise one would answer "does this address have an account". Here the
 * password has already been proved, so "that code is not right" discloses
 * nothing the caller did not already know — which is exactly what
 * `cognito/errors.ts` encodes by mapping `CodeMismatchException` to its own
 * message instead of the collapsed credential one. This screen surfaces that
 * message as-is.
 *
 * ---------------------------------------------------------------------------
 * PINNED, BUT NOT TRAPPED
 * ---------------------------------------------------------------------------
 * Routing rule 3 pins a person here while a challenge is outstanding: a
 * challenge is an incomplete sign-in, not a session, and there is no way to
 * skip it. The escape hatch is to abandon the attempt, which is what "Cancel
 * and sign in again" does — `clearChallenge()` drops the store all the way to
 * unauthenticated, and this screen then navigates itself back to sign-in,
 * because rule 2 would leave an unauthenticated person sitting right here.
 *
 * There is no resend. A time-based code is generated on the user's own device
 * and rotates on its own, so there is nothing for us to send — which is why
 * `PendingChallenge.resendAvailableAt` is set equal to `expiresAt` upstream.
 */

const DIGITS_ONLY = /^\d+$/u;

export default function MfaChallengeScreen() {
  const router = useRouter();
  const { challenge } = useSession();
  const setChallenge = useSessionStore((state) => state.setChallenge);
  const clearChallenge = useSessionStore((state) => state.clearChallenge);

  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const abandon = useCallback(() => {
    clearChallenge();
    router.replace(ROUTES.signIn);
  }, [clearChallenge, router]);

  const submit = useCallback(async () => {
    if (busy || challenge === null) return;
    setError(null);

    const entered = code.trim();
    if (entered.length !== challenge.codeLength || !DIGITS_ONLY.test(entered)) {
      setError(`Enter the ${challenge.codeLength}-digit code from your authenticator app.`);
      return;
    }

    // The expiry was computed from this device's own clock when the challenge
    // was issued, so comparing against it here cannot be thrown off by skew.
    // Checking first turns a guaranteed rejection into a clear instruction.
    if (Date.parse(challenge.expiresAt) <= Date.now()) {
      setError(
        'This sign-in took too long. Start again and we will ask for your code straight away.',
      );
      return;
    }

    setBusy(true);
    try {
      const outcome = await submitMfaCode(challenge, entered);
      if (outcome.kind === 'session') {
        // No navigation: where a signed-in person belongs depends on consent,
        // family membership and onboarding progress, which the guard reads from
        // the account snapshot (routing rules 4-6).
        await establishSession(outcome.session);
        return;
      }
      // Cognito answered a challenge with another challenge. Carry the new one
      // rather than reusing a session id that is now spent.
      setChallenge(outcome.challenge);
      setCode('');
      setError('That code was not accepted. Enter the next one from your authenticator app.');
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  }, [busy, challenge, code, setChallenge]);

  // The store was cleared underneath us, or the app restarted mid-challenge:
  // the challenge session is memory-only and never written to the keychain.
  if (challenge === null) {
    return (
      <Screen
        footer={
          <Button
            accessibilityHint="Opens the sign-in screen."
            label="Back to sign in"
            onPress={abandon}
            testID="mfa-challenge-back"
          />
        }
        testID="mfa-challenge-empty"
      >
        <Stack gap="three">
          <Title>There is no sign-in to finish</Title>
          <Body>
            This step is only held while you are signing in, and it is never stored on this device.
            Sign in again and we will ask for your code straight away.
          </Body>
        </Stack>
      </Screen>
    );
  }

  return (
    <Screen
      footer={
        <Stack gap="two">
          <Button
            accessibilityHint="Finishes signing you in. Your location is not shared until you turn sharing on."
            busy={busy}
            label="Confirm code"
            onPress={() => {
              void submit();
            }}
            testID="mfa-challenge-submit"
          />
          <Button
            accessibilityHint="Abandons this sign-in and returns to the sign-in screen."
            label="Cancel and sign in again"
            onPress={abandon}
            testID="mfa-challenge-cancel"
            variant="ghost"
          />
        </Stack>
      }
      testID="mfa-challenge"
    >
      <Stack gap="three">
        <Title>Enter your authenticator code</Title>
        <Subtitle>
          Signing in as {challenge.maskedIdentifier}. Open your authenticator app and enter the
          current {challenge.codeLength}-digit code for Kinmap.
        </Subtitle>

        {error !== null ? (
          <Callout
            testID="mfa-challenge-error"
            title="We could not finish signing you in"
            tone="danger"
          >
            {error}
          </Callout>
        ) : null}

        <Field
          autoComplete="one-time-code"
          autoCorrect={false}
          helper="The code your authenticator app is showing right now."
          inputMode="numeric"
          keyboardType="number-pad"
          label="Authenticator code"
          maxLength={challenge.codeLength}
          onChangeText={setCode}
          onSubmitEditing={() => {
            void submit();
          }}
          returnKeyType="go"
          testID="mfa-challenge-code"
          textContentType="oneTimeCode"
          value={code}
        />

        <Caption>
          Codes are generated on your own device and change every few seconds, so there is nothing
          for us to resend. If you have lost your authenticator app, cancel and use “Forgot your
          password?” on the sign-in screen to recover your account.
        </Caption>

        <Body>
          You are not signed in yet, and nothing about your location is being shared while this step
          is outstanding.
        </Body>
      </Stack>
    </Screen>
  );
}
