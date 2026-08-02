import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useCallback, useEffect } from 'react';
import { ActivityIndicator, View, StyleSheet } from 'react-native';

import { Body, Button, Callout, Screen, Stack, Title, useUiTheme } from '@/components/ui';
import { describeError } from '@/lib/api';
import { setObservabilityUser } from '@/lib/observability';

import { cancelAccountDeletion, fetchAccount } from './api';
import { readOnboardingCompleted } from './onboarding-progress';
import { loadStoredSession } from './secure-token-storage';
import { useSessionStore } from './session-store';
import { signOut } from './sign-out';

/**
 * Restores the session on launch and keeps the account snapshot current.
 *
 * The account snapshot is what the consent gate and the onboarding gate read,
 * so this provider does not render the app until it has one. That is a
 * deliberate trade: a moment of loading is preferable to briefly rendering a
 * product surface to someone whose consent state is still unknown.
 */

export const ACCOUNT_QUERY_KEY = ['account'] as const;

export function AuthSessionProvider({ children }: { children: ReactNode }) {
  const status = useSessionStore((state) => state.status);
  const account = useSessionStore((state) => state.account);
  const setAccount = useSessionStore((state) => state.setAccount);
  const restoreFinished = useSessionStore((state) => state.restoreFinished);
  const setOnboardingCompleted = useSessionStore((state) => state.setOnboardingCompleted);

  // ---- Restore from the keychain, exactly once per mount. -----------------
  useEffect(() => {
    let cancelled = false;

    async function restore(): Promise<void> {
      const stored = await loadStoredSession();
      if (cancelled) return;

      if (stored !== null) {
        setObservabilityUser(stored.userId);
        setOnboardingCompleted(await readOnboardingCompleted(stored.userId));
        if (cancelled) return;
      }
      restoreFinished(stored);
    }

    void restore();
    return () => {
      cancelled = true;
    };
  }, [restoreFinished, setOnboardingCompleted]);

  // ---- Keep the server-authoritative account snapshot fresh. --------------
  const accountQuery = useQuery({
    queryKey: ACCOUNT_QUERY_KEY,
    queryFn: fetchAccount,
    enabled: status === 'authenticated',
    staleTime: 60_000,
  });

  const accountData = accountQuery.data;
  useEffect(() => {
    if (accountData !== undefined) {
      setAccount(accountData);
    }
  }, [accountData, setAccount]);

  const awaitingAccount = status === 'authenticated' && account === null;

  if (awaitingAccount && accountQuery.isError) {
    return (
      <AccountUnavailable
        message={describeError(accountQuery.error)}
        onRetry={() => {
          void accountQuery.refetch();
        }}
      />
    );
  }

  if (status === 'restoring' || awaitingAccount) {
    return <BootstrapIndicator />;
  }

  if (account !== null && account.status === 'PENDING_DELETION') {
    return <PendingDeletionGate scheduledPurgeAt={account.scheduledPurgeAt} />;
  }

  return <>{children}</>;
}

// ---------------------------------------------------------------------------

function BootstrapIndicator() {
  const theme = useUiTheme();
  return (
    <View
      accessibilityLabel="Loading Family Location"
      accessible
      style={[styles.centred, { backgroundColor: theme.background }]}
    >
      <ActivityIndicator color={theme.accent} size="large" />
    </View>
  );
}

/**
 * Shown when we hold valid credentials but cannot load the account.
 *
 * The app deliberately stops here rather than continuing with unknown consent
 * and unknown membership. The wording says what we could not do, not what the
 * user did wrong, and sign-out stays available — being unable to reach the
 * server must never trap someone in the app.
 */
function AccountUnavailable({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Screen
      footer={
        <Stack gap="two">
          <Button label="Try again" onPress={onRetry} />
          <Button
            label="Sign out"
            onPress={() => {
              void signOut('USER_REQUESTED');
            }}
            variant="ghost"
          />
        </Stack>
      }
      testID="account-unavailable"
    >
      <Stack gap="three">
        <Title>We could not load your account</Title>
        <Body>{message}</Body>
        <Callout tone="info" title="Nothing is being shared right now">
          Family Location does not share your location while it cannot reach our servers, and it
          will not start sharing on its own when the connection returns.
        </Callout>
      </Stack>
    </Screen>
  );
}

/**
 * The account is scheduled for deletion. Signing in during the grace period is
 * an explicit signal the user wants to keep it, but we ask rather than assume —
 * silently resurrecting a deleted account is not a decision to make for someone.
 */
function PendingDeletionGate({ scheduledPurgeAt }: { scheduledPurgeAt: string | null }) {
  const purgeDate =
    scheduledPurgeAt === null
      ? null
      : new Date(scheduledPurgeAt).toLocaleDateString(undefined, {
          day: 'numeric',
          month: 'long',
          year: 'numeric',
        });

  const keepAccount = useCallback(async () => {
    await cancelAccountDeletion();
  }, []);

  return (
    <Screen
      footer={
        <Stack gap="two">
          <Button
            label="Keep my account"
            onPress={() => {
              void keepAccount();
            }}
          />
          <Button
            label="Sign out"
            onPress={() => {
              void signOut('USER_REQUESTED');
            }}
            variant="ghost"
          />
        </Stack>
      }
      testID="pending-deletion-gate"
    >
      <Stack gap="three">
        <Title>Your account is scheduled for deletion</Title>
        <Body>
          {purgeDate === null
            ? 'Your account and all of your location history will be permanently deleted soon.'
            : `Your account and all of your location history will be permanently deleted on ${purgeDate}.`}
        </Body>
        <Callout tone="warning" title="Sharing is off">
          Your location is not being shared with anyone while your account is scheduled for
          deletion.
        </Callout>
        <Body>
          If you did not mean to delete your account, you can keep it. If you did, do nothing and it
          will be deleted as planned.
        </Body>
      </Stack>
    </Screen>
  );
}

const styles = StyleSheet.create({
  centred: { alignItems: 'center', flex: 1, justifyContent: 'center' },
});
