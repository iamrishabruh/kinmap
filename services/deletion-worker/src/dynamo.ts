import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  BatchWriteCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

import {
  FamilyRoleSchema,
  MembershipStatusSchema,
  type DeviceId,
  type FamilyId,
  type UserId,
} from '@family/contracts';

import { historyPartitionKey, type DeletionJob, type DeletionStep, type Tombstone } from './job.js';
import type { MembershipRow } from './membership-plan.js';
import type {
  DeletionJobStore,
  DeviceRepository,
  DeviceSummary,
  MembershipRepository,
  SharingRevoker,
  TombstoneWriter,
  UserDataDeleter,
} from './ports.js';

/** DynamoDB bindings for the deletion ports. */

export function createDocumentClient(client?: DynamoDBClient): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(client ?? new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true, convertClassInstanceToMap: false },
  });
}

type Attributes = Record<string, unknown>;

export type DeletionTables = {
  readonly deletionJobs: string;
  readonly users: string;
  readonly devices: string;
  readonly families: string;
  readonly familyMemberships: string;
  readonly currentLocations: string;
  readonly locationHistory: string;
  readonly savedPlaces: string;
  readonly notificationPreferences: string;
  readonly liveSessions: string;
  readonly geofenceState: string;
};

const BATCH_SIZE = 25;

function readString(item: Attributes, key: string): string | null {
  const value = item[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

async function queryAll(
  documents: DynamoDBDocumentClient,
  input: {
    TableName: string;
    IndexName?: string;
    KeyConditionExpression: string;
    ExpressionAttributeNames: Record<string, string>;
    ExpressionAttributeValues: Record<string, unknown>;
  },
): Promise<Attributes[]> {
  const items: Attributes[] = [];
  let exclusiveStartKey: Attributes | undefined;

  do {
    const response = await documents.send(
      new QueryCommand({ ...input, ExclusiveStartKey: exclusiveStartKey }),
    );
    for (const item of response.Items ?? []) items.push(item as Attributes);
    exclusiveStartKey = response.LastEvaluatedKey as Attributes | undefined;
  } while (exclusiveStartKey !== undefined);

  return items;
}

/**
 * Deletes in batches of 25 and re-submits whatever DynamoDB hands back as
 * unprocessed. Dropping an unprocessed item would leave a row behind and turn a
 * "your data is gone" promise into a lie.
 */
async function batchDelete(
  documents: DynamoDBDocumentClient,
  tableName: string,
  keys: ReadonlyArray<Record<string, unknown>>,
): Promise<number> {
  let deleted = 0;

  for (let offset = 0; offset < keys.length; offset += BATCH_SIZE) {
    let pending = keys
      .slice(offset, offset + BATCH_SIZE)
      .map((Key) => ({ DeleteRequest: { Key } }));

    for (let attempt = 0; attempt < 8 && pending.length > 0; attempt += 1) {
      const response = await documents.send(
        new BatchWriteCommand({ RequestItems: { [tableName]: pending } }),
      );
      deleted += pending.length;
      const unprocessed = response.UnprocessedItems?.[tableName] ?? [];
      deleted -= unprocessed.length;
      pending = unprocessed as typeof pending;
    }

    if (pending.length > 0) {
      throw new Error('BatchWriteUnprocessedItems');
    }
  }

  return deleted;
}

function toMembershipRow(item: Attributes): MembershipRow | null {
  const familyId = readString(item, 'familyId');
  const userId = readString(item, 'userId');
  const role = FamilyRoleSchema.safeParse(item.role);
  const status = MembershipStatusSchema.safeParse(item.status);
  if (familyId === null || userId === null || !role.success || !status.success) return null;

  return {
    familyId: familyId as FamilyId,
    userId: userId as UserId,
    role: role.data,
    status: status.data,
    joinedAt: readString(item, 'joinedAt') ?? new Date(0).toISOString(),
  };
}

export class DynamoSharingRevoker implements SharingRevoker {
  constructor(
    private readonly documents: DynamoDBDocumentClient,
    private readonly tables: DeletionTables,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Sets every membership to DISABLED and empties the visibility allow-list.
   * Both, because either one alone would still leave a path to a coordinate if
   * a later read consulted only the other.
   */
  async revokeAllSharing(input: { userId: UserId }): Promise<number> {
    const rows = await queryAll(this.documents, {
      TableName: this.tables.familyMemberships,
      IndexName: 'byUser',
      KeyConditionExpression: '#userId = :userId',
      ExpressionAttributeNames: { '#userId': 'userId' },
      ExpressionAttributeValues: { ':userId': input.userId },
    });

    let updated = 0;
    for (const row of rows) {
      const familyId = readString(row, 'familyId');
      if (familyId === null) continue;
      await this.documents.send(
        new UpdateCommand({
          TableName: this.tables.familyMemberships,
          Key: { familyId, userId: input.userId },
          UpdateExpression:
            'SET #sharingStatus = :disabled, #visibleToUserIds = :empty, #updatedAt = :now',
          ExpressionAttributeNames: {
            '#sharingStatus': 'sharingStatus',
            '#visibleToUserIds': 'visibleToUserIds',
            '#updatedAt': 'updatedAt',
          },
          ExpressionAttributeValues: {
            ':disabled': 'DISABLED',
            ':empty': [],
            ':now': this.now().toISOString(),
          },
          ConditionExpression: 'attribute_exists(userId)',
        }),
      );
      updated += 1;
    }
    return updated;
  }
}

export class DynamoMembershipRepository implements MembershipRepository {
  constructor(
    private readonly documents: DynamoDBDocumentClient,
    private readonly tables: DeletionTables,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async listMemberships(input: { userId: UserId }): Promise<MembershipRow[]> {
    const rows = await queryAll(this.documents, {
      TableName: this.tables.familyMemberships,
      IndexName: 'byUser',
      KeyConditionExpression: '#userId = :userId',
      ExpressionAttributeNames: { '#userId': 'userId' },
      ExpressionAttributeValues: { ':userId': input.userId },
    });
    return rows.map(toMembershipRow).filter((row): row is MembershipRow => row !== null);
  }

  async listFamilyMembers(input: { familyId: FamilyId }): Promise<MembershipRow[]> {
    const rows = await queryAll(this.documents, {
      TableName: this.tables.familyMemberships,
      KeyConditionExpression: '#familyId = :familyId',
      ExpressionAttributeNames: { '#familyId': 'familyId' },
      ExpressionAttributeValues: { ':familyId': input.familyId },
    });
    return rows.map(toMembershipRow).filter((row): row is MembershipRow => row !== null);
  }

  async transferOwnership(input: {
    familyId: FamilyId;
    fromUserId: UserId;
    toUserId: UserId;
  }): Promise<void> {
    await this.documents.send(
      new UpdateCommand({
        TableName: this.tables.familyMemberships,
        Key: { familyId: input.familyId, userId: input.toUserId },
        UpdateExpression: 'SET #role = :owner, #updatedAt = :now',
        ExpressionAttributeNames: { '#role': 'role', '#updatedAt': 'updatedAt' },
        ExpressionAttributeValues: { ':owner': 'OWNER', ':now': this.now().toISOString() },
        ConditionExpression: 'attribute_exists(userId)',
      }),
    );
    await this.documents.send(
      new UpdateCommand({
        TableName: this.tables.families,
        Key: { familyId: input.familyId },
        UpdateExpression: 'SET #ownerUserId = :owner, #updatedAt = :now',
        ExpressionAttributeNames: { '#ownerUserId': 'ownerUserId', '#updatedAt': 'updatedAt' },
        ExpressionAttributeValues: { ':owner': input.toUserId, ':now': this.now().toISOString() },
        ConditionExpression: 'attribute_exists(familyId)',
      }),
    );
  }

  async removeMembership(input: { familyId: FamilyId; userId: UserId }): Promise<void> {
    await this.documents.send(
      new DeleteCommand({
        TableName: this.tables.familyMemberships,
        Key: { familyId: input.familyId, userId: input.userId },
      }),
    );
  }

  async dissolveFamily(input: { familyId: FamilyId }): Promise<void> {
    const members = await queryAll(this.documents, {
      TableName: this.tables.familyMemberships,
      KeyConditionExpression: '#familyId = :familyId',
      ExpressionAttributeNames: { '#familyId': 'familyId' },
      ExpressionAttributeValues: { ':familyId': input.familyId },
    });
    const memberKeys = members.flatMap((member) => {
      const userId = readString(member, 'userId');
      return userId === null ? [] : [{ familyId: input.familyId, userId }];
    });
    if (memberKeys.length > 0) {
      await batchDelete(this.documents, this.tables.familyMemberships, memberKeys);
    }

    const places = await queryAll(this.documents, {
      TableName: this.tables.savedPlaces,
      KeyConditionExpression: '#familyId = :familyId',
      ExpressionAttributeNames: { '#familyId': 'familyId' },
      ExpressionAttributeValues: { ':familyId': input.familyId },
    });
    const placeKeys = places.flatMap((place) => {
      const placeId = readString(place, 'placeId');
      return placeId === null ? [] : [{ familyId: input.familyId, placeId }];
    });
    if (placeKeys.length > 0) {
      await batchDelete(this.documents, this.tables.savedPlaces, placeKeys);
    }

    await this.documents.send(
      new DeleteCommand({ TableName: this.tables.families, Key: { familyId: input.familyId } }),
    );
  }
}

export class DynamoDeviceRepository implements DeviceRepository {
  constructor(
    private readonly documents: DynamoDBDocumentClient,
    private readonly tables: DeletionTables,
  ) {}

  async listDevices(input: { userId: UserId }): Promise<DeviceSummary[]> {
    const rows = await queryAll(this.documents, {
      TableName: this.tables.devices,
      KeyConditionExpression: '#userId = :userId',
      ExpressionAttributeNames: { '#userId': 'userId' },
      ExpressionAttributeValues: { ':userId': input.userId },
    });
    return rows.flatMap((row) => {
      const deviceId = readString(row, 'deviceId');
      if (deviceId === null) return [];
      return [
        { deviceId: deviceId as DeviceId, pushEndpointArn: readString(row, 'pushEndpointArn') },
      ];
    });
  }

  async revokeDevice(input: { userId: UserId; deviceId: DeviceId }): Promise<void> {
    await this.documents.send(
      new DeleteCommand({
        TableName: this.tables.devices,
        Key: { userId: input.userId, deviceId: input.deviceId },
      }),
    );
  }
}

export class DynamoUserDataDeleter implements UserDataDeleter {
  constructor(
    private readonly documents: DynamoDBDocumentClient,
    private readonly tables: DeletionTables,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async deleteCurrentLocations(input: { userId: UserId }): Promise<number> {
    const rows = await queryAll(this.documents, {
      TableName: this.tables.currentLocations,
      KeyConditionExpression: '#userId = :userId',
      ExpressionAttributeNames: { '#userId': 'userId' },
      ExpressionAttributeValues: { ':userId': input.userId },
    });
    const keys = rows.flatMap((row) => {
      const deviceId = readString(row, 'deviceId');
      return deviceId === null ? [] : [{ userId: input.userId, deviceId }];
    });
    return keys.length === 0
      ? 0
      : await batchDelete(this.documents, this.tables.currentLocations, keys);
  }

  async deleteHistoryDay(input: { userId: UserId; day: string }): Promise<number> {
    const pk = historyPartitionKey(input.userId, input.day);
    const rows = await queryAll(this.documents, {
      TableName: this.tables.locationHistory,
      KeyConditionExpression: '#pk = :pk',
      ExpressionAttributeNames: { '#pk': 'pk' },
      ExpressionAttributeValues: { ':pk': pk },
    });
    const keys = rows.flatMap((row) => {
      const sk = readString(row, 'sk');
      return sk === null ? [] : [{ pk, sk }];
    });
    return keys.length === 0
      ? 0
      : await batchDelete(this.documents, this.tables.locationHistory, keys);
  }

  async purgeSavedPlaces(input: {
    userId: UserId;
    dissolvedFamilyIds: readonly FamilyId[];
    reassignments: ReadonlyArray<{ familyId: FamilyId; inheritorUserId: UserId }>;
  }): Promise<number> {
    let touched = 0;
    const dissolved = new Set<string>(input.dissolvedFamilyIds);

    const authored = await queryAll(this.documents, {
      TableName: this.tables.savedPlaces,
      IndexName: 'byCreator',
      KeyConditionExpression: '#createdBy = :userId',
      ExpressionAttributeNames: { '#createdBy': 'createdBy' },
      ExpressionAttributeValues: { ':userId': input.userId },
    });

    const inheritors = new Map(
      input.reassignments.map((entry) => [entry.familyId, entry.inheritorUserId] as const),
    );

    for (const place of authored) {
      const familyId = readString(place, 'familyId');
      const placeId = readString(place, 'placeId');
      if (familyId === null || placeId === null) continue;

      if (dissolved.has(familyId)) {
        // The family is gone, so its places go with it.
        await this.documents.send(
          new DeleteCommand({ TableName: this.tables.savedPlaces, Key: { familyId, placeId } }),
        );
        touched += 1;
        continue;
      }

      // The family survives. A saved place is family data, not personal data:
      // deleting the shared "Home" because its author left would be data loss
      // for everyone else, so authorship moves to the remaining owner.
      const inheritor = inheritors.get(familyId as FamilyId);
      if (inheritor === undefined) continue;
      await this.documents.send(
        new UpdateCommand({
          TableName: this.tables.savedPlaces,
          Key: { familyId, placeId },
          UpdateExpression: 'SET #createdBy = :inheritor, #updatedAt = :now',
          ExpressionAttributeNames: { '#createdBy': 'createdBy', '#updatedAt': 'updatedAt' },
          ExpressionAttributeValues: { ':inheritor': inheritor, ':now': this.now().toISOString() },
          ConditionExpression: 'attribute_exists(placeId)',
        }),
      );
      touched += 1;
    }

    return touched;
  }

  async deleteNotificationPreferences(input: { userId: UserId }): Promise<number> {
    const rows = await queryAll(this.documents, {
      TableName: this.tables.notificationPreferences,
      KeyConditionExpression: '#userId = :userId',
      ExpressionAttributeNames: { '#userId': 'userId' },
      ExpressionAttributeValues: { ':userId': input.userId },
    });
    const keys = rows.flatMap((row) => {
      const familyId = readString(row, 'familyId');
      return familyId === null ? [] : [{ userId: input.userId, familyId }];
    });
    return keys.length === 0
      ? 0
      : await batchDelete(this.documents, this.tables.notificationPreferences, keys);
  }

  /** Both directions: sessions watching the subject and sessions they started. */
  async deleteLiveSessions(input: { userId: UserId }): Promise<number> {
    const sessionIds = new Set<string>();

    for (const [indexName, attribute] of [
      ['byTarget', 'targetUserId'],
      ['byRequester', 'requesterUserId'],
    ] as const) {
      const rows = await queryAll(this.documents, {
        TableName: this.tables.liveSessions,
        IndexName: indexName,
        KeyConditionExpression: '#attribute = :userId',
        ExpressionAttributeNames: { '#attribute': attribute },
        ExpressionAttributeValues: { ':userId': input.userId },
      });
      for (const row of rows) {
        const sessionId = readString(row, 'sessionId');
        if (sessionId !== null) sessionIds.add(sessionId);
      }
    }

    const keys = [...sessionIds].map((sessionId) => ({ sessionId }));
    return keys.length === 0
      ? 0
      : await batchDelete(this.documents, this.tables.liveSessions, keys);
  }

  async deleteGeofenceState(input: { userId: UserId }): Promise<number> {
    const rows = await queryAll(this.documents, {
      TableName: this.tables.geofenceState,
      KeyConditionExpression: '#userId = :userId',
      ExpressionAttributeNames: { '#userId': 'userId' },
      ExpressionAttributeValues: { ':userId': input.userId },
    });
    const keys = rows.flatMap((row) => {
      const placeId = readString(row, 'placeId');
      return placeId === null ? [] : [{ userId: input.userId, placeId }];
    });
    return keys.length === 0
      ? 0
      : await batchDelete(this.documents, this.tables.geofenceState, keys);
  }
}

/**
 * The tombstone row.
 *
 * Written into the deletion-jobs table under a sentinel key so it is not
 * reachable from the `byUser` index and carries no user id of its own. The user
 * row itself is removed at the same time: the account is gone, and what remains
 * is a hash that proves a deletion happened.
 */
export class DynamoTombstoneWriter implements TombstoneWriter {
  constructor(
    private readonly documents: DynamoDBDocumentClient,
    private readonly tables: DeletionTables,
    private readonly userId: UserId,
  ) {}

  async write(tombstone: Tombstone): Promise<void> {
    await this.documents.send(
      new PutCommand({
        TableName: this.tables.deletionJobs,
        Item: {
          jobId: `TOMBSTONE#${tombstone.tombstoneId}`,
          status: 'TOMBSTONE',
          deletedAt: tombstone.deletedAt,
          reason: tombstone.reason,
          schemaVersion: tombstone.schemaVersion,
        },
      }),
    );
    await this.documents.send(
      new DeleteCommand({ TableName: this.tables.users, Key: { userId: this.userId } }),
    );
  }
}

export class DynamoDeletionJobStore implements DeletionJobStore {
  constructor(
    private readonly documents: DynamoDBDocumentClient,
    private readonly tables: DeletionTables,
  ) {}

  async load(input: { jobId: string }): Promise<DeletionJob | null> {
    const response = await this.documents.send(
      new GetCommand({
        TableName: this.tables.deletionJobs,
        Key: { jobId: input.jobId },
        ConsistentRead: true,
      }),
    );
    const item = response.Item as Attributes | undefined;
    if (item === undefined) return null;

    const userId = readString(item, 'userId');
    const step = readString(item, 'step');
    if (userId === null || step === null) return null;

    const completedSteps = Array.isArray(item.completedSteps)
      ? item.completedSteps.filter((entry): entry is string => typeof entry === 'string')
      : [];

    return {
      jobId: input.jobId,
      userId: userId as UserId,
      status: (readString(item, 'status') ?? 'PENDING') as DeletionJob['status'],
      step: step as DeletionStep,
      cursor: readString(item, 'cursor'),
      requestedAt: readString(item, 'requestedAt') ?? new Date(0).toISOString(),
      scheduledFor: readString(item, 'scheduledFor') ?? new Date(0).toISOString(),
      startedAt: readString(item, 'startedAt'),
      completedAt: readString(item, 'completedAt'),
      attempts: typeof item.attempts === 'number' ? item.attempts : 0,
      completedSteps: completedSteps as DeletionStep[],
      updatedAt: readString(item, 'updatedAt') ?? new Date(0).toISOString(),
      lastErrorCode: readString(item, 'lastErrorCode'),
    };
  }

  async save(job: DeletionJob): Promise<void> {
    await this.documents.send(
      new PutCommand({
        TableName: this.tables.deletionJobs,
        Item: {
          jobId: job.jobId,
          userId: job.userId,
          status: job.status,
          step: job.step,
          cursor: job.cursor,
          requestedAt: job.requestedAt,
          scheduledFor: job.scheduledFor,
          startedAt: job.startedAt,
          completedAt: job.completedAt,
          attempts: job.attempts,
          completedSteps: [...job.completedSteps],
          updatedAt: job.updatedAt,
          lastErrorCode: job.lastErrorCode,
        },
      }),
    );
  }
}
