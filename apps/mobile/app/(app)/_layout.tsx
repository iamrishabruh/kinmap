import { Redirect, Stack, useSegments } from 'expo-router';
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { resolveRouteDecision } from '@/features/auth/routing';
import { useSession } from '@/features/auth/use-session';
import { LiveSessionIndicator } from '@/features/live/live-session-indicator';
import { usePalette } from '@/features/ui/palette';
import { recordGuardRedirect } from '@/lib/observability';

/**
 * The authenticated product surface.
 *
 * Two things live here and nowhere else.
 *
 * 1. THE GUARD. `resolveRouteDecision` runs on every render of this group with
 *    the real `useSegments()` output. `app/index.tsx` also redirects, but that
 *    is a convenience for people arriving at `/`; a deep link, a notification
 *    tap or a restored navigation state can land inside `(app)` without ever
 *    passing through `/`. This layout is what makes those paths safe, so it
 *    re-derives the decision rather than trusting that something upstream did.
 *
 * 2. THE LIVE INDICATOR. Mounted above the navigator so it is present on every
 *    screen in the group and cannot be scrolled away, covered or dismissed. It
 *    is the difference between this product and a tracking app: if somebody is
 *    following you right now, you can see it without tapping anything. Do not
 *    move it below the `Stack`, and do not make it conditional on the route.
 */
export default function AppGroupLayout() {
  const palette = usePalette();
  const segments = useSegments();
  const session = useSession();

  const decision = resolveRouteDecision({
    status: session.status,
    challenge: session.challenge,
    consentRequired: session.consent.acceptanceRequired,
    hasFamily: session.hasFamily,
    onboardingCompleted: session.onboardingCompleted,
    segments,
  });

  const reason = decision.type === 'redirect' ? decision.reason : null;
  const href = decision.type === 'redirect' ? decision.href : null;

  useEffect(() => {
    if (reason === null || href === null) return;
    recordGuardRedirect(reason, href);
  }, [reason, href]);

  // Splash is still up and the session is still being restored. Rendering the
  // group now would mount the map's queries against an unknown identity.
  if (session.isRestoring) return null;

  if (decision.type === 'redirect') {
    return <Redirect href={decision.href} />;
  }

  return (
    <SafeAreaView
      edges={['top', 'left', 'right']}
      style={[styles.root, { backgroundColor: palette.background }]}
    >
      <LiveSessionIndicator />
      <View style={styles.navigator}>
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: palette.background },
          }}
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  navigator: { flex: 1 },
});
