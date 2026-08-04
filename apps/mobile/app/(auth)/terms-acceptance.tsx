import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Stack as NavigationStack } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useCallback, useEffect, useReducer, useState } from 'react';
import { BackHandler, Linking, Pressable, StyleSheet, Text as RNText, View } from 'react-native';

import {
  Body,
  Button,
  Callout,
  Caption,
  Card,
  Field,
  LinkButton,
  MIN_TOUCH_TARGET,
  Radius,
  Screen,
  Stack,
  StatusRow,
  Subtitle,
  Title,
  useUiTheme,
} from '@/components/ui';
import { env, hasEnv } from '@/config/env';
import { Spacing } from '@/constants/theme';
import { acceptTerms } from '@/features/auth/api';
import { ACCOUNT_QUERY_KEY } from '@/features/auth/session-provider';
import { signOut } from '@/features/auth/sign-out';
import { useSession } from '@/features/auth/use-session';
import {
  canSubmitConsent,
  describeDocument,
  EMPTY_CONSENT_SELECTION,
  type ConsentSelection,
} from '@/features/consent/consent-gate';
import { CURRENT_POLICY_VERSIONS, POLICY_CHANGE_SUMMARY } from '@/features/consent/versions';
import {
  accountDeletionReducer,
  blockingReason,
  canSubmitDeletion,
  describeReauthenticationFailure,
  DELETION_CONFIRMATION_PHRASE,
  initialAccountDeletionState,
  reauthenticateForDeletion,
  requestAccountDeletion,
} from '@/features/settings/account/delete-account-flow';
import { fetchAccountDeletionPreview } from '@/features/settings/api/endpoints';
import { describeError } from '@/lib/api';

/**
 * Re-accepting the terms and the privacy policy.
 *
 * Reached only by a signed-in user whose stored acceptance is behind the
 * versions that shipped in this binary (`consent-gate.ts`), and pinned there by
 * rule 4 of the routing guard until it is resolved. Nothing else in the product
 * is reachable in the meantime, because everything else in the product either
 * collects this person's location or shows somebody else's.
 *
 * ---------------------------------------------------------------------------
 * NOT DISMISSABLE, BUT NOT A TRAP
 * ---------------------------------------------------------------------------
 * The gesture and the hardware back button are both disabled, and there is no
 * "later", no "skip", no "remind me". A consent screen with a way past it is
 * not a consent screen.
 *
 * A consent screen with no way OUT is not consent either — it is coercion, and
 * the answer it collects is worthless. So both exits are on this screen, in
 * plain words, at the same level as the agree button: sign out, or delete the
 * account. Neither is buried, neither costs an extra tap more than agreeing
 * does, and neither is styled to look like a mistake.
 *
 * ---------------------------------------------------------------------------
 * NO DARK PATTERNS
 * ---------------------------------------------------------------------------
 *  - Both boxes start empty. `EMPTY_CONSENT_SELECTION` is the initial state and
 *    there is no code path that sets either to true except a tap.
 *  - The terms and the privacy policy are agreed to separately. One document
 *    governs the service; the other governs continuous location collection, and
 *    bundling them into a single "I agree" would hide the second behind the
 *    first.
 *  - Every button does what its label says. "Sign out" signs out; nothing here
 *    enables anything.
 *  - If this build cannot open the documents, it does not ask anybody to agree
 *    to them. Consent to a document you were not shown is not consent.
 */

type Mode = 'CONSENT' | 'DELETE';

export default function TermsAcceptanceScreen() {
  const { account, consent } = useSession();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<Mode>('CONSENT');

  // Back closes the deletion detour, and does nothing at all on the consent
  // screen itself. Returning true swallows the event; the exits are on screen.
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (mode === 'DELETE') {
        setMode('CONSENT');
      }
      return true;
    });
    return () => {
      subscription.remove();
    };
  }, [mode]);

  return (
    <>
      {/* iOS swipe-back would otherwise leave the gate without answering it. */}
      <NavigationStack.Screen options={{ gestureEnabled: false, headerShown: false }} />
      {mode === 'DELETE' ? (
        <DeleteInstead
          queryClient={queryClient}
          onBack={() => {
            setMode('CONSENT');
          }}
        />
      ) : (
        <AcceptanceRequest
          consent={consent}
          displayName={account?.displayName ?? null}
          onDeleteInstead={() => {
            setMode('DELETE');
          }}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// The request itself
// ---------------------------------------------------------------------------

function AcceptanceRequest({
  consent,
  displayName,
  onDeleteInstead,
}: {
  consent: ReturnType<typeof useSession>['consent'];
  displayName: string | null;
  onDeleteInstead: () => void;
}) {
  const queryClient = useQueryClient();
  const [selection, setSelection] = useState<ConsentSelection>(EMPTY_CONSENT_SELECTION);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [recorded, setRecorded] = useState(false);

  const documentsReadable = hasEnv('termsUrl') && hasEnv('privacyUrl');
  const ready = documentsReadable && canSubmitConsent(selection) && !recorded;

  const agree = useCallback(() => {
    if (!canSubmitConsent(selection) || !documentsReadable) return;
    setBusy(true);
    setProblem(null);

    void (async () => {
      try {
        await acceptTerms(CURRENT_POLICY_VERSIONS);
        setRecorded(true);
        // The account snapshot is the authority on consent, so the screen does
        // not navigate: it refreshes the fact and lets the routing guard move
        // the user on. A screen that both records consent and decides where to
        // go next can disagree with the guard, and the guard has to win.
        await queryClient.invalidateQueries({ queryKey: ACCOUNT_QUERY_KEY });
      } catch (cause) {
        setProblem(describeError(cause));
      } finally {
        setBusy(false);
      }
    })();
  }, [documentsReadable, queryClient, selection]);

  const outdated = consent.outdatedDocuments.map(describeDocument).join(' and ');
  const returning = consent.reason === 'VERSION_CHANGED';

  return (
    <Screen
      footer={
        <Stack gap="two">
          {ready || recorded ? null : (
            <Caption testID="terms-blocked">
              {documentsReadable
                ? 'Tick both boxes to continue. Nothing is agreed until you do.'
                : 'This build cannot open the documents, so we will not ask you to agree to them.'}
            </Caption>
          )}
          <Button
            accessibilityHint="Records that you accept both documents and continues into the app."
            busy={busy}
            disabled={!ready}
            label="Agree and continue"
            onPress={agree}
            testID="terms-agree"
          />
          <Button
            accessibilityHint="Signs you out. Your account and your history are left exactly as they are."
            label="Sign out instead"
            onPress={() => {
              void signOut('USER_REQUESTED');
            }}
            testID="terms-sign-out"
            variant="ghost"
          />
          <Button
            accessibilityHint="Opens the steps for deleting your account and everything in it."
            label="Delete my account instead"
            onPress={onDeleteInstead}
            testID="terms-delete-instead"
            variant="destructive"
          />
        </Stack>
      }
      testID="terms-acceptance"
    >
      <Stack gap="three">
        <Title>
          {returning ? 'We have updated our terms' : 'Before you start, please read these'}
        </Title>
        <Body>
          {displayName === null ? 'Hello. ' : `Hello ${displayName}. `}
          {returning
            ? `We have published a new ${outdated}. You need to agree to the current version before Family Location shares anything else about you.`
            : `Family Location can only collect your location once you have agreed to the ${outdated}.`}
        </Body>

        {returning && POLICY_CHANGE_SUMMARY.length > 0 ? (
          <Card testID="terms-changes">
            <Subtitle>What changed</Subtitle>
            {POLICY_CHANGE_SUMMARY.map((change) => (
              <Body key={change}>{`•  ${change}`}</Body>
            ))}
          </Card>
        ) : null}

        {/*
          The plain-language version of the two documents. It is not a summary
          for convenience — it is the part App Review, and anybody being
          followed by a family member, actually needs: what leaves the phone,
          who receives it, and how to make it stop.
        */}
        <Card testID="terms-plain-language">
          <Subtitle>In plain words</Subtitle>
          <StatusRow
            detail="Your phone sends its position while sharing is on, plus how recent and how accurate that position is, and whether the battery is low. It does not send your photos, your contacts, or what you do in other apps."
            label="What is shared"
            value="Where your phone is"
          />
          <StatusRow
            detail="Only the people in the families you have joined, and only while you are sharing with that family. Nobody outside a family you joined can see you. We do not sell it and we do not use it for advertising."
            label="Who can see it"
            value="The families you join"
          />
          <StatusRow
            detail="Pause or turn off sharing at any time in Settings, per family or for everyone at once. Turning it off stops new points immediately. You can delete your stored history whenever you like, and deleting your account deletes it all."
            label="How to stop"
            value="Any time, from Settings"
          />
          <StatusRow
            detail="Location history is kept for the period described in the Privacy Policy and then deleted automatically."
            label="How long it is kept"
            value="See the Privacy Policy"
          />
        </Card>

        <Stack gap="two">
          <DocumentLink
            available={hasEnv('termsUrl')}
            label={`Read the Terms of Service (version ${CURRENT_POLICY_VERSIONS.termsVersion})`}
            testID="terms-open-terms"
            url={env.termsUrl}
          />
          <DocumentLink
            available={hasEnv('privacyUrl')}
            label={`Read the Privacy Policy (version ${CURRENT_POLICY_VERSIONS.privacyPolicyVersion})`}
            testID="terms-open-privacy"
            url={env.privacyUrl}
          />
        </Stack>

        {documentsReadable ? null : (
          <Callout
            testID="terms-documents-unavailable"
            title="We cannot show you the documents"
            tone="danger"
          >
            This build has no address for the Terms of Service or the Privacy Policy, so we will not
            ask you to agree to them. Please update the app. You can still sign out or delete your
            account from this screen.
          </Callout>
        )}

        <Stack gap="two">
          <ConsentCheck
            checked={selection.termsChecked}
            disabled={!documentsReadable || recorded}
            onToggle={() => {
              setSelection((current) => ({ ...current, termsChecked: !current.termsChecked }));
            }}
            testID="terms-check-terms"
            title={`I agree to the Terms of Service, version ${CURRENT_POLICY_VERSIONS.termsVersion}.`}
          />
          <ConsentCheck
            checked={selection.privacyChecked}
            detail="This is the one that covers collecting your location."
            disabled={!documentsReadable || recorded}
            onToggle={() => {
              setSelection((current) => ({ ...current, privacyChecked: !current.privacyChecked }));
            }}
            testID="terms-check-privacy"
            title={`I have read the Privacy Policy, version ${CURRENT_POLICY_VERSIONS.privacyPolicyVersion}.`}
          />
        </Stack>

        {problem === null ? null : (
          <Callout testID="terms-error" title="We could not record that" tone="danger">
            {problem}
          </Callout>
        )}

        {recorded && consent.acceptanceRequired ? (
          <Callout testID="terms-still-required" title="Saved, but not yet applied" tone="warning">
            We recorded your agreement, but your account still reports an older version, so this
            screen cannot let you through yet. Please try again in a moment. If it keeps happening,
            contact support — and you can sign out or delete your account from here at any time.
          </Callout>
        ) : null}

        {recorded && !consent.acceptanceRequired ? (
          <Callout testID="terms-recorded" title="Thank you" tone="success">
            Your agreement is recorded against your account.
          </Callout>
        ) : null}

        <Caption>
          Agreeing does not turn sharing on. Nothing about where you are leaves this phone until you
          choose to share, and you can stop at any time.
        </Caption>
      </Stack>
    </Screen>
  );
}

// ---------------------------------------------------------------------------
// The other exit: deleting the account rather than agreeing
// ---------------------------------------------------------------------------

/**
 * The account-deletion flow, run from inside the consent gate.
 *
 * It is the same flow as the one in Settings, because it is the same module:
 * `delete-account-flow` owns the four gates and refuses the destructive call
 * itself if any of them is unmet. This screen only renders them. A second,
 * "quick" deletion path for people who declined the terms would be a second
 * place for that logic to be wrong.
 */
function DeleteInstead({
  onBack,
  queryClient,
}: {
  onBack: () => void;
  queryClient: ReturnType<typeof useQueryClient>;
}) {
  const [state, dispatch] = useReducer(accountDeletionReducer, initialAccountDeletionState);

  const preview = useQuery({
    queryKey: ['account', 'deletion', 'preview'] as const,
    queryFn: ({ signal }) => fetchAccountDeletionPreview(signal),
  });

  const confirmIdentity = useCallback(() => {
    dispatch({ type: 'BEGIN_REAUTHENTICATION' });
    void (async () => {
      try {
        const result = await reauthenticateForDeletion();
        if (result.ok) {
          dispatch({ type: 'REAUTHENTICATION_SUCCEEDED', proof: result.proof });
          return;
        }
        dispatch({
          type: 'REAUTHENTICATION_FAILED',
          message: describeReauthenticationFailure(result.failure),
        });
      } catch (cause) {
        dispatch({ type: 'REAUTHENTICATION_FAILED', message: describeError(cause) });
      }
    })();
  }, []);

  const destroy = useCallback(() => {
    const snapshot = state;
    dispatch({ type: 'SUBMIT_STARTED' });
    void (async () => {
      try {
        const result = await requestAccountDeletion(snapshot, {
          queryClient,
          // The account is gone; the device must stop being a copy of it.
          signOut: () => signOut('ACCOUNT_UNAVAILABLE'),
        });
        dispatch({ type: 'SUBMIT_SUCCEEDED', result });
      } catch (cause) {
        dispatch({ type: 'SUBMIT_FAILED', message: describeError(cause) });
      }
    })();
  }, [queryClient, state]);

  if (state.step === 'DONE' && state.result !== null) {
    const purgeDate = new Date(state.result.scheduledPurgeAt).toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
    return (
      <Screen testID="terms-delete-done">
        <Stack gap="three">
          <Title>Your account is scheduled for deletion</Title>
          <Body>
            {`Everything in it is deleted permanently on ${purgeDate}. You have been signed out on this phone.`}
          </Body>
          <Callout title="You can still change your mind" tone="info">
            {`Signing in before then cancels the deletion and keeps your account. After ${purgeDate} it cannot be recovered.`}
          </Callout>
        </Stack>
      </Screen>
    );
  }

  const blocker = blockingReason(state);
  const details = preview.data;
  const submitting = state.step === 'SUBMITTING';
  // The typed confirmation stays on screen while the request is in flight, so
  // the last thing the user read is still the thing they are waiting on.
  const confirming = state.step === 'CONFIRM' || submitting;

  return (
    <Screen
      footer={
        <Stack gap="two">
          {confirming ? (
            <>
              {blocker === null ? null : <Caption testID="terms-delete-blocked">{blocker}</Caption>}
              <Button
                accessibilityHint="Deletes your account and everything in it, after a grace period."
                busy={submitting}
                disabled={!canSubmitDeletion(state)}
                label="Delete my account"
                onPress={destroy}
                testID="terms-delete-submit"
                variant="destructive"
              />
            </>
          ) : state.consequencesAcknowledged ? (
            <Button
              accessibilityHint="Asks you to prove it is you before anything is deleted."
              label="Confirm it is you"
              onPress={confirmIdentity}
              testID="terms-delete-reauthenticate"
            />
          ) : (
            <Button
              accessibilityHint="Confirms you have read what deleting your account removes."
              disabled={preview.isLoading}
              label="I understand what is deleted"
              onPress={() => {
                dispatch({ type: 'ACKNOWLEDGE_CONSEQUENCES' });
              }}
              testID="terms-delete-acknowledge"
            />
          )}
          <Button
            accessibilityHint="Returns to the terms without deleting anything."
            label="Back to the terms"
            onPress={onBack}
            testID="terms-delete-back"
            variant="ghost"
          />
        </Stack>
      }
      testID="terms-delete"
    >
      <Stack gap="three">
        <Title>Delete your account</Title>
        <Body>
          You do not have to agree to the new terms. If you would rather not, you can delete your
          account and everything Family Location holds about you. This is permanent.
        </Body>

        {preview.isError ? (
          <Callout title="We could not load the details" tone="warning">
            {describeError(preview.error)} Everything below still happens; we just could not show
            you the numbers.
          </Callout>
        ) : null}

        <Card testID="terms-delete-consequences">
          <Subtitle>What is deleted</Subtitle>
          <StatusRow
            detail="Every position ever stored for you, on our servers and on this phone."
            label="Location history"
            value={
              details === undefined ? 'All of it' : `${details.storedLocationPointCount} points`
            }
          />
          <StatusRow
            detail="Home, school, work and anywhere else you named."
            label="Saved places"
            value={details === undefined ? 'All of them' : `${details.savedPlaceCount}`}
          />
          <StatusRow
            detail="Every phone signed in to this account stops sharing and is signed out."
            label="Devices"
            value={details === undefined ? 'All of them' : `${details.registeredDeviceCount}`}
          />
          <StatusRow
            detail="You are removed from them, and they can no longer see you."
            label="Families you are in"
            value={details === undefined ? 'All of them' : `${details.memberFamilyCount}`}
          />
          {(details?.ownedFamilies ?? []).map((family) => (
            <StatusRow
              detail={
                family.willBeDissolved
                  ? `This family is deleted for all ${family.memberCount} members.`
                  : `Another member takes over. Its ${family.memberCount} members keep it.`
              }
              key={family.familyId}
              label={`Family you own: ${family.name}`}
              tone={family.willBeDissolved ? 'danger' : 'neutral'}
              value={family.willBeDissolved ? 'Will be deleted' : 'Handed over'}
            />
          ))}
        </Card>

        {details?.hasActiveSubscription === true ? (
          <Callout title="Your subscription is not cancelled by this" tone="warning">
            {details.subscriptionStore === 'APP_STORE'
              ? 'Cancel it in the App Store, under Subscriptions, or you will keep being charged.'
              : details.subscriptionStore === 'PLAY_STORE'
                ? 'Cancel it in Google Play, under Subscriptions, or you will keep being charged.'
                : 'Cancel it wherever you bought it, or you will keep being charged.'}
          </Callout>
        ) : null}

        <Callout title="There is a grace period" tone="info">
          {details === undefined
            ? 'Signing in again before the deletion completes cancels it and keeps your account.'
            : `Nothing is destroyed for ${details.gracePeriodDays} days. Signing in again during that time cancels the deletion and keeps your account.`}
        </Callout>

        {state.error === null ? null : (
          <Callout testID="terms-delete-error" title="Nothing has been deleted" tone="danger">
            {state.error}
            {hasEnv('supportEmail') ? ' You can also ask us to do it for you.' : ''}
          </Callout>
        )}

        {state.error !== null && hasEnv('supportEmail') ? (
          <LinkButton
            accessibilityHint="Opens your email app with a message to our support address."
            label="Email support about deleting my account"
            onPress={() => {
              void Linking.openURL(
                `mailto:${env.supportEmail ?? ''}?subject=${encodeURIComponent(
                  'Please delete my Family Location account',
                )}`,
              );
            }}
            testID="terms-delete-support"
          />
        ) : null}

        {confirming ? (
          <Field
            autoCapitalize="characters"
            autoCorrect={false}
            helper={`Type ${DELETION_CONFIRMATION_PHRASE} exactly, in capitals.`}
            label="Type DELETE to confirm"
            onChangeText={(value) => {
              dispatch({ type: 'SET_TYPED_CONFIRMATION', value });
            }}
            testID="terms-delete-confirmation"
            value={state.typedConfirmation}
          />
        ) : null}
      </Stack>
    </Screen>
  );
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

function DocumentLink({
  available,
  label,
  testID,
  url,
}: {
  available: boolean;
  label: string;
  testID: string;
  url: string | undefined;
}) {
  if (!available || url === undefined) {
    return (
      <Caption testID={`${testID}-unavailable`}>{`${label} — not available in this build`}</Caption>
    );
  }
  return (
    <LinkButton
      accessibilityHint="Opens the document in a browser. You will come straight back here."
      label={label}
      onPress={() => {
        void WebBrowser.openBrowserAsync(url);
      }}
      testID={testID}
    />
  );
}

/**
 * One tick box, for one document.
 *
 * Built here rather than taken from the kit because the kit has no checkbox and
 * a radio (`ChoiceRow`) would announce the wrong thing: these two answers are
 * independent, not alternatives. Everything about it comes from the theme —
 * colour, radius and the 44pt minimum target — and its state is carried in
 * words as well as in colour, because a filled blue square means nothing to
 * somebody who cannot see it.
 */
function ConsentCheck({
  checked,
  detail,
  disabled = false,
  onToggle,
  testID,
  title,
}: {
  checked: boolean;
  detail?: string;
  disabled?: boolean;
  onToggle: () => void;
  testID: string;
  title: string;
}) {
  const theme = useUiTheme();
  return (
    <Pressable
      accessibilityHint="Nothing is agreed until you tap Agree and continue."
      accessibilityLabel={title}
      accessibilityRole="checkbox"
      accessibilityState={{ checked, disabled }}
      disabled={disabled}
      onPress={onToggle}
      style={({ pressed }) => [
        styles.consentCheck,
        {
          backgroundColor: pressed ? theme.backgroundSelected : theme.backgroundElement,
          borderColor: checked ? theme.accent : theme.border,
          opacity: disabled ? 0.5 : 1,
        },
      ]}
      testID={testID}
    >
      <View
        style={[
          styles.box,
          {
            backgroundColor: checked ? theme.accent : 'transparent',
            borderColor: checked ? theme.accent : theme.border,
          },
        ]}
      >
        {/* The only glyph on the screen: state must never be colour alone. */}
        {checked ? <RNText style={[styles.tick, { color: theme.onAccent }]}>✓</RNText> : null}
      </View>
      <View style={styles.consentLabel}>
        <Body>{title}</Body>
        {detail === undefined ? null : <Caption>{detail}</Caption>}
        <Caption>{checked ? 'Agreed' : 'Not agreed yet'}</Caption>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  box: {
    alignItems: 'center',
    borderRadius: Radius.sm,
    borderWidth: 2,
    height: 28,
    justifyContent: 'center',
    marginTop: Spacing.half,
    width: 28,
  },
  consentCheck: {
    borderRadius: Radius.md,
    borderWidth: 1,
    flexDirection: 'row',
    gap: Spacing.three,
    minHeight: MIN_TOUCH_TARGET,
    padding: Spacing.three,
  },
  consentLabel: { flex: 1, gap: Spacing.one },
  tick: { fontSize: 18, fontWeight: '700', lineHeight: 22 },
});
