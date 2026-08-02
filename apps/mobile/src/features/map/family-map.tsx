import { AppleMaps, GoogleMaps } from 'expo-maps';
import { useMemo } from 'react';
import { Platform, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import {
  regionForMarkers,
  zoomForRegion,
  type MapRegion,
  type MemberMarker,
} from '@/features/map/marker-model';
import { markerVisual } from '@/features/map/marker-style';
import type { LocationPoint } from '@/features/query/types';
import { usePalette } from '@/features/ui/palette';

/**
 * The only component in the app that touches `expo-maps`, and the only surface
 * on which a coordinate is ever rendered (spec §20).
 *
 * Everything that reaches this file has already been through
 * `buildFamilyPresences`, so a position here is one the target is actively
 * sharing. There is no prop for "last known position", no fallback pin, and no
 * clustering: with `LIMITS.MAX_FAMILY_MEMBERS` capped at 12, every member is
 * drawn as their own pin so nobody is ever swallowed into a cluster bubble.
 */

export type MapPathSegment = {
  id: string;
  points: readonly LocationPoint[];
  color: string;
  width: number;
};

export type FamilyMapSurfaceProps = {
  markers: readonly MemberMarker[];
  /** Route geometry for the history screen. Empty everywhere else. */
  paths?: readonly MapPathSegment[];
  /** Explicit framing; otherwise the camera fits the markers. */
  region?: MapRegion | null;
  style?: StyleProp<ViewStyle>;
  /** Single non-member pin, used by the saved-place editor. */
  focusPoint?: { latitude: number; longitude: number; title: string } | null;
};

type MapCoordinate = { latitude: number; longitude: number };

function toCoordinate(point: LocationPoint | MapCoordinate): MapCoordinate {
  return { latitude: point.latitude, longitude: point.longitude };
}

export function FamilyMapSurface({
  markers,
  paths = [],
  region = null,
  style,
  focusPoint = null,
}: FamilyMapSurfaceProps) {
  const palette = usePalette();

  const nativeMarkers = useMemo(
    () =>
      markers.map((marker) => {
        const visual = markerVisual(palette, marker);
        return {
          coordinates: toCoordinate(marker.point),
          // The freshness label travels with the pin so the map itself never
          // shows a bare dot that implies "here, now".
          title: `${marker.displayName} · ${marker.freshnessLabel}`,
          tintColor: visual.fill,
        };
      }),
    [markers, palette],
  );

  const nativePolylines = useMemo(
    () =>
      paths
        .filter((segment) => segment.points.length > 1)
        .map((segment) => ({
          coordinates: segment.points.map(toCoordinate),
          color: segment.color,
          width: segment.width,
        })),
    [paths],
  );

  const focusMarkers = useMemo(
    () =>
      focusPoint === null
        ? []
        : [
            {
              coordinates: toCoordinate(focusPoint),
              title: focusPoint.title,
              tintColor: palette.accent,
            },
          ],
    [focusPoint, palette.accent],
  );

  const allMarkers = useMemo(
    () => [...nativeMarkers, ...focusMarkers],
    [nativeMarkers, focusMarkers],
  );

  const camera = useMemo(() => {
    const explicit = region ?? regionForMarkers(markers);
    const fallbackFromPaths = explicit === null ? firstPathRegion(paths) : explicit;
    const resolved =
      fallbackFromPaths ??
      (focusPoint === null
        ? null
        : {
            latitude: focusPoint.latitude,
            longitude: focusPoint.longitude,
            latitudeDelta: 0.01,
            longitudeDelta: 0.01,
          });
    if (resolved === null) return null;
    return {
      coordinates: { latitude: resolved.latitude, longitude: resolved.longitude },
      zoom: zoomForRegion(resolved),
    };
  }, [region, markers, paths, focusPoint]);

  if (Platform.OS === 'ios') {
    return (
      <AppleMaps.View
        style={[styles.map, style]}
        markers={allMarkers}
        polylines={nativePolylines}
        {...(camera === null ? {} : { cameraPosition: camera })}
      />
    );
  }

  if (Platform.OS === 'android') {
    return (
      <GoogleMaps.View
        style={[styles.map, style]}
        markers={allMarkers}
        polylines={nativePolylines}
        {...(camera === null ? {} : { cameraPosition: camera })}
      />
    );
  }

  // No native map here. Say so plainly rather than draw a placeholder that
  // could be mistaken for a real position.
  return (
    <View
      style={[styles.map, styles.unsupported, { backgroundColor: palette.surface }, style]}
      accessibilityRole="summary"
    >
      <Text style={[styles.unsupportedTitle, { color: palette.text }]}>Map not available here</Text>
      <Text style={[styles.unsupportedBody, { color: palette.textSecondary }]}>
        Open the app on your phone to see the family map.
      </Text>
    </View>
  );
}

function firstPathRegion(paths: readonly MapPathSegment[]): MapRegion | null {
  const points = paths.flatMap((segment) => segment.points);
  const first = points[0];
  if (first === undefined) return null;

  let minLat = first.latitude;
  let maxLat = first.latitude;
  let minLon = first.longitude;
  let maxLon = first.longitude;
  for (const point of points) {
    minLat = Math.min(minLat, point.latitude);
    maxLat = Math.max(maxLat, point.latitude);
    minLon = Math.min(minLon, point.longitude);
    maxLon = Math.max(maxLon, point.longitude);
  }
  return {
    latitude: (minLat + maxLat) / 2,
    longitude: (minLon + maxLon) / 2,
    latitudeDelta: Math.max(0.01, (maxLat - minLat) * 1.6),
    longitudeDelta: Math.max(0.01, (maxLon - minLon) * 1.6),
  };
}

const styles = StyleSheet.create({
  map: { flex: 1, minHeight: 220 },
  unsupported: { alignItems: 'center', justifyContent: 'center', gap: 8, padding: 24 },
  unsupportedTitle: { fontSize: 16, fontWeight: '700' },
  unsupportedBody: { fontSize: 14, textAlign: 'center' },
});
