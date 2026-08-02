import { z } from 'zod';

import type { UserAccountRecord, UserAccountRepository } from '@family/auth';
import {
  AppError,
  SharingStatusSchema,
  UserIdSchema,
  type SharingStatus,
  type UserId,
} from '@family/contracts';
import {
  AvatarUrlSchema,
  DisplayNameSchema,
  EmailSchema,
  IsoDateTimeSchema,
  LocaleSchema,
  PhoneNumberSchema,
  TermsVersionSchema,
  TimeZoneSchema,
} from '@family/schemas';

import { isConditionalCheckFailed, type DocumentClient, type Item } from './document-client.js';
import { buildSetExpression } from './expressions.js';

/**
 * The Users table: one row per person, partitioned by `userId`.
 *
 * `sharingStatus` here is the *master* switch. It is mirrored onto every
 * membership row when it changes, because the authorization checker reads the
 * membership row and nothing else — see `domain/sharing.ts` for why that
 * mirroring is what makes a pause take effect on the very next read.
 */

export const AccountStatusRecordSchema = z.enum([
  'ACTIVE',
  'SUSPENDED',
  'PENDING_DELETION',
  'DELETED',
]);
export type AccountStatusRecord = z.infer<typeof AccountStatusRecordSchema>;

export const UserRecordSchema = z.object({
  userId: UserIdSchema,
  displayName: DisplayNameSchema,
  avatarUrl: AvatarUrlSchema.nullable().default(null),
  email: EmailSchema.nullable().default(null),
  phoneNumber: PhoneNumberSchema.nullable().default(null),
  locale: LocaleSchema.default('en'),
  timeZone: TimeZoneSchema.default('UTC'),
  status: AccountStatusRecordSchema,
  acceptedTermsVersion: TermsVersionSchema.nullable().default(null),
  acceptedPrivacyPolicyVersion: TermsVersionSchema.nullable().default(null),
  sharingStatus: SharingStatusSchema.default('SHARING'),
  sharingPausedUntil: IsoDateTimeSchema.nullable().default(null),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  scheduledPurgeAt: IsoDateTimeSchema.nullable().default(null),
});
export type UserRecord = z.infer<typeof UserRecordSchema>;

export type ProfilePatch = {
  readonly displayName?: string;
  readonly avatarUrl?: string | null;
  readonly locale?: string;
  readonly timeZone?: string;
};

export interface AccountsRepository extends UserAccountRepository {
  getUser(userId: UserId): Promise<UserRecord | null>;
  updateProfile(input: {
    userId: UserId;
    patch: ProfilePatch;
    now: Date;
  }): Promise<UserRecord | null>;
  setSharing(input: {
    userId: UserId;
    sharingStatus: SharingStatus;
    pausedUntil: string | null;
    now: Date;
  }): Promise<void>;
  markPendingDeletion(input: {
    userId: UserId;
    scheduledPurgeAt: string;
    now: Date;
  }): Promise<'MARKED' | 'ALREADY_PENDING'>;
  cancelDeletion(input: { userId: UserId; now: Date }): Promise<'CANCELLED' | 'NOT_PENDING'>;
}

export function createAccountsRepository(
  client: DocumentClient,
  tableName: string,
): AccountsRepository {
  async function readUser(userId: UserId): Promise<UserRecord | null> {
    // Consistent: a profile update immediately followed by a read is the most
    // common client sequence, and an eventually-consistent answer there looks
    // like a lost write.
    const result = await client.get({
      TableName: tableName,
      Key: { userId },
      ConsistentRead: true,
    });
    return parseUser(result.Item);
  }

  return {
    getUser: readUser,

    async getUserAccount(input: { userId: UserId }): Promise<UserAccountRecord | null> {
      const user = await readUser(input.userId);
      return user === null ? null : { userId: user.userId, status: user.status };
    },

    async updateProfile(input): Promise<UserRecord | null> {
      const expression = buildSetExpression({
        displayName: input.patch.displayName,
        avatarUrl: input.patch.avatarUrl,
        locale: input.patch.locale,
        timeZone: input.patch.timeZone,
        updatedAt: input.now.toISOString(),
      });
      if (expression === null) {
        return readUser(input.userId);
      }

      try {
        const result = await client.update({
          TableName: tableName,
          Key: { userId: input.userId },
          UpdateExpression: expression.UpdateExpression,
          ConditionExpression: 'attribute_exists(userId)',
          ExpressionAttributeNames: expression.ExpressionAttributeNames,
          ExpressionAttributeValues: expression.ExpressionAttributeValues,
          ReturnValues: 'ALL_NEW',
        });
        return parseUser(result.Attributes);
      } catch (error) {
        if (isConditionalCheckFailed(error)) {
          return null;
        }
        throw error;
      }
    },

    async setSharing(input): Promise<void> {
      await client.update({
        TableName: tableName,
        Key: { userId: input.userId },
        UpdateExpression: 'SET #s = :s, #p = :p, #u = :u',
        ConditionExpression: 'attribute_exists(userId)',
        ExpressionAttributeNames: {
          '#s': 'sharingStatus',
          '#p': 'sharingPausedUntil',
          '#u': 'updatedAt',
        },
        ExpressionAttributeValues: {
          ':s': input.sharingStatus,
          ':p': input.pausedUntil,
          ':u': input.now.toISOString(),
        },
      });
    },

    async markPendingDeletion(input): Promise<'MARKED' | 'ALREADY_PENDING'> {
      try {
        await client.update({
          TableName: tableName,
          Key: { userId: input.userId },
          UpdateExpression: 'SET #st = :pending, #sp = :purge, #u = :u',
          // Only an ACTIVE account can be scheduled, so a replayed request never
          // moves the purge deadline further out.
          ConditionExpression: 'attribute_exists(userId) AND #st = :active',
          ExpressionAttributeNames: {
            '#st': 'status',
            '#sp': 'scheduledPurgeAt',
            '#u': 'updatedAt',
          },
          ExpressionAttributeValues: {
            ':pending': 'PENDING_DELETION',
            ':active': 'ACTIVE',
            ':purge': input.scheduledPurgeAt,
            ':u': input.now.toISOString(),
          },
        });
        return 'MARKED';
      } catch (error) {
        if (isConditionalCheckFailed(error)) {
          return 'ALREADY_PENDING';
        }
        throw error;
      }
    },

    async cancelDeletion(input): Promise<'CANCELLED' | 'NOT_PENDING'> {
      try {
        await client.update({
          TableName: tableName,
          Key: { userId: input.userId },
          UpdateExpression: 'SET #st = :active, #sp = :null, #u = :u',
          ConditionExpression: '#st = :pending',
          ExpressionAttributeNames: {
            '#st': 'status',
            '#sp': 'scheduledPurgeAt',
            '#u': 'updatedAt',
          },
          ExpressionAttributeValues: {
            ':active': 'ACTIVE',
            ':pending': 'PENDING_DELETION',
            ':null': null,
            ':u': input.now.toISOString(),
          },
        });
        return 'CANCELLED';
      } catch (error) {
        if (isConditionalCheckFailed(error)) {
          return 'NOT_PENDING';
        }
        throw error;
      }
    },
  };
}

/**
 * A row that no longer matches the record schema is treated as unreadable
 * rather than coerced: serving a half-parsed account is how a stale field ends
 * up authorising something.
 */
function parseUser(item: Item | undefined): UserRecord | null {
  if (item === undefined) {
    return null;
  }
  const parsed = UserRecordSchema.safeParse(item);
  if (!parsed.success) {
    throw new AppError('INTERNAL_ERROR', 'The account record could not be read.');
  }
  return parsed.data;
}
