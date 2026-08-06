import { useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useCallback, useRef, useState } from 'react';
import { StyleSheet, View, type TextInput } from 'react-native';

import { AppError } from '@family/contracts';

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
  Subtitle,
  Title,
} from '@/components/ui';
import { hasEnv, requireEnv } from '@/config/env';
import { maskEmail } from '@/features/auth/api';
import { signUpWithPassword } from '@/features/auth/cognito/sign-up';
import { ROUTES } from '@/features/auth/routing';
import {
  describeBlocker,
  planSignUp,
  PASSWORD_REQUIREMENTS_HELPER,
} from '@/features/auth/sign-up-plan';
import { CURRENT_POLICY_VERSIONS, type PolicyVersions } from '@/features/consent/versions';
import { describeError } from '@/lib/api';

import { useAuthFlow } from './_layout';

/**
 * Create an account.
 *
 * ---------------------------------------------------------------------------
 * CONSENT IS THE POINT OF THIS SCREEN, NOT A FOOTNOTE ON IT
 * ---------------------------------------------------------------------------
 * The pool's PreSignUp trigger refuses an account whose accepted policy
 * versions are absent or stale, which is why `signUpWithPassword` takes them as
 * a required argument. That gate is easy to satisfy dishonestly — hard-code the
 * constants, never show anybody anything — and this screen deliberately does
 * not.
 *
 * Two properties hold it up:
 *
 *   1. The documents have to be REACHABLE. If this build has no terms URL or no
 *      privacy URL, there is no way to show a person what they are agreeing to,
 *      so no account is created at all. Failing closed on a build problem is
 *      better than recording an acceptance nobody could have read.
 *
 *   2. The versions that get recorded are the versions that were RENDERED.
 *      `planSignUp` takes them as an argument and refuses when they are absent;
 *      it never reaches for `CURRENT_POLICY_VERSIONS` itself. A screen that
 *      displayed one version cannot post another.
 *
 * There is no pre-ticked box, because there is no box: the agreement is stated
 * immediately above a button whose label says it is an agreement, and the
 * affirmative act is the tap. Nothing on this screen is enabled on the user's
 * behalf, and nothing else on it can be mistaken for the accept action.
 */

// ---------------------------------------------------------------------------
// Policy documents
// ---------------------------------------------------------------------------

type PolicyDocuments = { readonly terms: string; readonly privacy: string };

/**
 * Both addresses or neither. A screen that could show the terms but not the
 * privacy policy would be asking someone to agree to a document it cannot
 * produce, so it is treated exactly like having neither.
 */
const POLICY_DOCUMENTS: PolicyDocuments | null =
  hasEnv('termsUrl') && hasEnv('privacyUrl')
    ? { terms: requireEnv('termsUrl'), privacy: requireEnv('privacyUrl') }
    : null;

/** The versions this screen is able to display, and therefore able to record. */
const SHOWN_POLICIES: PolicyVersions | null =
  POLICY_DOCUMENTS === null ? null : CURRENT_POLICY_VERSIONS;

const dateRow = StyleSheet.create({
  row: { flexDirection: 'row', gap: 12 },
  narrow: { flex: 1 },
  /** Four digits rather than two, so it needs the extra room. */
  wide: { flex: 1.6 },
});

// ---------------------------------------------------------------------------

export default function SignUpScreen() {
  const router = useRouter();
  const { beginEmailVerification, confirmAccount } = useAuthFlow();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [passwordAgain, setPasswordAgain] = useState('');
  const [birthDay, setBirthDay] = useState('');
  const [birthMonth, setBirthMonth] = useState('');
  const [birthYear, setBirthYear] = useState('');
  const [revealPassword, setRevealPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * Set once the attested age falls below the minimum, and never cleared.
   *
   * A screen that says "too young" and then lets you edit the year is an age
   * screen in name only — it collects the number that works rather than the
   * date that is true. This is the "no retry" half of the neutral age screen,
   * and it is why the form is disabled rather than the message merely shown.
   */
  const [refused, setRefused] = useState(false);

  const passwordField = useRef<TextInput>(null);
  const passwordAgainField = useRef<TextInput>(null);
  const birthDayField = useRef<TextInput>(null);
  const birthMonthField = useRef<TextInput>(null);
  const birthYearField = useRef<TextInput>(null);

  const openDocument = useCallback(async (url: string) => {
    try {
      await WebBrowser.openBrowserAsync(url);
    } catch {
      setError('We could not open that document. Check your connection and try again.');
    }
  }, []);

  const submit = useCallback(async () => {
    if (busy || refused) return;
    setError(null);

    const plan = planSignUp({
      email,
      password,
      passwordAgain,
      birth: { day: birthDay, month: birthMonth, year: birthYear },
      shown: SHOWN_POLICIES,
    });
    if (!plan.ready) {
      if (plan.blocker === 'AGE_BELOW_MINIMUM') {
        setRefused(true);
      }
      setError(describeBlocker(plan.blocker, password));
      return;
    }

    setBusy(true);
    try {
      const outcome = await signUpWithPassword({
        email: plan.email,
        password: plan.password,
        accepted: plan.accepted,
        birthDate: plan.birthDate,
      });

      if (outcome.confirmed) {
        // Nothing to verify — the account is usable immediately.
        confirmAccount(plan.email);
        router.replace(ROUTES.signIn);
        return;
      }

      // `replace`, not `push`: going back to a filled-in sign-up form would
      // only offer to create the same account twice.
      beginEmailVerification({
        email: plan.email,
        codeSentTo: outcome.codeSentTo ?? maskEmail(plan.email),
      });
      router.replace(ROUTES.verifyEmail);
    } catch (cause) {
      // The server applies the same gate, and its refusal is final too — a
      // client that skipped the screen must not be left able to retry.
      if (cause instanceof AppError && cause.code === 'AGE_REQUIREMENT_NOT_MET') {
        setRefused(true);
      }
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  }, [
    beginEmailVerification,
    birthDay,
    birthMonth,
    birthYear,
    busy,
    confirmAccount,
    email,
    password,
    passwordAgain,
    refused,
    router,
  ]);

  return (
    <Screen
      footer={
        <Stack gap="two">
          <Button
            accessibilityHint={
              SHOWN_POLICIES === null
                ? 'Unavailable: this version of Kinmap cannot show you the terms.'
                : `Creates your account and records that you accept the Terms of Service version ${SHOWN_POLICIES.termsVersion} and the Privacy Policy version ${SHOWN_POLICIES.privacyPolicyVersion}. Your location is not shared with anyone until you turn sharing on.`
            }
            busy={busy}
            disabled={SHOWN_POLICIES === null || refused}
            label="Agree and create account"
            onPress={() => {
              void submit();
            }}
            testID="sign-up-submit"
          />
          <LinkButton
            accessibilityHint="Returns to the sign-in screen."
            label="I already have an account"
            onPress={() => {
              // `back()` when there is somewhere to go back to, so arriving from
              // sign-in and changing your mind does not stack a second copy of
              // the screen you came from.
              if (router.canGoBack()) {
                router.back();
                return;
              }
              router.replace(ROUTES.signIn);
            }}
            testID="sign-up-go-to-sign-in"
          />
        </Stack>
      }
      testID="sign-up"
    >
      <Stack gap="three">
        <Title>Create your Kinmap account</Title>
        <Subtitle>
          Creating an account does not start sharing your location. Sharing is off until you turn it
          on, and you choose who can see you.
        </Subtitle>

        {error !== null ? (
          <Callout testID="sign-up-error" title="We could not create your account" tone="danger">
            {error}
          </Callout>
        ) : null}

        <Field
          autoCapitalize="none"
          autoComplete="email"
          autoCorrect={false}
          helper="We send a confirmation code here, and use it if you ever need to recover your account."
          inputMode="email"
          keyboardType="email-address"
          label="Email address"
          onChangeText={setEmail}
          onSubmitEditing={() => passwordField.current?.focus()}
          returnKeyType="next"
          testID="sign-up-email"
          textContentType="username"
          value={email}
        />

        <Field
          autoCapitalize="none"
          autoComplete="new-password"
          autoCorrect={false}
          helper={PASSWORD_REQUIREMENTS_HELPER}
          label="Password"
          onChangeText={setPassword}
          onSubmitEditing={() => passwordAgainField.current?.focus()}
          ref={passwordField}
          returnKeyType="next"
          secureTextEntry={!revealPassword}
          testID="sign-up-password"
          textContentType="newPassword"
          value={password}
        />

        <Field
          autoCapitalize="none"
          autoComplete="new-password"
          autoCorrect={false}
          label="Repeat password"
          onChangeText={setPasswordAgain}
          onSubmitEditing={() => birthDayField.current?.focus()}
          ref={passwordAgainField}
          returnKeyType="next"
          secureTextEntry={!revealPassword}
          testID="sign-up-password-again"
          textContentType="newPassword"
          value={passwordAgain}
        />

        {/*
          The age screen.

          It asks for a date and says nothing about a minimum, which is the
          whole design: a form that states the threshold collects the threshold.
          The helper text explains why the date is wanted, because asking a
          person for their date of birth without a reason is its own problem.

          Three boxes, not one, and labelled words rather than a locale format —
          03/04/11 is three different dates in three different countries, and a
          month misread here moves somebody across the boundary.

          Laid out in a row. Stacked full-width they were three more screens of
          scrolling between the password and the thing the user is agreeing to,
          which pushed the consent card further below the fold than it already
          was — on a screen whose whole point is that somebody sees what they
          accept before they accept it.
        */}
        <Stack gap="one">
          <View style={dateRow.row}>
            <View style={dateRow.narrow}>
              <Field
                autoComplete="birthdate-day"
                editable={!refused}
                inputMode="numeric"
                keyboardType="number-pad"
                label="Day of birth"
                maxLength={2}
                onChangeText={setBirthDay}
                onSubmitEditing={() => birthMonthField.current?.focus()}
                placeholder="DD"
                ref={birthDayField}
                returnKeyType="next"
                testID="sign-up-birth-day"
                value={birthDay}
              />
            </View>
            <View style={dateRow.narrow}>
              <Field
                autoComplete="birthdate-month"
                editable={!refused}
                inputMode="numeric"
                keyboardType="number-pad"
                label="Month of birth"
                maxLength={2}
                onChangeText={setBirthMonth}
                onSubmitEditing={() => birthYearField.current?.focus()}
                placeholder="MM"
                ref={birthMonthField}
                returnKeyType="next"
                testID="sign-up-birth-month"
                value={birthMonth}
              />
            </View>
            <View style={dateRow.wide}>
              <Field
                autoComplete="birthdate-year"
                editable={!refused}
                inputMode="numeric"
                keyboardType="number-pad"
                label="Year of birth"
                maxLength={4}
                onChangeText={setBirthYear}
                onSubmitEditing={() => {
                  void submit();
                }}
                placeholder="YYYY"
                ref={birthYearField}
                returnKeyType="go"
                testID="sign-up-birth-year"
                value={birthYear}
              />
            </View>
          </View>
          <Caption>
            We ask so we know which rules apply to your account. We check it and do not store it.
          </Caption>
        </Stack>

        <LinkButton
          accessibilityHint={
            revealPassword
              ? 'Hides both password fields again.'
              : 'Shows both password fields on screen so you can check them.'
          }
          label={revealPassword ? 'Hide passwords' : 'Show passwords'}
          onPress={() => {
            setRevealPassword((shown) => !shown);
          }}
          testID="sign-up-reveal-password"
        />

        {POLICY_DOCUMENTS === null ? (
          <Callout
            testID="sign-up-policies-unavailable"
            title="We cannot show you the terms right now"
            tone="danger"
          >
            This version of Kinmap was not given the addresses of the Terms of Service and the
            Privacy Policy, so we cannot show you what you would be agreeing to — and we will not
            create an account without that. Please update the app.
          </Callout>
        ) : (
          <Card testID="sign-up-consent">
            <Subtitle>What you are agreeing to</Subtitle>
            <Body>
              Kinmap shares your device’s location with the family members you choose, and with
              nobody else. It is off when your account is created and stays off until you turn it
              on.
            </Body>
            <Body>
              Somebody who is not in a family with you can never see where you are, and you can see
              at any time who can.
            </Body>
            <Body>
              You can pause sharing, turn it off, leave a family, delete your location history, or
              delete your account and everything in it — all from Settings, at any time.
            </Body>
            <Body>
              We keep your email address so you can sign in and recover your account. We do not sell
              your data, and we do not track you across other apps or websites.
            </Body>
            <LinkButton
              accessibilityHint="Opens the Terms of Service in your browser."
              label={`Read the Terms of Service (version ${CURRENT_POLICY_VERSIONS.termsVersion})`}
              onPress={() => {
                void openDocument(POLICY_DOCUMENTS.terms);
              }}
              testID="sign-up-terms-link"
            />
            <LinkButton
              accessibilityHint="Opens the Privacy Policy in your browser."
              label={`Read the Privacy Policy (version ${CURRENT_POLICY_VERSIONS.privacyPolicyVersion})`}
              onPress={() => {
                void openDocument(POLICY_DOCUMENTS.privacy);
              }}
              testID="sign-up-privacy-link"
            />
            <Caption>
              Tapping “Agree and create account” records that you accept the Terms of Service
              version {CURRENT_POLICY_VERSIONS.termsVersion} and the Privacy Policy version{' '}
              {CURRENT_POLICY_VERSIONS.privacyPolicyVersion}. Nothing above is agreed to on your
              behalf.
            </Caption>
          </Card>
        )}
      </Stack>
    </Screen>
  );
}
