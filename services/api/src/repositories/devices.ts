import { z } from 'zod';

import type { DeviceRecord as AuthDeviceRecord, DeviceRepository } from '@family/auth';
import {
  AppError,
  DeviceIdSchema,
  TrackingStateSchema,
  UserIdSchema,
  type DeviceId,
  type UserId,
} from '@family/contracts';
import {
  AppVersionSchema,
  DeviceStatusSchema,
  IsoDateTimeSchema,
  LocaleSchema,
  PlatformSchema,
  PushTokenSchema,
  StrictDeviceLocationHealthSchema,
  TimeZoneSchema,
  type DeviceStatus,
} from '@family/schemas';

import { isConditionalCheckFailed, type DocumentClient, type Item } from './document-client.js';
import { buildSetExpression } from './expressions.js';

/**
 * The Devices table: partitioned by `userId`, sorted by `deviceId`.
 *
 * The push token is stored because the notification service needs it, and is
 * never projected into a response or a log line — the API exposes only
 * `pushTokenRegistered`. Nothing in this module returns the token.
 */

export const DeviceRecordSchema = z.object({
  userId: UserIdSchema,
  deviceId: DeviceIdSchema,
  platform: PlatformSchema,
  osVersion: z.string().min(1).max(40),
  appVersion: AppVersionSchema,
  appBuild: z.string().min(1).max(40),
  modelIdentifier: z.string().min(1).max(80),
  deviceName: z.string().min(1).max(80).nullable().default(null),
  status: DeviceStatusSchema,
  pushToken: PushTokenSchema.nullable().default(null),
  trackingState: TrackingStateSchema.default('PERMISSION_REQUIRED'),
  locale: LocaleSchema,
  timeZone: TimeZoneSchema,
  health: StrictDeviceLocationHealthSchema.nullable().default(null),
  registeredAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  lastSeenAt: IsoDateTimeSchema.nullable().default(null),
  lastUploadAt: IsoDateTimeSchema.nullable().default(null),
  revokedAt: IsoDateTimeSchema.nullable().default(null),
});
export type DeviceRecord = z.infer<typeof DeviceRecordSchema>;

export type DevicePatch = {
  readonly deviceName?: string | null;
  readonly pushToken?: string | null;
  readonly appVersion?: string;
  readonly appBuild?: string;
  readonly osVersion?: string;
  readonly locale?: string;
  readonly timeZone?: string;
  readonly health?: DeviceRecord['health'];
  readonly trackingState?: DeviceRecord['trackingState'];
};

export interface DevicesRepository extends DeviceRepository {
  get(input: { userId: UserId; deviceId: DeviceId }): Promise<DeviceRecord | null>;
  list(userId: UserId): Promise<DeviceRecord[]>;
  /** Re-registering the same id is an upsert, so the client can retry safely. */
  upsert(record: DeviceRecord): Promise<void>;
  update(input: {
    userId: UserId;
    deviceId: DeviceId;
    patch: DevicePatch;
    now: Date;
  }): Promise<DeviceRecord | null>;
  revoke(input: { userId: UserId; deviceId: DeviceId; now: Date }): Promise<DeviceRecord | null>;
  /** Used by account deletion: every device loses its credentials at once. */
  revokeAll(input: { userId: UserId; now: Date }): Promise<number>;
}

export function createDevicesRepository(
  client: DocumentClient,
  tableName: string,
): DevicesRepository {
  async function read(userId: UserId, deviceId: DeviceId): Promise<DeviceRecord | null> {
    const result = await client.get({
      TableName: tableName,
      Key: { userId, deviceId },
      ConsistentRead: true,
    });
    return result.Item === undefined ? null : parseDevice(result.Item);
  }

  async function list(userId: UserId): Promise<DeviceRecord[]> {
    const records: DeviceRecord[] = [];
    let cursor: Item | undefined;
    do {
      const page = await client.query({
        TableName: tableName,
        KeyConditionExpression: '#u = :u',
        ExpressionAttributeNames: { '#u': 'userId' },
        ExpressionAttributeValues: { ':u': userId },
        ExclusiveStartKey: cursor,
      });
      for (const item of page.Items ?? []) {
        records.push(parseDevice(item));
      }
      cursor = page.LastEvaluatedKey;
    } while (cursor !== undefined);
    return records;
  }

  async function revokeOne(
    userId: UserId,
    deviceId: DeviceId,
    now: Date,
  ): Promise<DeviceRecord | null> {
    const timestamp = now.toISOString();
    try {
      const result = await client.update({
        TableName: tableName,
        Key: { userId, deviceId },
        UpdateExpression: 'SET #s = :revoked, #r = :t, #u = :t REMOVE #p',
        ConditionExpression: 'attribute_exists(deviceId)',
        ExpressionAttributeNames: {
          '#s': 'status',
          '#r': 'revokedAt',
          '#u': 'updatedAt',
          // The push token is destroyed, not just flagged: a revoked device must
          // stop being reachable, and a token left behind is a live channel.
          '#p': 'pushToken',
        },
        ExpressionAttributeValues: { ':revoked': 'REVOKED', ':t': timestamp },
        ReturnValues: 'ALL_NEW',
      });
      return result.Attributes === undefined ? null : parseDevice(result.Attributes);
    } catch (error) {
      if (isConditionalCheckFailed(error)) {
        return null;
      }
      throw error;
    }
  }

  return {
    get: (input) => read(input.userId, input.deviceId),
    list,

    async getDevice(input: {
      userId: UserId;
      deviceId: DeviceId;
    }): Promise<AuthDeviceRecord | null> {
      const record = await read(input.userId, input.deviceId);
      return record === null
        ? null
        : { deviceId: record.deviceId, userId: record.userId, status: toAuthStatus(record.status) };
    },

    async upsert(record): Promise<void> {
      await client.put({ TableName: tableName, Item: { ...record } });
    },

    async update(input): Promise<DeviceRecord | null> {
      const expression = buildSetExpression(
        {
          deviceName: input.patch.deviceName,
          pushToken: input.patch.pushToken,
          appVersion: input.patch.appVersion,
          appBuild: input.patch.appBuild,
          osVersion: input.patch.osVersion,
          locale: input.patch.locale,
          timeZone: input.patch.timeZone,
          health: input.patch.health,
          trackingState: input.patch.trackingState,
          lastSeenAt: input.now.toISOString(),
          updatedAt: input.now.toISOString(),
        },
        // Clearing the push token removes the attribute entirely rather than
        // storing a null the notification service would have to special-case.
        { removeWhenNull: ['pushToken'] },
      );
      if (expression === null) {
        return read(input.userId, input.deviceId);
      }

      const values = { ...(expression.ExpressionAttributeValues ?? {}), ':revoked': 'REVOKED' };
      try {
        const result = await client.update({
          TableName: tableName,
          Key: { userId: input.userId, deviceId: input.deviceId },
          UpdateExpression: expression.UpdateExpression,
          // A revoked device may not quietly resurrect itself by patching.
          ConditionExpression: 'attribute_exists(deviceId) AND #status <> :revoked',
          ExpressionAttributeNames: { ...expression.ExpressionAttributeNames, '#status': 'status' },
          ExpressionAttributeValues: values,
          ReturnValues: 'ALL_NEW',
        });
        return result.Attributes === undefined ? null : parseDevice(result.Attributes);
      } catch (error) {
        if (isConditionalCheckFailed(error)) {
          return null;
        }
        throw error;
      }
    },

    revoke: (input) => revokeOne(input.userId, input.deviceId, input.now),

    async revokeAll(input): Promise<number> {
      const devices = await list(input.userId);
      let revoked = 0;
      for (const device of devices) {
        if (device.status === 'REVOKED') {
          continue;
        }
        await revokeOne(input.userId, device.deviceId, input.now);
        revoked += 1;
      }
      return revoked;
    },
  };
}

/**
 * The API's device lifecycle (`INACTIVE` for a device that has gone quiet) is
 * finer-grained than the authorization package's. Everything that is not
 * `ACTIVE` denies, so the mapping only has to preserve that distinction.
 */
function toAuthStatus(status: DeviceStatus): AuthDeviceRecord['status'] {
  switch (status) {
    case 'ACTIVE':
      return 'ACTIVE';
    case 'INACTIVE':
      return 'PENDING';
    case 'REVOKED':
      return 'REVOKED';
  }
}

function parseDevice(item: Item): DeviceRecord {
  const parsed = DeviceRecordSchema.safeParse(item);
  if (!parsed.success) {
    throw new AppError('INTERNAL_ERROR', 'A device record could not be read.');
  }
  return parsed.data;
}
