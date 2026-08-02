import { Colors } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';

/**
 * Semantic colour tokens layered on top of the base theme in
 * `@/constants/theme`. The base theme owns neutrals; this module owns the
 * *meaning* colours the product needs — and in a consent-based location app the
 * status colours are load-bearing, not decorative.
 *
 * In particular `stale`, `paused` and `blocked` must never be mistaken for
 * `live` or `fresh`. A user looking at the map has to be able to tell, at a
 * glance and without reading, that what they are seeing is old or absent
 * (spec §19). Nothing here may be used to make an unavailable position look
 * available.
 */
export type Palette = {
  text: string;
  textSecondary: string;
  textMuted: string;
  background: string;
  surface: string;
  surfaceSelected: string;
  border: string;
  borderStrong: string;
  accent: string;
  onAccent: string;
  success: string;
  successSurface: string;
  warning: string;
  warningSurface: string;
  danger: string;
  dangerSurface: string;
  /** Reserved exclusively for an in-progress live session. */
  live: string;
  liveSurface: string;
  onLive: string;
  /** A position we hold but that is older than the RECENT bucket. */
  stale: string;
  staleSurface: string;
  /** The member deliberately switched sharing off. Never implies a position. */
  paused: string;
  pausedSurface: string;
  /** The OS is withholding location from the member's own device. */
  blocked: string;
  blockedSurface: string;
  scrim: string;
};

export const PALETTES: Record<'light' | 'dark', Palette> = {
  light: {
    text: Colors.light.text,
    textSecondary: Colors.light.textSecondary,
    textMuted: '#80838D',
    background: Colors.light.background,
    surface: Colors.light.backgroundElement,
    surfaceSelected: Colors.light.backgroundSelected,
    border: '#DFE0E6',
    borderStrong: '#C3C5CE',
    accent: '#208AEF',
    onAccent: '#FFFFFF',
    success: '#18794E',
    successSurface: '#E4F7EC',
    warning: '#9A5B00',
    warningSurface: '#FDF2E0',
    danger: '#C22B2B',
    dangerSurface: '#FDEDED',
    live: '#D93025',
    liveSurface: '#FCE8E6',
    onLive: '#FFFFFF',
    stale: '#6F7278',
    staleSurface: '#ECEDF0',
    paused: '#5A5D66',
    pausedSurface: '#E9EAEE',
    blocked: '#8C4A00',
    blockedSurface: '#FBEDDD',
    scrim: 'rgba(0,0,0,0.45)',
  },
  dark: {
    text: Colors.dark.text,
    textSecondary: Colors.dark.textSecondary,
    textMuted: '#8A8F98',
    background: Colors.dark.background,
    surface: Colors.dark.backgroundElement,
    surfaceSelected: Colors.dark.backgroundSelected,
    border: '#33363B',
    borderStrong: '#4A4E55',
    accent: '#4DA3FF',
    onAccent: '#04121F',
    success: '#4CC38A',
    successSurface: '#0E2A1D',
    warning: '#E0A44B',
    warningSurface: '#2C1F0B',
    danger: '#FF6369',
    dangerSurface: '#2B1214',
    live: '#FF5A4E',
    liveSurface: '#33100C',
    onLive: '#1A0503',
    stale: '#9AA0A8',
    staleSurface: '#1F2124',
    paused: '#A0A5AD',
    pausedSurface: '#1C1E21',
    blocked: '#E4A66A',
    blockedSurface: '#2A1B0C',
    scrim: 'rgba(0,0,0,0.65)',
  },
};

export function usePalette(): Palette {
  const scheme = useColorScheme();
  return scheme === 'dark' ? PALETTES.dark : PALETTES.light;
}
