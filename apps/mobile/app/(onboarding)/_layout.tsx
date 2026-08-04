import { Stack } from 'expo-router';

/**
 * First run, from "what is this app" to belonging to a family.
 *
 * The order is deliberate and is the product's promise in navigation form:
 *
 *   welcome        -> what Kinmap does, what is shared, and how to stop
 *   create-or-join -> the one structural choice, with neither option preselected
 *   create-family  -> POST /v1/families
 *   join-family    -> preview an invitation, then redeem it on an explicit tap
 *
 * NOTHING HERE ASKS FOR A PERMISSION. The location primer, the OS prompts and
 * the notification primer come after this group and are somebody else's
 * screens; a person reaches them already knowing what the app is for and who
 * they would be sharing with. Asking before that is how you get an install that
 * says "allow" without understanding, which is the pattern this product exists
 * to avoid.
 *
 * `initialRouteName` is load-bearing rather than cosmetic. An invitation
 * universal link opens `join-family` directly; without a declared initial route
 * the stack would contain that one screen and the user would be standing in a
 * flow with no way back. With it, `welcome` is always underneath, so every
 * screen in this group can be backed out of — by gesture, by the hardware back
 * button, and by the explicit control each screen renders.
 */
export const unstable_settings = { initialRouteName: 'welcome' };

export default function OnboardingLayout() {
  return (
    <Stack screenOptions={{ headerShown: false, gestureEnabled: true }}>
      {/*
       * The group's entry point has nothing behind it, so the swipe is turned
       * off here only — everywhere else in the group it stays on, alongside the
       * on-screen control, because a dead-end onboarding screen is a trap.
       */}
      <Stack.Screen name="welcome" options={{ gestureEnabled: false }} />
    </Stack>
  );
}
