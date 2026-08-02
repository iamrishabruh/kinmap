import { useRouter } from 'expo-router';
import { useEffect, useRef } from 'react';
import { AccessibilityInfo, Pressable, StyleSheet, Text, View } from 'react-native';

import { Spacing } from '@/constants/theme';
import { LiveCountdown, useNow } from '@/features/live/countdown';
import { deriveLiveSessionView } from '@/features/live/session-model';
import {
  useRespondToLiveSession,
  useSessionsTargetingMe,
  useStopLiveSession,
} from '@/features/live/use-live-session';
import { useActiveFamilyId, useSession } from '@/features/query/hooks';
import type { LiveSession } from '@/features/query/types';
import { formatDuration } from '@/features/ui/format';
import { usePalette } from '@/features/ui/palette';

/**
 * The indicator the person being located cannot miss.
 *
 * Mounted above the tab navigator so it is present on every screen, in a colour
 * reserved for nothing else, with the requester's name, a live countdown, and a
 * one-tap stop. It is not dismissible and there is no setting that hides it.
 *
 * This component is the reason the product is allowed to exist. Location
 * sharing that the subject cannot see is surveillance; the difference between
 * this app and a stalkerware app is, quite literally, this bar. Do not add a
 * prop that lets a caller suppress it, do not make it collapsible, and do not
 * let it be rendered behind anything.
 */

export function LiveSessionIndicator() {
  const palette = usePalette();
  const router = useRouter();
  const session = useSession();
  const familyId = useActiveFamilyId();
  const myUserId = session.data?.userId ?? null;
  const { active, pending } = useSessionsTargetingMe(familyId, myUserId);
  const stop = useStopLiveSession();
  const respond = useRespondToLiveSession();
  const now = useNow(1000);

  const announcedRef = useRef<string | null>(null);
  const firstActive = active[0];

  useEffect(() => {
    if (firstActive === undefined) {
      announcedRef.current = null;
      return;
    }
    if (announcedRef.current === firstActive.sessionId) return;
    announcedRef.current = firstActive.sessionId;
    AccessibilityInfo.announceForAccessibility(
      `${firstActive.requestedByDisplayName} is now following your location live.`,
    );
  }, [firstActive]);

  const firstPending = pending[0];

  if (firstActive === undefined && firstPending === undefined) return null;

  return (
    <View>
      {firstActive === undefined ? null : (
        <ActiveBanner
          session={firstActive}
          nowMs={now}
          busy={stop.isPending}
          onStop={() => stop.mutate({ sessionId: firstActive.sessionId })}
          onOpen={() =>
            router.push({
              pathname: '/live-session/[sessionId]',
              params: { sessionId: firstActive.sessionId },
            })
          }
        />
      )}
      {firstPending === undefined ? null : (
        <View
          style={[
            styles.pending,
            { backgroundColor: palette.warningSurface, borderColor: palette.warning },
          ]}
          accessibilityRole="alert"
        >
          <Text style={[styles.pendingText, { color: palette.text }]}>
            {firstPending.requestedByDisplayName} asked to follow your location for{' '}
            {formatDuration(firstPending.durationSeconds)}.
          </Text>
          <View style={styles.pendingActions}>
            <Pressable
              accessibilityRole="button"
              disabled={respond.isPending}
              onPress={() => respond.mutate({ sessionId: firstPending.sessionId, accept: false })}
              style={[styles.smallButton, { borderColor: palette.borderStrong }]}
            >
              <Text style={[styles.smallButtonText, { color: palette.text }]}>Decline</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={respond.isPending}
              onPress={() => respond.mutate({ sessionId: firstPending.sessionId, accept: true })}
              style={[
                styles.smallButton,
                { backgroundColor: palette.accent, borderColor: palette.accent },
              ]}
            >
              <Text style={[styles.smallButtonText, { color: palette.onAccent }]}>Allow</Text>
            </Pressable>
          </View>
        </View>
      )}
    </View>
  );
}

function ActiveBanner({
  session,
  nowMs,
  busy,
  onStop,
  onOpen,
}: {
  session: LiveSession;
  nowMs: number;
  busy: boolean;
  onStop: () => void;
  onOpen: () => void;
}) {
  const palette = usePalette();
  const view = deriveLiveSessionView(session, nowMs);
  if (!view.isActive) return null;

  return (
    <View
      style={[styles.live, { backgroundColor: palette.live }]}
      accessibilityRole="alert"
      accessibilityLabel={`Live location sharing is on. ${session.requestedByDisplayName} can see where you are. ${Math.ceil(view.remainingSeconds / 60)} minutes remaining.`}
    >
      <Pressable style={styles.liveMain} accessibilityRole="button" onPress={onOpen}>
        <View style={[styles.dot, { backgroundColor: palette.onLive }]} />
        <View style={styles.liveText}>
          <Text style={[styles.liveTitle, { color: palette.onLive }]}>
            Live — {session.requestedByDisplayName} can see your location
          </Text>
          <Text style={[styles.liveSubtitle, { color: palette.onLive }]}>
            Ends automatically. Tap for details.
          </Text>
        </View>
      </Pressable>
      <LiveCountdown
        remainingSeconds={view.remainingSeconds}
        elapsedFraction={view.elapsedFraction}
        size="small"
        onLight
      />
      <Pressable
        accessibilityRole="button"
        accessibilityHint="Ends live location sharing immediately"
        disabled={busy}
        onPress={onStop}
        style={[styles.stop, { borderColor: palette.onLive, opacity: busy ? 0.6 : 1 }]}
      >
        <Text style={[styles.stopText, { color: palette.onLive }]}>Stop</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  live: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
  },
  liveMain: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two, flex: 1 },
  liveText: { flex: 1, gap: 1 },
  liveTitle: { fontSize: 14, fontWeight: '800' },
  liveSubtitle: { fontSize: 12, opacity: 0.9 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  stop: {
    borderWidth: 1.5,
    borderRadius: 8,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.one,
    minHeight: 36,
    justifyContent: 'center',
  },
  stopText: { fontSize: 14, fontWeight: '800' },
  pending: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    gap: Spacing.two,
  },
  pendingText: { fontSize: 14, fontWeight: '600' },
  pendingActions: { flexDirection: 'row', gap: Spacing.two },
  smallButton: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: Spacing.three,
    minHeight: 36,
    justifyContent: 'center',
  },
  smallButtonText: { fontSize: 14, fontWeight: '700' },
});
