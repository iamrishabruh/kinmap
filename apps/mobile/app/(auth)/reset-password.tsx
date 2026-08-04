import { useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';

import {
  Body,
  Button,
  Callout,
  Caption,
  Card,
  Field,
  LinkButton,
  Screen,
  Stack,
  StatusRow,
  Title,
} from '@/components/ui';
import {
  clearPendingPasswordReset,
  confirmPasswordReset,
  meetsPasswordPolicy,
  passwordRequirements,
  pendingPasswordReset,
  resendPasswordReset,
} from '@/features/auth/cognito/forgot-password';
import { ROUTES } from '@/features/auth/routing';
import { describeError } from '@/lib/api';

/**
 * The second half of password recovery: spend the emailed code, set a password.
 *
 * The address is not on this screen and is not reachable from it. It lives in
 * `cognito/forgot-password.ts` for as long as the reset does, which is why there
 * is no "we sent a code to a***@e***.com" line here — a per-address string in
 * the copy would differ between an account that exists and one that does not,
 * and that difference is the whole thing the previous screen refuses to leak.
 *
 * The password rules are shown BEFORE they are broken, and the submit button
 * says why it is disabled. Both matter more than usual here: the server's
 * rejection has to be collapsed into one opaque answer to avoid becoming an
 * account-existence oracle, so anything the client can check, the client checks.
 */
export default function ResetPasswordScreen() {
  const router = useRouter();

  // Read once. The module clears the ticket when the code is spent, and this
  // screen tracks that itself rather than re-reading module state on render.
  const [ticket] = useState(pendingPasswordReset);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const codeLength = ticket?.codeLength ?? 0;
  const requirements = useMemo(() => passwordRequirements(password), [password]);
  const codeReady = code.trim().length === codeLength;

  const blocked = !codeReady
    ? `Enter the ${codeLength}-digit code from your email.`
    : meetsPasswordPolicy(password)
      ? null
      : 'Your new password does not meet all of the requirements above yet.';

  const startAgain = useCallback(() => {
    clearPendingPasswordReset();
    router.replace(ROUTES.forgotPassword);
  }, [router]);

  const submit = useCallback(() => {
    if (blocked !== null) return;
    setProblem(null);
    setNotice(null);
    setBusy(true);

    void (async () => {
      try {
        await confirmPasswordReset({ code, newPassword: password });
        // Nothing about the old password, the code or the address survives this
        // screen: the module has already dropped the address, and the fields go
        // with the component.
        setPassword('');
        setCode('');
        setDone(true);
      } catch (cause) {
        setProblem(describeError(cause));
      } finally {
        setBusy(false);
      }
    })();
  }, [blocked, code, password]);

  const resend = useCallback(() => {
    setProblem(null);
    setNotice(null);
    setBusy(true);

    void (async () => {
      try {
        await resendPasswordReset();
        setNotice('If that address has an account, another code is on its way.');
      } catch (cause) {
        setProblem(describeError(cause));
      } finally {
        setBusy(false);
      }
    })();
  }, []);

  // -------------------------------------------------------------------------
  // Nothing in flight: a cold start, or a link opened out of order.
  // -------------------------------------------------------------------------
  if (ticket === null && !done) {
    return (
      <Screen
        footer={
          <Stack gap="two">
            <Button
              accessibilityHint="Returns to the screen where you enter your email address."
              label="Ask for a new code"
              onPress={startAgain}
              testID="reset-password-restart"
            />
            <LinkButton
              label="Back to sign in"
              onPress={() => {
                router.replace(ROUTES.signIn);
              }}
              testID="reset-password-restart-back"
            />
          </Stack>
        }
        testID="reset-password-expired"
      >
        <Stack gap="three">
          <Title>Start your password reset again</Title>
          <Body>
            We do not keep the email address you entered anywhere on this device, so a reset only
            lasts while the app is running. Ask for a new code and you will be back here in a
            moment.
          </Body>
          <Callout title="This is deliberate" tone="info">
            Storing the address would leave a record on the phone that somebody was resetting this
            account&apos;s password. One extra tap is a fair price for not leaving it.
          </Callout>
        </Stack>
      </Screen>
    );
  }

  // -------------------------------------------------------------------------
  // Done.
  // -------------------------------------------------------------------------
  if (done) {
    return (
      <Screen
        footer={
          <Button
            accessibilityHint="Opens the sign-in screen so you can sign in with your new password."
            label="Sign in"
            onPress={() => {
              router.replace(ROUTES.signIn);
            }}
            testID="reset-password-signin"
          />
        }
        testID="reset-password-done"
      >
        <Stack gap="three">
          <Title>Your new password is set</Title>
          <Body>Sign in with it to get back into Family Location.</Body>
          <Callout title="Other devices are still signed in" tone="warning">
            Changing your password does not sign out phones that are already signed in to your
            account, and it does not change your sharing settings. If you think somebody else has
            access, sign in and remove their device under Settings, then Devices.
          </Callout>
        </Stack>
      </Screen>
    );
  }

  // -------------------------------------------------------------------------
  // The code and the new password.
  // -------------------------------------------------------------------------
  return (
    <Screen
      footer={
        <Stack gap="two">
          {blocked === null ? null : <Caption testID="reset-password-blocked">{blocked}</Caption>}
          <Button
            accessibilityHint="Sets this as your password. You will then sign in with it."
            busy={busy}
            disabled={blocked !== null}
            label="Set new password"
            onPress={submit}
            testID="reset-password-submit"
          />
          <Button
            accessibilityHint="Emails another code to the same address."
            disabled={busy}
            label="Send a new code"
            onPress={resend}
            testID="reset-password-resend"
            variant="ghost"
          />
          <LinkButton
            accessibilityHint="Discards this code and returns to the email address screen."
            label="Use a different email address"
            onPress={startAgain}
            testID="reset-password-change-address"
          />
        </Stack>
      }
      testID="reset-password"
    >
      <Stack gap="three">
        <Title>Enter your code</Title>
        <Body>
          If the address you entered has an account, a {codeLength}-digit code is in its inbox. It
          may take a minute, and it may be in the spam folder.
        </Body>

        <Field
          autoComplete="one-time-code"
          inputMode="numeric"
          keyboardType="number-pad"
          label={`${codeLength}-digit code`}
          maxLength={codeLength}
          onChangeText={(value) => {
            setCode(value.replace(/\D/gu, ''));
            setProblem(null);
          }}
          textContentType="oneTimeCode"
          value={code}
        />

        <Field
          autoCapitalize="none"
          autoComplete="new-password"
          autoCorrect={false}
          helper="Your family cannot see this, and neither can we."
          label="New password"
          onChangeText={(value) => {
            setPassword(value);
            setProblem(null);
          }}
          // Lets the OS keychain offer a password the pool will actually accept.
          passwordRules="minlength: 12; required: lower; required: upper; required: digit; required: special;"
          secureTextEntry={!revealed}
          textContentType="newPassword"
          value={password}
        />

        <LinkButton
          accessibilityHint={
            revealed
              ? 'Hides the password you are typing.'
              : 'Shows the password you are typing on screen.'
          }
          label={revealed ? 'Hide password' : 'Show password'}
          onPress={() => {
            setRevealed((current) => !current);
          }}
          testID="reset-password-reveal"
        />

        <Card testID="reset-password-requirements">
          <Body>Your new password needs:</Body>
          {requirements.map((requirement) => (
            <StatusRow
              key={requirement.id}
              label={requirement.label}
              testID={`reset-password-requirement-${requirement.id}`}
              tone={requirement.met ? 'success' : 'neutral'}
              value={requirement.met ? 'Done' : 'Not yet'}
            />
          ))}
        </Card>

        {notice === null ? null : (
          <Callout testID="reset-password-notice" tone="info">
            {notice}
          </Callout>
        )}

        {problem === null ? null : (
          <Callout testID="reset-password-error" title="That did not work" tone="danger">
            {problem}
          </Callout>
        )}
      </Stack>
    </Screen>
  );
}
