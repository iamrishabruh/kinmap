import { randomUUID } from 'node:crypto';

import {
  type AuthContext,
  type AuthorizationChecker,
  type HistoryAuthorizationGrant,
} from '@family/auth';
import {
  AppError,
  opaqueAuthorizationError,
  type AuditEvent,
  type FamilyId,
  type UserId,
} from '@family/contracts';
import type { Logger } from '@family/observability';
import type {
  CurrentLocationsResponse,
  LocationHistoryPoint,
  LocationHistoryQuery,
  LocationHistoryResponse,
  LocationPoint,
  MemberCurrentLocation,
} from '@family/schemas';
import { haversineMeters } from '@family/validation';

import {
  dayPartitions,
  decodeCursor,
  encodeCursor,
  isLogicallyExpired,
  resolvePageSize,
  sortKeyBounds,
  type HistoryCursor,
} from './domain/history-window.js';
import { classifyFreshness, classifyMember, isRenderableMember } from './domain/visibility.js';
import type {
  AuditWriter,
  CoordinateOpener,
  CurrentLocationReader,
  FamilyMemberRow,
  HistoryReader,
  MembershipDirectory,
  SavedPlaceReader,
  SavedPlaceRow,
  SealedFixRow,
} from './ports.js';

/**
 * The two authorised reads.
 *
 * Both follow the same shape: authorise server-side against the membership
 * records and the target's own sharing switch, decrypt only what the caller is
 * entitled to, and record the read before answering. A caller who fails any
 * check receives the single opaque FORBIDDEN produced by @family/auth — the
 * specific cause never leaves the process.
 */

export type QueryDependencies = {
  readonly checker: AuthorizationChecker;
  readonly memberships: MembershipDirectory;
  readonly currentLocations: CurrentLocationReader;
  readonly history: HistoryReader;
  readonly savedPlaces: SavedPlaceReader | null;
  readonly opener: CoordinateOpener;
  readonly audit: AuditWriter;
  readonly logger: Logger;
  readonly now: () => Date;
};

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function toLocationPoint(fix: { lat: number; lng: number }, row: SealedFixRow): LocationPoint {
  return {
    latitude: fix.lat,
    longitude: fix.lng,
    horizontalAccuracy: row.horizontalAccuracy,
    altitude: row.altitude,
    heading: row.heading,
    speed: row.speed,
  };
}

/**
 * The saved place a fix falls inside, if any.
 *
 * Resolved server-side so the response can name "Home" without the client ever
 * holding the family's saved-place geometry — which is a list of home and school
 * addresses.
 */
function resolvePlace(
  point: { lat: number; lng: number },
  places: readonly SavedPlaceRow[],
): SavedPlaceRow | null {
  let closest: SavedPlaceRow | null = null;
  let closestDistance = Number.POSITIVE_INFINITY;

  for (const place of places) {
    const distance = haversineMeters(
      { latitude: point.lat, longitude: point.lng },
      { latitude: place.latitude, longitude: place.longitude },
    );
    if (distance <= place.radiusMeters && distance < closestDistance) {
      closest = place;
      closestDistance = distance;
    }
  }
  return closest;
}

function auditEvent(input: {
  action: AuditEvent['action'];
  actorUserId: UserId;
  targetUserId: UserId;
  familyId: FamilyId | null;
  requestId: string;
  occurredAt: string;
  metadata: AuditEvent['metadata'];
}): AuditEvent {
  return {
    auditId: randomUUID(),
    action: input.action,
    actorUserId: input.actorUserId,
    targetUserId: input.targetUserId,
    familyId: input.familyId,
    // Coarse only: counts and flags. Never a coordinate, never a place name.
    metadata: input.metadata,
    occurredAt: input.occurredAt,
    requestId: input.requestId,
    sourceIpHash: null,
  };
}

// ---------------------------------------------------------------------------
// GET /v1/families/{familyId}/locations/current
// ---------------------------------------------------------------------------

export type CurrentLocationsRequest = {
  readonly auth: AuthContext;
  readonly familyId: FamilyId;
  /** Restrict to specific members; null for the whole family. */
  readonly userIds: readonly UserId[] | null;
};

export async function readCurrentLocations(
  request: CurrentLocationsRequest,
  deps: QueryDependencies,
): Promise<CurrentLocationsResponse> {
  const now = deps.now();
  const generatedAt = now.toISOString();

  // Authorising against the caller's *own* membership runs the full §18
  // checklist — active account, registered device, ACTIVE membership in this
  // family, rate limit — without asserting anything about the other members.
  // Per-member consent is applied below, because a paused member must still
  // appear in the list rather than vanish from it.
  await deps.checker.assertCanReadCurrentLocation({
    auth: request.auth,
    familyId: request.familyId,
    targetUserId: request.auth.userId,
  });

  const requested = request.userIds === null ? null : new Set<string>(request.userIds);
  const members = (await deps.memberships.listFamilyMembers(request.familyId))
    .filter(isRenderableMember)
    .filter((member) => requested === null || requested.has(member.userId));

  const places =
    deps.savedPlaces === null ? [] : await deps.savedPlaces.listForFamily(request.familyId);

  const entries: MemberCurrentLocation[] = [];
  const revealed: UserId[] = [];

  for (const member of members) {
    const entry = await buildMemberEntry(member, request, deps, places, now);
    entries.push(entry);
    if (entry.visibility === 'VISIBLE' && entry.userId !== request.auth.userId) {
      revealed.push(entry.userId);
    }
  }

  // The audit trail answers "who looked at me". Written before the response is
  // produced: a read that cannot be recorded must not be served.
  for (const targetUserId of revealed) {
    await deps.audit.record(
      auditEvent({
        action: 'LOCATION_CURRENT_READ',
        actorUserId: request.auth.userId,
        targetUserId,
        familyId: request.familyId,
        requestId: request.auth.requestId,
        occurredAt: generatedAt,
        metadata: { memberCount: members.length },
      }),
    );
  }

  deps.logger.info('current locations read', {
    familyId: request.familyId,
    actorUserId: request.auth.userId,
    memberCount: members.length,
    revealedCount: revealed.length,
  });

  entries.sort((left, right) =>
    left.userId < right.userId ? -1 : left.userId > right.userId ? 1 : 0,
  );

  return { familyId: request.familyId, generatedAt, members: entries };
}

async function buildMemberEntry(
  member: FamilyMemberRow,
  request: CurrentLocationsRequest,
  deps: QueryDependencies,
  places: readonly SavedPlaceRow[],
  now: Date,
): Promise<MemberCurrentLocation> {
  const classification = classifyMember(member, request.auth.userId);
  if (classification.kind === 'HIDDEN') {
    return {
      visibility: 'HIDDEN',
      userId: member.userId,
      sharingStatus: classification.sharingStatus,
      freshness: 'UNKNOWN',
      sharingChangedAt: member.sharingChangedAt,
    };
  }

  const row = await deps.currentLocations.latestForUser(member.userId);
  if (row === null) {
    // Sharing is on but nothing has ever been stored — a brand-new member, or a
    // device that has not yet produced a fix. There is no coordinate to return,
    // and the visible arm cannot be constructed without one.
    return {
      visibility: 'HIDDEN',
      userId: member.userId,
      sharingStatus: 'NEVER_ENABLED',
      freshness: 'UNKNOWN',
      sharingChangedAt: member.sharingChangedAt,
    };
  }

  // The encryption context comes from the row, never from the request: a caller
  // cannot nominate a family in order to have a fix decrypted under it.
  const fix = await deps.opener.decryptCoordinates(row.sealed, {
    familyId: row.coordinateScopeFamilyId,
    userId: row.userId,
  });
  const place = resolvePlace(fix, places);

  return {
    visibility: 'VISIBLE',
    userId: member.userId,
    sharingStatus: 'SHARING',
    point: toLocationPoint(fix, row),
    freshness: classifyFreshness(row.capturedAt, now.getTime()),
    capturedAt: row.capturedAt,
    receivedAt: row.receivedAt,
    trackingState: row.trackingState,
    motionState: row.motionState,
    batteryLevel: row.batteryLevel,
    isCharging: null,
    placeId: place?.placeId ?? null,
    placeName: place?.name ?? null,
    liveSessionExpiresAt: null,
  };
}

// ---------------------------------------------------------------------------
// GET /v1/users/{userId}/locations/history
// ---------------------------------------------------------------------------

export type LocationHistoryRequest = {
  readonly auth: AuthContext;
  readonly targetUserId: UserId;
  readonly query: LocationHistoryQuery;
};

/**
 * A history read is authorised against a *specific* family. When the client did
 * not name one, every family the two people actually share is tried in a stable
 * order. This never widens the read — each attempt runs the same checklist — it
 * only saves the client a round trip.
 */
async function authorizeHistory(
  request: LocationHistoryRequest,
  deps: QueryDependencies,
): Promise<HistoryAuthorizationGrant> {
  const range = { from: request.query.from, to: request.query.to };

  const named = request.query.familyId;
  if (named !== null) {
    return deps.checker.assertCanReadHistory({
      auth: request.auth,
      familyId: named,
      targetUserId: request.targetUserId,
      range,
    });
  }

  const requesterFamilies = await deps.memberships.listFamiliesForUser(request.auth.userId);
  const candidates =
    request.targetUserId === request.auth.userId
      ? requesterFamilies.map((membership) => membership.familyId)
      : await sharedFamilies(requesterFamilies, request.targetUserId, deps);

  for (const familyId of [...candidates].sort()) {
    try {
      return await deps.checker.assertCanReadHistory({
        auth: request.auth,
        familyId,
        targetUserId: request.targetUserId,
        range,
      });
    } catch (error) {
      if (!(error instanceof AppError)) {
        throw error;
      }
      // Keep trying; every failure is the same opaque denial anyway.
    }
  }

  throw opaqueAuthorizationError(request.auth.requestId);
}

async function sharedFamilies(
  requesterFamilies: readonly FamilyMemberRow[],
  targetUserId: UserId,
  deps: QueryDependencies,
): Promise<FamilyId[]> {
  const targetFamilies = await deps.memberships.listFamiliesForUser(targetUserId);
  const targetIds = new Set<string>(targetFamilies.map((membership) => membership.familyId));
  return requesterFamilies
    .filter((membership) => targetIds.has(membership.familyId))
    .map((membership) => membership.familyId);
}

export async function readLocationHistory(
  request: LocationHistoryRequest,
  deps: QueryDependencies,
): Promise<LocationHistoryResponse> {
  const now = deps.now();
  const grant = await authorizeHistory(request, deps);

  const { effectiveRange, retentionDays } = grant;
  const days = dayPartitions(effectiveRange.from, effectiveRange.to);
  const bounds = sortKeyBounds(effectiveRange.from, effectiveRange.to);
  const pageSize = resolvePageSize(request.query.limit);
  const cursor = request.query.cursor === null ? null : decodeCursor(request.query.cursor);

  const points: LocationHistoryPoint[] = [];
  let lastReturned: HistoryCursor | null = null;
  let hasMore = false;
  let expiredCount = 0;

  const remainingDays = days.filter((day) => cursor === null || day >= cursor.day);

  outer: for (const day of remainingDays) {
    let startSortKey = cursor !== null && day === cursor.day ? cursor.sk : null;

    for (;;) {
      const rows = await deps.history.queryDay({
        userId: request.targetUserId,
        day,
        lowSortKey: bounds.low,
        highSortKey: bounds.high,
        exclusiveStartSortKey: startSortKey,
        // One extra so a full page can be distinguished from an exhausted day.
        limit: pageSize + 1,
      });
      if (rows.length === 0) {
        break;
      }

      for (const row of rows) {
        startSortKey = row.sortKey;

        // LOGICAL EXPIRY: a row past the plan's retention is not returned even
        // when DynamoDB has not yet swept it, and it does not consume a slot in
        // the page either.
        if (isLogicallyExpired(row, retentionDays, now)) {
          expiredCount += 1;
          continue;
        }
        if (points.length >= pageSize) {
          hasMore = true;
          break outer;
        }

        const fix = await deps.opener.decryptCoordinates(row.sealed, {
          familyId: row.coordinateScopeFamilyId,
          userId: row.userId,
        });
        points.push({
          eventId: row.eventId,
          point: toLocationPoint(fix, row),
          capturedAt: row.capturedAt,
          trackingState: row.trackingState,
          motionState: row.motionState,
          placeId: null,
        });
        lastReturned = { day, sk: row.sortKey };
      }

      if (rows.length <= pageSize) {
        break;
      }
    }
  }

  await deps.audit.record(
    auditEvent({
      action: 'LOCATION_HISTORY_READ',
      actorUserId: request.auth.userId,
      targetUserId: request.targetUserId,
      familyId: grant.familyId,
      requestId: request.auth.requestId,
      occurredAt: now.toISOString(),
      metadata: {
        pointCount: points.length,
        dayCount: days.length,
        retentionDays,
        truncated: hasMore,
      },
    }),
  );

  deps.logger.info('location history read', {
    actorUserId: request.auth.userId,
    targetUserId: request.targetUserId,
    familyId: grant.familyId,
    pointCount: points.length,
    logicallyExpiredCount: expiredCount,
  });

  return {
    visibility: 'VISIBLE',
    userId: request.targetUserId,
    familyId: grant.familyId,
    from: effectiveRange.from,
    to: effectiveRange.to,
    points,
    page: {
      nextCursor: hasMore && lastReturned !== null ? encodeCursor(lastReturned) : null,
      hasMore,
    },
    retentionDays,
  };
}
