/**
 * Design tokens shared by the mobile app and the marketing site.
 *
 * Sharing status is the most important thing this product communicates, so its
 * colours are named semantically and are ALWAYS paired with text in the
 * components below — colour alone never carries the meaning of "you are being
 * located right now".
 */

export type ColorScheme = 'light' | 'dark';

export type Palette = {
  background: string;
  surface: string;
  surfaceRaised: string;
  border: string;
  text: string;
  textMuted: string;
  textInverse: string;
  accent: string;
  accentPressed: string;
  onAccent: string;
  /** Sharing is active and location is fresh. */
  sharing: string;
  sharingSurface: string;
  /** The user has deliberately paused sharing. */
  paused: string;
  pausedSurface: string;
  /** The OS is preventing sharing (permission or services disabled). */
  blocked: string;
  blockedSurface: string;
  /** Data exists but is older than the freshness threshold. */
  stale: string;
  staleSurface: string;
  danger: string;
  dangerSurface: string;
};

export const palettes: Record<ColorScheme, Palette> = {
  light: {
    background: '#FFFFFF',
    surface: '#F6F8FA',
    surfaceRaised: '#FFFFFF',
    border: '#DDE3EA',
    text: '#0B1622',
    textMuted: '#5A6B7B',
    textInverse: '#FFFFFF',
    accent: '#0B6BCB',
    accentPressed: '#095AAC',
    onAccent: '#FFFFFF',
    sharing: '#137A4E',
    sharingSurface: '#E4F5EC',
    paused: '#8A5A00',
    pausedSurface: '#FCF1DC',
    blocked: '#A32B2B',
    blockedSurface: '#FBE9E9',
    stale: '#5A6B7B',
    staleSurface: '#EDF1F5',
    danger: '#A32B2B',
    dangerSurface: '#FBE9E9',
  },
  dark: {
    background: '#0B1016',
    surface: '#141B23',
    surfaceRaised: '#1B242E',
    border: '#2A3641',
    text: '#F2F6FA',
    textMuted: '#9BAABA',
    textInverse: '#0B1016',
    accent: '#4DA3FF',
    accentPressed: '#3B8AE0',
    onAccent: '#04121F',
    sharing: '#4FD08A',
    sharingSurface: '#12291E',
    paused: '#E5B45C',
    pausedSurface: '#2C2313',
    blocked: '#FF8080',
    blockedSurface: '#2E1616',
    stale: '#9BAABA',
    staleSurface: '#1C242C',
    danger: '#FF8080',
    dangerSurface: '#2E1616',
  },
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radii = {
  sm: 6,
  md: 10,
  lg: 16,
  pill: 999,
} as const;

export const typography = {
  title: { fontSize: 28, lineHeight: 34, fontWeight: '700' },
  heading: { fontSize: 20, lineHeight: 26, fontWeight: '600' },
  body: { fontSize: 16, lineHeight: 22, fontWeight: '400' },
  label: { fontSize: 14, lineHeight: 20, fontWeight: '600' },
  caption: { fontSize: 13, lineHeight: 18, fontWeight: '400' },
} as const;

/** Minimum tap target, per both Apple HIG and Material guidance. */
export const MIN_TAP_TARGET = 44;
