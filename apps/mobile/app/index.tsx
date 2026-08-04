import { Redirect } from 'expo-router';
import { useEffect } from 'react';

import { resolveRouteDecision } from '@/features/auth/routing';
import { useSession } from '@/features/auth/use-session';
import { recordGuardRedirect } from '@/lib/observability';

/**
 * `/` is a decision, not a screen.
 *
 * Everything this route knows comes from `resolveRouteDecision`, which is the
 * one place the precedence between "no session", "challenge outstanding",
 * "consent out of date" and "onboarding unfinished" is written down. Repeating
 * any part of that ordering here would create a second, weaker copy of the
 * guard — and the weaker copy is the one that eventually lets somebody past.
 *
 * The guard is asked about the root path, so `segments` is empty. For a fully
 * set-up user that yields `stay`, which cannot be honoured: `/` has nothing to
 * render. `stay` therefore means "go to the product surface", and the product
 * surface is the `(app)` group. `ROUTES.home` is `/` — this file — so
 * redirecting to it would loop; that is why the destination below is written as
 * the group href and not as `ROUTES.home`.
 */

/** `useSegments()` for `/`. Hoisted so the guard input is referentially stable. */
const ROOT_SEGMENTS: readonly string[] = [];

/**
 * The authenticated group. `(app)/_layout.tsx` re-runs the same guard, so this
 * redirect is a convenience, never the thing keeping anyone out.
 */
const APP_GROUP_HREF = '/(app)';

export default function EntryRoute() {
  const session = useSession();

  const decision = resolveRouteDecision({
    status: session.status,
    challenge: session.challenge,
    consentRequired: session.consent.acceptanceRequired,
    hasFamily: session.hasFamily,
    onboardingCompleted: session.onboardingCompleted,
    segments: ROOT_SEGMENTS,
  });

  const reason = decision.type === 'redirect' ? decision.reason : null;
  const href = decision.type === 'redirect' ? decision.href : null;

  useEffect(() => {
    if (reason === null || href === null) return;
    // A closed enum and a static route literal. No identifier, no path
    // parameter, and nothing positional can reach this breadcrumb.
    recordGuardRedirect(reason, href);
  }, [reason, href]);

  // The keychain read is still in flight. Navigating now would race the restore
  // and can flash sign-in at somebody who is already signed in.
  if (session.isRestoring) return null;

  if (decision.type === 'redirect') {
    return <Redirect href={decision.href} />;
  }

  return <Redirect href={APP_GROUP_HREF} />;
}
