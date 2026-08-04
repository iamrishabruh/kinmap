import { useRouter } from 'expo-router';
import { useCallback, useState } from 'react';

import { EmailSchema } from '@family/schemas';

import { Body, Button, Callout, Field, LinkButton, Screen, Stack, Title } from '@/components/ui';
import { requestPasswordReset } from '@/features/auth/cognito/forgot-password';
import { ROUTES } from '@/features/auth/routing';
import { describeError } from '@/lib/api';

/**
 * "I have forgotten my password."
 *
 * The screen has one job and one hard rule: it must behave identically for an
 * address that has an account and an address that does not. Same wording, same
 * next screen, same everything. `cognito/forgot-password.ts` holds that property
 * up on the network side; this file must not undo it by, say, showing a
 * different message when the request fails.
 *
 * That is why the copy says "if that address has an account" rather than "we
 * have sent you a code", and why the reason is spelled out rather than hidden.
 * A person who is being looked for is entitled to know that this app will not
 * confirm to somebody else that they use it.
 */
export default function ForgotPasswordScreen() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [addressProblem, setAddressProblem] = useState<string | null>(null);
  const [requestProblem, setRequestProblem] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const submit = useCallback(() => {
    const address = email.trim();
    if (!EmailSchema.safeParse(address).success) {
      setAddressProblem('Enter the email address you use for Family Location.');
      return;
    }
    setAddressProblem(null);
    setRequestProblem(null);
    setSending(true);

    void (async () => {
      try {
        await requestPasswordReset({ email: address });
        // Push rather than replace: backing out of the code screen returns
        // here, which is where somebody who mistyped their address needs to be.
        router.push(ROUTES.resetPassword);
      } catch (cause) {
        // Only a rate limit or an unreachable network reaches this branch;
        // everything that could identify an account was already collapsed.
        setRequestProblem(describeError(cause));
      } finally {
        setSending(false);
      }
    })();
  }, [email, router]);

  return (
    <Screen
      footer={
        <Stack gap="two">
          <Button
            accessibilityHint="Emails a six-digit code to that address if it has an account."
            busy={sending}
            label="Email me a code"
            onPress={submit}
            testID="forgot-password-submit"
          />
          <LinkButton
            accessibilityHint="Returns to the sign-in screen without changing anything."
            label="Back to sign in"
            onPress={() => {
              router.replace(ROUTES.signIn);
            }}
            testID="forgot-password-back"
          />
        </Stack>
      }
      testID="forgot-password"
    >
      <Stack gap="three">
        <Title>Reset your password</Title>
        <Body>
          Enter the email address you use for Family Location. If it has an account, we will email a
          six-digit code you can use to set a new password.
        </Body>

        <Field
          autoCapitalize="none"
          autoComplete="email"
          autoCorrect={false}
          error={addressProblem}
          inputMode="email"
          keyboardType="email-address"
          label="Email address"
          onChangeText={(value) => {
            setEmail(value);
            setAddressProblem(null);
          }}
          onSubmitEditing={submit}
          returnKeyType="send"
          textContentType="username"
          value={email}
        />

        {requestProblem === null ? null : (
          <Callout testID="forgot-password-error" title="We could not send the code" tone="danger">
            {requestProblem}
          </Callout>
        )}

        <Callout title="Why we answer the same way for every address" tone="info">
          We never say whether an address has an account. Confirming that somebody uses Family
          Location would tell a stranger they can be located through this app, so this screen gives
          the same answer either way — and so does the next one.
        </Callout>

        <Body>
          Resetting your password does not change your sharing settings, and nobody is told that you
          asked.
        </Body>
      </Stack>
    </Screen>
  );
}
