import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Spacing } from '@/constants/theme';
import { isMarker, type MemberPresence } from '@/features/map/marker-model';
import { markerVisual, toneColor, tonePill } from '@/features/map/marker-style';
import { formatBatteryLevel } from '@/features/ui/format';
import { usePalette } from '@/features/ui/palette';
import { Pill } from '@/features/ui/primitives';

/**
 * The list beneath the map.
 *
 * Every member appears here exactly once, whether or not they have a position.
 * That is deliberate: the map can only show people who are sharing, so if the
 * list were filtered the same way, a paused member would silently vanish from
 * the interface and the person looking would have no idea whether they were
 * missing, offline, or never invited. Here they appear with a plain
 * "Sharing paused" row and no position at all.
 */

export function PresenceAvatar({ presence }: { presence: MemberPresence }) {
  const palette = usePalette();
  const visual = isMarker(presence)
    ? markerVisual(palette, presence)
    : {
        fill: palette.surfaceSelected,
        ring: toneColor(palette, presence.tone),
        ringStyle: 'DASHED' as const,
        ringWidth: 2,
        opacity: 0.7,
        badge: null,
      };

  return (
    <View style={styles.avatarWrap}>
      <View
        style={[
          styles.avatar,
          {
            backgroundColor: visual.fill,
            borderColor: visual.ring,
            borderWidth: visual.ringWidth,
            borderStyle: visual.ringStyle === 'DASHED' ? 'dashed' : 'solid',
            opacity: visual.opacity,
          },
        ]}
      >
        <Text style={[styles.avatarText, { color: palette.text }]}>{presence.initials}</Text>
      </View>
      {visual.badge === 'LIVE' ? (
        <View
          style={[
            styles.liveDot,
            { backgroundColor: palette.live, borderColor: palette.background },
          ]}
        />
      ) : null}
    </View>
  );
}

export function PresenceRow({
  presence,
  onPress,
}: {
  presence: MemberPresence;
  onPress?: (presence: MemberPresence) => void;
}) {
  const palette = usePalette();
  const marker = isMarker(presence) ? presence : null;

  // Narrow on `presence` itself; TypeScript cannot infer the discriminant from
  // a comparison against the derived `marker` binding.
  const secondary = isMarker(presence)
    ? presence.placeName === null
      ? presence.freshnessLabel
      : `${presence.placeName} · ${presence.freshnessLabel}`
    : presence.detail;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={presence.accessibilityLabel}
      onPress={() => onPress?.(presence)}
      style={({ pressed }) => [
        styles.row,
        { borderColor: palette.border, opacity: pressed ? 0.7 : 1 },
      ]}
    >
      <PresenceAvatar presence={presence} />
      <View style={styles.rowText}>
        <Text style={[styles.name, { color: palette.text }]} numberOfLines={1}>
          {presence.displayName}
        </Text>
        <Text style={[styles.secondary, { color: palette.textSecondary }]} numberOfLines={2}>
          {isMarker(presence) ? secondary : `${presence.title} — ${secondary}`}
        </Text>
      </View>
      <View style={styles.rowMeta}>
        {isMarker(presence) ? (
          presence.isLive ? (
            <Pill text="LIVE" tone="live" />
          ) : presence.isStale ? (
            <Pill text="Out of date" tone="stale" />
          ) : null
        ) : (
          <Pill text={presence.title} tone={tonePill(presence.tone)} />
        )}
        {marker?.batteryLevel === undefined || marker?.batteryLevel === null ? null : (
          <Text style={[styles.battery, { color: palette.textMuted }]}>
            {formatBatteryLevel(marker.batteryLevel)}
          </Text>
        )}
      </View>
    </Pressable>
  );
}

export function PresenceList({
  presences,
  onSelect,
}: {
  presences: readonly MemberPresence[];
  onSelect?: (presence: MemberPresence) => void;
}) {
  return (
    <View>
      {presences.map((presence) => (
        <PresenceRow
          key={presence.userId}
          presence={presence}
          {...(onSelect === undefined ? {} : { onPress: onSelect })}
        />
      ))}
    </View>
  );
}

/** Explains the encoding rather than assuming a solid dot is self-evident. */
export function MapLegend() {
  const palette = usePalette();
  const items: Array<{ label: string; color: string; dashed: boolean }> = [
    { label: 'Live session', color: palette.live, dashed: false },
    { label: 'Updated recently', color: palette.success, dashed: false },
    { label: 'Out of date', color: palette.stale, dashed: true },
    { label: 'Not shown on map', color: palette.paused, dashed: true },
  ];
  return (
    <View style={styles.legend}>
      {items.map((item) => (
        <View key={item.label} style={styles.legendItem}>
          <View
            style={[
              styles.legendSwatch,
              {
                borderColor: item.color,
                backgroundColor: item.dashed ? 'transparent' : item.color,
                borderStyle: item.dashed ? 'dashed' : 'solid',
              },
            ]}
          />
          <Text style={[styles.legendLabel, { color: palette.textSecondary }]}>{item.label}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    paddingVertical: Spacing.two,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowText: { flex: 1, gap: 2 },
  rowMeta: { alignItems: 'flex-end', gap: 4 },
  name: { fontSize: 16, fontWeight: '600' },
  secondary: { fontSize: 13, lineHeight: 18 },
  battery: { fontSize: 12 },
  avatarWrap: { width: 44, height: 44 },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { fontSize: 14, fontWeight: '700' },
  liveDot: {
    position: 'absolute',
    right: -1,
    top: -1,
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: 2,
  },
  legend: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.three,
    paddingVertical: Spacing.two,
  },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: Spacing.one },
  legendSwatch: { width: 14, height: 14, borderRadius: 7, borderWidth: 2 },
  legendLabel: { fontSize: 12 },
});
