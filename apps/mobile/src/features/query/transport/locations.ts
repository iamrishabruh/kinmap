import * as Crypto from 'expo-crypto';

import { AppError, LIMITS, type FamilyId, type TrackingState } from '@family/contracts';
import {
  CurrentLocationsResponseSchema,
  GetSharingSettingsResponseSchema,
  LocationHistoryResponseSchema,
  UpdateSharingResponseSchema,
  type LocationHistoryPoint,
  type LocationHistoryResponse,
  type MemberCurrentLocation,
  type SharingSettings,
  type UpdateSharingRequest,
} from '@family/schemas';

import { isAuthorizationGranted } from '@/features/location/engine/consent';
import { locationEngineStore } from '@/features/location/state/tracking-store';
import type { FamilyApi } from '@/features/query/api';
import type {
  DayHistory,
  HistorySegment,
  HistorySegmentKind,
  MemberLocation,
  SelfSharingState,
  TimelineEntry,
} from '@/features/query/types';
import { request } from '@/lib/api';

/**
 * The location slice of {@link FamilyApi}: where the family is now, where one
 * member was on a given day, and the caller's own sharing switch.
 *
 * Four deployed routes back this module and nothing else. Each is declared in
 * `infrastructure/stacks/api-stack.ts` and served by the function named beside
 * it:
 *
 *   `GET   /v1/families/{familyId}/locations/current` -> services/location-query
 *   `GET   /v1/users/{userId}/locations/history`      -> services/location-query
 *   `GET   /v1/privacy/sharing`                       -> services/api
 *   `PATCH /v1/privacy/sharing`                       -> services/api
 *
 * There is no `/pause` and no `/resume`: consent is one PATCH whose body says
 * what the state should become, so a single write can never leave sharing half
 * changed. There is also no timeline route at all — see `getMemberTimeline`.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MODULE IS NOT ALLOWED TO DO
 * ---------------------------------------------------------------------------
 * This is the only transport module that ever holds a precise position, so the
 * rules here are absolute rather than stylistic:
 *
 *   - It does not log. Not a success, not a failure, not a count. There is no
 *     logger imported and no `console` call, because the cheapest way to leak a
 *     position is a debugging line somebody forgot to remove.
 *   - It does not transform a coordinate. Every `LocationPoint` is the object
 *     Zod produced from the server's own response, moved into the view by
 *     reference: never rounded, never re-projected, never geocoded, never
 *     measured. Distances and freshness are somebody else's job.
 *   - It does not persist anything. React Query holds the result in memory,
 *     with the shortest lifetime of anything in the app (`CACHE_POLICIES`), and
 *     this module adds no second copy anywhere.
 *   - No coordinate reaches a URL. The only values put into a path or a query
 *     string are ids the server issued, plus the day boundaries of a history
 *     read.
 *
 * Every response is parsed by its schema from `@family/schemas` before a single
 * field is read. An unparsed body is how a shape change on the server becomes a
 * crash on a phone in somebody's pocket.
 */

/** Both bounds of a day are sent as instants, which is what the route accepts. */
const MILLISECONDS_PER_DAY = 86_400_000;

/**
 * A day of points can exceed one page, and a partial route drawn without saying
 * so is a lie about where somebody was. So history pages are followed — but only
 * this many, so a pathological account cannot spin the app forever. Ten pages is
 * 10,000 points, roughly one fix every eight seconds for a whole day, which is
 * far denser than any tracking mode the engine will produce.
 */
const MAX_HISTORY_PAGES = 10;

/**
 * Opaque, non-guessable idempotency key: randomness only, never user data, so
 * the header cannot carry anything about who is pausing or when.
 */
function newIdempotencyKey(): string {
  return Crypto.randomUUID();
}

function currentLocationsPath(familyId: FamilyId): string {
  return `/v1/families/${encodeURIComponent(familyId)}/locations/current`;
}

function historyPath(userId: string): string {
  return `/v1/users/${encodeURIComponent(userId)}/locations/history`;
}

// ---------------------------------------------------------------------------
// Current locations
// ---------------------------------------------------------------------------

/**
 * Wire entry -> view model.
 *
 * The two arms are kept apart exactly as the contract keeps them: the HIDDEN
 * arm has no positional field to copy, so a paused member's position cannot be
 * produced here even by a typo. `familyId` comes from the envelope, which is
 * the family the server authorised the read against — not from the argument the
 * caller passed in.
 *
 * Two view fields have no source in `MemberCurrentLocationSchema` and are
 * reported as gaps rather than guessed at:
 *
 *   - `isLowPowerMode` is device state the current-location response does not
 *     carry for anyone but yourself. `false` is the inert value: it renders no
 *     badge and claims nothing.
 *   - `liveSessionId` cannot be derived from `liveSessionExpiresAt`. An expiry
 *     is not an id, and putting a timestamp in a field the live-session screen
 *     would address a route with is worse than showing no live badge. (Today
 *     the service hardcodes that expiry to null anyway.)
 */
function toMemberLocation(familyId: FamilyId, entry: MemberCurrentLocation): MemberLocation {
  if (entry.visibility === 'HIDDEN') {
    return {
      visibility: 'HIDDEN',
      userId: entry.userId,
      familyId,
      sharingStatus: entry.sharingStatus,
      statusChangedAt: entry.sharingChangedAt,
    };
  }

  return {
    visibility: 'VISIBLE',
    userId: entry.userId,
    familyId,
    sharingStatus: entry.sharingStatus,
    // Moved, not rebuilt: the parsed point is handed to the view untouched.
    point: entry.point,
    capturedAt: entry.capturedAt,
    trackingState: entry.trackingState,
    batteryLevel: entry.batteryLevel,
    isCharging: entry.isCharging,
    isLowPowerMode: false,
    placeId: entry.placeId,
    placeName: entry.placeName,
    liveSessionId: null,
  };
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

/**
 * `day` is a bare calendar date with no zone, and the route takes instants, so
 * the day is read as a UTC day. The family's time zone is not applied here:
 * choosing which day a fix belongs to is a display decision, and making it in
 * two places would put the map and the day picker into disagreement.
 */
function dayRange(day: string): { from: string; to: string } {
  const from = `${day}T00:00:00.000Z`;
  const to = `${day}T23:59:59.999Z`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(from))) {
    throw new AppError('VALIDATION_FAILED', 'A day must be given as YYYY-MM-DD.');
  }
  return { from, to };
}

/**
 * The server classifies motion at ingestion; this only reads that classification
 * back. Nothing is inferred from the coordinates themselves — a client that
 * decided "moving" by measuring the gap between two fixes would be deriving new
 * location data from somebody's position, which is precisely what this module
 * must not do.
 */
function segmentKindOf(point: LocationHistoryPoint): HistorySegmentKind {
  if (point.motionState === 'STATIONARY') return 'STATIONARY';
  if (point.motionState === 'UNKNOWN' && point.trackingState === 'STATIONARY') return 'STATIONARY';
  return 'MOVING';
}

/**
 * Groups the day's points into the polyline segments the map draws.
 *
 * `GET /v1/users/{userId}/locations/history` returns a flat, time-ordered list
 * of points; it does not return trips, and no route in the table does. So the
 * grouping here is deliberately the smallest thing that lets the day be drawn:
 * consecutive points sharing the server's own motion classification and place
 * attribution become one segment, in the order the server sent them. Every
 * coordinate goes into `path` exactly as it was parsed.
 *
 * `distanceMeters` is reported as 0 because the response carries no distance and
 * this module will not compute one from coordinates. It is an unpopulated field,
 * not a measurement — reported as a gap so a screen does not start rendering it
 * as if it were real.
 */
function groupIntoSegments(points: readonly LocationHistoryPoint[]): HistorySegment[] {
  const segments: HistorySegment[] = [];
  let current: HistorySegment | null = null;
  let currentKey: string | null = null;

  for (const point of points) {
    const kind = segmentKindOf(point);
    const key = `${kind}:${point.placeId ?? ''}`;

    if (current === null || key !== currentKey) {
      // The segment is identified by the first event in it: a real id the server
      // issued, so it is stable across refetches instead of shuffling keys.
      current = {
        segmentId: point.eventId,
        kind,
        startedAt: point.capturedAt,
        endedAt: point.capturedAt,
        placeId: point.placeId,
        placeName: null,
        distanceMeters: 0,
        path: [point.point],
      };
      currentKey = key;
      segments.push(current);
      continue;
    }

    current.endedAt = point.capturedAt;
    current.path.push(point.point);
  }

  return segments;
}

type DayPoints = {
  points: LocationHistoryPoint[];
  familyId: FamilyId;
  retentionDays: number;
};

async function readDayPoints(
  input: { familyId: FamilyId; userId: string; day: string },
  signal?: AbortSignal,
): Promise<DayPoints> {
  const range = dayRange(input.day);
  const points: LocationHistoryPoint[] = [];
  let cursor: string | null = null;
  let familyId: FamilyId = input.familyId;
  let retentionDays = 0;

  for (let page = 0; page < MAX_HISTORY_PAGES; page += 1) {
    // Annotated rather than inferred: the request carries the cursor that the
    // response then sets, and TypeScript will not resolve that loop on its own.
    const response: LocationHistoryResponse = await request({
      method: 'GET',
      path: historyPath(input.userId),
      query: {
        from: range.from,
        to: range.to,
        // Naming the family saves the server walking every family the two people
        // share. It never widens the read: the same checklist runs either way.
        familyId: input.familyId,
        limit: LIMITS.MAX_HISTORY_PAGE_SIZE,
        cursor: cursor ?? undefined,
      },
      schema: LocationHistoryResponseSchema,
      signal,
    });

    if (response.visibility === 'HIDDEN') {
      // The arm exists so a paused member is not confused with a missing one.
      // Surfaced as an error rather than as an empty day, because an empty day
      // would tell the caller this person went nowhere.
      throw new AppError(
        'SHARING_DISABLED_BY_TARGET',
        'This person is not sharing their location history.',
      );
    }

    familyId = response.familyId ?? input.familyId;
    retentionDays = response.retentionDays;
    for (const point of response.points) points.push(point);

    if (!response.page.hasMore || response.page.nextCursor === null) break;
    cursor = response.page.nextCursor;
  }

  return { points, familyId, retentionDays };
}

/**
 * `isEmptyDay` means "inside retention and genuinely empty", so a day the plan
 * no longer keeps must not claim it. The server already applies logical expiry
 * per row; comparing the requested day against the retention window it reported
 * is what tells the two silences apart.
 */
function isInsideRetention(day: string, retentionDays: number, now: number): boolean {
  const dayStart = Date.parse(`${day}T00:00:00.000Z`);
  return dayStart >= now - retentionDays * MILLISECONDS_PER_DAY;
}

// ---------------------------------------------------------------------------
// The caller's own sharing state
// ---------------------------------------------------------------------------

/**
 * The half of `SelfSharingState` that no server can answer.
 *
 * `SelfSharingState` mirrors the OS state so the settings screen can explain
 * *why* sharing is not working — permission, background refresh, precise
 * location, the upload queue. None of that is in `SharingSettingsSchema`, and
 * none of it could be: it is what this handset is doing right now. So the
 * server owns `sharingStatus` and `updatedAt`, and these fields are read from
 * the app's own engine store, which is the single source the sharing indicator
 * already reads. Filling them with constants instead would have the privacy
 * screen assert that permissions are fine and nothing is queued, which is the
 * one screen that must never say that without knowing.
 */
export type DeviceSharingSnapshot = {
  trackingState: TrackingState;
  permissionBlocked: boolean;
  backgroundRefreshEnabled: boolean;
  preciseLocationEnabled: boolean;
  notificationsEnabled: boolean;
  batteryLevel: number | null;
  isLowPowerMode: boolean;
  lastUploadAt: string | null;
  pendingEventCount: number;
};

/**
 * Reads the engine store at call time rather than at module load, so a snapshot
 * taken before the engine started is never frozen into the transport. Nothing
 * here is a coordinate: the store deliberately holds the state machine only.
 */
function readDeviceSharingSnapshot(): DeviceSharingSnapshot {
  const snapshot = locationEngineStore.getState();
  const { permission, health } = snapshot;

  return {
    trackingState: snapshot.trackingState,
    // Unknown is not blocked. Before the engine has reported, the screen has
    // nothing to accuse the OS of.
    permissionBlocked:
      permission !== null &&
      (!permission.locationServicesEnabled || !isAuthorizationGranted(permission.authorization)),
    backgroundRefreshEnabled: permission?.backgroundRefreshEnabled ?? false,
    preciseLocationEnabled: permission?.preciseLocationEnabled ?? false,
    notificationsEnabled: permission?.notificationsEnabled ?? false,
    batteryLevel: health?.batteryLevel ?? null,
    isLowPowerMode: health?.isLowPowerMode ?? false,
    // The last upload the server accepted, not the last one attempted: this is
    // the field a user reads as "they can see me as of...".
    lastUploadAt: snapshot.lastAcceptedAt,
    pendingEventCount: snapshot.pendingEventCount,
  };
}

/**
 * `globalStatus` is the master switch, and it is the only status this view can
 * express. `sharing.families[]` — per-family pauses — has nowhere to go in
 * `SelfSharingState` and is dropped rather than flattened into something that
 * would misreport a family the user paused individually.
 */
function toSelfSharingState(
  sharing: SharingSettings,
  device: DeviceSharingSnapshot,
): SelfSharingState {
  return {
    sharingStatus: sharing.globalStatus,
    trackingState: device.trackingState,
    // Either authority may know: the server records PERMISSION_BLOCKED from the
    // last upload, the handset knows what the OS is doing right now.
    permissionBlocked: sharing.globalStatus === 'PERMISSION_BLOCKED' || device.permissionBlocked,
    backgroundRefreshEnabled: device.backgroundRefreshEnabled,
    preciseLocationEnabled: device.preciseLocationEnabled,
    notificationsEnabled: device.notificationsEnabled,
    batteryLevel: device.batteryLevel,
    isLowPowerMode: device.isLowPowerMode,
    lastUploadAt: device.lastUploadAt,
    pendingEventCount: device.pendingEventCount,
    updatedAt: sharing.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// The module
// ---------------------------------------------------------------------------

/** Exactly the six methods this module owns. */
export type LocationsApi = Pick<
  FamilyApi,
  | 'listCurrentLocations'
  | 'getMemberLocation'
  | 'getMemberTimeline'
  | 'getDayHistory'
  | 'getSharingState'
  | 'setSharingPaused'
>;

export type LocationsApiOptions = {
  /**
   * Supplies the OS-mirror half of `SelfSharingState`. Defaults to the app's
   * location engine store; injectable so a test can drive the settings screen
   * without a running engine.
   */
  readDeviceSharingSnapshot?: () => DeviceSharingSnapshot;
};

export function createLocationsApi(options: LocationsApiOptions = {}): LocationsApi {
  const readDevice = options.readDeviceSharingSnapshot ?? readDeviceSharingSnapshot;

  return {
    async listCurrentLocations(input, signal): Promise<MemberLocation[]> {
      const response = await request({
        method: 'GET',
        path: currentLocationsPath(input.familyId),
        schema: CurrentLocationsResponseSchema,
        signal,
      });

      return response.members.map((entry) => toMemberLocation(response.familyId, entry));
    },

    /**
     * One member, read through the family's own current-locations route with a
     * `userIds` filter — the route the deployed table actually has. There is no
     * `/families/{familyId}/members/{userId}/location`, and asking for one
     * member instead of twelve is a smaller read, not a different permission:
     * the server runs the identical §18 checklist either way.
     *
     * A member the response does not mention is reported as NOT_FOUND, which is
     * also what a caller outside the family gets, so this cannot be used to
     * probe whether somebody is in a family.
     */
    async getMemberLocation(input, signal): Promise<MemberLocation> {
      const response = await request({
        method: 'GET',
        path: currentLocationsPath(input.familyId),
        // Repeated query keys arrive comma-joined through the gateway's 2.0
        // payload format, which is exactly how the service splits them back.
        query: { userIds: input.userId },
        schema: CurrentLocationsResponseSchema,
        signal,
      });

      const entry = response.members.find((member) => member.userId === input.userId);
      if (entry === undefined) {
        throw new AppError('NOT_FOUND', 'That member is no longer available.');
      }
      return toMemberLocation(response.familyId, entry);
    },

    /**
     * NOT IMPLEMENTED, DELIBERATELY.
     *
     * `TimelineEntry` is a coordinate-free row: arrivals and departures by saved
     * place name, sharing and live-session transitions, permission loss. No route
     * in `API_ROUTES` returns anything of the sort. The history route returns raw
     * points and the audit route answers "who looked at me" for the caller alone,
     * so neither is a timeline for another member.
     *
     * The alternatives were both worse than failing. Returning `[]` would tell a
     * user their family member did nothing all day. Synthesising arrivals by
     * watching place ids change across history points would invent a server-owned
     * derivation on the device, from somebody else's positions, and it would be
     * believed. So this throws the same NOT_FOUND the missing route would, and
     * the gap is reported rather than buried.
     */
    async getMemberTimeline(_input, _signal): Promise<TimelineEntry[]> {
      throw new AppError(
        'NOT_FOUND',
        'A member timeline is not available in this version of Family Location.',
      );
    },

    async getDayHistory(input, signal): Promise<DayHistory> {
      const { points, familyId, retentionDays } = await readDayPoints(input, signal);

      return {
        day: input.day,
        userId: input.userId,
        // The family the server authorised against, falling back to the one that
        // was asked for when the server did not scope the read to one.
        familyId,
        segments: groupIntoSegments(points),
        isEmptyDay: points.length === 0 && isInsideRetention(input.day, retentionDays, Date.now()),
      };
    },

    async getSharingState(signal): Promise<SelfSharingState> {
      const response = await request({
        method: 'GET',
        path: '/v1/privacy/sharing',
        schema: GetSharingSettingsResponseSchema,
        signal,
      });

      return toSelfSharingState(response.sharing, readDevice());
    },

    /**
     * Pausing and resuming are one PATCH whose body says what the state should
     * become; there is no `/pause` and no `/resume` to call.
     *
     * `pauseUntil` is null in both directions. This interface pauses until the
     * user says otherwise — the only promise the app can keep without a device
     * clock deciding when somebody becomes visible again — and the contract
     * rejects an auto-resume instant on a resume outright.
     *
     * The idempotency key matters more here than anywhere else in the app: a
     * retried pause that the server treated as a second write is how somebody
     * ends up visible again without touching their phone.
     */
    async setSharingPaused(input): Promise<SelfSharingState> {
      const body: UpdateSharingRequest = {
        scope: 'GLOBAL',
        familyId: null,
        sharing: !input.paused,
        pauseUntil: null,
      };

      const response = await request({
        method: 'PATCH',
        path: '/v1/privacy/sharing',
        body,
        schema: UpdateSharingResponseSchema,
        idempotencyKey: newIdempotencyKey(),
      });

      // `affectedViewerUserIds` — who just lost sight of the user — is parsed and
      // dropped: `SelfSharingState` has nowhere to put it, and it is not this
      // module's business to decide how that is shown.
      return toSelfSharingState(response.sharing, readDevice());
    },
  };
}

/** The composed instance; `createLocationsApi()` exists for tests that want a fresh one. */
export const locationsApi: LocationsApi = createLocationsApi();
