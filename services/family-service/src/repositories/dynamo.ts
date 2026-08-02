import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

import {
  AccountStatusSchema,
  DeviceStatusSchema,
  type DeviceRecord,
  type DeviceRepository,
  type FamilyMembershipRepository,
  type SubscriptionRecord,
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
  SharingStatusSchema,
  SubscriptionStatusSchema,
  UserIdSchema,
  type AuditEvent,
  type DeviceId,
  type FamilyId,
  type FamilyRole,
  type MembershipStatus,
  type PlanTier,
  type UserId,
} from '@family/contracts';

import type {
  AuditWriter,
  FamilyRecord,
  FamilyStore,
  MembershipPatch,
  MembershipRow,
  MembershipStore,
} from '../ports.js';
import type { SubscriptionReader } from '../service.js';

/**
 * DynamoDB bindings.
 *
 * Two operations here are transactional on purpose, because a partial write
 * would break an invariant the product depends on rather than merely losing
 * data: ownership transfer (a family must always have exactly one owner) and
 * mutual hiding (a block must never leave one party visible to the other).
 */

const CONDITIONAL_CHECK_FAILED = 'ConditionalCheckFailedException';
const TRANSACTION_CANCELED = 'TransactionCanceledException';
const AUDIT_RETENTION_DAYS = 400;
const SECONDS_PER_DAY = 86_400;

/** One row per store transaction lineage; a handful is a generous ceiling. */
const MAX_SUBSCRIPTION_ROWS_PER_USER = 25;

export const dynamoClient = new DynamoDBClient({});

export const documentClient = DynamoDBDocumentClient.from(dynamoClient, {
  marshallOptions: { removeUndefinedValues: true, convertClassInstanceToMap: false },
  unmarshallOptions: { wrapNumbers: false },
});

function isConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === CONDITIONAL_CHECK_FAILED || error.name === TRANSACTION_CANCELED)
  );
}

function conflict(): AppError {
  return new AppError('CONFLICT', 'This family changed while your request was in flight.');
}

function upstreamUnavailable(): AppError {
  return new AppError('UPSTREAM_UNAVAILABLE', 'A dependency is temporarily unavailable.');
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function asStringList(value: unknown): string[] | null {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : null;
}

// ---------------------------------------------------------------------------
// Accounts, devices and subscriptions
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

const TIER_RANK: Record<PlanTier, number> = { FREE: 0, FAMILY: 1, FAMILY_PLUS: 2 };

function toSubscription(item: Record<string, unknown>): SubscriptionRecord | null {
  const familyId = FamilyIdSchema.safeParse(item.familyId);
  const plan = PlanSchema.safeParse(item.plan);
  const status = SubscriptionStatusSchema.safeParse(item.status);
  if (!familyId.success || !plan.success || !status.success) {
    return null;
  }
  if (!ENTITLED_SUBSCRIPTION_STATUSES.includes(status.data)) {
    return null;
  }
  return { familyId: familyId.data, plan: plan.data, status: status.data };
}

function bestOf(candidates: readonly SubscriptionRecord[]): SubscriptionRecord | null {
  let best: SubscriptionRecord | null = null;
  for (const candidate of candidates) {
    if (best === null || TIER_RANK[PLAN_TIER[candidate.plan]] > TIER_RANK[PLAN_TIER[best.plan]]) {
      best = candidate;
    }
  }
  return best;
}

export function createSubscriptionReader(tableName: string): SubscriptionReader {
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
      return bestOf((result.Items ?? []).flatMap((item) => toSubscription(item) ?? []));
    },

    async getSubscriptionForUser(userId: UserId): Promise<SubscriptionRecord | null> {
      const result = await documentClient.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: '#userId = :userId',
          ExpressionAttributeNames: { '#userId': 'userId' },
          ExpressionAttributeValues: { ':userId': userId },
          Limit: MAX_SUBSCRIPTION_ROWS_PER_USER,
        }),
      );
      return bestOf((result.Items ?? []).flatMap((item) => toSubscription(item) ?? []));
    },
  };
}

// ---------------------------------------------------------------------------
// Families
// ---------------------------------------------------------------------------

function toFamilyRecord(item: Record<string, unknown>): FamilyRecord | null {
  const familyId = FamilyIdSchema.safeParse(item.familyId);
  const ownerUserId = UserIdSchema.safeParse(item.ownerUserId);
  const name = asString(item.name);
  const timeZone = asString(item.timeZone);
  const createdAt = asString(item.createdAt);
  const updatedAt = asString(item.updatedAt);
  if (
    !familyId.success ||
    !ownerUserId.success ||
    name === null ||
    timeZone === null ||
    createdAt === null ||
    updatedAt === null
  ) {
    return null;
  }
  return {
    familyId: familyId.data,
    name,
    ownerUserId: ownerUserId.data,
    timeZone,
    savedPlaceCount: typeof item.savedPlaceCount === 'number' ? item.savedPlaceCount : 0,
    pendingInvitationCount:
      typeof item.pendingInvitationCount === 'number' ? item.pendingInvitationCount : 0,
    createdAt,
    updatedAt,
    schemaVersion: typeof item.schemaVersion === 'number' ? item.schemaVersion : 1,
  };
}

export function createFamilyStore(options: {
  familiesTable: string;
  membershipsTable: string;
}): FamilyStore {
  return {
    async get(familyId: FamilyId): Promise<FamilyRecord | null> {
      const result = await documentClient.send(
        new GetCommand({
          TableName: options.familiesTable,
          Key: { familyId },
          ConsistentRead: true,
        }),
      );
      return result.Item === undefined ? null : toFamilyRecord(result.Item);
    },

    async create(record: FamilyRecord): Promise<void> {
      try {
        await documentClient.send(
          new PutCommand({
            TableName: options.familiesTable,
            Item: { ...record },
            ConditionExpression: 'attribute_not_exists(familyId)',
          }),
        );
      } catch (error) {
        throw isConflict(error) ? conflict() : upstreamUnavailable();
      }
    },

    async update(
      familyId: FamilyId,
      patch: { name?: string; timeZone?: string },
      updatedAt: string,
    ): Promise<FamilyRecord> {
      const names: Record<string, string> = { '#updatedAt': 'updatedAt' };
      const values: Record<string, unknown> = { ':updatedAt': updatedAt };
      const assignments = ['#updatedAt = :updatedAt'];

      if (patch.name !== undefined) {
        names['#name'] = 'name';
        values[':name'] = patch.name;
        assignments.push('#name = :name');
      }
      if (patch.timeZone !== undefined) {
        names['#timeZone'] = 'timeZone';
        values[':timeZone'] = patch.timeZone;
        assignments.push('#timeZone = :timeZone');
      }

      const result = await documentClient.send(
        new UpdateCommand({
          TableName: options.familiesTable,
          Key: { familyId },
          UpdateExpression: `SET ${assignments.join(', ')}`,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
          ConditionExpression: 'attribute_exists(familyId)',
          ReturnValues: 'ALL_NEW',
        }),
      );
      const record = result.Attributes === undefined ? null : toFamilyRecord(result.Attributes);
      if (record === null) {
        throw upstreamUnavailable();
      }
      return record;
    },

    async transferOwnership(input: {
      familyId: FamilyId;
      previousOwnerUserId: UserId;
      newOwnerUserId: UserId;
      previousOwnerRole: FamilyRole;
      at: string;
    }): Promise<void> {
      try {
        await documentClient.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Update: {
                  TableName: options.familiesTable,
                  Key: { familyId: input.familyId },
                  UpdateExpression: 'SET ownerUserId = :new, updatedAt = :at',
                  // Guards against two concurrent transfers: only the owner the
                  // caller observed may hand the family on.
                  ConditionExpression: 'ownerUserId = :previous',
                  ExpressionAttributeValues: {
                    ':new': input.newOwnerUserId,
                    ':previous': input.previousOwnerUserId,
                    ':at': input.at,
                  },
                },
              },
              {
                Update: {
                  TableName: options.membershipsTable,
                  Key: { familyId: input.familyId, userId: input.previousOwnerUserId },
                  UpdateExpression: 'SET #role = :role, updatedAt = :at',
                  ConditionExpression: '#role = :owner',
                  ExpressionAttributeNames: { '#role': 'role' },
                  ExpressionAttributeValues: {
                    ':role': input.previousOwnerRole,
                    ':owner': 'OWNER',
                    ':at': input.at,
                  },
                },
              },
              {
                Update: {
                  TableName: options.membershipsTable,
                  Key: { familyId: input.familyId, userId: input.newOwnerUserId },
                  UpdateExpression: 'SET #role = :owner, updatedAt = :at',
                  ConditionExpression: '#status = :active AND #role <> :owner',
                  ExpressionAttributeNames: { '#role': 'role', '#status': 'status' },
                  ExpressionAttributeValues: {
                    ':owner': 'OWNER',
                    ':active': 'ACTIVE',
                    ':at': input.at,
                  },
                },
              },
            ],
          }),
        );
      } catch (error) {
        throw isConflict(error) ? conflict() : upstreamUnavailable();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Memberships
// ---------------------------------------------------------------------------

export function toMembershipRow(item: Record<string, unknown>): MembershipRow | null {
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

  const hidden = asStringList(item.hiddenFromUserIds);

  return {
    familyId: familyId.data,
    userId: userId.data,
    role: role.data,
    status: status.data,
    sharingStatus: sharingStatus.data,
    visibleToUserIds: asStringList(item.visibleToUserIds),
    ...(hidden === null ? {} : { hiddenFromUserIds: hidden }),
    displayName: asString(item.displayName) ?? 'Member',
    avatarUrl: asString(item.avatarUrl),
    deviceCount: typeof item.deviceCount === 'number' ? item.deviceCount : 0,
    lastSeenAt: asString(item.lastSeenAt),
    joinedAt: asString(item.joinedAt),
    invitedByUserId: UserIdSchema.safeParse(item.invitedByUserId).success
      ? (item.invitedByUserId as UserId)
      : null,
    sharingChangedAt: asString(item.sharingChangedAt),
    updatedAt: asString(item.updatedAt) ?? asString(item.joinedAt) ?? '1970-01-01T00:00:00.000Z',
  };
}

export function createMembershipStore(
  tableName: string,
): MembershipStore & FamilyMembershipRepository {
  async function read(familyId: FamilyId, userId: UserId): Promise<MembershipRow | null> {
    const result = await documentClient.send(
      new GetCommand({
        TableName: tableName,
        Key: { familyId, userId },
        // Removal must revoke access immediately, so no eventually-consistent
        // replica is allowed to answer an authorisation question.
        ConsistentRead: true,
      }),
    );
    return result.Item === undefined ? null : toMembershipRow(result.Item);
  }

  return {
    getMembership(input: { familyId: FamilyId; userId: UserId }): Promise<MembershipRow | null> {
      return read(input.familyId, input.userId);
    },

    get(familyId: FamilyId, userId: UserId): Promise<MembershipRow | null> {
      return read(familyId, userId);
    },

    async listByFamily(familyId: FamilyId): Promise<MembershipRow[]> {
      const result = await documentClient.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: '#familyId = :familyId',
          ExpressionAttributeNames: { '#familyId': 'familyId' },
          ExpressionAttributeValues: { ':familyId': familyId },
          Limit: LIMITS.MAX_FAMILY_MEMBERS * 2,
          ConsistentRead: true,
        }),
      );
      return (result.Items ?? []).flatMap((item) => toMembershipRow(item) ?? []);
    },

    async listByUser(userId: UserId): Promise<MembershipRow[]> {
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
      return (result.Items ?? []).flatMap((item) => toMembershipRow(item) ?? []);
    },

    async create(row: MembershipRow): Promise<void> {
      try {
        await documentClient.send(
          new PutCommand({
            TableName: tableName,
            Item: { ...row },
            ConditionExpression: 'attribute_not_exists(familyId) AND attribute_not_exists(userId)',
          }),
        );
      } catch (error) {
        throw isConflict(error) ? conflict() : upstreamUnavailable();
      }
    },

    async patch(
      familyId: FamilyId,
      userId: UserId,
      patch: MembershipPatch,
      updatedAt: string,
    ): Promise<MembershipRow> {
      const names: Record<string, string> = { '#updatedAt': 'updatedAt' };
      const values: Record<string, unknown> = { ':updatedAt': updatedAt };
      const assignments = ['#updatedAt = :updatedAt'];

      if (patch.role !== undefined) {
        names['#role'] = 'role';
        values[':role'] = patch.role;
        assignments.push('#role = :role');
      }
      if (patch.status !== undefined) {
        names['#status'] = 'status';
        values[':status'] = patch.status;
        assignments.push('#status = :status');
      }
      if (patch.displayName !== undefined) {
        names['#displayName'] = 'displayName';
        values[':displayName'] = patch.displayName;
        assignments.push('#displayName = :displayName');
      }

      const result = await documentClient.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { familyId, userId },
          UpdateExpression: `SET ${assignments.join(', ')}`,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
          ConditionExpression: 'attribute_exists(familyId)',
          ReturnValues: 'ALL_NEW',
        }),
      );
      const row = result.Attributes === undefined ? null : toMembershipRow(result.Attributes);
      if (row === null) {
        throw upstreamUnavailable();
      }
      return row;
    },

    async revoke(input: {
      familyId: FamilyId;
      userId: UserId;
      status: Extract<MembershipStatus, 'REMOVED' | 'LEFT'>;
      at: string;
    }): Promise<MembershipRow> {
      const result = await documentClient.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { familyId: input.familyId, userId: input.userId },
          // One write ends the membership AND revokes location access: the
          // status alone would leave a stale allow-list naming viewers.
          UpdateExpression: [
            'SET #status = :status',
            '#sharingStatus = :disabled',
            'visibleToUserIds = :nobody',
            'sharingChangedAt = :at',
            'updatedAt = :at',
          ].join(', '),
          ExpressionAttributeNames: { '#status': 'status', '#sharingStatus': 'sharingStatus' },
          ExpressionAttributeValues: {
            ':status': input.status,
            ':disabled': 'DISABLED',
            ':nobody': [],
            ':at': input.at,
          },
          ConditionExpression: 'attribute_exists(familyId)',
          ReturnValues: 'ALL_NEW',
        }),
      );
      const row = result.Attributes === undefined ? null : toMembershipRow(result.Attributes);
      if (row === null) {
        throw upstreamUnavailable();
      }
      return row;
    },

    async setMutuallyHidden(input: {
      familyId: FamilyId;
      userId: UserId;
      otherUserId: UserId;
      hidden: boolean;
      at: string;
    }): Promise<void> {
      const [mine, theirs] = await Promise.all([
        read(input.familyId, input.userId),
        read(input.familyId, input.otherUserId),
      ]);
      if (mine === null || theirs === null) {
        throw conflict();
      }

      const next = (row: MembershipRow, other: UserId): string[] => {
        const current = new Set(row.hiddenFromUserIds ?? []);
        if (input.hidden) {
          current.add(other);
        } else {
          current.delete(other);
        }
        return [...current].sort();
      };

      try {
        await documentClient.send(
          new TransactWriteCommand({
            TransactItems: [mine, theirs].map((row, index) => ({
              Update: {
                TableName: tableName,
                Key: { familyId: input.familyId, userId: row.userId },
                UpdateExpression: 'SET hiddenFromUserIds = :hidden, updatedAt = :at',
                // Optimistic concurrency: if either row moved under us the whole
                // block is retried rather than applied asymmetrically.
                ConditionExpression: 'updatedAt = :expected',
                ExpressionAttributeValues: {
                  ':hidden': next(row, index === 0 ? input.otherUserId : input.userId),
                  ':at': input.at,
                  ':expected': row.updatedAt,
                },
              },
            })),
          }),
        );
      } catch (error) {
        throw isConflict(error) ? conflict() : upstreamUnavailable();
      }
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
            ConditionExpression: 'attribute_not_exists(targetUserId) OR attribute_not_exists(sk)',
          }),
        );
      } catch {
        throw upstreamUnavailable();
      }
    },
  };
}
