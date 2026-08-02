import { z } from 'zod';

import type { FamilyMembershipRecord, FamilyMembershipRepository } from '@family/auth';
import {
  AppError,
  FamilyIdSchema,
  FamilyRoleSchema,
  MembershipStatusSchema,
  SharingStatusSchema,
  UserIdSchema,
  type FamilyId,
  type MembershipStatus,
  type SharingStatus,
  type UserId,
} from '@family/contracts';
import { IsoDateTimeSchema } from '@family/schemas';

import { type DocumentClient, type Item } from './document-client.js';

/**
 * FamilyMemberships is the authorisation source of truth (spec §18): every
 * sensitive read in the platform is decided against a row in this table, and
 * nothing about a requester's claims is trusted.
 *
 * Consequences that shape this module:
 *
 *  - Sharing state is written *here*, on the membership row, not only on the
 *    user's profile. The checker reads one row; if a pause lived anywhere else
 *    it would not be visible to the very next read.
 *  - `visibleToUserIds` / `hiddenFromUserIds` belong to the *target*. Nothing in
 *    this service lets a requester edit another member's visibility, with the
 *    single exception of a mutual block, which is symmetric by construction.
 */

export const PausedScopeSchema = z.enum(['GLOBAL', 'FAMILY']);
export type PausedScope = z.infer<typeof PausedScopeSchema>;

export const MembershipRecordSchema = z.object({
  familyId: FamilyIdSchema,
  userId: UserIdSchema,
  role: FamilyRoleSchema,
  status: MembershipStatusSchema,
  sharingStatus: SharingStatusSchema.default('SHARING'),
  /** `null` means "every active member of this family". */
  visibleToUserIds: z.array(UserIdSchema).nullable().default(null),
  hiddenFromUserIds: z.array(UserIdSchema).default([]),
  pausedUntil: IsoDateTimeSchema.nullable().default(null),
  /** Which switch caused the current pause, so a global resume can be precise. */
  pausedScope: PausedScopeSchema.nullable().default(null),
  sharingChangedAt: IsoDateTimeSchema,
  joinedAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type MembershipRecord = z.infer<typeof MembershipRecordSchema>;

export const FamilyRecordSchema = z.object({
  familyId: FamilyIdSchema,
  name: z.string().min(1).max(80),
  ownerUserId: UserIdSchema,
  createdAt: IsoDateTimeSchema,
});
export type FamilyRecord = z.infer<typeof FamilyRecordSchema>;

export type SharingWrite = {
  readonly familyId: FamilyId;
  readonly userId: UserId;
  readonly sharingStatus: SharingStatus;
  readonly pausedUntil: string | null;
  readonly pausedScope: PausedScope | null;
};

export interface MembershipsRepository extends FamilyMembershipRepository {
  /** Every membership row for one person, across all their families. */
  listForUser(userId: UserId): Promise<MembershipRecord[]>;
  /** Every row in one family. Used to compute who loses sight of a member. */
  listFamilyMembers(familyId: FamilyId): Promise<MembershipRecord[]>;
  getMembershipRecord(input: {
    familyId: FamilyId;
    userId: UserId;
  }): Promise<MembershipRecord | null>;
  /** Applies one sharing decision per membership row. */
  writeSharing(input: { writes: readonly SharingWrite[]; now: Date }): Promise<void>;
  setHiddenFromUserIds(input: {
    familyId: FamilyId;
    userId: UserId;
    hiddenFromUserIds: readonly UserId[];
    now: Date;
  }): Promise<void>;
  setStatus(input: {
    familyId: FamilyId;
    userId: UserId;
    status: MembershipStatus;
    now: Date;
  }): Promise<void>;
}

export interface FamiliesRepository {
  getFamily(familyId: FamilyId): Promise<FamilyRecord | null>;
  /** Names for a handful of families; the plan cap is 3, so N gets is correct. */
  getFamilyNames(familyIds: readonly FamilyId[]): Promise<Map<FamilyId, string>>;
}

export function createMembershipsRepository(
  client: DocumentClient,
  tableName: string,
): MembershipsRepository {
  async function queryAll(input: {
    IndexName?: string;
    KeyConditionExpression: string;
    ExpressionAttributeNames: Record<string, string>;
    ExpressionAttributeValues: Record<string, unknown>;
  }): Promise<MembershipRecord[]> {
    const records: MembershipRecord[] = [];
    let cursor: Item | undefined;
    do {
      const page = await client.query({
        TableName: tableName,
        IndexName: input.IndexName,
        KeyConditionExpression: input.KeyConditionExpression,
        ExpressionAttributeNames: input.ExpressionAttributeNames,
        ExpressionAttributeValues: input.ExpressionAttributeValues,
        ExclusiveStartKey: cursor,
      });
      for (const item of page.Items ?? []) {
        records.push(parseMembership(item));
      }
      cursor = page.LastEvaluatedKey;
    } while (cursor !== undefined);
    return records;
  }

  async function read(familyId: FamilyId, userId: UserId): Promise<MembershipRecord | null> {
    const result = await client.get({
      TableName: tableName,
      Key: { familyId, userId },
      // Authorization must never read a stale row: a member removed a second
      // ago has to be gone now, not on the next replica sync.
      ConsistentRead: true,
    });
    return result.Item === undefined ? null : parseMembership(result.Item);
  }

  return {
    async getMembership(input: {
      familyId: FamilyId;
      userId: UserId;
    }): Promise<FamilyMembershipRecord | null> {
      const record = await read(input.familyId, input.userId);
      return record === null ? null : toAuthMembership(record);
    },

    getMembershipRecord(input): Promise<MembershipRecord | null> {
      return read(input.familyId, input.userId);
    },

    listForUser(userId): Promise<MembershipRecord[]> {
      return queryAll({
        IndexName: 'byUser',
        KeyConditionExpression: '#u = :u',
        ExpressionAttributeNames: { '#u': 'userId' },
        ExpressionAttributeValues: { ':u': userId },
      });
    },

    listFamilyMembers(familyId): Promise<MembershipRecord[]> {
      return queryAll({
        KeyConditionExpression: '#f = :f',
        ExpressionAttributeNames: { '#f': 'familyId' },
        ExpressionAttributeValues: { ':f': familyId },
      });
    },

    async writeSharing(input): Promise<void> {
      const timestamp = input.now.toISOString();
      // Serial rather than transactional: a global pause can span more families
      // than a 100-item transaction allows, and a partially applied pause has
      // already made the user *less* visible, never more.
      for (const write of input.writes) {
        await client.update({
          TableName: tableName,
          Key: { familyId: write.familyId, userId: write.userId },
          UpdateExpression: 'SET #s = :s, #pu = :pu, #ps = :ps, #c = :c, #u = :u',
          ConditionExpression: 'attribute_exists(familyId) AND attribute_exists(userId)',
          ExpressionAttributeNames: {
            '#s': 'sharingStatus',
            '#pu': 'pausedUntil',
            '#ps': 'pausedScope',
            '#c': 'sharingChangedAt',
            '#u': 'updatedAt',
          },
          ExpressionAttributeValues: {
            ':s': write.sharingStatus,
            ':pu': write.pausedUntil,
            ':ps': write.pausedScope,
            ':c': timestamp,
            ':u': timestamp,
          },
        });
      }
    },

    async setHiddenFromUserIds(input): Promise<void> {
      const timestamp = input.now.toISOString();
      await client.update({
        TableName: tableName,
        Key: { familyId: input.familyId, userId: input.userId },
        UpdateExpression: 'SET #h = :h, #u = :u',
        ConditionExpression: 'attribute_exists(familyId) AND attribute_exists(userId)',
        ExpressionAttributeNames: { '#h': 'hiddenFromUserIds', '#u': 'updatedAt' },
        ExpressionAttributeValues: { ':h': [...input.hiddenFromUserIds], ':u': timestamp },
      });
    },

    async setStatus(input): Promise<void> {
      const timestamp = input.now.toISOString();
      await client.update({
        TableName: tableName,
        Key: { familyId: input.familyId, userId: input.userId },
        UpdateExpression: 'SET #s = :s, #u = :u',
        ConditionExpression: 'attribute_exists(familyId) AND attribute_exists(userId)',
        ExpressionAttributeNames: { '#s': 'status', '#u': 'updatedAt' },
        ExpressionAttributeValues: { ':s': input.status, ':u': timestamp },
      });
    },
  };
}

export function createFamiliesRepository(
  client: DocumentClient,
  tableName: string,
): FamiliesRepository {
  async function getFamily(familyId: FamilyId): Promise<FamilyRecord | null> {
    const result = await client.get({ TableName: tableName, Key: { familyId } });
    if (result.Item === undefined) {
      return null;
    }
    const parsed = FamilyRecordSchema.safeParse(result.Item);
    if (!parsed.success) {
      throw new AppError('INTERNAL_ERROR', 'The family record could not be read.');
    }
    return parsed.data;
  }

  return {
    getFamily,
    async getFamilyNames(familyIds): Promise<Map<FamilyId, string>> {
      const names = new Map<FamilyId, string>();
      for (const familyId of new Set(familyIds)) {
        const family = await getFamily(familyId);
        if (family !== null) {
          names.set(familyId, family.name);
        }
      }
      return names;
    },
  };
}

/** Projects the stored row onto the shape @family/auth authorises against. */
export function toAuthMembership(record: MembershipRecord): FamilyMembershipRecord {
  return {
    familyId: record.familyId,
    userId: record.userId,
    role: record.role,
    status: record.status,
    sharingStatus: record.sharingStatus,
    visibleToUserIds: record.visibleToUserIds,
    hiddenFromUserIds: record.hiddenFromUserIds,
  };
}

function parseMembership(item: Item): MembershipRecord {
  const parsed = MembershipRecordSchema.safeParse(item);
  if (!parsed.success) {
    // Fail closed. An unreadable membership row must never be treated as
    // "no restrictions"; it is an outage, not an allow.
    throw new AppError('INTERNAL_ERROR', 'A membership record could not be read.');
  }
  return parsed.data;
}
