import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Spacing } from '@/constants/theme';
import { formatCountdown } from '@/features/ui/format';
import { usePalette } from '@/features/ui/palette';

/**
 * A ticking clock, shared by every live-session surface.
 *
 * The countdown is not decoration. It is the mechanism by which the person
 * being located can see, without tapping anything, that this is temporary and
 * exactly how temporary. It ticks every second because a number that only
 * updates on refetch looks frozen, and a frozen countdown looks like a bug in
 * the thing that is supposed to end the sharing.
 */

/** Re-renders on an interval so any `Date.now()`-derived value stays honest. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const handle = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(handle);
  }, [intervalMs]);
  return now;
}

export function LiveCountdown({
  remainingSeconds,
  elapsedFraction,
  size = 'medium',
  onLight = false,
}: {
  remainingSeconds: number;
  elapsedFraction: number;
  size?: 'small' | 'medium' | 'large';
  /** True when drawn on the live-red banner, where text must be light. */
  onLight?: boolean;
}) {
  const palette = usePalette();
  const color = onLight ? palette.onLive : palette.live;
  const track = onLight ? 'rgba(255,255,255,0.35)' : palette.staleSurface;
  const fontSize = size === 'large' ? 34 : size === 'small' ? 14 : 20;
  const remainingPercent = Math.max(0, Math.min(100, (1 - elapsedFraction) * 100));

  return (
    <View style={styles.wrap}>
      <Text
        style={[styles.time, { color, fontSize }]}
        accessibilityLabel={`${Math.ceil(remainingSeconds / 60)} minutes remaining`}
      >
        {formatCountdown(remainingSeconds)}
      </Text>
      <View style={[styles.track, { backgroundColor: track }]}>
        <View style={[styles.fill, { backgroundColor: color, width: `${remainingPercent}%` }]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: Spacing.one, minWidth: 72 },
  time: { fontWeight: '700', fontVariant: ['tabular-nums'] },
  track: { height: 4, borderRadius: 2, overflow: 'hidden' },
  fill: { height: 4, borderRadius: 2 },
});
