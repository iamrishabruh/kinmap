import type { ReactNode } from 'react';
import {
  Pressable,
  Text as RNText,
  StyleSheet,
  View,
  useColorScheme,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';

import { MIN_TAP_TARGET, palettes, radii, spacing, typography, type Palette } from './tokens.js';

export function usePalette(): Palette {
  const scheme = useColorScheme();
  return palettes[scheme === 'dark' ? 'dark' : 'light'];
}

type TextProps = {
  children: ReactNode;
  variant?: keyof typeof typography;
  tone?: 'default' | 'muted' | 'danger' | 'inverse';
  style?: StyleProp<TextStyle>;
  /** Passed through so callers can mark headings for assistive technology. */
  accessibilityRole?: 'text' | 'header' | 'link' | 'summary' | 'alert';
  accessibilityLabel?: string;
  numberOfLines?: number;
  testID?: string;
};

export function Text({
  children,
  variant = 'body',
  tone = 'default',
  style,
  accessibilityRole,
  accessibilityLabel,
  numberOfLines,
  testID,
}: TextProps) {
  const palette = usePalette();
  const color =
    tone === 'muted'
      ? palette.textMuted
      : tone === 'danger'
        ? palette.danger
        : tone === 'inverse'
          ? palette.textInverse
          : palette.text;
  return (
    <RNText
      accessibilityRole={accessibilityRole}
      accessibilityLabel={accessibilityLabel}
      numberOfLines={numberOfLines}
      testID={testID}
      style={[typography[variant] as TextStyle, { color }, style]}
    >
      {children}
    </RNText>
  );
}

type ButtonProps = {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
  accessibilityHint?: string;
};

export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled = false,
  accessibilityHint,
}: ButtonProps) {
  const palette = usePalette();
  const background =
    variant === 'primary' ? palette.accent : variant === 'danger' ? palette.danger : 'transparent';
  const textColor = variant === 'secondary' ? palette.accent : palette.onAccent;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: pressed && variant === 'primary' ? palette.accentPressed : background,
          borderColor: variant === 'secondary' ? palette.accent : 'transparent',
          opacity: disabled ? 0.5 : 1,
        },
      ]}
    >
      <RNText style={[typography.label as TextStyle, { color: textColor }]}>{label}</RNText>
    </Pressable>
  );
}

export function Card({
  children,
  style,
  testID,
  accessibilityLabel,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  accessibilityLabel?: string;
}) {
  const palette = usePalette();
  return (
    <View
      testID={testID}
      accessibilityLabel={accessibilityLabel}
      style={[
        styles.card,
        { backgroundColor: palette.surfaceRaised, borderColor: palette.border },
        style,
      ]}
    >
      {children}
    </View>
  );
}

export type SharingState = 'SHARING' | 'PAUSED' | 'BLOCKED' | 'STALE' | 'OFF';

const SHARING_COPY: Record<SharingState, string> = {
  SHARING: 'Sharing on',
  PAUSED: 'Sharing paused',
  BLOCKED: 'Permission needed',
  STALE: 'Location out of date',
  OFF: 'Sharing off',
};

/**
 * The status a person sees about their own location sharing.
 *
 * The label text is never omitted — a coloured dot alone would be invisible to
 * anyone with a colour-vision deficiency and to a screen reader, and this is
 * precisely the signal a user must never miss (spec §2).
 */
export function SharingStatusPill({ state }: { state: SharingState }) {
  const palette = usePalette();
  const colors: Record<SharingState, { fg: string; bg: string }> = {
    SHARING: { fg: palette.sharing, bg: palette.sharingSurface },
    PAUSED: { fg: palette.paused, bg: palette.pausedSurface },
    BLOCKED: { fg: palette.blocked, bg: palette.blockedSurface },
    STALE: { fg: palette.stale, bg: palette.staleSurface },
    OFF: { fg: palette.textMuted, bg: palette.staleSurface },
  };
  const { fg, bg } = colors[state];
  const label = SHARING_COPY[state];

  return (
    <View
      accessibilityRole="text"
      accessibilityLabel={label}
      style={[styles.pill, { backgroundColor: bg }]}
    >
      <View style={[styles.dot, { backgroundColor: fg }]} />
      <RNText style={[typography.caption as TextStyle, { color: fg }]}>{label}</RNText>
    </View>
  );
}

export function Banner({
  tone = 'info',
  title,
  message,
  action,
}: {
  tone?: 'info' | 'warning' | 'danger';
  title: string;
  message: string;
  action?: { label: string; onPress: () => void };
}) {
  const palette = usePalette();
  const bg =
    tone === 'danger'
      ? palette.dangerSurface
      : tone === 'warning'
        ? palette.pausedSurface
        : palette.staleSurface;
  const fg =
    tone === 'danger' ? palette.danger : tone === 'warning' ? palette.paused : palette.text;

  return (
    <View accessibilityRole="alert" style={[styles.banner, { backgroundColor: bg }]}>
      <RNText style={[typography.label as TextStyle, { color: fg }]}>{title}</RNText>
      <RNText style={[typography.caption as TextStyle, { color: palette.textMuted }]}>
        {message}
      </RNText>
      {action ? <Button label={action.label} onPress={action.onPress} variant="secondary" /> : null}
    </View>
  );
}

/**
 * Explains a permission before the OS dialog appears. Never triggers the
 * request itself — the caller does that from an explicit user action.
 */
export function PermissionCallout({
  title,
  whatIsShared,
  withWhom,
  howToStop,
  onContinue,
  onSkip,
}: {
  title: string;
  whatIsShared: string;
  withWhom: string;
  howToStop: string;
  onContinue: () => void;
  onSkip?: () => void;
}) {
  return (
    <Card>
      <Text variant="heading">{title}</Text>
      <View style={{ gap: spacing.sm, marginVertical: spacing.md }}>
        <Text variant="body">{whatIsShared}</Text>
        <Text variant="body" tone="muted">
          {withWhom}
        </Text>
        <Text variant="body" tone="muted">
          {howToStop}
        </Text>
      </View>
      <Button label="Continue" onPress={onContinue} />
      {onSkip ? <Button label="Not now" onPress={onSkip} variant="secondary" /> : null}
    </Card>
  );
}

export function ListRow({
  title,
  subtitle,
  right,
  onPress,
}: {
  title: string;
  subtitle?: string;
  right?: ReactNode;
  onPress?: () => void;
}) {
  const palette = usePalette();
  const content = (
    <View style={[styles.row, { borderBottomColor: palette.border }]}>
      <View style={{ flex: 1 }}>
        <Text variant="label">{title}</Text>
        {subtitle ? (
          <Text variant="caption" tone="muted">
            {subtitle}
          </Text>
        ) : null}
      </View>
      {right}
    </View>
  );
  if (!onPress) return content;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={title} onPress={onPress}>
      {content}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: MIN_TAP_TARGET,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.md,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  card: {
    borderRadius: radii.lg,
    borderWidth: 1,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radii.pill,
    alignSelf: 'flex-start',
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  banner: {
    borderRadius: radii.md,
    padding: spacing.lg,
    gap: spacing.xs,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: MIN_TAP_TARGET,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
});
