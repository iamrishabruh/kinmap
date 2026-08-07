import { Stack } from 'expo-router';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

/**
 * The (auth) group: the only surface reachable without a session.
 *
 * The routing guard in `@/features/auth/routing` decides *whether* a person may
 * be here (rules 2 and 3) and pins them to a challenge when one is outstanding.
 * This layout owns only what happens *within* the group, and that is one thing:
 * the short-lived state that has to survive the hop from sign-up to
 * verify-email, and from verify-email back to sign-in.
 *
 * ---------------------------------------------------------------------------
 * WHY THE ADDRESS LIVES HERE AND NOT IN A ROUTE PARAM
 * ---------------------------------------------------------------------------
 * `ConfirmSignUp` needs the address verbatim — Cognito identifies the account
 * by it — so verify-email cannot work from a mask. But `api.ts` is explicit
 * that the full address travels no further than the screen it was typed on: it
 * is never a route parameter and never telemetry. A route parameter would put
 * it in the navigation state, which is serialised, restored, and shows up in
 * deep links and in any navigation breadcrumb.
 *
 * So it is held here, in React state, for the length of one sign-up attempt:
 * memory only, never persisted, never logged, gone when the group unmounts.
 * The masked form (`codeSentTo`) is the only one any screen renders.
 */

export type PendingEmailVerification = {
  /**
   * The address the account was created with, exactly as Cognito has it.
   * Passed to `confirmSignUp` and to nothing else.
   */
  readonly email: string;
  /**
   * Already masked — by Cognito if it told us where it sent the code, by
   * `maskEmail` otherwise. This is the only form that reaches a rendered
   * string.
   */
  readonly codeSentTo: string;
  /**
   * `YYYY-MM-DD`, as attested on the sign-up screen, carried to `ConfirmSignUp`
   * so PostConfirmation can record the age band. Held on exactly the same terms
   * as the address above — memory only, one attempt, never persisted, never a
   * route parameter, never rendered — because a date of birth is a strong
   * identifier and, next to location history, a much stronger one.
   */
  readonly birthDate: string;
};

type AuthFlowState = {
  readonly pendingVerification: PendingEmailVerification | null;
  /**
   * Set once an account is confirmed, so sign-in can pre-fill the field and say
   * so rather than making someone retype an address they entered a moment ago.
   *
   * This is the one place the full address is handed to a screen other than the
   * one it was typed on, and it is deliberate: it goes into a text input the
   * person was about to fill in themselves, on the same device, seconds later.
   * It is not persisted, not a route parameter, and not telemetry — the three
   * things `api.ts` rules out — and sign-in drops it as soon as it is used.
   */
  readonly confirmedEmail: string | null;
};

export type AuthFlow = AuthFlowState & {
  /** Sign-up created an account that still needs its emailed code. */
  readonly beginEmailVerification: (pending: PendingEmailVerification) => void;
  /** The user backed out. Nothing is kept. */
  readonly abandonEmailVerification: () => void;
  /** The account is confirmed and can now be signed in to. */
  readonly confirmAccount: (email: string) => void;
  readonly clearConfirmedEmail: () => void;
};

const EMPTY: AuthFlowState = { pendingVerification: null, confirmedEmail: null };

const AuthFlowContext = createContext<AuthFlow | null>(null);

/**
 * @throws when called outside the (auth) group, which would mean a screen had
 * been moved out of the group without its state moving with it.
 */
export function useAuthFlow(): AuthFlow {
  const flow = useContext(AuthFlowContext);
  if (flow === null) {
    throw new Error('useAuthFlow() may only be used inside the (auth) group.');
  }
  return flow;
}

function AuthFlowProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthFlowState>(EMPTY);

  // Every updater is pure and dependency-free, so none of them goes stale and
  // none of them runs twice to a different result under StrictMode.
  const beginEmailVerification = useCallback((pending: PendingEmailVerification) => {
    setState({ pendingVerification: pending, confirmedEmail: null });
  }, []);

  const abandonEmailVerification = useCallback(() => {
    setState((current) => ({ ...current, pendingVerification: null }));
  }, []);

  const confirmAccount = useCallback((email: string) => {
    setState({ pendingVerification: null, confirmedEmail: email });
  }, []);

  const clearConfirmedEmail = useCallback(() => {
    setState((current) => ({ ...current, confirmedEmail: null }));
  }, []);

  const value = useMemo<AuthFlow>(
    () => ({
      ...state,
      beginEmailVerification,
      abandonEmailVerification,
      confirmAccount,
      clearConfirmedEmail,
    }),
    [state, beginEmailVerification, abandonEmailVerification, confirmAccount, clearConfirmedEmail],
  );

  return <AuthFlowContext.Provider value={value}>{children}</AuthFlowContext.Provider>;
}

export default function AuthLayout() {
  return (
    <AuthFlowProvider>
      {/*
        Headers are off here as well as at the root: `screenOptions` on the root
        Stack applies to the root's own screens, and this nested navigator would
        otherwise default a native header back on. Every screen in this group
        therefore carries its own way back, in the content, where it is part of
        the reading order rather than a chrome affordance.

        Screens owned by other parts of the auth surface (forgot-password,
        reset-password, terms-acceptance) are deliberately not listed: expo-router
        registers them from the file system, and naming them here would only be a
        second place to keep in step.
      */}
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="sign-in" />
        <Stack.Screen name="sign-up" />
        <Stack.Screen name="verify-email" />
        <Stack.Screen
          name="mfa-challenge"
          // A swipe back would land on sign-in, which the guard immediately
          // bounces back here (routing rule 3) — a gesture that visibly does
          // nothing. The way out of a challenge is the explicit "Cancel and
          // start again" on the screen, which abandons the sign-in properly.
          options={{ gestureEnabled: false }}
        />
      </Stack>
    </AuthFlowProvider>
  );
}
