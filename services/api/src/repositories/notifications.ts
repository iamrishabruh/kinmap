import { z } from 'zod';

import {
  AppError,
  FamilyIdSchema,
  PlaceIdSchema,
  UserIdSchema,
  type UserId,
} from '@family/contracts';
import {
  IsoDateTimeSchema,
  NotificationChannelPreferenceSchema,
  NotificationKindSchema,
  QuietHoursSchema,
  type NotificationPreferences,
} from '@family/schemas';

import { isConditionalCheckFailed, type DocumentClient, type Item } from './document-client.js';

/**
 * The in-app notification list and the per-user delivery preferences.
 *
 * NEITHER TABLE HOLDS A POSITION. A notification row carries ids plus the copy
 * the notification worker already rendered — "Ana arrived at School" — which
 * names a person and a saved place the recipient's own family authored. That is
 * the same rule `PushPayloadSchema` enforces on the way out to APNs/FCM, and it
 * is what makes these rows safe to keep, to log the ids of, and to hand back.
 *
 * Both record schemas are non-strict on purpose, and Zod drops what they do not
 * name: an attribute some future writer adds to a row is discarded at parse
 * rather than carried outward, so the only way a new field reaches a client is
 * by being named in a projection.
 */

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export const NotificationRecordSchema = z.object({
  userId: UserIdSchema,
  notificationId: z.string().uuid(),
  kind: NotificationKindSchema,
  familyId: FamilyIdSchema.nullable().default(null),
  subjectUserId: UserIdSchema.nullable().default(null),
  placeId: PlaceIdSchema.nullable().default(null),
  /** Rendered by the notification worker. User-safe, and coordinate-free. */
  title: z.string().min(1).max(120),
  body: z.string().min(1).max(300),
  occurredAt: IsoDateTimeSchema,
  /** Absent until the row is read, which is how the unread count is counted. */
  readAt: IsoDateTimeSchema.nullable().default(null),
});
export type NotificationRecord = z.infer<typeof NotificationRecordSchema>;

/**
 * Sort keys are `<occurredAt>#<notificationId>`, the shape the audit trail
 * already uses, so a descending query is newest-first without a second index.
 */
export function notificationSortKey(occurredAt: string, notificationId: string): string {
  return `${occurredAt}#${notificationId}`;
}

/**
 * The newest slice one list read returns.
 *
 * It matches the 200-id ceiling `MarkNotificationsReadRequestSchema` puts on a
 * mark-read call, so a client can always mark everything it was just shown as
 * read in a single request rather than discovering it cannot.
 */
export const MAX_NOTIFICATIONS_LISTED = 200;

export type NotificationPage = {
  readonly notifications: NotificationRecord[];
  /** Across the whole partition, not merely the returned slice. */
  readonly unreadCount: number;
};

export type MarkReadResult = {
  readonly readCount: number;
  readonly unreadCount: number;
};

export interface NotificationsRepository {
  list(input: { userId: UserId; limit: number }): Promise<NotificationPage>;
  /**
   * Marks the caller's own unread rows. Ids that are not in the caller's
   * partition are not errors and are not reported: this is not a lookup.
   */
  markRead(input: {
    userId: UserId;
    notificationIds: readonly string[];
    now: Date;
  }): Promise<MarkReadResult>;
}

export function createNotificationsRepository(
  client: DocumentClient,
  tableName: string,
): NotificationsRepository {
  /**
   * The caller's own partition, newest first.
   *
   * `userId` is the partition key and always arrives from the verified token,
   * so there is no input to this query that could reach another person's rows.
   * The read is consistent because a list fetched straight after a mark-read
   * must show the row as read.
   */
  async function readPartition(userId: UserId): Promise<NotificationRecord[]> {
    const records: NotificationRecord[] = [];
    let cursor: Item | undefined;
    do {
      const page = await client.query({
        TableName: tableName,
        KeyConditionExpression: '#u = :u',
        ExpressionAttributeNames: { '#u': 'userId' },
        ExpressionAttributeValues: { ':u': userId },
        // Newest first: a list and a badge are both read from the top, and
        // nothing in this surface pages backwards.
        ScanIndexForward: false,
        ExclusiveStartKey: cursor,
        ConsistentRead: true,
      });
      for (const item of page.Items ?? []) {
        records.push(parseNotification(item));
      }
      cursor = page.LastEvaluatedKey;
    } while (cursor !== undefined);
    return records;
  }

  async function markOne(
    userId: UserId,
    record: NotificationRecord,
    timestamp: string,
  ): Promise<boolean> {
    try {
      await client.update({
        TableName: tableName,
        Key: { userId, sk: notificationSortKey(record.occurredAt, record.notificationId) },
        UpdateExpression: 'SET #r = :t',
        // Guards against the row having aged out between the read and the
        // write: an update with no condition would resurrect it as a stub.
        ConditionExpression: 'attribute_exists(sk)',
        ExpressionAttributeNames: { '#r': 'readAt' },
        ExpressionAttributeValues: { ':t': timestamp },
      });
      return true;
    } catch (error) {
      if (isConditionalCheckFailed(error)) {
        return false;
      }
      throw error;
    }
  }

  return {
    async list(input): Promise<NotificationPage> {
      const records = await readPartition(input.userId);
      return {
        notifications: records.slice(0, input.limit),
        unreadCount: records.filter((record) => record.readAt === null).length,
      };
    },

    async markRead(input): Promise<MarkReadResult> {
      const requested = new Set(input.notificationIds);
      const records = await readPartition(input.userId);
      const timestamp = input.now.toISOString();

      let readCount = 0;
      let unreadCount = 0;
      for (const record of records) {
        if (record.readAt !== null) {
          continue;
        }
        // Only rows this read found are ever written, so a replay of the same
        // request marks nothing a second time and cannot move a timestamp the
        // user is already looking at.
        if (
          requested.has(record.notificationId) &&
          (await markOne(input.userId, record, timestamp))
        ) {
          readCount += 1;
          continue;
        }
        unreadCount += 1;
      }
      return { readCount, unreadCount };
    },
  };
}

function parseNotification(item: Item): NotificationRecord {
  const parsed = NotificationRecordSchema.safeParse(item);
  if (!parsed.success) {
    throw new AppError('INTERNAL_ERROR', 'A notification could not be read.');
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

/**
 * Sort-key sentinel for the account-wide preference row.
 *
 * The NotificationPreferences table is keyed `(userId, familyId)` because the
 * notification worker looks for a family-scoped override before falling back to
 * the account-wide row, which it reads under exactly this sentinel. The v1 API
 * exposes the account-wide row only, and the string is part of that
 * cross-service contract: changing it here would quietly stop the worker from
 * seeing a user's choices at all.
 */
export const GLOBAL_PREFERENCE_SCOPE = 'GLOBAL';

/**
 * The stored row.
 *
 * Non-strict, because the row also carries the `familyId` key attribute that
 * the strict contract schema (correctly) has no field for.
 */
const StoredPreferencesSchema = z.object({
  userId: UserIdSchema,
  arrivals: NotificationChannelPreferenceSchema,
  departures: NotificationChannelPreferenceSchema,
  liveSessions: NotificationChannelPreferenceSchema,
  membership: NotificationChannelPreferenceSchema,
  sharingChanges: NotificationChannelPreferenceSchema,
  deviceHealth: NotificationChannelPreferenceSchema,
  billing: NotificationChannelPreferenceSchema,
  quietHours: QuietHoursSchema,
  mutedFamilyIds: z.array(FamilyIdSchema).default([]),
  mutedUserIds: z.array(UserIdSchema).default([]),
  updatedAt: IsoDateTimeSchema,
});

const CHANNEL_ON = { push: true, inApp: true } as const;

/**
 * What a user who has never opened the settings screen is on.
 *
 * Identical to the defaults the notification worker applies when it finds no
 * row, so this API never describes delivery behaviour the worker would not
 * actually produce. Opt-in for everything the family agreed to on joining, with
 * quiet hours off — silence by default reads as a broken product, and a user
 * who wants silence has an explicit control for it.
 */
export function defaultNotificationPreferences(
  userId: UserId,
  updatedAt: string,
): NotificationPreferences {
  return {
    userId,
    arrivals: { ...CHANNEL_ON },
    departures: { ...CHANNEL_ON },
    liveSessions: { ...CHANNEL_ON },
    membership: { ...CHANNEL_ON },
    sharingChanges: { ...CHANNEL_ON },
    deviceHealth: { ...CHANNEL_ON },
    billing: { ...CHANNEL_ON },
    quietHours: { enabled: false, startMinuteOfDay: 0, endMinuteOfDay: 0 },
    mutedFamilyIds: [],
    mutedUserIds: [],
    updatedAt,
  };
}

export interface NotificationPreferencesRepository {
  /** Null when the user has never changed a setting. */
  get(userId: UserId): Promise<NotificationPreferences | null>;
  /** Upsert of the whole account-wide row, keyed by `preferences.userId`. */
  put(preferences: NotificationPreferences): Promise<void>;
}

export function createNotificationPreferencesRepository(
  client: DocumentClient,
  tableName: string,
): NotificationPreferencesRepository {
  return {
    async get(userId): Promise<NotificationPreferences | null> {
      const result = await client.get({
        TableName: tableName,
        Key: { userId, familyId: GLOBAL_PREFERENCE_SCOPE },
        // A settings screen opened straight after a save must show the save.
        ConsistentRead: true,
      });
      return result.Item === undefined ? null : parsePreferences(result.Item);
    },

    async put(preferences): Promise<void> {
      // Written whole rather than patched: the worker reads this row field by
      // field, and a partial row would silently fall back to defaults for the
      // fields it could not find.
      await client.put({
        TableName: tableName,
        Item: { ...preferences, familyId: GLOBAL_PREFERENCE_SCOPE },
      });
    },
  };
}

/**
 * A row that cannot be read is an error, not an excuse to use the defaults:
 * every default here is "on", so quietly falling back to them would switch
 * notifications a user had deliberately switched off back on again.
 */
function parsePreferences(item: Item): NotificationPreferences {
  const parsed = StoredPreferencesSchema.safeParse(item);
  if (!parsed.success) {
    throw new AppError('INTERNAL_ERROR', 'Notification preferences could not be read.');
  }
  return parsed.data;
}

/**
 * The members the composition root adds to `ApiServices` for this area.
 *
 * Named here so a route can depend on the repositories rather than on the shape
 * of the container while the two are wired together.
 */
export type NotificationServices = {
  readonly notifications: NotificationsRepository;
  readonly notificationPreferences: NotificationPreferencesRepository;
};
