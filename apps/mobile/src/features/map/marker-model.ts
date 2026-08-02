import type { Freshness, SharingStatus, UserId } from '@family/contracts';

import { freshnessFor, isStaleFreshness } from '@/features/map/freshness';
import {
  isVisibleLocation,
  type FamilyMemberView,
  type LocationPoint,
  type MemberLocation,
} from '@/features/query/types';
import { formatRelativeTime, initialsOf } from '@/features/ui/format';

/**
 * Turns members + locations into exactly what the map may draw.
 *
 * This module is the enforcement point for the product's central promise. Two
 * things are true of it by construction:
 *
 *   1. A member who is not sharing produces a `MemberAbsence`, which has no
 *      positional field of any kind. There is no code path — not a fallback,
 *      not a "last known", not a cached value — that yields a position for
 *      someone who paused. They appear in the member list with "Sharing
 *      paused" and nowhere on the map (spec §19, §35).
 *
 *   2. A member whose fix is old produces a marker whose `freshness` is STALE
 *      and whose `isStale` flag is true. The renderer is required to style it
 *      differently. A stale fix is never presented as a fresh one.
 *
 * If you need to add a new sharing state, add it to `absenceFor` and the
 * compiler will tell you where else to handle it.
 */

export type AbsenceReason =
  | 'PAUSED'
  | 'PERMISSION_BLOCKED'
  | 'SHARING_OFF'
  | 'NEVER_ENABLED'
  | 'NOT_SHARING_WITH_YOU'
  | 'NO_LOCATION_YET';

export type PresenceTone = 'live' | 'fresh' | 'recent' | 'stale' | 'paused' | 'blocked';

export type MemberMarker = {
  kind: 'MARKER';
  userId: UserId;
  displayName: string;
  initials: string;
  /** The only positional payload in this module. Consumed by the map alone. */
  point: LocationPoint;
  capturedAt: string;
  freshness: Freshness;
  isStale: boolean;
  /** A live session is streaming this member right now. */
  isLive: boolean;
  liveSessionId: string | null;
  tone: PresenceTone;
  /** "Just now" / "42 min ago". Always rendered next to the marker's label. */
  freshnessLabel: string;
  /** Saved place name if the member is inside one. A name, never a position. */
  placeName: string | null;
  batteryLevel: number | null;
  isCharging: boolean | null;
  accessibilityLabel: string;
};

export type MemberAbsence = {
  kind: 'NO_POSITION';
  userId: UserId;
  displayName: string;
  initials: string;
  reason: AbsenceReason;
  /** Headline shown in the member strip, e.g. "Sharing paused". */
  title: string;
  /** One line of honest explanation. */
  detail: string;
  tone: PresenceTone;
  accessibilityLabel: string;
};

export type MemberPresence = MemberMarker | MemberAbsence;

export function isMarker(presence: MemberPresence): presence is MemberMarker {
  return presence.kind === 'MARKER';
}

const ABSENCE_COPY: Record<AbsenceReason, { title: string; detail: string; tone: PresenceTone }> = {
  PAUSED: {
    title: 'Sharing paused',
    detail: 'They paused location sharing. No position is shown while it is paused.',
    tone: 'paused',
  },
  PERMISSION_BLOCKED: {
    title: 'Location permission off',
    detail: 'Their phone is not allowing location access, so nothing is being shared.',
    tone: 'blocked',
  },
  SHARING_OFF: {
    title: 'Sharing off',
    detail: 'They turned location sharing off for this family.',
    tone: 'paused',
  },
  NEVER_ENABLED: {
    title: 'Not sharing yet',
    detail: 'They have not turned on location sharing.',
    tone: 'paused',
  },
  NOT_SHARING_WITH_YOU: {
    title: 'Not sharing with you',
    detail: 'They are not sharing their location with you.',
    tone: 'paused',
  },
  NO_LOCATION_YET: {
    title: 'No location yet',
    detail: 'Sharing is on, but no location has arrived from their phone yet.',
    tone: 'stale',
  },
};

function absenceReasonFor(sharingStatus: Exclude<SharingStatus, 'SHARING'>): AbsenceReason {
  switch (sharingStatus) {
    case 'PAUSED':
      return 'PAUSED';
    case 'PERMISSION_BLOCKED':
      return 'PERMISSION_BLOCKED';
    case 'DISABLED':
      return 'SHARING_OFF';
    case 'NEVER_ENABLED':
    default:
      return 'NEVER_ENABLED';
  }
}

function buildAbsence(member: FamilyMemberView, reason: AbsenceReason): MemberAbsence {
  const copy = ABSENCE_COPY[reason];
  return {
    kind: 'NO_POSITION',
    userId: member.userId,
    displayName: member.displayName,
    initials: initialsOf(member.displayName),
    reason,
    title: copy.title,
    detail: copy.detail,
    tone: copy.tone,
    accessibilityLabel: `${member.displayName}. ${copy.title}. ${copy.detail}`,
  };
}

function toneFor(freshness: Freshness): PresenceTone {
  switch (freshness) {
    case 'LIVE':
      return 'live';
    case 'FRESH':
      return 'fresh';
    case 'RECENT':
      return 'recent';
    case 'STALE':
    case 'UNKNOWN':
    default:
      return 'stale';
  }
}

/**
 * Builds the presence for one member.
 *
 * Order matters: sharing status is checked BEFORE the payload is inspected. If
 * the member roster says PAUSED, no location object — however it got into the
 * cache — can produce a marker. The two sources are allowed to disagree; when
 * they do, the answer is always "no position".
 */
export function buildMemberPresence(
  member: FamilyMemberView,
  location: MemberLocation | undefined,
  nowMs: number,
): MemberPresence {
  if (!member.sharingWithCaller) {
    return buildAbsence(member, 'NOT_SHARING_WITH_YOU');
  }

  if (member.sharingStatus !== 'SHARING') {
    return buildAbsence(member, absenceReasonFor(member.sharingStatus));
  }

  if (location === undefined) {
    return buildAbsence(member, 'NO_LOCATION_YET');
  }

  if (!isVisibleLocation(location)) {
    return buildAbsence(member, absenceReasonFor(location.sharingStatus));
  }

  const freshness = freshnessFor(location.capturedAt, nowMs);
  const stale = isStaleFreshness(freshness);
  const relative = formatRelativeTime(location.capturedAt, nowMs);
  const isLive = location.liveSessionId !== null;
  const placeSuffix = location.placeName === null ? '' : ` at ${location.placeName}`;

  return {
    kind: 'MARKER',
    userId: member.userId,
    displayName: member.displayName,
    initials: initialsOf(member.displayName),
    point: location.point,
    capturedAt: location.capturedAt,
    freshness,
    isStale: stale,
    isLive,
    liveSessionId: location.liveSessionId,
    tone: isLive ? 'live' : toneFor(freshness),
    freshnessLabel: stale ? `Last seen ${relative}` : `Updated ${relative}`,
    placeName: location.placeName,
    batteryLevel: location.batteryLevel,
    isCharging: location.isCharging,
    accessibilityLabel: stale
      ? `${member.displayName}${placeSuffix}. Position may be out of date. Last seen ${relative}.`
      : `${member.displayName}${placeSuffix}. Updated ${relative}.`,
  };
}

/**
 * Presences for a whole family, sorted so the people you can actually see come
 * first, freshest first, and the "not shown" rows sit together at the bottom.
 * Members who are no longer ACTIVE are dropped entirely.
 */
export function buildFamilyPresences(
  members: readonly FamilyMemberView[],
  locations: readonly MemberLocation[],
  nowMs: number,
): MemberPresence[] {
  const byUserId = new Map<UserId, MemberLocation>();
  for (const location of locations) {
    byUserId.set(location.userId, location);
  }

  return members
    .filter((member) => member.status === 'ACTIVE')
    .map((member) => buildMemberPresence(member, byUserId.get(member.userId), nowMs))
    .sort(comparePresence);
}

function presenceRank(presence: MemberPresence): number {
  if (!isMarker(presence)) return 10;
  if (presence.isLive) return 0;
  switch (presence.freshness) {
    case 'LIVE':
      return 1;
    case 'FRESH':
      return 2;
    case 'RECENT':
      return 3;
    default:
      return 4;
  }
}

function comparePresence(a: MemberPresence, b: MemberPresence): number {
  const rank = presenceRank(a) - presenceRank(b);
  if (rank !== 0) return rank;
  return a.displayName.localeCompare(b.displayName);
}

/**
 * The markers the map is allowed to draw. Anything without a position is
 * structurally excluded — this is what guarantees a paused member has no pin.
 */
export function drawableMarkers(presences: readonly MemberPresence[]): MemberMarker[] {
  return presences.filter(isMarker);
}

export function absentPresences(presences: readonly MemberPresence[]): MemberAbsence[] {
  return presences.filter((presence): presence is MemberAbsence => presence.kind === 'NO_POSITION');
}

/**
 * Camera framing. With at most `LIMITS.MAX_FAMILY_MEMBERS` (12) pins there is
 * no clustering anywhere in this app: every member is one pin, always, so a
 * person can never be hidden inside a cluster bubble.
 */
export type MapRegion = {
  latitude: number;
  longitude: number;
  latitudeDelta: number;
  longitudeDelta: number;
};

const MIN_DELTA = 0.01;
const PADDING_FACTOR = 1.6;

export function regionForMarkers(markers: readonly MemberMarker[]): MapRegion | null {
  const first = markers[0];
  if (first === undefined) return null;

  let minLat = first.point.latitude;
  let maxLat = first.point.latitude;
  let minLon = first.point.longitude;
  let maxLon = first.point.longitude;

  for (const marker of markers) {
    minLat = Math.min(minLat, marker.point.latitude);
    maxLat = Math.max(maxLat, marker.point.latitude);
    minLon = Math.min(minLon, marker.point.longitude);
    maxLon = Math.max(maxLon, marker.point.longitude);
  }

  return {
    latitude: (minLat + maxLat) / 2,
    longitude: (minLon + maxLon) / 2,
    latitudeDelta: Math.max(MIN_DELTA, (maxLat - minLat) * PADDING_FACTOR),
    longitudeDelta: Math.max(MIN_DELTA, (maxLon - minLon) * PADDING_FACTOR),
  };
}

/** Rough zoom level for the expo-maps camera, derived from a region. */
export function zoomForRegion(region: MapRegion): number {
  const delta = Math.max(region.latitudeDelta, region.longitudeDelta, MIN_DELTA);
  const zoom = Math.log2(360 / delta);
  return Math.min(18, Math.max(2, Math.round(zoom)));
}
