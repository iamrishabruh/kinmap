import { useRouter } from 'expo-router';

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

/**
 * The first screen a new account sees.
 *
 * It asks for nothing. No permission, no toggle, no field — the only control
 * that does anything is "Continue". That is the point: a person cannot
 * meaningfully agree to being located until they have been told, in their own
 * language, what is collected, who receives it, and how they make it stop. This
 * screen is where that is said, and it is said before the first ask rather than
 * inside it.
 *
 * The copy below is deliberately concrete and mirrors the public claims on
 * kinmap.app and in the Terms of Service. Two rules govern it:
 *
 *   1. No sentence may be true only of the happy path. "You can stop at any
 *      time" is stated because it is implemented — pausing and leaving take
 *      effect immediately, and the settings surface proves it.
 *   2. No sentence may be vague enough to survive a change in behaviour.
 *      "Kinmap needs your location" would still read fine if the app started
 *      collecting in the background without telling anyone. "Your family sees
 *      where you are while sharing is on, and you can turn it off" would not.
 */
export default function WelcomeScreen() {
  const router = useRouter();

  return (
    <Screen
      footer={
        <Button
          accessibilityHint="Goes to the next step, where you choose whether to create a family or join one with an invitation. Nothing is shared yet."
          label="Continue"
          onPress={() => {
            router.push(ROUTES.createOrJoin);
          }}
          testID="welcome-continue"
        />
      }
      testID="onboarding-welcome"
    >
      <Stack gap="four">
        <Stack gap="two">
          <Title>Kinmap shares where you are, with people you choose</Title>
          <Subtitle>
            And it shows you where they are. That is the whole app. Here is exactly what that means
            before you set anything up.
          </Subtitle>
        </Stack>

        <Card testID="welcome-what-is-shared">
          <Body>What is shared</Body>
          <Caption>
            Your device's location — a point on a map and how recently it was updated — plus the
            name you choose to show. Nothing else. Not your messages, not your photos, not what you
            do in other apps. We do not sell location data and we do not give it to advertisers.
          </Caption>
        </Card>

        <Card testID="welcome-who-can-see">
          <Body>Who can see it</Body>
          <Caption>
            Only the people in a family you have joined. You join a family by accepting an
            invitation — nobody can add you without one, and you will see who invited you before you
            decide. If you leave a family, or remove someone from yours, their access ends straight
            away.
          </Caption>
        </Card>

        <Card testID="welcome-how-to-stop">
          <Body>How you stop</Body>
          <Caption>
            Sharing stays off until you switch it on. After that you can pause it or switch it off
            entirely, at any moment, from inside the app — your family stops seeing you immediately.
            The app always shows you whether sharing is currently on, so there is no state in which
            you are being located quietly.
          </Caption>
        </Card>

        <Callout title="Nothing is being shared yet" tone="info">
          Setting up Kinmap does not switch sharing on. We will ask for that separately, in a
          moment, and explain what each permission is for first. You can say no and keep using the
          app — you simply will not appear on the map.
        </Callout>

        <Caption>
          Kinmap is not an emergency or safety service. If someone is in danger, call your local
          emergency number.
        </Caption>
      </Stack>
    </Screen>
  );
}
