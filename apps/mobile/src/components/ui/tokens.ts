import { Colors } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';

/**
 * Semantic colour tokens for the auth and consent surface.
 *
 * `@/constants/theme` only carries the neutral ramp. Consent screens need
 * accent, warning, danger and success surfaces so that "sharing is ON" and
 * "sharing is OFF" are legible at a glance and never rely on colour alone —
 * every status in this app is also carried by text.
 */

type SemanticPalette = {
  accent: string;
  accentPressed: string;
  onAccent: string;
  danger: string;
  dangerSurface: string;
  warning: string;
  warningSurface: string;
  success: string;
  successSurface: string;
  info: string;
  infoSurface: string;
  border: string;
  overlay: string;
};

const SEMANTIC: Record<'light' | 'dark', SemanticPalette> = {
  light: {
    accent: '#0B6FD0',
    accentPressed: '#095AA8',
    onAccent: '#FFFFFF',
    danger: '#B3261E',
    dangerSurface: '#FCEBEA',
    warning: '#7A4F00',
    warningSurface: '#FFF4DB',
    success: '#1B5E20',
    successSurface: '#E6F4EA',
    info: '#0B4C8C',
    infoSurface: '#E6F1FB',
    border: '#D3D8DE',
    overlay: 'rgba(0,0,0,0.45)',
  },
  dark: {
    accent: '#5AA9F5',
    accentPressed: '#3D8FDD',
    onAccent: '#04182B',
    danger: '#F2B8B5',
    dangerSurface: '#3A1614',
    warning: '#F5CE7A',
    warningSurface: '#3A2C0E',
    success: '#9ED8A6',
    successSurface: '#11301A',
    info: '#9CC9F5',
    infoSurface: '#0F2437',
    border: '#3A3D42',
    overlay: 'rgba(0,0,0,0.65)',
  },
};

// Colors is declared `as const`, so Colors.light and Colors.dark have distinct
// literal types. Widen the ramp to string so either scheme satisfies UiTheme.
export type UiTheme = Record<keyof (typeof Colors)['light'], string> &
  SemanticPalette & { scheme: 'light' | 'dark' };

export function resolveUiTheme(scheme: 'light' | 'dark'): UiTheme {
  return { ...Colors[scheme], ...SEMANTIC[scheme], scheme };
}

export function useUiTheme(): UiTheme {
  const scheme = useColorScheme();
  return resolveUiTheme(scheme === 'dark' ? 'dark' : 'light');
}

/** 4pt rhythm, matching `Spacing` in `@/constants/theme`. */
export const Radius = {
  sm: 8,
  md: 12,
  lg: 20,
  pill: 999,
} as const;

/** Minimum touch target required for every interactive element. */
export const MIN_TOUCH_TARGET = 44;
