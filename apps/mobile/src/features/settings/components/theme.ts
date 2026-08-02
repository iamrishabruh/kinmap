import { Colors, Spacing } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';

/**
 * Semantic colours for the settings surface.
 *
 * `@/constants/theme` owns the app's neutral palette; this adds only the
 * meanings this surface needs — "this is on", "this is stopped", "this will
 * destroy something". Those three states carry real consequences here, so they
 * are named by meaning rather than by hue, and every one of them is paired with
 * a text label in the UI: colour alone never communicates whether a user is
 * being located.
 */

const SEMANTIC = {
  light: {
    accent: '#0B69D4',
    accentSoft: '#E7F1FD',
    danger: '#C0272D',
    dangerSoft: '#FDECEC',
    warning: '#8A5A00',
    warningSoft: '#FDF3E2',
    success: '#1B7F4A',
    successSoft: '#E6F5EC',
    border: '#DCDFE4',
    scrim: 'rgba(0,0,0,0.35)',
  },
  dark: {
    accent: '#5FA8FF',
    accentSoft: '#132C46',
    danger: '#FF7B7B',
    dangerSoft: '#3A1C1C',
    warning: '#F0B75E',
    warningSoft: '#3A2E17',
    success: '#5CD08A',
    successSoft: '#15321F',
    border: '#2E3135',
    scrim: 'rgba(0,0,0,0.6)',
  },
} as const;

// Colors and SEMANTIC are declared `as const`, so their light and dark members
// have distinct literal types. Widening to string lets either scheme satisfy
// SettingsTheme.
export type SettingsTheme = Record<keyof (typeof Colors)['light'], string> &
  Record<keyof (typeof SEMANTIC)['light'], string>;

export function useSettingsTheme(): SettingsTheme {
  const scheme = useColorScheme();
  const mode = scheme === 'dark' ? 'dark' : 'light';
  return { ...Colors[mode], ...SEMANTIC[mode] };
}

export { Spacing };

/** Type scale used across the settings screens. */
export const Type = {
  title: { fontSize: 28, lineHeight: 34, fontWeight: '700' },
  heading: { fontSize: 20, lineHeight: 26, fontWeight: '700' },
  sectionTitle: { fontSize: 13, lineHeight: 18, fontWeight: '600' },
  body: { fontSize: 16, lineHeight: 22, fontWeight: '400' },
  bodyStrong: { fontSize: 16, lineHeight: 22, fontWeight: '600' },
  caption: { fontSize: 13, lineHeight: 18, fontWeight: '400' },
} as const;
