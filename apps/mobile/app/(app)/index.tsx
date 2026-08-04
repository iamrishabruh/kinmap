import { useCallback, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { FRESHNESS_THRESHOLDS, type UserId } from '@family/contracts';
import { SharingStatusPill, type SharingState } from '@family/design-system';

import { Spacing } from '@/constants/theme';
import { useNow } from '@/features/live/countdown';
import { FamilyMapSurface } from '@/features/map/family-map';
import { STALE_AFTER_SECONDS, freshnessFor, isStaleFreshness } from '@/features/map/freshness';
import {
  absentPresences,
  buildFamilyPresences,
  drawableMarkers,
  isMarker,
  regionForMarkers,
  type MemberPresence,
} from '@/features/map/marker-model';
import { MapLegend, PresenceList } from '@/features/map/presence-list';
import {
  useActiveFamilyId,
  useCurrentLocations,
  useFamily,
  useSharingState,
} from '@/features/query/hooks';
import type { SelfSharingState } from '@/features/query/types';
import { formatDuration, formatRelativeTime } from '@/features/ui/format';
import { usePalette } from '@/features/ui/palette';
import {
  AppButton,
  Body,
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  Screen,
  SectionHeader,
} from '@/features/ui/primitives';
import { describeError } from '@/lib/api';

/**
 * The family map. Where a signed-in person lands.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SCREEN IS RESPONSIBLE FOR
 * ---------------------------------------------------------------------------
 * Someone acting on a position that is older than they think is the failure
 * this screen exists to prevent — leaving for a school gate because a pin says
 * "school" when the pin is fifty minutes old. Three rules follow from that, and
 * every layout decision below is downstream of them.
 *
 *   1. NOTHING IS INVENTED. Presences come from `buildFamilyPresences`, which
 *      structurally cannot produce a position for someone who is not sharing
 *      one. There is no "last known" fallback here, no interpolation, and no
 *      placeholder pin. If the locations request FAILS, the roster is not
 *      rebuilt from an empty list — that would silently relabel the whole
 *      family as "No location yet", which is a statement about them rather than
 *      about our network. The failure is reported as a failure instead.
 *
 *   2. AGE IS ALWAYS VISIBLE, AND ALWAYS MOVING. `useNow` re-renders on a timer
 *      set to half the shortest freshness bucket, so a position cannot sit on
 *      screen looking fresher than it is between polls. A frozen "4 min ago" on
 *      a phone that lost signal is the exact lie this screen must not tell.
 *
 *   3. NO COORDINATE IS EVER TEXT. The map surface draws pins; that is the only
 *      place a latitude or longitude is rendered in this app (spec §20). This
 *      file formats names, place names, relative times and battery levels, and
 *      nothing else. It also emits no telemetry of its own.
 */

/**
 * Half the LIVE bucket. Any slower and a marker could sit on screen a whole
 * freshness bucket out of date; any faster and the native map re-diffs its
 * pins for no gain.
 */
const FRESHNESS_TICK_MS = (FRESHNESS_THRESHOLDS.LIVE_SECONDS / 2) * 1000;

/** What "out of date" means, in words, derived from the threshold itself. */
const STALE_AFTER_LABEL = formatDuration(STALE_AFTER_SECONDS);

export default function FamilyMapScreen() {
  const palette = usePalette();
  const nowMs = useNow(FRESHNESS_TICK_MS);

  const familyId = useActiveFamilyId();
  const familyQuery = useFamily(familyId);
  const locationsQuery = useCurrentLocations(familyId);
  const sharingQuery = useSharingState();

  const [focusedUserId, setFocusedUserId] = useState<UserId | null>(null);

  const members = familyQuery.data?.members;
  const locations = locationsQuery.data;

  /**
   * Built only when BOTH sides have arrived. Passing `[]` for locations while
   * the request is in flight or failed would render every member as "No
   * location yet" — a claim about them that we cannot make.
   */
  const presences = useMemo(
    () =>
      members === undefined || locations === undefined
        ? null
        : buildFamilyPresences(members, locations, nowMs),
    [members, locations, nowMs],
  );

  const markers = useMemo(
    () => (presences === null ? [] : drawableMarkers(presences)),
    [presences],
  );
  const absent = useMemo(() => (presences === null ? [] : absentPresences(presences)), [presences]);

  const focused = useMemo(
    () => presences?.find((presence) => presence.userId === focusedUserId) ?? null,
    [presences, focusedUserId],
  );

  /** Framing follows the selection; with nothing selected the camera fits all. */
  const region = useMemo(
    () => (focused !== null && isMarker(focused) ? regionForMarkers([focused]) : null),
    [focused],
  );

  const toggleFocus = useCallback((presence: MemberPresence) => {
    setFocusedUserId((current) => (current === presence.userId ? null : presence.userId));
  }, []);

  const clearFocus = useCallback(() => setFocusedUserId(null), []);

  const retryAll = useCallback(() => {
    void familyQuery.refetch();
    void locationsQuery.refetch();
  }, [familyQuery, locationsQuery]);

  // ---- States that must not be dressed up as a map ------------------------

  if (familyId === null) {
    return (
      <Screen>
        <EmptyState
          title="This account is not in a family yet"
          body="A family map needs a family. Create one or accept an invitation, and the people who join will choose for themselves whether to share a location."
        />
      </Screen>
    );
  }

  if (presences === null) {
    const failed = familyQuery.error ?? locationsQuery.error;
    if (failed !== null) {
      return (
        <Screen>
          <ErrorState message={describeError(failed)} onRetry={retryAll} />
          <Card>
            <Body tone="secondary">
              Nothing is shown while we cannot reach the server. Family Location does not fall back
              to an older position — an out-of-date pin with no warning is worse than no pin.
            </Body>
          </Card>
        </Screen>
      );
    }
    return (
      <Screen>
        <LoadingState label="Loading your family map" />
      </Screen>
    );
  }

  if (presences.length === 0) {
    return (
      <Screen>
        <EmptyState
          title="Nobody to show yet"
          body="Once someone joins this family they decide for themselves whether to share their location. Until they do, this map stays empty."
        />
      </Screen>
    );
  }

  // ---- The map -------------------------------------------------------------

  const staleCount = markers.filter((marker) => marker.isStale).length;
  /**
   * A refresh failed but earlier data is still on screen. Saying so matters more
   * here than almost anywhere else: the pins are not wrong, they are simply not
   * getting any newer, and only the freshness labels below reveal that.
   */
  const refreshError = locationsQuery.error ?? familyQuery.error;
  const lastRefreshedAt =
    locationsQuery.dataUpdatedAt > 0 ? new Date(locationsQuery.dataUpdatedAt).toISOString() : null;
  const selfState = selfSharingPillState(sharingQuery.data, nowMs);
  const selfPermissionWarning = permissionWarning(sharingQuery.data);

  return (
    <Screen scroll={false}>
      <FamilyMapSurface markers={markers} region={region} style={styles.map} />
      <View style={[styles.sheetEdge, { backgroundColor: palette.border }]} />

      <ScrollView
        style={styles.sheet}
        contentContainerStyle={styles.sheetContent}
        keyboardShouldPersistTaps="handled"
      >
        <SectionHeader
          title={familyQuery.data?.family.name ?? 'Your family'}
          hint={summarise(markers.length, presences.length)}
        />

        <MapLegend />

        {refreshError === null ? null : (
          <Card tone="warning">
            <Body>We could not refresh the map.</Body>
            <Body tone="secondary">
              {lastRefreshedAt === null
                ? 'Nothing new has arrived from the server.'
                : `You are looking at what we last received ${formatRelativeTime(
                    lastRefreshedAt,
                    nowMs,
                  ).toLowerCase()}.`}{' '}
              {describeError(refreshError)}
            </Body>
            <AppButton
              title="Try again"
              variant="secondary"
              onPress={retryAll}
              accessibilityHint="Asks the server for the latest positions again"
            />
          </Card>
        )}

        {staleCount > 0 ? (
          <Card tone="warning">
            <Body>
              {staleCount === 1
                ? 'One position on this map is out of date.'
                : `${staleCount} positions on this map are out of date.`}
            </Body>
            <Body tone="secondary">
              {`A pin is marked out of date once it is more than ${STALE_AFTER_LABEL} old. It shows where that person was when their phone last reported, not where they are now.`}
            </Body>
          </Card>
        ) : null}

        {focused === null ? null : (
          <Card>
            <Body style={styles.emphasis}>{focused.displayName}</Body>
            <Body tone="secondary">{describePresence(focused)}</Body>
            <AppButton
              title="Show the whole family"
              variant="quiet"
              onPress={clearFocus}
              accessibilityHint="Clears the selection and frames every pin on the map"
            />
          </Card>
        )}

        <Card>
          <View style={styles.selfRow}>
            <Body style={styles.emphasis}>You</Body>
            {selfState === null ? null : <SharingStatusPill state={selfState} />}
          </View>
          <Body tone="secondary">
            {selfState === null
              ? sharingQuery.isError
                ? 'We could not check whether your own location is being shared. Open Settings to see and change it.'
                : 'Checking whether your own location is being shared…'
              : SELF_SHARING_COPY[selfState]}
          </Body>
          {selfPermissionWarning === null ? null : (
            <Body tone="danger">{selfPermissionWarning}</Body>
          )}
        </Card>

        <SectionHeader
          title="On the map"
          hint="The time beside each name is when that person's phone last reported. It is not a promise that they are still there."
        />
        {markers.length === 0 ? (
          <EmptyState
            title="No positions to show"
            body="Nobody in this family is sharing a position with you right now. Everyone is listed below with the reason."
          />
        ) : (
          <PresenceList presences={markers} onSelect={toggleFocus} />
        )}

        {absent.length === 0 ? null : (
          <>
            <SectionHeader
              title="Not on the map"
              hint="Family Location never guesses, estimates or reuses an old position for someone who is not sharing one."
            />
            <PresenceList presences={absent} onSelect={toggleFocus} />
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

// ---------------------------------------------------------------------------
// Copy helpers. Every string below states what is true, including when what is
// true is "we do not know".
// ---------------------------------------------------------------------------

function summarise(shown: number, total: number): string {
  const hidden = total - shown;
  if (hidden === 0) {
    return `${shown} of ${total} on the map. Everyone in this family is sharing a position with you.`;
  }
  if (shown === 0) {
    return `Nobody is on the map. All ${total} are listed below, each with the reason there is nothing to show.`;
  }
  return `${shown} of ${total} on the map. The other ${hidden} are listed below with the reason.`;
}

/**
 * The selected member, in one line, for both kinds of presence. A marker gets
 * its place name and its age; an absence gets the reason and nothing else,
 * because there is nothing else that is true.
 */
function describePresence(presence: MemberPresence): string {
  if (!isMarker(presence)) {
    return `${presence.title}. ${presence.detail}`;
  }
  const where = presence.placeName === null ? '' : `${presence.placeName}. `;
  const caution = presence.isStale
    ? ' This is where they were when their phone last reported, not where they are now.'
    : '';
  return `${where}${presence.freshnessLabel}.${caution}`;
}

/**
 * What the signed-in person sees about their own sharing.
 *
 * Deliberately shown on the same screen as everyone else's status: a map that
 * tells you where your family is while staying quiet about what you are
 * broadcasting is only honest in one direction. `SHARING` is the only value
 * that reads as reassuring, so it is also the hardest to reach — sharing that
 * is switched on but has not delivered a position recently resolves to `STALE`,
 * because that is what the rest of the family is actually looking at.
 */
function selfSharingPillState(
  state: SelfSharingState | undefined,
  nowMs: number,
): SharingState | null {
  if (state === undefined) return null;

  // The SERVER decides what other people see, so the server decides what this
  // screen is allowed to claim.
  //
  // `permissionBlocked` is a device-local mirror of the OS setting, and reading
  // it first was wrong in the one direction that matters: revoke location
  // permission in iOS Settings while the server still has you SHARING with a
  // last-known fix, and your family keeps seeing your pin while this screen told
  // you nothing was being shared. Over-reporting what you broadcast is a
  // nuisance; under-reporting it is the failure this product cannot have.
  //
  // A blocked permission is still shown — as the reason uploads have stopped,
  // layered on top of the truth about what is visible, never in place of it.
  if (state.sharingStatus === 'PERMISSION_BLOCKED') return 'BLOCKED';
  if (state.sharingStatus === 'PAUSED') return 'PAUSED';
  if (state.sharingStatus !== 'SHARING') return 'OFF';
  return isStaleFreshness(freshnessFor(state.lastUploadAt, nowMs)) ? 'STALE' : 'SHARING';
}

/**
 * The extra sentence shown when the phone has stopped being able to upload.
 *
 * Deliberately additive. It explains why a position is going stale; it never
 * asserts that nothing is visible, because whether anything is visible is the
 * server's answer and not this device's.
 */
function permissionWarning(state: SelfSharingState | undefined): string | null {
  if (state === undefined || !state.permissionBlocked) return null;
  if (state.sharingStatus === 'SHARING') {
    return 'This phone is no longer allowed to read your location, so it has stopped sending new positions. Your family can still see the last one until you pause or turn off sharing.';
  }
  return 'This phone is no longer allowed to read your location.';
}

const SELF_SHARING_COPY: Record<SharingState, string> = {
  SHARING:
    'Your family can see where you are. You can pause or stop sharing at any time in Settings, and they will see that you have.',
  STALE: `Sharing is on, but your phone has not sent a position for more than ${STALE_AFTER_LABEL}. Your family is looking at an older one, marked as out of date.`,
  PAUSED:
    'Your location is not being shared with anyone while sharing is paused. Your family sees "Sharing paused" and no position.',
  BLOCKED:
    'Your phone is not allowing location access, so nothing is being shared. Your family sees "Location permission off" and no position.',
  OFF: 'Location sharing is off. Nobody in your family can see where you are.',
};

const styles = StyleSheet.create({
  /** The map keeps its own `minHeight`; this splits the screen with the sheet. */
  map: { flex: 1 },
  sheet: { flex: 1.15 },
  sheetContent: { gap: Spacing.two, padding: Spacing.three, paddingBottom: Spacing.six },
  sheetEdge: { height: StyleSheet.hairlineWidth, width: '100%' },
  selfRow: { alignItems: 'center', flexDirection: 'row', gap: Spacing.two },
  emphasis: { fontWeight: '700' },
});
