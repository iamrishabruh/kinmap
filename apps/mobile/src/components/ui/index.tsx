import { type ReactNode, forwardRef } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text as RNText,
  TextInput,
  type TextInputProps,
  type StyleProp,
  type TextStyle,
  View,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Card as DesignSystemCard, Text as DesignSystemText } from '@family/design-system';

import { Spacing } from '@/constants/theme';

import { MIN_TOUCH_TARGET, Radius, useUiTheme } from './tokens';

/**
 * The auth + consent UI kit.
 *
 * ---------------------------------------------------------------------------
 * SINGLE SWAP POINT
 * ---------------------------------------------------------------------------
 * This module is the ONLY file in the auth/consent surface that imports
 * `@family/design-system`. Every screen imports from `@/components/ui`, so if
 * the shared package renames or reshapes a primitive, exactly one file changes.
 *
 * `Card` and `Text` come from the design system because they own typography and
 * surface elevation. `Button` is deliberately local: consent screens depend on
 * an exact, auditable relationship between a tap and an OS permission dialog,
 * so the press handling, disabled state, busy state and accessibility roles of
 * every button on this surface are defined here where they can be tested.
 */

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export type ScreenProps = {
  children: ReactNode;
  /** Pinned action area; stays reachable without scrolling past the content. */
  footer?: ReactNode;
  scroll?: boolean;
  testID?: string;
};

export function Screen({ children, footer, scroll = true, testID }: ScreenProps) {
  const theme = useUiTheme();
  const body = <View style={styles.screenBody}>{children}</View>;

  return (
    <SafeAreaView
      edges={['top', 'left', 'right']}
      style={[styles.screen, { backgroundColor: theme.background }]}
      testID={testID}
    >
      {scroll ? (
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {body}
        </ScrollView>
      ) : (
        body
      )}
      {footer ? (
        <SafeAreaView edges={['bottom']} style={[styles.footer, { borderTopColor: theme.border }]}>
          <View style={styles.footerInner}>{footer}</View>
        </SafeAreaView>
      ) : null}
    </SafeAreaView>
  );
}

export type StackProps = {
  children: ReactNode;
  gap?: keyof typeof Spacing;
  style?: StyleProp<ViewStyle>;
};

export function Stack({ children, gap = 'three', style }: StackProps) {
  return <View style={[{ gap: Spacing[gap] }, style]}>{children}</View>;
}

export function Divider() {
  const theme = useUiTheme();
  return <View style={[styles.divider, { backgroundColor: theme.border }]} />;
}

// ---------------------------------------------------------------------------
// Typography
// ---------------------------------------------------------------------------

type TypographyProps = {
  children: ReactNode;
  style?: StyleProp<TextStyle>;
  /** Announced by screen readers ahead of the text. */
  accessibilityLabel?: string;
  testID?: string;
};

export function Title({ children, style, testID }: TypographyProps) {
  const theme = useUiTheme();
  return (
    <DesignSystemText
      accessibilityRole="header"
      style={[styles.title, { color: theme.text }, style]}
      testID={testID}
    >
      {children}
    </DesignSystemText>
  );
}

export function Subtitle({ children, style, testID }: TypographyProps) {
  const theme = useUiTheme();
  return (
    <DesignSystemText
      style={[styles.subtitle, { color: theme.textSecondary }, style]}
      testID={testID}
    >
      {children}
    </DesignSystemText>
  );
}

export function Body({ children, style, testID }: TypographyProps) {
  const theme = useUiTheme();
  return (
    <DesignSystemText style={[styles.body, { color: theme.text }, style]} testID={testID}>
      {children}
    </DesignSystemText>
  );
}

export function Caption({ children, style, testID }: TypographyProps) {
  const theme = useUiTheme();
  return (
    <DesignSystemText
      style={[styles.caption, { color: theme.textSecondary }, style]}
      testID={testID}
    >
      {children}
    </DesignSystemText>
  );
}

export type CardProps = {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

export function Card({ children, style, testID }: CardProps) {
  const theme = useUiTheme();
  return (
    <DesignSystemCard
      style={[
        styles.card,
        { backgroundColor: theme.backgroundElement, borderColor: theme.border },
        style,
      ]}
      testID={testID}
    >
      {children}
    </DesignSystemCard>
  );
}

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive';

export type ButtonProps = {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  busy?: boolean;
  /**
   * Required on any control that can open an OS dialog or change what the
   * user's family can see, so VoiceOver/TalkBack states the consequence before
   * the tap, not after.
   */
  accessibilityHint?: string;
  testID?: string;
  icon?: ReactNode;
};

export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled = false,
  busy = false,
  accessibilityHint,
  testID,
  icon,
}: ButtonProps) {
  const theme = useUiTheme();
  const isDisabled = disabled || busy;

  const surface: Record<ButtonVariant, ViewStyle> = {
    primary: { backgroundColor: theme.accent, borderColor: theme.accent },
    secondary: { backgroundColor: 'transparent', borderColor: theme.border },
    ghost: { backgroundColor: 'transparent', borderColor: 'transparent' },
    destructive: { backgroundColor: 'transparent', borderColor: theme.danger },
  };

  const labelColor: Record<ButtonVariant, string> = {
    primary: theme.onAccent,
    secondary: theme.text,
    ghost: theme.accent,
    destructive: theme.danger,
  };

  return (
    <Pressable
      accessibilityHint={accessibilityHint}
      accessibilityRole="button"
      accessibilityState={{ disabled: isDisabled, busy }}
      disabled={isDisabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        surface[variant],
        pressed && !isDisabled ? styles.buttonPressed : null,
        isDisabled ? styles.buttonDisabled : null,
      ]}
      testID={testID}
    >
      {busy ? <ActivityIndicator color={labelColor[variant]} size="small" /> : icon}
      <RNText style={[styles.buttonLabel, { color: labelColor[variant] }]}>{label}</RNText>
    </Pressable>
  );
}

export type LinkButtonProps = {
  label: string;
  onPress: () => void;
  accessibilityHint?: string;
  testID?: string;
};

export function LinkButton({ label, onPress, accessibilityHint, testID }: LinkButtonProps) {
  const theme = useUiTheme();
  return (
    <Pressable
      accessibilityHint={accessibilityHint}
      accessibilityRole="link"
      hitSlop={12}
      onPress={onPress}
      style={styles.linkButton}
      testID={testID}
    >
      <RNText style={[styles.linkLabel, { color: theme.accent }]}>{label}</RNText>
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// Callouts and status
// ---------------------------------------------------------------------------

export type CalloutTone = 'info' | 'warning' | 'success' | 'danger';

export type CalloutProps = {
  tone?: CalloutTone;
  title?: string;
  children: ReactNode;
  testID?: string;
};

export function Callout({ tone = 'info', title, children, testID }: CalloutProps) {
  const theme = useUiTheme();
  const surfaces: Record<CalloutTone, { bg: string; fg: string }> = {
    info: { bg: theme.infoSurface, fg: theme.info },
    warning: { bg: theme.warningSurface, fg: theme.warning },
    success: { bg: theme.successSurface, fg: theme.success },
    danger: { bg: theme.dangerSurface, fg: theme.danger },
  };
  const surface = surfaces[tone];

  return (
    <View
      accessibilityRole={tone === 'danger' || tone === 'warning' ? 'alert' : 'summary'}
      style={[styles.callout, { backgroundColor: surface.bg }]}
      testID={testID}
    >
      {title ? <RNText style={[styles.calloutTitle, { color: surface.fg }]}>{title}</RNText> : null}
      <RNText style={[styles.calloutBody, { color: theme.text }]}>{children}</RNText>
    </View>
  );
}

export type StatusRowProps = {
  label: string;
  value: string;
  tone?: CalloutTone | 'neutral';
  detail?: string;
  testID?: string;
};

/**
 * A labelled state row. Status is never carried by colour alone — `value` is
 * always spelled out, which is what a screen reader and a colour-blind user
 * both rely on.
 */
export function StatusRow({ label, value, tone = 'neutral', detail, testID }: StatusRowProps) {
  const theme = useUiTheme();
  const colors: Record<CalloutTone | 'neutral', string> = {
    neutral: theme.textSecondary,
    info: theme.info,
    warning: theme.warning,
    success: theme.success,
    danger: theme.danger,
  };

  return (
    <View
      accessible
      accessibilityLabel={`${label}: ${value}`}
      style={styles.statusRow}
      testID={testID}
    >
      <View style={styles.statusRowHeader}>
        <RNText style={[styles.statusLabel, { color: theme.textSecondary }]}>{label}</RNText>
        <RNText style={[styles.statusValue, { color: colors[tone] }]}>{value}</RNText>
      </View>
      {detail ? (
        <RNText style={[styles.caption, { color: theme.textSecondary }]}>{detail}</RNText>
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Choice rows
// ---------------------------------------------------------------------------

export type ChoiceRowProps = {
  title: string;
  description: string;
  onPress: () => void;
  selected?: boolean;
  disabled?: boolean;
  testID?: string;
};

export function ChoiceRow({
  title,
  description,
  onPress,
  selected = false,
  disabled = false,
  testID,
}: ChoiceRowProps) {
  const theme = useUiTheme();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.choiceRow,
        {
          backgroundColor: selected ? theme.backgroundSelected : theme.backgroundElement,
          borderColor: selected ? theme.accent : theme.border,
          opacity: disabled ? 0.5 : pressed ? 0.85 : 1,
        },
      ]}
      testID={testID}
    >
      <RNText style={[styles.choiceTitle, { color: theme.text }]}>{title}</RNText>
      <RNText style={[styles.choiceDescription, { color: theme.textSecondary }]}>
        {description}
      </RNText>
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// Text input
// ---------------------------------------------------------------------------

export type FieldProps = Omit<TextInputProps, 'style'> & {
  label: string;
  helper?: string;
  error?: string | null;
};

export const Field = forwardRef<TextInput, FieldProps>(function Field(
  { label, helper, error, ...inputProps },
  ref,
) {
  const theme = useUiTheme();
  return (
    <View style={styles.field}>
      <RNText style={[styles.fieldLabel, { color: theme.textSecondary }]}>{label}</RNText>
      <TextInput
        accessibilityLabel={label}
        accessibilityHint={helper}
        placeholderTextColor={theme.textSecondary}
        ref={ref}
        style={[
          styles.input,
          {
            backgroundColor: theme.backgroundElement,
            borderColor: error ? theme.danger : theme.border,
            color: theme.text,
          },
        ]}
        {...inputProps}
      />
      {error ? (
        <RNText accessibilityRole="alert" style={[styles.fieldError, { color: theme.danger }]}>
          {error}
        </RNText>
      ) : helper ? (
        <RNText style={[styles.caption, { color: theme.textSecondary }]}>{helper}</RNText>
      ) : null}
    </View>
  );
});

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

export type ProgressDotsProps = {
  count: number;
  index: number;
  label: string;
};

export function ProgressDots({ count, index, label }: ProgressDotsProps) {
  const theme = useUiTheme();
  const dots = Array.from({ length: Math.max(count, 0) }, (_unused, position) => position);
  return (
    <View
      accessible
      accessibilityLabel={`${label}. Step ${index + 1} of ${count}.`}
      accessibilityRole="progressbar"
      style={styles.progress}
    >
      {dots.map((position) => (
        <View
          key={position}
          style={[
            styles.progressDot,
            { backgroundColor: position <= index ? theme.accent : theme.border },
          ]}
        />
      ))}
    </View>
  );
}

// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  screen: { flex: 1 },
  screenBody: { gap: Spacing.three, paddingHorizontal: Spacing.four },
  scrollContent: { paddingBottom: Spacing.five, paddingTop: Spacing.four },
  footer: { borderTopWidth: StyleSheet.hairlineWidth },
  footerInner: {
    gap: Spacing.two,
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.three,
  },
  divider: { height: StyleSheet.hairlineWidth, width: '100%' },

  title: { fontSize: 28, fontWeight: '700', letterSpacing: -0.4, lineHeight: 34 },
  subtitle: { fontSize: 17, lineHeight: 24 },
  body: { fontSize: 16, lineHeight: 23 },
  caption: { fontSize: 13, lineHeight: 18 },

  card: {
    borderRadius: Radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    gap: Spacing.two,
    padding: Spacing.three,
  },

  button: {
    alignItems: 'center',
    borderRadius: Radius.md,
    borderWidth: 1,
    flexDirection: 'row',
    gap: Spacing.two,
    justifyContent: 'center',
    minHeight: MIN_TOUCH_TARGET + 6,
    paddingHorizontal: Spacing.four,
  },
  buttonPressed: { opacity: 0.82 },
  buttonDisabled: { opacity: 0.45 },
  buttonLabel: { fontSize: 16, fontWeight: '600' },

  linkButton: { minHeight: MIN_TOUCH_TARGET, justifyContent: 'center' },
  linkLabel: { fontSize: 15, fontWeight: '600' },

  callout: { borderRadius: Radius.md, gap: Spacing.one, padding: Spacing.three },
  calloutTitle: { fontSize: 14, fontWeight: '700' },
  calloutBody: { fontSize: 15, lineHeight: 21 },

  statusRow: { gap: Spacing.half, paddingVertical: Spacing.two },
  statusRowHeader: {
    alignItems: 'baseline',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  statusLabel: { fontSize: 14 },
  statusValue: { fontSize: 15, fontWeight: '700' },

  choiceRow: {
    borderRadius: Radius.md,
    borderWidth: 1,
    gap: Spacing.one,
    minHeight: MIN_TOUCH_TARGET,
    padding: Spacing.three,
  },
  choiceTitle: { fontSize: 17, fontWeight: '600' },
  choiceDescription: { fontSize: 14, lineHeight: 20 },

  field: { gap: Spacing.one },
  fieldLabel: { fontSize: 13, fontWeight: '600' },
  fieldError: { fontSize: 13, fontWeight: '600' },
  input: {
    borderRadius: Radius.sm,
    borderWidth: 1,
    fontSize: 17,
    minHeight: MIN_TOUCH_TARGET + 4,
    paddingHorizontal: Spacing.three,
  },

  progress: { flexDirection: 'row', gap: Spacing.two, justifyContent: 'center' },
  progressDot: { borderRadius: Radius.pill, height: 6, width: 22 },
});

export { Radius, MIN_TOUCH_TARGET, useUiTheme } from './tokens';
export type { UiTheme } from './tokens';
