import { useRouter } from 'expo-router';

import { LIMITS } from '@family/contracts';

import {
  Body,
  Button,
  Callout,
  Caption,
  Card,
  Screen,
  Stack,
  Subtitle,
  Title,
} from '@/components/ui';
import { ROUTES } from '@/features/auth/routing';
import { SAFE_DEFAULT_ENGINE_CONFIG } from '@/features/location/config/defaults';

/**
 * The location primer — the screen before the operating system's own dialog.
 *
 * WHY IT EXISTS. iOS asks for a location permission exactly once. Someone who
 * taps "Don't Allow" because they did not understand the question cannot be
 * asked again by the app; recovering means talking them through Settings, and
 * most people never do. So the explanation comes first, in our own words, on a
 * screen they read at their own pace and can leave — and the OS dialog is the
 * second thing they see, not the first.
 *
 * The copy says "on iPhone" where the one-shot behaviour is iOS-specific.
 * Android will usually offer its dialog a second time, and claiming otherwise
 * to make the moment feel weightier would be manufacturing urgency.
 *
 * WHAT IT MUST NOT DO.
 *
 *   - It does not request anything. Nothing here touches expo-location; the
 *     only controls are two navigations.
 *   - It does not enable sharing, and it says so out loud. Granting an OS
 *     permission is not consent to share: `evaluateConsent()` in
 *     `features/location/engine/consent.ts` still blocks on
 *     `SHARING_NOT_ENABLED` afterwards, and that switch is turned on later, by
 *     the user, on purpose.
 *   - It never reads or renders a position. No coordinate exists anywhere in
 *     this flow, so none can reach a log line, an analytics event, or a
 *     screenshot.
 *
 * The numbers below are read from the shipped engine defaults and the shared
 * limits rather than typed in as prose, so what is promised here cannot drift
 * away from what the app actually does.
 */

/** Default cadence while the user is moving, in whole minutes. */
const MOVING_INTERVAL_MINUTES = Math.round(
  SAFE_DEFAULT_ENGINE_CONFIG.targetFreshnessSeconds.PASSIVE / 60,
);

/** Default cadence while the user is still, in whole minutes. */
const STILL_INTERVAL_MINUTES = Math.round(
  SAFE_DEFAULT_ENGINE_CONFIG.targetFreshnessSeconds.STATIONARY / 60,
);

/** Movement required before a new point is worth recording, in metres. */
const MOVING_DISTANCE_METRES = SAFE_DEFAULT_ENGINE_CONFIG.distanceFilters.PASSIVE;

export default function LocationPrimerScreen() {
  const router = useRouter();

  return (
    <Screen
      footer={
        <Stack gap="two">
          <Button
            accessibilityHint="Goes to the next screen, where you choose which level of location access to give. Your phone's dialog appears only after you have chosen there."
            label="Continue"
            onPress={() => {
              router.push(ROUTES.permissions);
            }}
            testID="location-primer-continue"
          />
          <Button
            accessibilityHint="Skips the location permission. Nothing is granted and nothing is shared. You can set it up later from Settings."
            label="Set up location later"
            onPress={() => {
              router.push(ROUTES.notificationsPrimer);
            }}
            testID="location-primer-skip"
            variant="ghost"
          />
        </Stack>
      }
      testID="onboarding-location-primer"
    >
      <Stack gap="four">
        <Stack gap="two">
          <Title>Before your phone asks about location</Title>
          <Subtitle>
            Exactly what Kinmap would collect, how often, who would see it, and how you stop it.
            Worth reading first: on iPhone the permission is asked once, and after that only your
            phone's own Settings can change it.
          </Subtitle>
        </Stack>

        <Callout title="Nothing is being shared yet" tone="info">
          Sharing is off, and this screen does not turn it on. Even after you allow location, your
          family sees nothing until you switch sharing on yourself.
        </Callout>

        <Card testID="location-primer-what">
          <Body>What is collected</Body>
          <Caption>
            Where your phone is and how accurate that reading is, plus the time it was taken. Each
            point also carries your battery level and whether the phone is still, walking or in a
            vehicle, so your family can tell "their phone died" from "they have stopped answering".
            Nothing else — no microphone, no contacts, no browsing history, and no identifier that
            follows you into other apps.
          </Caption>
        </Card>

        <Card testID="location-primer-how-often">
          <Body>How often</Body>
          <Caption>
            While you are moving: a new point after roughly {MOVING_DISTANCE_METRES} metres, and at
            most about every {MOVING_INTERVAL_MINUTES} minutes. While you are still: about every{' '}
            {STILL_INTERVAL_MINUTES} minutes. Less often than either when your battery is low. Those
            are the app's targets, not a promise — your phone has the final say and will hold points
            back to protect its battery.
          </Caption>
        </Card>

        <Card testID="location-primer-who">
          <Body>Who can see it</Body>
          <Caption>
            The people in your family, and only the ones you have not hidden yourself from — you
            choose per person and can change your mind per person. Not advertisers, not other apps.
            It is never sold and never used to build a profile of you, and support staff cannot look
            up where you are.
          </Caption>
        </Card>

        <Card testID="location-primer-retention">
          <Body>How long it is kept</Body>
          <Caption>
            On a paid plan, history is kept for {LIMITS.HISTORY_RETENTION_DAYS} days and then
            deleted automatically. On the free plan there is no history at all — only your latest
            position, replaced each time it updates. You can delete your history yourself at any
            time, and see who has looked at your location, in Settings under Privacy.
          </Caption>
        </Card>

        <Card testID="location-primer-how-to-stop">
          <Body>How you stop it</Body>
          <Caption>
            Pause from the home screen and collection stops on this phone straight away — it does
            not wait for the network to agree. Or turn sharing off completely in Settings, leave the
            family, or revoke the permission in your phone's own Settings. Any one of those is
            enough, and none of them needs us.
          </Caption>
        </Card>

        <Caption>
          Whenever sharing is on, the app shows you that it is on. There is no hidden mode, and
          nobody — including us — can turn your sharing back on for you.
        </Caption>
      </Stack>
    </Screen>
  );
}
