import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  type BatchWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';

import {
  AccountStatusSchema,
  DeviceStatusSchema,
  type DeviceRecord,
  type FamilyMembershipRecord,
  type UserAccountRecord,
} from '@family/auth';
import {
  AppError,
  DeviceIdSchema,
  FamilyIdSchema,
  FamilyRoleSchema,
  LIMITS,
  MembershipStatusSchema,
  SharingStatusSchema,
  UserIdSchema,
  type DeviceId,
  type UserId,
} from '@family/contracts';

import type { StoredCurrentLocation, StoredHistoryPoint } from '../domain/records.js';
import type {
  AccountReader,
  CurrentLocationStore,
  DeviceReader,
  HistoryWriter,
  MembershipReader,
  UploadWindowGate,
  UploadWindowDecision,
} from '../ports.js';

/**
 * DynamoDB bindings for the ingestion ports.
 *
 * Clients are constructed at module scope so a warm container reuses its
 * connection pool and its credential cache. Every row that crosses this boundary
 * is re-validated against the contract schemas: a table is shared infrastructure,
 * and an item written by an older deployment must not be trusted to still match
 * the type the compiler believes it has.
 */

const CONDITIONAL_CHECK_FAILED = 'ConditionalCheckFailedException';

/** The element type BatchWriteItem accepts, so retries stay type-compatible. */
type WriteRequests = NonNullable<BatchWriteCommandInput['RequestItems']>[string];

export const dynamoClient = new DynamoDBClient({});

export const documentClient = DynamoDBDocumentClient.from(dynamoClient, {
  marshallOptions: { removeUndefinedValues: true, convertClassInstanceToMap: false },
  unmarshallOptions: { wrapNumbers: false },
});

function isConditionalCheckFailure(error: unknown): boolean {
  return error instanceof Error && error.name === CONDITIONAL_CHECK_FAILED;
}

function upstreamUnavailable(): AppError {
  return new AppError('UPSTREAM_UNAVAILABLE', 'A dependency is temporarily unavailable.');
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export function createAccountReader(tableName: string): AccountReader {
  return {
    async getAccount(userId: UserId): Promise<UserAccountRecord | null> {
      const result = await documentClient.send(
        new GetCommand({
          TableName: tableName,
          Key: { userId },
          ProjectionExpression: 'userId, #status',
          ExpressionAttributeNames: { '#status': 'status' },
          ConsistentRead: true,
        }),
      );
      const item = result.Item;
      if (item === undefined) {
        return null;
      }
      const parsedId = UserIdSchema.safeParse(item.userId);
      const parsedStatus = AccountStatusSchema.safeParse(item.status);
      if (!parsedId.success || !parsedStatus.success) {
        return null;
      }
      return { userId: parsedId.data, status: parsedStatus.data };
    },
  };
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

export function createDeviceReader(tableName: string): DeviceReader {
  return {
    async getDevice(userId: UserId, deviceId: DeviceId): Promise<DeviceRecord | null> {
      const result = await documentClient.send(
        new GetCommand({
          TableName: tableName,
          Key: { userId, deviceId },
          ProjectionExpression: 'userId, deviceId, #status',
          ExpressionAttributeNames: { '#status': 'status' },
          ConsistentRead: true,
        }),
      );
      const item = result.Item;
      if (item === undefined) {
        return null;
      }
      const parsedUser = UserIdSchema.safeParse(item.userId);
      const parsedDevice = DeviceIdSchema.safeParse(item.deviceId);
      const parsedStatus = DeviceStatusSchema.safeParse(item.status);
      if (!parsedUser.success || !parsedDevice.success || !parsedStatus.success) {
        return null;
      }
      return { userId: parsedUser.data, deviceId: parsedDevice.data, status: parsedStatus.data };
    },
  };
}

// ---------------------------------------------------------------------------
// Family memberships
// ---------------------------------------------------------------------------

function toMembership(item: Record<string, unknown>): FamilyMembershipRecord | null {
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
  const visibleToUserIds = Array.isArray(visibleRaw)
    ? visibleRaw.filter((value): value is string => typeof value === 'string')
    : null;
  const hiddenRaw = item.hiddenFromUserIds;
  const hiddenFromUserIds = Array.isArray(hiddenRaw)
    ? hiddenRaw.filter((value): value is string => typeof value === 'string')
    : undefined;

  return {
    familyId: familyId.data,
    userId: userId.data,
    role: role.data,
    status: status.data,
    sharingStatus: sharingStatus.data,
    visibleToUserIds,
    ...(hiddenFromUserIds === undefined ? {} : { hiddenFromUserIds }),
  };
}

export function createMembershipReader(tableName: string): MembershipReader {
  return {
    async listForUser(userId: UserId): Promise<FamilyMembershipRecord[]> {
      const result = await documentClient.send(
        new QueryCommand({
          TableName: tableName,
          IndexName: 'byUser',
          KeyConditionExpression: '#userId = :userId',
          ExpressionAttributeNames: { '#userId': 'userId' },
          ExpressionAttributeValues: { ':userId': userId },
          // A user cannot belong to more families than the platform ceiling
          // allows, so an unbounded page is never needed here.
          Limit: LIMITS.MAX_FAMILY_MEMBERS,
        }),
      );
      const items = result.Items ?? [];
      const memberships: FamilyMembershipRecord[] = [];
      for (const item of items) {
        const membership = toMembership(item);
        if (membership !== null) {
          memberships.push(membership);
        }
      }
      return memberships;
    },
  };
}

// ---------------------------------------------------------------------------
// Per-device upload window
// ---------------------------------------------------------------------------

/**
 * `LIMITS.MIN_UPLOAD_INTERVAL_SECONDS` enforced with a conditional write on the
 * idempotency table. The condition — "no row, or the previous window has already
 * elapsed" — makes the gate correct across concurrent containers, which a
 * read-then-write or an in-memory counter would not be.
 */
export function createUploadWindowGate(tableName: string): UploadWindowGate {
  return {
    async reserve(deviceId: DeviceId, now: Date): Promise<UploadWindowDecision> {
      const nowSeconds = Math.floor(now.getTime() / 1000);
      const expiresAt = nowSeconds + LIMITS.MIN_UPLOAD_INTERVAL_SECONDS;

      try {
        await documentClient.send(
          new PutCommand({
            TableName: tableName,
            Item: {
              idempotencyKey: `LOCATION_BATCH#${deviceId}`,
              reservedAt: now.toISOString(),
              expiresAt,
            },
            ConditionExpression: 'attribute_not_exists(idempotencyKey) OR expiresAt <= :now',
            ExpressionAttributeValues: { ':now': nowSeconds },
          }),
        );
        return { allowed: true, retryAfterSeconds: LIMITS.MIN_UPLOAD_INTERVAL_SECONDS };
      } catch (error) {
        if (isConditionalCheckFailure(error)) {
          return { allowed: false, retryAfterSeconds: LIMITS.MIN_UPLOAD_INTERVAL_SECONDS };
        }
        throw upstreamUnavailable();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Current locations
// ---------------------------------------------------------------------------

export function createCurrentLocationStore(tableName: string): CurrentLocationStore {
  return {
    async readCapturedAt(userId: UserId, deviceId: DeviceId): Promise<string | null> {
      const result = await documentClient.send(
        new GetCommand({
          TableName: tableName,
          Key: { userId, deviceId },
          // Deliberately narrow: this function has no decrypt grant, so it must
          // not even pull the sealed coordinate into memory.
          ProjectionExpression: 'capturedAt',
        }),
      );
      const capturedAt = result.Item?.capturedAt;
      return typeof capturedAt === 'string' ? capturedAt : null;
    },

    async putIfNewer(record: StoredCurrentLocation): Promise<boolean> {
      try {
        await documentClient.send(
          new PutCommand({
            TableName: tableName,
            Item: { ...record },
            // The whole point of the endpoint's ordering guarantee: a delayed or
            // replayed batch can never move the current fix backwards in time.
            ConditionExpression: 'attribute_not_exists(userId) OR capturedAt < :capturedAt',
            ExpressionAttributeValues: { ':capturedAt': record.capturedAt },
          }),
        );
        return true;
      } catch (error) {
        if (isConditionalCheckFailure(error)) {
          return false;
        }
        throw upstreamUnavailable();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Location history
// ---------------------------------------------------------------------------

export function createHistoryWriter(tableName: string): HistoryWriter {
  return {
    async append(records: readonly StoredHistoryPoint[]): Promise<void> {
      if (records.length === 0) {
        return;
      }
      let pending: WriteRequests = records.map((record) => ({
        PutRequest: { Item: { ...record } },
      }));

      // BatchWriteItem can return unprocessed items under throttling; retrying
      // them is required, and is safe because the key is derived from the event
      // id, so a re-put is an overwrite of an identical row.
      for (let attempt = 0; attempt < 4 && pending.length > 0; attempt += 1) {
        const result = await documentClient.send(
          new BatchWriteCommand({ RequestItems: { [tableName]: pending } }),
        );
        const unprocessed: WriteRequests = result.UnprocessedItems?.[tableName] ?? [];
        pending = unprocessed.filter((request) => request.PutRequest?.Item !== undefined);
      }

      if (pending.length > 0) {
        throw upstreamUnavailable();
      }
    },
  };
}
