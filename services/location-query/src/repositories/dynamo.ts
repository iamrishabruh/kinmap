import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';

import {
  AccountStatusSchema,
  DeviceStatusSchema,
  type DeviceRecord,
  type DeviceRepository,
  type FamilyMembershipRepository,
  type SubscriptionRecord,
  type SubscriptionRepository,
  type UserAccountRecord,
  type UserAccountRepository,
} from '@family/auth';
import {
  AppError,
  DeviceIdSchema,
  ENTITLED_SUBSCRIPTION_STATUSES,
  FamilyIdSchema,
  FamilyRoleSchema,
  LIMITS,
  MembershipStatusSchema,
  PLAN_TIER,
  PlanSchema,
  PlaceIdSchema,
  SharingStatusSchema,
  SubscriptionStatusSchema,
  UserIdSchema,
  type AuditEvent,
  type DeviceId,
  type FamilyId,
  type PlanTier,
  type UserId,
} from '@family/contracts';
import { EncryptedCoordinateRecordSchema } from '@family/crypto';

import { historyPartitionKeyForDay } from '../domain/history-window.js';
import type {
  AuditWriter,
  CurrentLocationReader,
  FamilyMemberRow,
  HistoryPageRequest,
  HistoryReader,
  MembershipDirectory,
  SavedPlaceReader,
  SavedPlaceRow,
  SealedFixRow,
  SealedHistoryRow,
} from '../ports.js';

/**
 * DynamoDB bindings.
 *
 * Every item is re-validated on the way out of the table. A row written by an
 * older deployment, or by a bug, must not be able to masquerade as a valid
 * membership or a valid ciphertext — a malformed row is treated as absent, which
 * is the fail-closed direction for both authorisation and decryption.
 */

/** Audit rows outlive a subscription so "who looked at me" survives a lapse. */
const AUDIT_RETENTION_DAYS = 400;
const SECONDS_PER_DAY = 86_400;

export const dynamoClient = new DynamoDBClient({});

export const documentClient = DynamoDBDocumentClient.from(dynamoClient, {
  marshallOptions: { removeUndefinedValues: true, convertClassInstanceToMap: false },
  unmarshallOptions: { wrapNumbers: false },
});

function upstreamUnavailable(): AppError {
  return new AppError('UPSTREAM_UNAVAILABLE', 'A dependency is temporarily unavailable.');
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function asNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asBooleanOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

// ---------------------------------------------------------------------------
// Accounts and devices (§18 steps 2 and 3)
// ---------------------------------------------------------------------------

export function createUserAccountRepository(tableName: string): UserAccountRepository {
  return {
    async getUserAccount(input: { userId: UserId }): Promise<UserAccountRecord | null> {
      const result = await documentClient.send(
        new GetCommand({
          TableName: tableName,
          Key: { userId: input.userId },
          ProjectionExpression: 'userId, #status',
          ExpressionAttributeNames: { '#status': 'status' },
          ConsistentRead: true,
        }),
      );
      const item = result.Item;
      if (item === undefined) {
        return null;
      }
      const userId = UserIdSchema.safeParse(item.userId);
      const status = AccountStatusSchema.safeParse(item.status);
      return userId.success && status.success ? { userId: userId.data, status: status.data } : null;
    },
  };
}

export function createDeviceRepository(tableName: string): DeviceRepository {
  return {
    async getDevice(input: { userId: UserId; deviceId: DeviceId }): Promise<DeviceRecord | null> {
      const result = await documentClient.send(
        new GetCommand({
          TableName: tableName,
          Key: { userId: input.userId, deviceId: input.deviceId },
          ProjectionExpression: 'userId, deviceId, #status',
          ExpressionAttributeNames: { '#status': 'status' },
          ConsistentRead: true,
        }),
      );
      const item = result.Item;
      if (item === undefined) {
        return null;
      }
      const userId = UserIdSchema.safeParse(item.userId);
      const deviceId = DeviceIdSchema.safeParse(item.deviceId);
      const status = DeviceStatusSchema.safeParse(item.status);
      return userId.success && deviceId.success && status.success
        ? { userId: userId.data, deviceId: deviceId.data, status: status.data }
        : null;
    },
  };
}

// ---------------------------------------------------------------------------
// Memberships (§18 steps 4-7)
// ---------------------------------------------------------------------------

function toMemberRow(item: Record<string, unknown>): FamilyMemberRow | null {
  const familyId = FamilyIdSchema.safeParse(item.familyId);
  const userId = UserIdSchema.safeParse(item.userId);
  const role = FamilyRoleSchema.safeParse(item.role);
  const status = MembershipStatusSchema.safeParse(item.status);
  const sharingStatus = SharingStatusSchema.safeParse(item.sharingStatus);
  if (
    !familyId.success ||
    !userId.success ||
    !role.success ||
    !status.success ||
    !sharingStatus.success
  ) {
    return null;
  }

  const visibleRaw = item.visibleToUserIds;
  const hiddenRaw = item.hiddenFromUserIds;

  return {
    familyId: familyId.data,
    userId: userId.data,
    role: role.data,
    status: status.data,
    sharingStatus: sharingStatus.data,
    visibleToUserIds: Array.isArray(visibleRaw)
      ? visibleRaw.filter((value): value is string => typeof value === 'string')
      : null,
    ...(Array.isArray(hiddenRaw)
      ? {
          hiddenFromUserIds: hiddenRaw.filter(
            (value): value is string => typeof value === 'string',
          ),
        }
      : {}),
    sharingChangedAt: asString(item.sharingChangedAt),
  };
}

export function createMembershipDirectory(
  tableName: string,
): MembershipDirectory & FamilyMembershipRepository {
  return {
    async getMembership(input: {
      familyId: FamilyId;
      userId: UserId;
    }): Promise<FamilyMemberRow | null> {
      const result = await documentClient.send(
        new GetCommand({
          TableName: tableName,
          Key: { familyId: input.familyId, userId: input.userId },
          // Strongly consistent: a removal must revoke access immediately, not
          // after a replica catches up.
          ConsistentRead: true,
        }),
      );
      return result.Item === undefined ? null : toMemberRow(result.Item);
    },

    async listFamilyMembers(familyId: FamilyId): Promise<FamilyMemberRow[]> {
      const result = await documentClient.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: '#familyId = :familyId',
          ExpressionAttributeNames: { '#familyId': 'familyId' },
          ExpressionAttributeValues: { ':familyId': familyId },
          Limit: LIMITS.MAX_FAMILY_MEMBERS,
          ConsistentRead: true,
        }),
      );
      return (result.Items ?? []).flatMap((item) => {
        const row = toMemberRow(item);
        return row === null ? [] : [row];
      });
    },

    async listFamiliesForUser(userId: UserId): Promise<FamilyMemberRow[]> {
      const result = await documentClient.send(
        new QueryCommand({
          TableName: tableName,
          IndexName: 'byUser',
          KeyConditionExpression: '#userId = :userId',
          ExpressionAttributeNames: { '#userId': 'userId' },
          ExpressionAttributeValues: { ':userId': userId },
          Limit: LIMITS.MAX_FAMILY_MEMBERS,
        }),
      );
      return (result.Items ?? []).flatMap((item) => {
        const row = toMemberRow(item);
        return row === null || row.status !== 'ACTIVE' ? [] : [row];
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Subscriptions (§18 step 8)
// ---------------------------------------------------------------------------

const TIER_RANK: Record<PlanTier, number> = { FREE: 0, FAMILY: 1, FAMILY_PLUS: 2 };

export function createSubscriptionRepository(tableName: string): SubscriptionRepository {
  return {
    async getSubscriptionForFamily(input: {
      familyId: FamilyId;
    }): Promise<SubscriptionRecord | null> {
      const result = await documentClient.send(
        new QueryCommand({
          TableName: tableName,
          IndexName: 'byFamily',
          KeyConditionExpression: '#familyId = :familyId',
          ExpressionAttributeNames: { '#familyId': 'familyId' },
          ExpressionAttributeValues: { ':familyId': input.familyId },
          Limit: LIMITS.MAX_FAMILY_MEMBERS,
        }),
      );

      // A family may carry several rows over its lifetime. Entitlements are the
      // best currently-entitled one, derived from the stored record only — a
      // client-supplied plan or receipt is never an input.
      let best: SubscriptionRecord | null = null;
      for (const item of result.Items ?? []) {
        const familyId = FamilyIdSchema.safeParse(item.familyId);
        const plan = PlanSchema.safeParse(item.plan);
        const status = SubscriptionStatusSchema.safeParse(item.status);
        if (!familyId.success || !plan.success || !status.success) {
          continue;
        }
        if (!ENTITLED_SUBSCRIPTION_STATUSES.includes(status.data)) {
          continue;
        }
        const candidate: SubscriptionRecord = {
          familyId: familyId.data,
          plan: plan.data,
          status: status.data,
        };
        if (
          best === null ||
          TIER_RANK[PLAN_TIER[candidate.plan]] > TIER_RANK[PLAN_TIER[best.plan]]
        ) {
          best = candidate;
        }
      }
      return best;
    },
  };
}

// ---------------------------------------------------------------------------
// Stored fixes
// ---------------------------------------------------------------------------

function toSealedFixRow(item: Record<string, unknown>): SealedFixRow | null {
  const userId = UserIdSchema.safeParse(item.userId);
  const deviceId = DeviceIdSchema.safeParse(item.deviceId);
  const scope = FamilyIdSchema.safeParse(item.coordinateScopeFamilyId);
  const sealed = EncryptedCoordinateRecordSchema.safeParse(item.sealed);
  const capturedAt = asString(item.capturedAt);
  const eventId = asString(item.eventId);
  if (
    !userId.success ||
    !deviceId.success ||
    !scope.success ||
    !sealed.success ||
    capturedAt === null ||
    eventId === null
  ) {
    return null;
  }

  const trackingState = item.trackingState;
  const motionState = item.motionState;

  return {
    userId: userId.data,
    deviceId: deviceId.data,
    eventId,
    capturedAt,
    receivedAt: asString(item.receivedAt) ?? capturedAt,
    trackingState:
      typeof trackingState === 'string'
        ? (trackingState as SealedFixRow['trackingState'])
        : 'STALE',
    motionState:
      typeof motionState === 'string' ? (motionState as SealedFixRow['motionState']) : 'UNKNOWN',
    horizontalAccuracy: asNumberOrNull(item.horizontalAccuracy) ?? 0,
    altitude: asNumberOrNull(item.altitude),
    heading: asNumberOrNull(item.heading),
    speed: asNumberOrNull(item.speed),
    batteryLevel: asNumberOrNull(item.batteryLevel),
    isLowPowerMode: asBooleanOrNull(item.isLowPowerMode),
    coordinateScopeFamilyId: scope.data,
    sealed: sealed.data,
    ...(typeof item.expiresAt === 'number' ? { expiresAt: item.expiresAt } : {}),
  };
}

export function createCurrentLocationReader(tableName: string): CurrentLocationReader {
  return {
    async latestForUser(userId: UserId): Promise<SealedFixRow | null> {
      const result = await documentClient.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: '#userId = :userId',
          ExpressionAttributeNames: { '#userId': 'userId' },
          ExpressionAttributeValues: { ':userId': userId },
        }),
      );

      // One row per device; the freshest capture wins so a spare tablet left at
      // home does not shadow the phone in someone's pocket.
      let newest: SealedFixRow | null = null;
      for (const item of result.Items ?? []) {
        const row = toSealedFixRow(item);
        if (row === null) {
          continue;
        }
        if (newest === null || row.capturedAt > newest.capturedAt) {
          newest = row;
        }
      }
      return newest;
    },
  };
}

export function createHistoryReader(tableName: string): HistoryReader {
  return {
    async queryDay(request: HistoryPageRequest): Promise<SealedHistoryRow[]> {
      const partitionKey = historyPartitionKeyForDay(request.userId, request.day);
      const result = await documentClient.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: '#pk = :pk AND #sk BETWEEN :low AND :high',
          ExpressionAttributeNames: { '#pk': 'pk', '#sk': 'sk' },
          ExpressionAttributeValues: {
            ':pk': partitionKey,
            ':low': request.lowSortKey,
            ':high': request.highSortKey,
          },
          Limit: request.limit,
          ScanIndexForward: true,
          ...(request.exclusiveStartSortKey === null
            ? {}
            : {
                ExclusiveStartKey: { pk: partitionKey, sk: request.exclusiveStartSortKey },
              }),
        }),
      );

      return (result.Items ?? []).flatMap((item) => {
        const row = toSealedFixRow(item);
        const sortKey = asString(item.sk);
        return row === null || sortKey === null ? [] : [{ ...row, day: request.day, sortKey }];
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Saved places
// ---------------------------------------------------------------------------

export function createSavedPlaceReader(tableName: string): SavedPlaceReader {
  return {
    async listForFamily(familyId: FamilyId): Promise<SavedPlaceRow[]> {
      const result = await documentClient.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: '#familyId = :familyId',
          ExpressionAttributeNames: { '#familyId': 'familyId' },
          ExpressionAttributeValues: { ':familyId': familyId },
          Limit: LIMITS.MAX_SAVED_PLACES,
        }),
      );

      return (result.Items ?? []).flatMap((item) => {
        const placeId = PlaceIdSchema.safeParse(item.placeId);
        const name = asString(item.name);
        const placeLat = asNumberOrNull(item.latitude);
        const placeLng = asNumberOrNull(item.longitude);
        const radiusMeters = asNumberOrNull(item.radiusMeters);
        if (
          !placeId.success ||
          name === null ||
          placeLat === null ||
          placeLng === null ||
          radiusMeters === null
        ) {
          return [];
        }
        return [
          {
            placeId: placeId.data,
            name,
            latitude: placeLat,
            longitude: placeLng,
            radiusMeters,
          },
        ];
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export function createAuditWriter(tableName: string): AuditWriter {
  return {
    async record(event: AuditEvent): Promise<void> {
      try {
        await documentClient.send(
          new PutCommand({
            TableName: tableName,
            Item: {
              // Keyed by the person who was looked at: "who accessed my
              // location?" must be one query, not a scan.
              targetUserId: event.targetUserId ?? event.actorUserId,
              sk: `${event.occurredAt}#${event.auditId}`,
              auditId: event.auditId,
              action: event.action,
              actorUserId: event.actorUserId,
              familyId: event.familyId,
              metadata: event.metadata,
              occurredAt: event.occurredAt,
              requestId: event.requestId,
              sourceIpHash: event.sourceIpHash,
              expiresAt:
                Math.floor(Date.parse(event.occurredAt) / 1000) +
                AUDIT_RETENTION_DAYS * SECONDS_PER_DAY,
            },
            // An audit id collision would overwrite someone else's record.
            ConditionExpression: 'attribute_not_exists(targetUserId) OR attribute_not_exists(sk)',
          }),
        );
      } catch {
        // The read must not be served if it cannot be accounted for.
        throw upstreamUnavailable();
      }
    },
  };
}
