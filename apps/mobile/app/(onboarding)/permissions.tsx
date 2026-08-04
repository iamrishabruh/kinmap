import * as Location from 'expo-location';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, View } from 'react-native';

import {
  Body,
  Button,
  Callout,
  Caption,
  Card,
  ChoiceRow,
  LinkButton,
  Screen,
  Stack,
  StatusRow,
  Subtitle,
  Title,
} from '@/components/ui';
import { ROUTES } from '@/features/auth/routing';
import {
  APP_SETTINGS,
  openSettingsDeepLink,
} from '@/features/settings/diagnostics/settings-deep-links';

/**
 * The screen that asks the operating system.
 *
 * WHY expo-location AND NOT THE ENGINE. `NativeLocationEngine`
 * (@family/contracts) can *read* a permission but has no method to request one,
 * deliberately: the engine is the thing that collects, and asking is not
 * collecting. `expo-location` is the app's single sanctioned permission
 * surface — it is what the Info.plist strings and the Android manifest entries
 * in `app.config.ts` were written for. This screen reads and requests through
 * it and nothing else, and builds no second path to anything.
 *
 * WHAT IT MUST NOT DO.
 *
 *   - It must not enable sharing. Granting an OS permission is not consent to
 *     share; `evaluateConsent()` still blocks on `SHARING_NOT_ENABLED` after
 *     everything here succeeds, and that is correct. Both the choosing state
 *     and the result state say so, because someone who believes a permission
 *     started sharing is someone who is wrong about who can see them.
 *   - It must not read a position. `getCurrentPositionAsync` and its relatives
 *     are never called, so no coordinate exists on this screen to leak into a
 *     log line, an analytics event, or a screenshot.
 *   - It must not pre-select an answer. Neither option is highlighted until the
 *     user picks one; a pre-ticked "Always" would be consent we invented.
 *   - It must not trap anyone. "Decide later" is always there, does exactly
 *     what it says, and carries the flow forward.
 *
 * ALWAYS IS OFFERED HONESTLY OR NOT AT ALL. It exists for one reason — so a
 * family member can be seen while their phone is in their pocket — and that is
 * the reason given. "While I am using the app" is a complete answer with its
 * own screen space, not a decoy, and the things it stops working are listed
 * rather than hinted at.
 */

// ---------------------------------------------------------------------------
// The decision, as data
//
// Everything the screen works out about the OS answer happens in the pure
// functions below. They take plain facts rather than expo types, so the mapping
// from "what the OS said" to "what we tell the user" can be reasoned about, and
// tested, without a device.
// ---------------------------------------------------------------------------

/** The two levels this product offers. Both are real choices. */
export type LocationChoice = 'WHILE_USING' | 'ALWAYS';

export type LocationAccessFacts = {
  foregroundGranted: boolean;
  /** False once the OS has stopped offering its dialog; only Settings remains. */
  foregroundCanAskAgain: boolean;
  backgroundGranted: boolean;
  /** iOS 14+ "Precise: Off", or an Android coarse-only grant. */
  approximateOnly: boolean;
  /** The device-wide location switch, independent of this app's grant. */
  locationServicesEnabled: boolean;
};

export type LocationAccessLevel = 'NONE' | 'WHILE_USING' | 'ALWAYS';

export type LocationAccessSummary = {
  level: LocationAccessLevel;
  approximateOnly: boolean;
  locationServicesEnabled: boolean;
  /**
   * True when the app has run out of ways to ask and the phone's own Settings
   * are the only route left. Shown so the user is told the truth about their
   * options instead of being handed a button that would do nothing.
   */
  onlySettingsCanChangeIt: boolean;
};

export function summariseLocationAccess(facts: LocationAccessFacts): LocationAccessSummary {
  const level: LocationAccessLevel = !facts.foregroundGranted
    ? 'NONE'
    : facts.backgroundGranted
      ? 'ALWAYS'
      : 'WHILE_USING';

  return {
    level,
    // "Approximate" only means something once something was granted.
    approximateOnly: level !== 'NONE' && facts.approximateOnly,
    locationServicesEnabled: facts.locationServicesEnabled,
    onlySettingsCanChangeIt: !facts.foregroundGranted && !facts.foregroundCanAskAgain,
  };
}

export type LocationAccessDescription = {
  /** Spelled out. Status in this app is never carried by colour alone. */
  statusValue: string;
  tone: 'success' | 'warning' | 'danger';
  /** What genuinely works at this level. Empty when nothing does. */
  works: string[];
  /** What genuinely does not. Never softened, never left out. */
  limits: string[];
};

/**
 * Turns the summary into the exact words the user reads.
 *
 * Every branch names a concrete consequence. "Some features may be limited" is
 * the kind of sentence that lets a person believe their family can see them get
 * home safely when they cannot, so it does not appear here.
 */
export function describeLocationAccess(summary: LocationAccessSummary): LocationAccessDescription {
  const works: string[] = [];
  const limits: string[] = [];

  if (summary.level === 'ALWAYS') {
    works.push(
      'Once you turn sharing on, your family can see where you are even when the app is closed.',
    );
    works.push('Arrival and departure alerts for places you save will work.');
  } else if (summary.level === 'WHILE_USING') {
    works.push(
      'Once you turn sharing on, your family can see where you are while the app is open on your screen.',
    );
    limits.push(
      'While the app is closed or your phone is in your pocket, your position stops updating and goes stale for your family.',
    );
    limits.push('Arrival and departure alerts will not fire.');
    limits.push(
      "To change this to Always later, open your phone's Settings, find Kinmap, then Location.",
    );
  } else {
    limits.push('Your family will not be able to see where you are at all.');
    limits.push('You can still see them, if they have chosen to share with you.');
  }

  if (summary.approximateOnly) {
    limits.push(
      'Your phone is giving an approximate area rather than a precise position, so the map will show a neighbourhood rather than a street.',
    );
  }

  if (!summary.locationServicesEnabled) {
    limits.push(
      'Location Services is switched off for your whole phone, so nothing can be shared until you turn it back on.',
    );
  }

  if (summary.onlySettingsCanChangeIt) {
    limits.push(
      "Your phone will not ask again. The only way to change this now is in your phone's own Settings.",
    );
  }

  const statusValue =
    summary.level === 'ALWAYS'
      ? summary.approximateOnly
        ? 'Always, approximate only'
        : 'Always'
      : summary.level === 'WHILE_USING'
        ? summary.approximateOnly
          ? 'While using the app, approximate only'
          : 'While using the app'
        : 'Not granted';

  const tone: 'success' | 'warning' | 'danger' =
    summary.level === 'NONE'
      ? 'danger'
      : summary.approximateOnly || !summary.locationServicesEnabled
        ? 'warning'
        : 'success';

  return { statusValue, tone, works, limits };
}

// ---------------------------------------------------------------------------
// Talking to the OS
// ---------------------------------------------------------------------------

function toFacts(
  foreground: Location.LocationPermissionResponse,
  background: Location.PermissionResponse | null,
  locationServicesEnabled: boolean,
): LocationAccessFacts {
  return {
    foregroundGranted: foreground.granted,
    foregroundCanAskAgain: foreground.canAskAgain,
    backgroundGranted: background?.granted ?? false,
    approximateOnly:
      foreground.ios?.accuracy === 'reduced' || foreground.android?.accuracy === 'coarse',
    locationServicesEnabled,
  };
}

/**
 * The background grant, or null when the platform will not answer.
 *
 * Some Android builds throw here rather than report, and a thrown background
 * read must not be mistaken for "location is unavailable" — the foreground
 * grant is the one that decides whether anything works at all.
 */
async function readBackgroundPermission(): Promise<Location.PermissionResponse | null> {
  try {
    return await Location.getBackgroundPermissionsAsync();
  } catch {
    return null;
  }
}

/** Reads the current state without prompting. Safe to call on every foreground. */
async function readLocationAccess(): Promise<LocationAccessFacts> {
  const [foreground, background, servicesEnabled] = await Promise.all([
    Location.getForegroundPermissionsAsync(),
    readBackgroundPermission(),
    Location.hasServicesEnabledAsync(),
  ]);
  return toFacts(foreground, background, servicesEnabled);
}

/**
 * Requests the level the user asked for, and nothing beyond it.
 *
 * Background is requested only when the user chose "Always", and only once
 * foreground has succeeded — both platforms require that order, and asking for
 * background off the back of a "While Using" choice would be quietly taking
 * more than was agreed to.
 */
async function requestLocationAccess(choice: LocationChoice): Promise<LocationAccessFacts> {
  const foreground = await Location.requestForegroundPermissionsAsync();

  const background =
    choice === 'ALWAYS' && foreground.granted
      ? await Location.requestBackgroundPermissionsAsync()
      : await readBackgroundPermission();

  const servicesEnabled = await Location.hasServicesEnabledAsync();
  return toFacts(foreground, background, servicesEnabled);
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

type Phase =
  | { kind: 'loading' }
  | { kind: 'choosing' }
  | { kind: 'asking' }
  | { kind: 'answered'; summary: LocationAccessSummary }
  /** The OS call failed — an unsupported build rather than a refusal. */
  | { kind: 'unavailable' };

const CHOICES: ReadonlyArray<{
  value: LocationChoice;
  title: string;
  description: string;
  hint: string;
}> = [
  {
    value: 'ALWAYS',
    title: 'Always',
    description:
      'Your family can see you while the app is closed. This is the only setting that answers "did they get home?" without you opening the app, and the only one where arrival alerts work. Your phone keeps its own record of apps using location in the background, and Kinmap shows you whenever sharing is on.',
    hint: 'Asks your phone for location access even while Kinmap is closed. Nothing is shared until you turn sharing on yourself.',
  },
  {
    value: 'WHILE_USING',
    title: 'While I am using the app',
    description:
      'Your family can see you only while Kinmap is open on your screen. Nothing is collected once you close it, so they will not see you arrive anywhere while your phone is in your pocket, and arrival alerts will not fire.',
    hint: 'Asks your phone for location access only while Kinmap is open. Nothing is shared until you turn sharing on yourself.',
  },
];

function hintFor(choice: LocationChoice | null): string {
  if (choice === null) return 'Choose one of the two options above first.';
  return CHOICES.find((option) => option.value === choice)?.hint ?? '';
}

export default function PermissionsScreen() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [choice, setChoice] = useState<LocationChoice | null>(null);
  const mounted = useRef(true);
  /**
   * True while an OS dialog is outstanding. Android's background request sends
   * the user to a settings page, which fires an `active` AppState change on the
   * way back; without this the refresh below would race the request and could
   * briefly render "not granted" over an answer already on its way.
   */
  const asking = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /**
   * Refreshes what is displayed. It NEVER prompts. It runs on mount and each
   * time the app returns to the foreground, which is exactly when someone has
   * come back from Settings and expects the screen to have noticed.
   */
  const refresh = useCallback(async (): Promise<void> => {
    if (asking.current) return;
    try {
      const facts = await readLocationAccess();
      if (!mounted.current || asking.current) return;
      const summary = summariseLocationAccess(facts);
      setPhase(
        summary.level === 'NONE' && !summary.onlySettingsCanChangeIt
          ? { kind: 'choosing' }
          : { kind: 'answered', summary },
      );
    } catch {
      // A build with no location module (Expo Go, web) lands here. Saying so is
      // better than offering a choice that would silently do nothing.
      if (mounted.current) setPhase({ kind: 'unavailable' });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refresh();
    });
    return () => {
      subscription.remove();
    };
  }, [refresh]);

  const ask = useCallback(async (selected: LocationChoice): Promise<void> => {
    if (asking.current) return;
    asking.current = true;
    setPhase({ kind: 'asking' });
    try {
      const facts = await requestLocationAccess(selected);
      if (mounted.current) {
        setPhase({ kind: 'answered', summary: summariseLocationAccess(facts) });
      }
    } catch {
      if (mounted.current) setPhase({ kind: 'unavailable' });
    } finally {
      asking.current = false;
    }
  }, []);

  const goForward = useCallback(() => {
    router.push(ROUTES.notificationsPrimer);
  }, [router]);

  /**
   * Returns to the two options with nothing selected.
   *
   * Offered only when the OS would genuinely show its dialog again, and only
   * ever on the user's own tap — this screen never re-prompts by itself. On
   * Android a single "Deny" leaves the dialog available, and sending someone to
   * Settings for something one tap could fix would be the unhelpful answer.
   */
  const chooseAgain = useCallback(() => {
    setChoice(null);
    setPhase({ kind: 'choosing' });
  }, []);

  return (
    <Screen
      footer={
        phase.kind === 'answered' || phase.kind === 'unavailable' ? (
          <ResultActions
            needsSettings={phase.kind === 'unavailable' || needsSettingsHelp(phase.summary)}
            onChooseAgain={
              phase.kind === 'answered' && canAskAgainInApp(phase.summary) ? chooseAgain : undefined
            }
            onForward={goForward}
          />
        ) : (
          <ChoiceActions
            busy={phase.kind === 'asking'}
            choice={choice}
            onAsk={ask}
            onForward={goForward}
          />
        )
      }
      testID="onboarding-permissions"
    >
      <Stack gap="four">
        <LinkButton
          accessibilityHint="Returns to the explanation of what is collected."
          label="Back"
          onPress={() => {
            if (router.canGoBack()) {
              router.back();
              return;
            }
            router.replace(ROUTES.locationPrimer);
          }}
          testID="permissions-back"
        />

        {phase.kind === 'answered' ? (
          <Answered summary={phase.summary} />
        ) : phase.kind === 'unavailable' ? (
          <Unavailable />
        ) : (
          <Choosing choice={choice} disabled={phase.kind !== 'choosing'} onChoose={setChoice} />
        )}
      </Stack>
    </Screen>
  );
}

/** True when the phone's own Settings are the only way to improve on this. */
function needsSettingsHelp(summary: LocationAccessSummary): boolean {
  return summary.level === 'NONE' || summary.approximateOnly || !summary.locationServicesEnabled;
}

/** True when nothing was granted but the OS is still willing to be asked. */
function canAskAgainInApp(summary: LocationAccessSummary): boolean {
  return summary.level === 'NONE' && !summary.onlySettingsCanChangeIt;
}

// ---------------------------------------------------------------------------

function Choosing({
  choice,
  disabled,
  onChoose,
}: {
  choice: LocationChoice | null;
  disabled: boolean;
  onChoose: (next: LocationChoice) => void;
}) {
  return (
    <>
      <Stack gap="two">
        <Title>How much location access?</Title>
        <Subtitle>
          Both of these are real answers. Pick the one you actually want: on iPhone the dialog
          appears once, and after that only your phone's own Settings can change what you said.
        </Subtitle>
      </Stack>

      <Callout title="This does not start sharing" tone="info">
        Allowing location lets Kinmap ask your phone where it is. It does not send anything to
        anyone. Sharing is a separate switch you turn on yourself, and the app shows you whenever it
        is on.
      </Callout>

      <View accessibilityLabel="How much location access?" accessibilityRole="radiogroup">
        <Stack gap="two">
          {CHOICES.map((option) => (
            <ChoiceRow
              description={option.description}
              disabled={disabled}
              key={option.value}
              onPress={() => {
                onChoose(option.value);
              }}
              selected={choice === option.value}
              testID={`permissions-choice-${option.value}`}
              title={option.title}
            />
          ))}
        </Stack>
      </View>

      <Caption>
        Always is a significant thing to agree to, and it exists for one reason: so a family member
        can be seen while their phone is in their pocket. If that is not what you want, "While I am
        using the app" is a complete answer and setup carries on either way.
      </Caption>
    </>
  );
}

function Answered({ summary }: { summary: LocationAccessSummary }) {
  const description = describeLocationAccess(summary);

  return (
    <>
      <Stack gap="two">
        <Title>What your phone allowed</Title>
        <Subtitle>
          This is what that answer means in practice, including the parts that will not work.
        </Subtitle>
      </Stack>

      <Card testID="permissions-result">
        <StatusRow
          label="Location access"
          testID="permissions-result-status"
          tone={description.tone}
          value={description.statusValue}
        />

        {description.works.length > 0 ? (
          <>
            <Body>What this makes possible</Body>
            {description.works.map((line) => (
              <Caption key={line}>{line}</Caption>
            ))}
          </>
        ) : null}

        {description.limits.length > 0 ? (
          <>
            <Body>What it does not do</Body>
            {description.limits.map((line) => (
              <Caption key={line}>{line}</Caption>
            ))}
          </>
        ) : null}
      </Card>

      <Callout title="Still nothing is being shared" tone="info">
        Your family cannot see you yet. Sharing stays off until you turn it on yourself, and you can
        pause or stop it at any moment afterwards.
      </Callout>

      {summary.level === 'WHILE_USING' ? (
        <Caption>
          On iPhone, your phone may later offer to switch you to Always by itself. That is iOS's
          decision rather than ours, and saying no to it costs you nothing here.
        </Caption>
      ) : null}
    </>
  );
}

function Unavailable() {
  return (
    <>
      <Stack gap="two">
        <Title>We cannot ask your phone right now</Title>
        <Subtitle>
          Nothing is being collected or shared, and you can carry on with the rest of setup.
        </Subtitle>
      </Stack>

      <Callout title="Location is unavailable in this build" tone="warning">
        This copy of the app cannot reach your phone's location services, so there is nothing for it
        to grant.
      </Callout>

      <Caption>
        If you are running Kinmap through Expo Go or in a browser, a development build will fix
        this. On a normal install, open your phone's Settings and check Kinmap's Location entry.
      </Caption>
    </>
  );
}

// ---------------------------------------------------------------------------

function ChoiceActions({
  busy,
  choice,
  onAsk,
  onForward,
}: {
  busy: boolean;
  choice: LocationChoice | null;
  onAsk: (selected: LocationChoice) => Promise<void>;
  onForward: () => void;
}) {
  return (
    <Stack gap="two">
      <Button
        accessibilityHint={hintFor(choice)}
        busy={busy}
        disabled={choice === null}
        label="Ask my phone"
        onPress={() => {
          if (choice !== null) void onAsk(choice);
        }}
        testID="permissions-ask"
      />
      <Button
        accessibilityHint="Skips the location permission. Nothing is granted and nothing is shared. You can grant it later from Settings."
        label="Decide later"
        onPress={onForward}
        testID="permissions-skip"
        variant="ghost"
      />
    </Stack>
  );
}

/**
 * Continuing is always the primary action, whatever the answer was. The second
 * button is the one route that can still change the outcome — the in-app dialog
 * when the OS will still show it, the phone's Settings when it will not — and
 * never both, so this never becomes a screen that badgers.
 */
function ResultActions({
  needsSettings,
  onChooseAgain,
  onForward,
}: {
  needsSettings: boolean;
  onChooseAgain?: (() => void) | undefined;
  onForward: () => void;
}) {
  return (
    <Stack gap="two">
      <Button
        accessibilityHint="Goes on to notifications. Your location answer is kept exactly as it is."
        label="Continue"
        onPress={onForward}
        testID="permissions-continue"
      />
      {onChooseAgain ? (
        <Button
          accessibilityHint="Goes back to the two options with neither selected, so you can ask your phone again."
          label="Choose again"
          onPress={onChooseAgain}
          testID="permissions-choose-again"
          variant="secondary"
        />
      ) : needsSettings ? (
        <Button
          accessibilityHint="Opens Kinmap's page in your phone's Settings, where Location can be changed. Come back afterwards and this screen updates on its own."
          label="Open phone settings"
          onPress={() => {
            void openSettingsDeepLink(APP_SETTINGS);
          }}
          testID="permissions-open-settings"
          variant="secondary"
        />
      ) : null}
    </Stack>
  );
}
