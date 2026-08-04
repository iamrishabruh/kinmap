import { useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import {
  Body,
  Button,
  Caption,
  ChoiceRow,
  LinkButton,
  Screen,
  Stack,
  Title,
} from '@/components/ui';
import { ROUTES } from '@/features/auth/routing';

/**
 * The one structural choice in onboarding: start a family, or join one.
 *
 * NEITHER OPTION IS PRESELECTED, and "Continue" stays disabled until the person
 * picks one. A default selection on a screen like this is a soft dark pattern:
 * it converts "I tapped the big button" into "I chose to create a family",
 * which is a claim about intent that we would have made up. The cost is one
 * extra tap and it is worth it.
 *
 * There is no "skip" here, and offering one would be dishonest — the routing
 * guard keeps a signed-in user without a family inside this group (rule 5 in
 * `features/auth/routing.ts`), so a skip control would be a button that
 * visibly does nothing. Backing out is still possible: this screen returns to
 * `welcome`, and sharing has not been enabled by anything up to this point.
 */

type Choice = 'CREATE' | 'JOIN';

export default function CreateOrJoinScreen() {
  const router = useRouter();
  const [choice, setChoice] = useState<Choice | null>(null);

  return (
    <Screen
      footer={
        <Button
          accessibilityHint={
            choice === 'JOIN'
              ? 'Opens the screen where you enter an invitation. You will see who invited you before you join anything.'
              : 'Opens the screen where you name your new family. Nothing is shared until you invite someone and turn sharing on.'
          }
          disabled={choice === null}
          label="Continue"
          onPress={() => {
            if (choice === null) return;
            router.push(choice === 'CREATE' ? ROUTES.createFamily : ROUTES.joinFamily);
          }}
          testID="create-or-join-continue"
        />
      }
      testID="onboarding-create-or-join"
    >
      <Stack gap="four">
        <LinkButton
          accessibilityHint="Returns to the introduction."
          label="Back"
          onPress={() => {
            if (router.canGoBack()) {
              router.back();
              return;
            }
            router.replace(ROUTES.welcome);
          }}
          testID="create-or-join-back"
        />

        <Stack gap="two">
          <Title>Create a family, or join one</Title>
          <Body>
            Kinmap works in families: a small group of people who have each agreed to share with the
            others. Everyone you can see, and everyone who can see you, comes from a family you are
            in.
          </Body>
        </Stack>

        <View accessibilityRole="radiogroup" accessibilityLabel="How would you like to start?">
          <Stack gap="two">
            <ChoiceRow
              description="You become the owner. The family is empty until you invite someone and they accept, and nobody can see you until you turn sharing on."
              onPress={() => {
                setChoice('CREATE');
              }}
              selected={choice === 'CREATE'}
              testID="choice-create-family"
              title="Create a new family"
            />
            <ChoiceRow
              description="Someone has sent you an invitation link or code. You will see the family's name and who invited you before you decide to join."
              onPress={() => {
                setChoice('JOIN');
              }}
              selected={choice === 'JOIN'}
              testID="choice-join-family"
              title="Join with an invitation"
            />
          </Stack>
        </View>

        <Caption>
          You can belong to more than one family later, and you can leave any of them at any time.
        </Caption>
      </Stack>
    </Screen>
  );
}
