import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

import type { FamilyMembershipRecord } from '@family/auth';
import {
  FamilyRoleSchema,
  MembershipStatusSchema,
  SharingStatusSchema,
  type DeviceId,
  type FamilyId,
  type UserId,
} from '@family/contracts';
import {
  NotificationPreferencesSchema,
  PlatformSchema,
  type NotificationPreferences,
} from '@family/schemas';

import type { NotificationCommand } from './messages.js';
import type {
  DeduplicationStore,
  DeliveryRecord,
  DeliveryRecorder,
  EndpointRegistry,
  EventLoader,
  MembershipReader,
  NotificationEvent,
  PreferencesReader,
  RateLimiter,
  RecipientDevice,
  RecipientProfile,
} from './ports.js';

/** DynamoDB bindings for every port in `ports.js`. */

export function createDocumentClient(client?: DynamoDBClient): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(client ?? new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true, convertClassInstanceToMap: false },
  });
}

type Attributes = Record<string, unknown>;

/** Sort-key sentinel for preferences that are not scoped to one family. */
export const GLOBAL_PREFERENCE_SCOPE = 'GLOBAL';

function readString(item: Attributes, key: string): string | null {
  const value = item[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readStringArray(item: Attributes, key: string): string[] {
  const value = item[key];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

const CHANNEL_ON = { push: true, inApp: true } as const;

/**
 * Preferences for a user who has never opened the settings screen. Opt-in by
 * default for everything the family agreed to when they joined, with quiet
 * hours off — a silent default would look like a broken product, and a user who
 * wants silence has an explicit control for it.
 */
export function defaultPreferences(userId: UserId, updatedAt: string): NotificationPreferences {
  return NotificationPreferencesSchema.parse({
    userId,
    arrivals: CHANNEL_ON,
    departures: CHANNEL_ON,
    liveSessions: CHANNEL_ON,
    membership: CHANNEL_ON,
    sharingChanges: CHANNEL_ON,
    deviceHealth: CHANNEL_ON,
    billing: CHANNEL_ON,
    quietHours: { enabled: false, startMinuteOfDay: 0, endMinuteOfDay: 0 },
    mutedFamilyIds: [],
    mutedUserIds: [],
    updatedAt,
  });
}

function channel(item: Attributes, key: string): { push: boolean; inApp: boolean } {
  const value = item[key];
  if (value === null || typeof value !== 'object') return { push: true, inApp: true };
  const record = value as Attributes;
  return {
    push: typeof record.push === 'boolean' ? record.push : true,
    inApp: typeof record.inApp === 'boolean' ? record.inApp : true,
  };
}

function quietHours(item: Attributes): {
  enabled: boolean;
  startMinuteOfDay: number;
  endMinuteOfDay: number;
} {
  const value = item.quietHours;
  if (value === null || typeof value !== 'object') {
    return { enabled: false, startMinuteOfDay: 0, endMinuteOfDay: 0 };
  }
  const record = value as Attributes;
  const start = typeof record.startMinuteOfDay === 'number' ? record.startMinuteOfDay : 0;
  const end = typeof record.endMinuteOfDay === 'number' ? record.endMinuteOfDay : 0;
  return {
    enabled: typeof record.enabled === 'boolean' ? record.enabled : false,
    startMinuteOfDay: Math.min(Math.max(Math.trunc(start), 0), 1439),
    endMinuteOfDay: Math.min(Math.max(Math.trunc(end), 0), 1439),
  };
}

export class DynamoPreferencesReader implements PreferencesReader {
  constructor(
    private readonly documents: DynamoDBDocumentClient,
    private readonly tables: {
      preferences: string;
      devices: string;
      users: string;
    },
    private readonly now: () => Date = () => new Date(),
  ) {}

  async load(input: {
    userId: UserId;
    familyId: FamilyId | null;
  }): Promise<RecipientProfile | null> {
    const user = await this.documents.send(
      new GetCommand({ TableName: this.tables.users, Key: { userId: input.userId } }),
    );
    const userItem = user.Item as Attributes | undefined;
    if (userItem === undefined) {
      // No account: nothing to notify, and nothing to say about why.
      return null;
    }

    const scoped = await this.readPreferences(input.userId, input.familyId);
    const global = scoped ?? (await this.readPreferences(input.userId, null));

    return {
      userId: input.userId,
      preferences: global ?? defaultPreferences(input.userId, this.now().toISOString()),
      timeZone: readString(userItem, 'timeZone'),
      devices: await this.readDevices(input.userId),
    };
  }

  private async readPreferences(
    userId: UserId,
    familyId: FamilyId | null,
  ): Promise<NotificationPreferences | null> {
    const response = await this.documents.send(
      new GetCommand({
        TableName: this.tables.preferences,
        Key: { userId, familyId: familyId ?? GLOBAL_PREFERENCE_SCOPE },
      }),
    );
    const item = response.Item as Attributes | undefined;
    if (item === undefined) return null;

    // Built field by field rather than parsed wholesale: the stored row carries
    // key attributes the strict contract schema would (correctly) reject.
    const parsed = NotificationPreferencesSchema.safeParse({
      userId,
      arrivals: channel(item, 'arrivals'),
      departures: channel(item, 'departures'),
      liveSessions: channel(item, 'liveSessions'),
      membership: channel(item, 'membership'),
      sharingChanges: channel(item, 'sharingChanges'),
      deviceHealth: channel(item, 'deviceHealth'),
      billing: channel(item, 'billing'),
      quietHours: quietHours(item),
      mutedFamilyIds: readStringArray(item, 'mutedFamilyIds'),
      mutedUserIds: readStringArray(item, 'mutedUserIds'),
      updatedAt: readString(item, 'updatedAt') ?? this.now().toISOString(),
    });
    return parsed.success ? parsed.data : null;
  }

  private async readDevices(userId: UserId): Promise<RecipientDevice[]> {
    const devices: RecipientDevice[] = [];
    let exclusiveStartKey: Attributes | undefined;

    do {
      const response = await this.documents.send(
        new QueryCommand({
          TableName: this.tables.devices,
          KeyConditionExpression: '#userId = :userId',
          ExpressionAttributeNames: { '#userId': 'userId' },
          ExpressionAttributeValues: { ':userId': userId },
          ExclusiveStartKey: exclusiveStartKey,
        }),
      );

      for (const raw of response.Items ?? []) {
        const item = raw as Attributes;
        const deviceId = readString(item, 'deviceId');
        const platform = PlatformSchema.safeParse(item.platform);
        if (deviceId === null || !platform.success) continue;

        const status = readString(item, 'status');
        devices.push({
          deviceId: deviceId as DeviceId,
          platform: platform.data,
          status:
            status === 'ACTIVE' || status === 'PENDING' || status === 'REVOKED'
              ? status
              : 'REVOKED',
          endpointArn: readString(item, 'pushEndpointArn'),
          pushToken: readString(item, 'pushToken'),
        });
      }

      exclusiveStartKey = response.LastEvaluatedKey as Attributes | undefined;
    } while (exclusiveStartKey !== undefined);

    return devices;
  }
}

function toMembershipRecord(item: Attributes): FamilyMembershipRecord | null {
  const familyId = readString(item, 'familyId');
  const userId = readString(item, 'userId');
  const role = FamilyRoleSchema.safeParse(item.role);
  const status = MembershipStatusSchema.safeParse(item.status);
  const sharing = SharingStatusSchema.safeParse(item.sharingStatus);
  if (
    familyId === null ||
    userId === null ||
    !role.success ||
    !status.success ||
    !sharing.success
  ) {
    return null;
  }

  const visibleToUserIds = Array.isArray(item.visibleToUserIds)
    ? readStringArray(item, 'visibleToUserIds')
    : null;

  return {
    familyId: familyId as FamilyId,
    userId: userId as UserId,
    role: role.data,
    status: status.data,
    sharingStatus: sharing.data,
    visibleToUserIds: visibleToUserIds as UserId[] | null,
    hiddenFromUserIds: readStringArray(item, 'hiddenFromUserIds') as UserId[],
  };
}

export class DynamoMembershipReader implements MembershipReader {
  constructor(
    private readonly documents: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async getMembership(input: {
    familyId: FamilyId;
    userId: UserId;
  }): Promise<FamilyMembershipRecord | null> {
    const response = await this.documents.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { familyId: input.familyId, userId: input.userId },
        // Strongly consistent: a member removed a second ago must not still be
        // visible to this read, because that read is the authorisation.
        ConsistentRead: true,
      }),
    );
    const item = response.Item as Attributes | undefined;
    return item === undefined ? null : toMembershipRecord(item);
  }

  async listActiveMembers(input: { familyId: FamilyId }): Promise<FamilyMembershipRecord[]> {
    const members: FamilyMembershipRecord[] = [];
    let exclusiveStartKey: Attributes | undefined;

    do {
      const response = await this.documents.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: '#familyId = :familyId',
          ExpressionAttributeNames: { '#familyId': 'familyId' },
          ExpressionAttributeValues: { ':familyId': input.familyId },
          ExclusiveStartKey: exclusiveStartKey,
          ConsistentRead: true,
        }),
      );

      for (const raw of response.Items ?? []) {
        const record = toMembershipRecord(raw as Attributes);
        if (record !== null && record.status === 'ACTIVE') members.push(record);
      }

      exclusiveStartKey = response.LastEvaluatedKey as Attributes | undefined;
    } while (exclusiveStartKey !== undefined);

    return members;
  }
}

export class DynamoEventLoader implements EventLoader {
  constructor(
    private readonly documents: DynamoDBDocumentClient,
    private readonly tables: { users: string; savedPlaces: string; liveSessions: string },
  ) {}

  async load(command: NotificationCommand): Promise<NotificationEvent | null> {
    // A notification about a live session that has already ended is worse than
    // no notification at all, so the underlying record is confirmed first.
    if (command.liveSessionId !== null) {
      const session = await this.documents.send(
        new GetCommand({
          TableName: this.tables.liveSessions,
          Key: { sessionId: command.liveSessionId },
        }),
      );
      if (session.Item === undefined) return null;
    }

    let placeName: string | null = null;
    if (command.placeId !== null && command.familyId !== null) {
      const place = await this.documents.send(
        new GetCommand({
          TableName: this.tables.savedPlaces,
          Key: { familyId: command.familyId, placeId: command.placeId },
        }),
      );
      const item = place.Item as Attributes | undefined;
      if (item === undefined) return null;
      placeName = readString(item, 'name');
    }

    let subjectDisplayName: string | null = null;
    if (command.subjectUserId !== null) {
      const subject = await this.documents.send(
        new GetCommand({ TableName: this.tables.users, Key: { userId: command.subjectUserId } }),
      );
      const item = subject.Item as Attributes | undefined;
      if (item === undefined) return null;
      subjectDisplayName = readString(item, 'displayName');
    }

    return { command, subjectDisplayName, placeName };
  }
}

/** Conditional-put claim in the shared idempotency table. */
export class DynamoDeduplicationStore implements DeduplicationStore {
  constructor(
    private readonly documents: DynamoDBDocumentClient,
    private readonly tableName: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async claim(input: { key: string; ttlSeconds: number }): Promise<boolean> {
    const expiresAt = Math.floor(this.now().getTime() / 1000) + Math.round(input.ttlSeconds);
    try {
      await this.documents.send(
        new PutCommand({
          TableName: this.tableName,
          Item: { idempotencyKey: input.key, claimedAt: this.now().toISOString(), expiresAt },
          ConditionExpression: 'attribute_not_exists(idempotencyKey)',
        }),
      );
      return true;
    } catch (error) {
      if (error instanceof Error && error.name === 'ConditionalCheckFailedException') return false;
      throw error;
    }
  }
}

/** Fixed-window counter, one item per (key, minute), reaped by TTL. */
export class DynamoRateLimiter implements RateLimiter {
  constructor(
    private readonly documents: DynamoDBDocumentClient,
    private readonly tableName: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async consume(input: { key: string; limitPerMinute: number }): Promise<{ allowed: boolean }> {
    const nowMs = this.now().getTime();
    const window = Math.floor(nowMs / 60_000);
    const expiresAt = Math.floor(nowMs / 1000) + 180;

    const response = await this.documents.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { idempotencyKey: `ratelimit:${input.key}:${String(window)}` },
        UpdateExpression: 'ADD #count :one SET #expiresAt = :expiresAt',
        ExpressionAttributeNames: { '#count': 'count', '#expiresAt': 'expiresAt' },
        ExpressionAttributeValues: { ':one': 1, ':expiresAt': expiresAt },
        ReturnValues: 'UPDATED_NEW',
      }),
    );

    const attributes = response.Attributes as Attributes | undefined;
    const count = typeof attributes?.count === 'number' ? attributes.count : 1;
    return { allowed: count <= input.limitPerMinute };
  }
}

/**
 * The durable, sanitised record of a delivery attempt.
 *
 * Ids, enums and a provider reason code only. No push token, no endpoint ARN,
 * no rendered copy, and nothing derived from a position — this row is queried
 * during support investigations and must be safe to read.
 */
export class DynamoDeliveryRecorder implements DeliveryRecorder {
  constructor(
    private readonly documents: DynamoDBDocumentClient,
    private readonly tableName: string,
    private readonly retentionDays: number = 30,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async record(result: DeliveryRecord): Promise<void> {
    const expiresAt =
      Math.floor(this.now().getTime() / 1000) + Math.round(this.retentionDays * 24 * 3600);
    await this.documents.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          idempotencyKey: `delivery:${result.commandId}:${result.recipientUserId}:${result.deviceId ?? 'none'}`,
          commandId: result.commandId,
          recipientUserId: result.recipientUserId,
          deviceId: result.deviceId,
          kind: result.kind,
          stage: result.stage,
          disposition: result.disposition,
          reasonCode: result.reasonCode,
          occurredAt: result.occurredAt,
          recordedAt: result.recordedAt,
          expiresAt,
        },
      }),
    );
  }
}

/** Device-row half of the endpoint registry: clear the credential. */
export class DynamoTokenRemover implements Pick<EndpointRegistry, 'removeToken'> {
  constructor(
    private readonly documents: DynamoDBDocumentClient,
    private readonly tableName: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async removeToken(input: { userId: UserId; deviceId: DeviceId }): Promise<void> {
    await this.documents.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { userId: input.userId, deviceId: input.deviceId },
        UpdateExpression:
          'REMOVE #pushToken, #pushEndpointArn SET #registered = :false, #updatedAt = :updatedAt',
        ExpressionAttributeNames: {
          '#pushToken': 'pushToken',
          '#pushEndpointArn': 'pushEndpointArn',
          '#registered': 'pushTokenRegistered',
          '#updatedAt': 'updatedAt',
        },
        ExpressionAttributeValues: { ':false': false, ':updatedAt': this.now().toISOString() },
        ConditionExpression: 'attribute_exists(deviceId)',
      }),
    );
  }
}
