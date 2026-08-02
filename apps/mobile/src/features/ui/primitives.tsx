import { type ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';

import { Spacing } from '@/constants/theme';
import { type Palette, usePalette } from '@/features/ui/palette';

/**
 * A deliberately small set of primitives. The app does not yet depend on a
 * design-system package, and screens in this feature slice must compile on
 * their own, so everything here is built from React Native core components.
 */

export function Screen({
  children,
  scroll = true,
  contentStyle,
}: {
  children: ReactNode;
  scroll?: boolean;
  contentStyle?: StyleProp<ViewStyle>;
}) {
  const palette = usePalette();
  if (!scroll) {
    return (
      <View style={[styles.screen, { backgroundColor: palette.background }, contentStyle]}>
        {children}
      </View>
    );
  }
  return (
    <ScrollView
      style={[styles.screen, { backgroundColor: palette.background }]}
      contentContainerStyle={[styles.scrollContent, contentStyle]}
      keyboardShouldPersistTaps="handled"
    >
      {children}
    </ScrollView>
  );
}

export function Card({
  children,
  style,
  tone,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  tone?: 'default' | 'danger' | 'warning' | 'live';
}) {
  const palette = usePalette();
  const background =
    tone === 'danger'
      ? palette.dangerSurface
      : tone === 'warning'
        ? palette.warningSurface
        : tone === 'live'
          ? palette.liveSurface
          : palette.surface;
  const border =
    tone === 'danger'
      ? palette.danger
      : tone === 'warning'
        ? palette.warning
        : tone === 'live'
          ? palette.live
          : palette.border;
  return (
    <View style={[styles.card, { backgroundColor: background, borderColor: border }, style]}>
      {children}
    </View>
  );
}

export function SectionHeader({ title, hint }: { title: string; hint?: string }) {
  const palette = usePalette();
  return (
    <View style={styles.sectionHeader}>
      <Text style={[styles.sectionTitle, { color: palette.text }]}>{title}</Text>
      {hint === undefined ? null : (
        <Text style={[styles.sectionHint, { color: palette.textSecondary }]}>{hint}</Text>
      )}
    </View>
  );
}

export function Body({
  children,
  tone = 'default',
  style,
}: {
  children: ReactNode;
  tone?: 'default' | 'secondary' | 'muted' | 'danger' | 'success';
  style?: StyleProp<TextStyle>;
}) {
  const palette = usePalette();
  const color =
    tone === 'secondary'
      ? palette.textSecondary
      : tone === 'muted'
        ? palette.textMuted
        : tone === 'danger'
          ? palette.danger
          : tone === 'success'
            ? palette.success
            : palette.text;
  return <Text style={[styles.body, { color }, style]}>{children}</Text>;
}

export function Label({ children }: { children: ReactNode }) {
  const palette = usePalette();
  return <Text style={[styles.label, { color: palette.textSecondary }]}>{children}</Text>;
}

export type PillTone = 'neutral' | 'live' | 'stale' | 'paused' | 'blocked' | 'success' | 'warning';

export function pillColors(palette: Palette, tone: PillTone): { bg: string; fg: string } {
  switch (tone) {
    case 'live':
      return { bg: palette.liveSurface, fg: palette.live };
    case 'stale':
      return { bg: palette.staleSurface, fg: palette.stale };
    case 'paused':
      return { bg: palette.pausedSurface, fg: palette.paused };
    case 'blocked':
      return { bg: palette.blockedSurface, fg: palette.blocked };
    case 'success':
      return { bg: palette.successSurface, fg: palette.success };
    case 'warning':
      return { bg: palette.warningSurface, fg: palette.warning };
    case 'neutral':
    default:
      return { bg: palette.surfaceSelected, fg: palette.textSecondary };
  }
}

export function Pill({ text, tone = 'neutral' }: { text: string; tone?: PillTone }) {
  const palette = usePalette();
  const { bg, fg } = pillColors(palette, tone);
  return (
    <View style={[styles.pill, { backgroundColor: bg }]}>
      <Text style={[styles.pillText, { color: fg }]} accessibilityLabel={text}>
        {text}
      </Text>
    </View>
  );
}

export function AppButton({
  title,
  onPress,
  variant = 'primary',
  disabled = false,
  busy = false,
  accessibilityHint,
}: {
  title: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'destructive' | 'quiet';
  disabled?: boolean;
  busy?: boolean;
  accessibilityHint?: string;
}) {
  const palette = usePalette();
  const isDisabled = disabled || busy;
  const background =
    variant === 'primary'
      ? palette.accent
      : variant === 'destructive'
        ? palette.danger
        : variant === 'secondary'
          ? palette.surfaceSelected
          : 'transparent';
  const foreground =
    variant === 'primary'
      ? palette.onAccent
      : variant === 'destructive'
        ? '#FFFFFF'
        : variant === 'secondary'
          ? palette.text
          : palette.accent;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: isDisabled, busy }}
      accessibilityHint={accessibilityHint}
      disabled={isDisabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: background,
          borderColor: variant === 'quiet' ? 'transparent' : background,
          opacity: isDisabled ? 0.5 : pressed ? 0.85 : 1,
        },
      ]}
    >
      {busy ? <ActivityIndicator color={foreground} /> : null}
      <Text style={[styles.buttonText, { color: foreground }]}>{title}</Text>
    </Pressable>
  );
}

export function RowButton({
  title,
  subtitle,
  onPress,
  right,
  tone = 'default',
  accessibilityHint,
}: {
  title: string;
  subtitle?: string;
  onPress: () => void;
  right?: ReactNode;
  tone?: 'default' | 'danger';
  accessibilityHint?: string;
}) {
  const palette = usePalette();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint={accessibilityHint}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        { borderColor: palette.border, opacity: pressed ? 0.7 : 1 },
      ]}
    >
      <View style={styles.rowMain}>
        <Text
          style={[styles.rowTitle, { color: tone === 'danger' ? palette.danger : palette.text }]}
        >
          {title}
        </Text>
        {subtitle === undefined ? null : (
          <Text style={[styles.rowSubtitle, { color: palette.textSecondary }]}>{subtitle}</Text>
        )}
      </View>
      {right}
    </Pressable>
  );
}

export function Divider() {
  const palette = usePalette();
  return <View style={[styles.divider, { backgroundColor: palette.border }]} />;
}

/**
 * The honest empty state. Every screen that can have "nothing to show" uses
 * this instead of an indefinite spinner — a permanent loading indicator is a
 * lie about whether data exists (spec §19).
 */
export function EmptyState({
  title,
  body,
  action,
  tone = 'default',
}: {
  title: string;
  body: string;
  action?: ReactNode;
  tone?: 'default' | 'warning' | 'danger';
}) {
  const palette = usePalette();
  const color =
    tone === 'warning' ? palette.warning : tone === 'danger' ? palette.danger : palette.text;
  return (
    <View style={styles.empty} accessibilityRole="summary">
      <Text style={[styles.emptyTitle, { color }]}>{title}</Text>
      <Text style={[styles.emptyBody, { color: palette.textSecondary }]}>{body}</Text>
      {action === undefined ? null : <View style={styles.emptyAction}>{action}</View>}
    </View>
  );
}

export function LoadingState({ label }: { label: string }) {
  const palette = usePalette();
  return (
    <View style={styles.empty} accessibilityRole="progressbar" accessibilityLabel={label}>
      <ActivityIndicator color={palette.accent} />
      <Text style={[styles.emptyBody, { color: palette.textSecondary }]}>{label}</Text>
    </View>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <EmptyState
      tone="danger"
      title="Something went wrong"
      body={message}
      action={onRetry === undefined ? undefined : <AppButton title="Try again" onPress={onRetry} />}
    />
  );
}

export function Avatar({ initials, tone }: { initials: string; tone?: string }) {
  const palette = usePalette();
  return (
    <View
      style={[
        styles.avatar,
        { backgroundColor: palette.surfaceSelected, borderColor: tone ?? palette.border },
      ]}
    >
      <Text style={[styles.avatarText, { color: palette.text }]}>{initials}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  scrollContent: { padding: Spacing.three, gap: Spacing.three, paddingBottom: Spacing.six },
  card: {
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    padding: Spacing.three,
    gap: Spacing.two,
  },
  sectionHeader: { gap: Spacing.one, marginTop: Spacing.two },
  sectionTitle: { fontSize: 18, fontWeight: '700' },
  sectionHint: { fontSize: 13, lineHeight: 18 },
  body: { fontSize: 15, lineHeight: 21 },
  label: { fontSize: 12, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.6 },
  pill: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4, alignSelf: 'flex-start' },
  pillText: { fontSize: 12, fontWeight: '700' },
  button: {
    minHeight: 48,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: Spacing.three,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.two,
  },
  buttonText: { fontSize: 16, fontWeight: '600' },
  row: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.three,
    paddingVertical: Spacing.two,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowMain: { flexShrink: 1, gap: 2 },
  rowTitle: { fontSize: 16, fontWeight: '600' },
  rowSubtitle: { fontSize: 13 },
  divider: { height: StyleSheet.hairlineWidth, width: '100%' },
  empty: { alignItems: 'center', gap: Spacing.two, paddingVertical: Spacing.five },
  emptyTitle: { fontSize: 17, fontWeight: '700', textAlign: 'center' },
  emptyBody: { fontSize: 14, lineHeight: 20, textAlign: 'center', maxWidth: 340 },
  emptyAction: { marginTop: Spacing.two },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { fontSize: 14, fontWeight: '700' },
});
