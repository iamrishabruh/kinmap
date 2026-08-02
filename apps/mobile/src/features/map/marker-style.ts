import type { PresenceTone } from '@/features/map/marker-model';
import type { Palette } from '@/features/ui/palette';
import type { PillTone } from '@/features/ui/primitives';

/**
 * Visual encoding for presence.
 *
 * Colour alone is not enough — around 1 in 12 men cannot reliably separate the
 * red/grey pair we use for live vs stale. So staleness is encoded three ways at
 * once: a desaturated fill, a DASHED ring instead of a solid one, and a text
 * label ("Last seen 42 min ago") that is always rendered. Any one of the three
 * is sufficient to tell a fresh position from an old one.
 */

export type RingStyle = 'SOLID' | 'DASHED';

export type MarkerVisual = {
  fill: string;
  ring: string;
  ringStyle: RingStyle;
  ringWidth: number;
  /** Applied to the whole pin. Stale pins are visibly recessive. */
  opacity: number;
  /** Only ever 'LIVE'; there is no badge that implies freshness we lack. */
  badge: 'LIVE' | null;
};

export function toneColor(palette: Palette, tone: PresenceTone): string {
  switch (tone) {
    case 'live':
      return palette.live;
    case 'fresh':
      return palette.success;
    case 'recent':
      return palette.accent;
    case 'stale':
      return palette.stale;
    case 'paused':
      return palette.paused;
    case 'blocked':
      return palette.blocked;
    default:
      return palette.stale;
  }
}

export function toneSurface(palette: Palette, tone: PresenceTone): string {
  switch (tone) {
    case 'live':
      return palette.liveSurface;
    case 'fresh':
      return palette.successSurface;
    case 'recent':
      return palette.surfaceSelected;
    case 'stale':
      return palette.staleSurface;
    case 'paused':
      return palette.pausedSurface;
    case 'blocked':
      return palette.blockedSurface;
    default:
      return palette.staleSurface;
  }
}

export function tonePill(tone: PresenceTone): PillTone {
  switch (tone) {
    case 'live':
      return 'live';
    case 'fresh':
      return 'success';
    case 'recent':
      return 'neutral';
    case 'stale':
      return 'stale';
    case 'paused':
      return 'paused';
    case 'blocked':
      return 'blocked';
    default:
      return 'neutral';
  }
}

export function markerVisual(
  palette: Palette,
  input: { tone: PresenceTone; isStale: boolean; isLive: boolean },
): MarkerVisual {
  if (input.isLive) {
    return {
      fill: palette.live,
      ring: palette.live,
      ringStyle: 'SOLID',
      ringWidth: 3,
      opacity: 1,
      badge: 'LIVE',
    };
  }
  if (input.isStale) {
    return {
      fill: palette.staleSurface,
      ring: palette.stale,
      ringStyle: 'DASHED',
      ringWidth: 2,
      opacity: 0.55,
      badge: null,
    };
  }
  const color = toneColor(palette, input.tone);
  return {
    fill: color,
    ring: color,
    ringStyle: 'SOLID',
    ringWidth: 2,
    opacity: 1,
    badge: null,
  };
}
