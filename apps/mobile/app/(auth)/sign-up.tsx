import { useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useCallback, useRef, useState } from 'react';
import type { TextInput } from 'react-native';

import { EmailSchema } from '@family/schemas';

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
import { signUpWithPassword, type PolicyAcceptance } from '@/features/auth/cognito/sign-up';
import { ROUTES } from '@/features/auth/routing';
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
// Password policy
// ---------------------------------------------------------------------------

type PasswordRule = {
  readonly describe: string;
  readonly satisfied: (value: string) => boolean;
};

/**
 * Cognito's documented password symbol set. Written out rather than
 * approximated with "not a letter or a digit", because the pool rejects an
 * emoji as a symbol and a user told otherwise would be stuck in a loop with no
 * way to see why.
 */
const COGNITO_SYMBOL = /[\^$*.[\]{}()?"!@#%&/\\,><':;|_~`+=-]/u;

/**
 * Mirrors `passwordPolicy` in `infrastructure/stacks/identity-stack.ts`.
 *
 * Checked here, before the call, because the shared Cognito error mapper folds
 * `InvalidPasswordException` into "That email address and password do not match
 * an account". That wording is right on sign-in and nonsense on sign-up, and
 * the fix is not to teach the mapper a second context — it is to make sure the
 * pool never has to reject the password in the first place.
 */
const PASSWORD_RULES: readonly PasswordRule[] = [
  { describe: 'at least 12 characters', satisfied: (value) => value.length >= 12 },
  { describe: 'a lower-case letter', satisfied: (value) => /\p{Ll}/u.test(value) },
  { describe: 'an upper-case letter', satisfied: (value) => /\p{Lu}/u.test(value) },
  { describe: 'a number', satisfied: (value) => /\d/u.test(value) },
  { describe: 'a symbol', satisfied: (value) => COGNITO_SYMBOL.test(value) },
];

export const PASSWORD_REQUIREMENTS_HELPER =
  'At least 12 characters, including an upper-case letter, a lower-case letter, a number and a symbol.';

export function unmetPasswordRules(password: string): readonly string[] {
  return PASSWORD_RULES.filter((rule) => !rule.satisfied(password)).map((rule) => rule.describe);
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

export type SignUpBlocker =
  'POLICIES_UNAVAILABLE' | 'EMAIL_INVALID' | 'PASSWORD_WEAK' | 'PASSWORD_MISMATCH';

export type SignUpPlan =
  | { readonly ready: false; readonly blocker: SignUpBlocker }
  | {
      readonly ready: true;
      readonly email: string;
      readonly password: string;
      readonly accepted: PolicyAcceptance;
    };

/**
 * Turns what is on screen into either a refusal or the exact sign-up payload.
 *
 * Pure, and kept separate from the component for that reason: this is the
 * function that decides what a person is consenting to, and it must be
 * inspectable without a renderer. `shown` is the versions this render actually
 * put in front of the user — `null` when the documents could not be shown at
 * all — and it is checked FIRST, so a build that cannot display the terms never
 * even validates a form it has no right to submit.
 */
export function planSignUp(input: {
  readonly email: string;
  readonly password: string;
  readonly passwordAgain: string;
  readonly shown: PolicyVersions | null;
}): SignUpPlan {
  if (input.shown === null) {
    return { ready: false, blocker: 'POLICIES_UNAVAILABLE' };
  }

  const email = input.email.trim();
  if (!EmailSchema.safeParse(email).success) {
    return { ready: false, blocker: 'EMAIL_INVALID' };
  }
  if (unmetPasswordRules(input.password).length > 0) {
    return { ready: false, blocker: 'PASSWORD_WEAK' };
  }
  if (input.password !== input.passwordAgain) {
    return { ready: false, blocker: 'PASSWORD_MISMATCH' };
  }

  return {
    ready: true,
    email,
    password: input.password,
    // Built from what was displayed, never re-read from the module. This is the
    // line that makes "the acceptance is the one the user saw" a property of
    // the code rather than a convention.
    accepted: {
      termsVersion: input.shown.termsVersion,
      privacyPolicyVersion: input.shown.privacyPolicyVersion,
    },
  };
}

function joinPhrases(phrases: readonly string[]): string {
  if (phrases.length <= 1) return phrases[0] ?? '';
  const last = phrases[phrases.length - 1] ?? '';
  return `${phrases.slice(0, -1).join(', ')} and ${last}`;
}

export function describeBlocker(blocker: SignUpBlocker, password: string): string {
  switch (blocker) {
    case 'POLICIES_UNAVAILABLE':
      return 'This version of Kinmap cannot show you the terms or the privacy policy, so it will not create an account. Please update the app.';
    case 'EMAIL_INVALID':
      return 'Enter an email address you can receive mail at — we send a confirmation code to it.';
    case 'PASSWORD_WEAK':
      return `Your password still needs ${joinPhrases(unmetPasswordRules(password))}.`;
    case 'PASSWORD_MISMATCH':
      return 'The two passwords do not match.';
  }
}

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

// ---------------------------------------------------------------------------

export default function SignUpScreen() {
  const router = useRouter();
  const { beginEmailVerification, confirmAccount } = useAuthFlow();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [passwordAgain, setPasswordAgain] = useState('');
  const [revealPassword, setRevealPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const passwordField = useRef<TextInput>(null);
  const passwordAgainField = useRef<TextInput>(null);

  const openDocument = useCallback(async (url: string) => {
    try {
      await WebBrowser.openBrowserAsync(url);
    } catch {
      setError('We could not open that document. Check your connection and try again.');
    }
  }, []);

  const submit = useCallback(async () => {
    if (busy) return;
    setError(null);

    const plan = planSignUp({ email, password, passwordAgain, shown: SHOWN_POLICIES });
    if (!plan.ready) {
      setError(describeBlocker(plan.blocker, password));
      return;
    }

    setBusy(true);
    try {
      const outcome = await signUpWithPassword({
        email: plan.email,
        password: plan.password,
        accepted: plan.accepted,
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
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  }, [beginEmailVerification, busy, confirmAccount, email, password, passwordAgain, router]);

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
            disabled={SHOWN_POLICIES === null}
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
          onSubmitEditing={() => {
            void submit();
          }}
          ref={passwordAgainField}
          returnKeyType="go"
          secureTextEntry={!revealPassword}
          testID="sign-up-password-again"
          textContentType="newPassword"
          value={passwordAgain}
        />

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
