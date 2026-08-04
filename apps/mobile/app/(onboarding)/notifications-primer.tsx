import * as Notifications from 'expo-notifications';
import { useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';

import {
  Body,
  Button,
  Callout,
  Caption,
  Card,
  LinkButton,
  Screen,
  Stack,
  Subtitle,
  Title,
} from '@/components/ui';
import { writeOnboardingCompleted } from '@/features/auth/onboarding-progress';
import { ROUTES } from '@/features/auth/routing';
import { useSessionStore } from '@/features/auth/session-store';

/**
 * The notification primer, and the end of onboarding.
 *
 * Notifications are not a nice-to-have in a location product. They are how a
 * person finds out that their own sharing turned on, that somebody asked to
 * follow them live, and that a new device signed in to their account. So the
 * list below is exhaustive rather than illustrative: every line is a category
 * the server can actually send (`NotificationCategorySchema` in
 * `features/settings/api/contracts.ts`), and there is nothing in it we do not
 * send.
 *
 * DECLINING IS A COMPLETE ANSWER. Both buttons finish setup, neither changes
 * anything about sharing, and the cost of saying no is stated before the choice
 * rather than argued afterwards. `onboarding-progress.ts` is explicit that
 * reaching the end without enabling anything still counts as finished —
 * re-running a primer until somebody gives in is the pattern this product does
 * not ship.
 *
 * It also writes nothing to the server. The per-category switches already have
 * a home in Settings, and switching them on from an onboarding screen would be
 * deciding on the user's behalf.
 */

const ALERTS: ReadonlyArray<{ id: string; title: string; detail: string }> = [
  {
    id: 'sharing-state',
    title: 'When your own sharing changes',
    detail:
      'Turned on, paused, resumed or stopped — including when it was this phone that did it. This is how you find out you can be seen without having to open the app and check.',
  },
  {
    id: 'live-session-request',
    title: 'When somebody asks to follow you live',
    detail:
      'A live session is a request you have to accept. The notification is the request; if you never see it, nothing happens.',
  },
  {
    id: 'arrival-departure',
    title: 'When a family member arrives or leaves',
    detail: 'Only for places you have saved, and only for people who are sharing with you.',
  },
  {
    id: 'family-membership',
    title: 'When your family changes',
    detail: 'Somebody joins, somebody leaves, or an invitation you sent is used.',
  },
  {
    id: 'low-battery',
    title: 'When a phone is nearly out of battery',
    detail: 'So a position going stale reads as "their battery died" rather than something worse.',
  },
];

export default function NotificationsPrimerScreen() {
  const router = useRouter();
  const userId = useSessionStore((state) => state.session?.userId ?? null);
  const setOnboardingCompleted = useSessionStore((state) => state.setOnboardingCompleted);
  const [busy, setBusy] = useState(false);
  const finishing = useRef(false);

  /**
   * Marks onboarding done and leaves the flow.
   *
   * The device-local record is written first so a relaunch does not drop the
   * user back into onboarding, then the in-memory flag flips and rule 5 of the
   * routing guard stops applying. A failed write is deliberately not fatal (see
   * `onboarding-progress.ts`): the worst case is seeing these screens again,
   * which is safe, whereas skipping a primer somebody never saw is not.
   */
  const finish = useCallback(async (): Promise<void> => {
    if (finishing.current) return;
    finishing.current = true;

    if (userId !== null) {
      await writeOnboardingCompleted(userId);
    }
    setOnboardingCompleted(true);
    router.replace(ROUTES.home);
  }, [router, setOnboardingCompleted, userId]);

  const allowThenFinish = useCallback(async (): Promise<void> => {
    setBusy(true);
    try {
      // The answer is deliberately not branched on. Granted or denied, setup is
      // over and nothing else about the account changes, so there is no outcome
      // screen here to argue with a "no".
      await Notifications.requestPermissionsAsync();
    } catch {
      // No notification module in this build (Expo Go, web). Not a reason to
      // strand somebody at the end of setup.
    }
    await finish();
  }, [finish]);

  return (
    <Screen
      footer={
        <Stack gap="two">
          <Button
            accessibilityHint="Asks your phone for permission to send the alerts listed above, then finishes setup. It does not change your sharing."
            busy={busy}
            label="Allow notifications"
            onPress={() => {
              void allowThenFinish();
            }}
            testID="notifications-primer-allow"
          />
          <Button
            accessibilityHint="Finishes setup without asking for notification permission. Nothing about sharing changes, and you can allow them later from your phone's Settings."
            disabled={busy}
            label="Finish without notifications"
            onPress={() => {
              void finish();
            }}
            testID="notifications-primer-decline"
            variant="ghost"
          />
        </Stack>
      }
      testID="onboarding-notifications-primer"
    >
      <Stack gap="four">
        <LinkButton
          accessibilityHint="Returns to the location permission screen."
          label="Back"
          onPress={() => {
            if (router.canGoBack()) {
              router.back();
              return;
            }
            router.replace(ROUTES.permissions);
          }}
          testID="notifications-primer-back"
        />

        <Stack gap="two">
          <Title>What we would notify you about</Title>
          <Subtitle>
            Every notification Kinmap can send is listed here. There are no others, and there is no
            marketing unless you switch it on yourself.
          </Subtitle>
        </Stack>

        {ALERTS.map((alert) => (
          <Card key={alert.id} testID={`notifications-primer-${alert.id}`}>
            <Body>{alert.title}</Body>
            <Caption>{alert.detail}</Caption>
          </Card>
        ))}

        <Callout title="If you say no" tone="info">
          Nothing about sharing changes and nothing stops working. You will simply have to open the
          app to see whether your location is being shared, instead of your phone telling you. You
          can allow notifications later from your phone's Settings.
        </Callout>

        <Caption>
          Once notifications are on you can switch off any single category, and set quiet hours, in
          Settings. Quiet hours silence everything, including a request to share your live location
          — a request you do not see is simply never accepted, so nothing starts sharing while you
          are not looking.
        </Caption>
      </Stack>
    </Screen>
  );
}
