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
import { env } from '@/config/env';
import { confirmSignUp } from '@/features/auth/cognito/sign-up';
import { ROUTES } from '@/features/auth/routing';
import { describeError } from '@/lib/api';

import { useAuthFlow } from './_layout';

/**
 * Confirm a new account with the code Cognito emailed.
 *
 * ---------------------------------------------------------------------------
 * THE FAILURE IS ONE FAILURE, ON PURPOSE
 * ---------------------------------------------------------------------------
 * `confirmSignUp` already collapses everything except a rate limit onto a
 * single message: a wrong code and an address nobody ever registered come back
 * identically. That is not an oversight to smooth over with friendlier copy —
 * confirmation happens BEFORE anyone is authenticated, so a message that told
 * the two apart would let an unauthenticated caller ask "does this person have
 * a Kinmap account", which for a location product is asking whether there is
 * somewhere to look for them.
 *
 * So this screen never inspects the error. It renders exactly what
 * `describeError` gives it, into one error surface, and does not branch on the
 * code to change the wording, the screen, or what is offered next.
 *
 * The checks made BEFORE the call are about the code the user typed — six
 * digits or not — and say nothing about any account.
 */

/** Cognito's email confirmation codes are six digits. */
const CONFIRMATION_CODE_LENGTH = 6;

const SIX_DIGITS = /^\d{6}$/u;

export default function VerifyEmailScreen() {
  const router = useRouter();
  const { pendingVerification, abandonEmailVerification, confirmAccount } = useAuthFlow();

  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const email = pendingVerification?.email ?? null;

  const submit = useCallback(async () => {
    if (busy || email === null) return;
    setError(null);

    const entered = code.trim();
    if (!SIX_DIGITS.test(entered)) {
      setError(`Enter the ${CONFIRMATION_CODE_LENGTH}-digit code from the email.`);
      return;
    }

    setBusy(true);
    try {
      await confirmSignUp({
        email,
        code: entered,
        // Carried from sign-up so PostConfirmation can band it. See
        // `confirmSignUp` for why Cognito makes this the only way through.
        birthDate: pendingVerification?.birthDate,
      });
      confirmAccount(email);
      router.replace(ROUTES.signIn);
    } catch (cause) {
      // Not inspected. See the header.
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  }, [busy, code, confirmAccount, email, pendingVerification?.birthDate, router]);

  const startOver = useCallback(() => {
    abandonEmailVerification();
    router.replace(ROUTES.signUp);
  }, [abandonEmailVerification, router]);

  // A cold start, or a restored navigation state, can land here with nothing to
  // confirm: the address is held in memory for the length of one attempt and
  // deliberately never persisted. Say so plainly rather than rendering a form
  // that cannot work.
  if (pendingVerification === null) {
    return (
      <Screen
        footer={
          <Stack gap="two">
            <Button
              accessibilityHint="Opens the sign-in screen."
              label="Back to sign in"
              onPress={() => {
                router.replace(ROUTES.signIn);
              }}
              testID="verify-email-back-to-sign-in"
            />
            <Button
              accessibilityHint="Opens the screen for creating a new Kinmap account."
              label="Create an account"
              onPress={startOver}
              testID="verify-email-restart"
              variant="ghost"
            />
          </Stack>
        }
        testID="verify-email-empty"
      >
        <Stack gap="three">
          <Title>Nothing to confirm here</Title>
          <Body>
            This screen finishes a brand-new account, and there is no sign-up waiting on this device
            — usually because the app restarted after you signed up.
          </Body>
          <Body>
            Your email address is only kept while you are creating an account, and never written to
            this device, which is why it is not here to pick up again.
          </Body>
        </Stack>
      </Screen>
    );
  }

  const supportEmail = env.supportEmail;

  return (
    <Screen
      footer={
        <Stack gap="two">
          <Button
            accessibilityHint="Confirms your email address and finishes creating your account."
            busy={busy}
            label="Confirm email address"
            onPress={() => {
              void submit();
            }}
            testID="verify-email-submit"
          />
          <Button
            accessibilityHint="Discards this sign-up and returns to the account creation screen."
            label="Use a different email address"
            onPress={startOver}
            testID="verify-email-change-address"
            variant="ghost"
          />
        </Stack>
      }
      testID="verify-email"
    >
      <Stack gap="three">
        <Title>Confirm your email address</Title>
        <Subtitle>
          We sent a {CONFIRMATION_CODE_LENGTH}-digit code to {pendingVerification.codeSentTo}. Enter
          it to finish creating your account.
        </Subtitle>

        {error !== null ? (
          <Callout testID="verify-email-error" title="We could not confirm that" tone="danger">
            {error}
          </Callout>
        ) : null}

        <Field
          autoComplete="one-time-code"
          autoCorrect={false}
          helper="Six digits, from the email we just sent."
          inputMode="numeric"
          keyboardType="number-pad"
          label="Confirmation code"
          maxLength={CONFIRMATION_CODE_LENGTH}
          onChangeText={setCode}
          onSubmitEditing={() => {
            void submit();
          }}
          returnKeyType="go"
          testID="verify-email-code"
          textContentType="oneTimeCode"
          value={code}
        />

        <Callout testID="verify-email-no-resend" title="Cannot find the code?" tone="info">
          {`Codes usually arrive within a few minutes and sometimes land in your spam folder. Kinmap cannot send a replacement code from this screen yet.${
            supportEmail === undefined || supportEmail.length === 0
              ? ''
              : ` If this one never arrives, email ${supportEmail}.`
          }`}
        </Callout>

        <Caption>
          Confirming your email address does not share your location. Sharing is off until you turn
          it on, and you choose who can see you.
        </Caption>
      </Stack>
    </Screen>
  );
}
