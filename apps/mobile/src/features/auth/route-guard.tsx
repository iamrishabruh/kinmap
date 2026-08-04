import { useRouter, useSegments } from 'expo-router';
import { useEffect, type ReactNode } from 'react';

import { resolveRouteDecision } from './routing';
import { useSession } from './use-session';

/**
 * Puts the routing rules into effect.
 *
 * `routing.ts` has always contained the whole decision — which group a person
 * belongs in given their session, a pending challenge, whether consent is
 * current, whether they are in a family, and whether onboarding finished. It had
 * no caller. Nothing evaluated it, so a cold start landed on the unmatched-route
 * screen and a successful sign-in left the user sitting on the sign-in form.
 *
 * The screens deliberately do not navigate themselves after establishing a
 * session: where somebody should land depends on facts only this guard can see
 * together, and two places deciding would race. A screen's job is to finish its
 * step; this decides what the next one is.
 *
 * `replace`, never `push`: a redirect the user could swipe back past would drop
 * them behind the guard that just moved them, and the guard would move them
 * again — a loop they cannot escape.
 */
export function RouteGuard({ children }: { children: ReactNode }) {
  const router = useRouter();
  const segments = useSegments();
  const { status, challenge, consent, hasFamily, onboardingCompleted } = useSession();

  const decision = resolveRouteDecision({
    status,
    challenge,
    consentRequired: consent.acceptanceRequired,
    hasFamily,
    onboardingCompleted,
    segments,
  });

  const href = decision.type === 'redirect' ? decision.href : null;

  useEffect(() => {
    if (href === null) {
      return;
    }
    router.replace(href);
  }, [href, router]);

  return <>{children}</>;
}
