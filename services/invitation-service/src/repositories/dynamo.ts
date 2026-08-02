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
  SharingStatusSchema,
  SubscriptionStatusSchema,
  UserIdSchema,
  type AuditEvent,
  type DeviceId,
  type FamilyId,
  type PlanTier,
  type UserId,
} from '@family/contracts';
import {
  AssignableFamilyRoleSchema,
  InvitationStatusSchema,
  type InvitationStatus,
} from '@family/schemas';

import type { InvitationRecord } from '../domain/invitation-rules.js';
import type {
  AuditWriter,
  FamilyReader,
  FamilySummary,
  InvitationStore,
  MembershipReader,
  MembershipSummary,
  NewMembership,
  RedemptionOutcome,
} from '../ports.js';

/**
 * DynamoDB bindings.
 *
 * The invitation table is keyed by `tokenHash`, so a redemption is a single-key
 * lookup and there is no index, projection, or stream anywhere that could carry
 * the raw token.
 */

const CONDITIONAL_CHECK_FAILED = 'ConditionalCheckFailedException';
const TRANSACTION_CANCELED = 'TransactionCanceledException';
const AUDIT_RETENTION_DAYS = 400;
const SECONDS_PER_DAY = 86_400;
const MAX_INVITATION_ROWS = 100;

export const dynamoClient = new DynamoDBClient({});

export const documentClient = DynamoDBDocumentClient.from(dynamoClient, {
  marshallOptions: { removeUndefinedValues: true, convertClassInstanceToMap: false },
  unmarshallOptions: { wrapNumbers: false },
});

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : '';
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
// Accounts, devices, subscriptions
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
// Families and memberships
// ---------------------------------------------------------------------------

export function createFamilyReader(tableName: string): FamilyReader {
  return {
    async get(familyId: FamilyId): Promise<FamilySummary | null> {
      const result = await documentClient.send(
        new GetCommand({
          TableName: tableName,
          Key: { familyId },
          ProjectionExpression: 'familyId, #name, ownerUserId',
          ExpressionAttributeNames: { '#name': 'name' },
          ConsistentRead: true,
        }),
      );
      const item = result.Item;
      if (item === undefined) {
        return null;
      }
      const parsedId = FamilyIdSchema.safeParse(item.familyId);
      const ownerUserId = UserIdSchema.safeParse(item.ownerUserId);
      const name = asString(item.name);
      return parsedId.success && ownerUserId.success && name !== null
        ? { familyId: parsedId.data, name, ownerUserId: ownerUserId.data }
        : null;
    },
  };
}

export function toMembershipSummary(item: Record<string, unknown>): MembershipSummary | null {
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
    updatedAt: asString(item.updatedAt) ?? '1970-01-01T00:00:00.000Z',
  };
}

export function createMembershipReader(
  tableName: string,
): MembershipReader & FamilyMembershipRepository {
  async function read(familyId: FamilyId, userId: UserId): Promise<MembershipSummary | null> {
    const result = await documentClient.send(
      new GetCommand({
        TableName: tableName,
        Key: { familyId, userId },
        ConsistentRead: true,
      }),
    );
    return result.Item === undefined ? null : toMembershipSummary(result.Item);
  }

  return {
    getMembership(input: {
      familyId: FamilyId;
      userId: UserId;
    }): Promise<MembershipSummary | null> {
      return read(input.familyId, input.userId);
    },
    get(familyId: FamilyId, userId: UserId): Promise<MembershipSummary | null> {
      return read(familyId, userId);
    },
    async listByFamily(familyId: FamilyId): Promise<MembershipSummary[]> {
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
      return (result.Items ?? []).flatMap((item) => toMembershipSummary(item) ?? []);
    },
  };
}

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

function toInvitationRecord(item: Record<string, unknown>): InvitationRecord | null {
  const familyId = FamilyIdSchema.safeParse(item.familyId);
  const createdByUserId = UserIdSchema.safeParse(item.createdByUserId);
  const role = AssignableFamilyRoleSchema.safeParse(item.role);
  const status = InvitationStatusSchema.safeParse(item.status);
  const tokenHash = asString(item.tokenHash);
  const invitationId = asString(item.invitationId);
  const createdAt = asString(item.createdAt);
  const expiresAtIso = asString(item.expiresAtIso);
  if (
    !familyId.success ||
    !createdByUserId.success ||
    !role.success ||
    !status.success ||
    tokenHash === null ||
    invitationId === null ||
    createdAt === null ||
    expiresAtIso === null ||
    typeof item.expiresAt !== 'number'
  ) {
    return null;
  }

  const acceptedBy = UserIdSchema.safeParse(item.acceptedByUserId);

  return {
    tokenHash,
    invitationId,
    familyId: familyId.data,
    role: role.data,
    status: status.data,
    label: asString(item.label),
    createdByUserId: createdByUserId.data,
    createdAt,
    expiresAt: item.expiresAt,
    expiresAtIso,
    redemptionCount: typeof item.redemptionCount === 'number' ? item.redemptionCount : 0,
    maxRedemptions:
      typeof item.maxRedemptions === 'number'
        ? item.maxRedemptions
        : LIMITS.MAX_INVITATION_REDEMPTIONS,
    acceptedByUserId: acceptedBy.success ? acceptedBy.data : null,
    acceptedAt: asString(item.acceptedAt),
    revokedAt: asString(item.revokedAt),
  };
}

export function createInvitationStore(options: {
  invitationsTable: string;
  membershipsTable: string;
}): InvitationStore {
  async function findByFamilyAndId(
    familyId: FamilyId,
    invitationId: string,
  ): Promise<InvitationRecord | null> {
    const result = await documentClient.send(
      new QueryCommand({
        TableName: options.invitationsTable,
        IndexName: 'byFamily',
        KeyConditionExpression: '#familyId = :familyId',
        ExpressionAttributeNames: { '#familyId': 'familyId' },
        ExpressionAttributeValues: { ':familyId': familyId },
        Limit: MAX_INVITATION_ROWS,
      }),
    );
    for (const item of result.Items ?? []) {
      const record = toInvitationRecord(item);
      if (record !== null && record.invitationId === invitationId) {
        return record;
      }
    }
    return null;
  }

  return {
    async create(record: InvitationRecord): Promise<void> {
      try {
        await documentClient.send(
          new PutCommand({
            TableName: options.invitationsTable,
            Item: { ...record },
            ConditionExpression: 'attribute_not_exists(tokenHash)',
          }),
        );
      } catch (error) {
        // A hash collision on 256 bits of entropy is not a real event; this is
        // here so that a retried write can never silently reset a live invite.
        throw errorName(error) === CONDITIONAL_CHECK_FAILED
          ? new AppError('CONFLICT', 'Please try again.')
          : upstreamUnavailable();
      }
    },

    async findByTokenHash(tokenHash: string): Promise<InvitationRecord | null> {
      const result = await documentClient.send(
        new GetCommand({
          TableName: options.invitationsTable,
          Key: { tokenHash },
          ConsistentRead: true,
        }),
      );
      return result.Item === undefined ? null : toInvitationRecord(result.Item);
    },

    async listByFamily(
      familyId: FamilyId,
      status: InvitationStatus | null,
    ): Promise<InvitationRecord[]> {
      const result = await documentClient.send(
        new QueryCommand({
          TableName: options.invitationsTable,
          IndexName: 'byFamily',
          KeyConditionExpression: '#familyId = :familyId',
          ExpressionAttributeNames: { '#familyId': 'familyId' },
          ExpressionAttributeValues: { ':familyId': familyId },
          Limit: MAX_INVITATION_ROWS,
        }),
      );
      const records = (result.Items ?? []).flatMap((item) => toInvitationRecord(item) ?? []);
      return status === null ? records : records.filter((record) => record.status === status);
    },

    async revoke(input: {
      familyId: FamilyId;
      invitationId: string;
      at: string;
    }): Promise<InvitationRecord | null> {
      const existing = await findByFamilyAndId(input.familyId, input.invitationId);
      if (existing === null) {
        return null;
      }

      try {
        const result = await documentClient.send(
          new UpdateCommand({
            TableName: options.invitationsTable,
            Key: { tokenHash: existing.tokenHash },
            UpdateExpression: 'SET #status = :revoked, revokedAt = :at',
            // Revoking an already-accepted invitation is a no-op, not a rewrite
            // of history.
            ConditionExpression: '#status = :pending',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: {
              ':revoked': 'REVOKED',
              ':pending': 'PENDING',
              ':at': input.at,
            },
            ReturnValues: 'ALL_NEW',
          }),
        );
        return result.Attributes === undefined ? null : toInvitationRecord(result.Attributes);
      } catch (error) {
        if (errorName(error) === CONDITIONAL_CHECK_FAILED) {
          return existing;
        }
        throw upstreamUnavailable();
      }
    },

    async redeem(input: {
      tokenHash: string;
      membership: NewMembership;
      acceptedByUserId: UserId;
      acceptedAt: string;
      nowEpochSeconds: number;
    }): Promise<RedemptionOutcome> {
      const membershipItem = {
        ...input.membership,
        visibleToUserIds: null,
        hiddenFromUserIds: [],
        avatarUrl: null,
        deviceCount: 0,
        lastSeenAt: null,
        sharingChangedAt: input.membership.sharingStatus === 'SHARING' ? input.acceptedAt : null,
        updatedAt: input.acceptedAt,
      };

      try {
        await documentClient.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Update: {
                  TableName: options.invitationsTable,
                  Key: { tokenHash: input.tokenHash },
                  UpdateExpression: [
                    'SET #status = :accepted',
                    'redemptionCount = redemptionCount + :one',
                    'acceptedByUserId = :user',
                    'acceptedAt = :at',
                  ].join(', '),
                  // The whole single-use guarantee lives in this condition. Two
                  // concurrent redemptions both evaluate it; DynamoDB serialises
                  // the transactions, so exactly one can observe an unconsumed
                  // token.
                  ConditionExpression: [
                    '#status = :pending',
                    'redemptionCount < maxRedemptions',
                    'attribute_not_exists(revokedAt)',
                    'expiresAt > :now',
                  ].join(' AND '),
                  ExpressionAttributeNames: { '#status': 'status' },
                  ExpressionAttributeValues: {
                    ':accepted': 'ACCEPTED',
                    ':pending': 'PENDING',
                    ':one': 1,
                    ':user': input.acceptedByUserId,
                    ':at': input.acceptedAt,
                    ':now': input.nowEpochSeconds,
                  },
                },
              },
              {
                Put: {
                  TableName: options.membershipsTable,
                  Item: membershipItem,
                  ConditionExpression:
                    'attribute_not_exists(familyId) AND attribute_not_exists(userId)',
                },
              },
            ],
          }),
        );
      } catch (error) {
        if (errorName(error) !== TRANSACTION_CANCELED) {
          throw upstreamUnavailable();
        }
        // Distinguish the two cancellations so the caller can answer precisely.
        const reasons = (error as { CancellationReasons?: Array<{ Code?: string }> })
          .CancellationReasons;
        const membershipRejected = reasons?.[1]?.Code === CONDITIONAL_CHECK_FAILED;
        return membershipRejected ? { kind: 'ALREADY_MEMBER' } : { kind: 'ALREADY_CONSUMED' };
      }

      return {
        kind: 'REDEEMED',
        membership: {
          familyId: input.membership.familyId,
          userId: input.membership.userId,
          role: input.membership.role,
          status: input.membership.status,
          sharingStatus: input.membership.sharingStatus,
          visibleToUserIds: null,
          hiddenFromUserIds: [],
          displayName: input.membership.displayName,
          avatarUrl: null,
          deviceCount: 0,
          lastSeenAt: null,
          joinedAt: input.membership.joinedAt,
          invitedByUserId: input.membership.invitedByUserId,
          updatedAt: input.acceptedAt,
        },
      };
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
