import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

import {
  FamilyRoleSchema,
  PlanSchema,
  SubscriptionStatusSchema,
  type FamilyId,
  type PlaceId,
  type UserId,
} from '@family/contracts';
import { SubscriptionSourceSchema } from '@family/schemas';

import { StoreEnvironmentSchema } from './events.js';
import type {
  IdempotencyStore,
  InventoryReader,
  ReadOnlyMarker,
  SubscriptionStore,
} from './ports.js';
import type {
  EffectiveSubscription,
  InventoryMember,
  InventoryPlace,
  PlatformSubscription,
  ReadOnlyPlan,
  SubscriptionInventory,
  SubscriptionState,
} from './reconcile.js';

/** DynamoDB bindings for the subscription ports. */

export function createDocumentClient(client?: DynamoDBClient): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(client ?? new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true, convertClassInstanceToMap: false },
  });
}

type Attributes = Record<string, unknown>;

/**
 * Sentinel partition key for a transaction-id pointer row.
 *
 * Google Play notifications identify an account only by purchase token, and a
 * user with both an App Store and a Play subscription has two of them, which a
 * single-attribute GSI cannot index. A pointer row per transaction id keeps the
 * lookup a single strongly-consistent GetItem.
 */
export function transactionPointerKey(originalTransactionId: string): string {
  return `TXN#${originalTransactionId}`;
}

function readString(item: Attributes, key: string): string | null {
  const value = item[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function toPlatform(raw: unknown): PlatformSubscription | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const item = raw as Attributes;
  const source = SubscriptionSourceSchema.safeParse(item.source);
  const plan = PlanSchema.safeParse(item.plan);
  const status = SubscriptionStatusSchema.safeParse(item.status);
  const environment = StoreEnvironmentSchema.safeParse(item.environment);
  if (!source.success || !plan.success || !status.success || !environment.success) return null;

  return {
    source: source.data,
    plan: plan.data,
    status: status.data,
    productId: readString(item, 'productId'),
    originalTransactionId: readString(item, 'originalTransactionId'),
    expiresAt: readString(item, 'expiresAt'),
    gracePeriodEndsAt: readString(item, 'gracePeriodEndsAt'),
    willRenew: item.willRenew === true,
    environment: environment.data,
    lastEventId: readString(item, 'lastEventId'),
    lastEventAt: readString(item, 'lastEventAt'),
  };
}

function toState(item: Attributes): SubscriptionState | null {
  const userId = readString(item, 'userId');
  if (userId === null) return null;
  const rawPlatforms = Array.isArray(item.platforms) ? item.platforms : [];
  const platforms = rawPlatforms
    .map(toPlatform)
    .filter((platform): platform is PlatformSubscription => platform !== null);
  return {
    userId: userId as UserId,
    platforms,
    updatedAt: readString(item, 'updatedAt') ?? new Date(0).toISOString(),
  };
}

export class DynamoSubscriptionStore implements SubscriptionStore {
  constructor(
    private readonly documents: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async getByUser(input: { userId: UserId }): Promise<SubscriptionState | null> {
    const response = await this.documents.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { userId: input.userId },
        ConsistentRead: true,
      }),
    );
    const item = response.Item as Attributes | undefined;
    return item === undefined ? null : toState(item);
  }

  async findByOriginalTransactionId(input: {
    originalTransactionId: string;
  }): Promise<SubscriptionState | null> {
    const pointer = await this.documents.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { userId: transactionPointerKey(input.originalTransactionId) },
        ConsistentRead: true,
      }),
    );
    const pointerItem = pointer.Item as Attributes | undefined;
    const pointedUserId = pointerItem === undefined ? null : readString(pointerItem, 'ownerUserId');
    if (pointedUserId !== null) {
      return await this.getByUser({ userId: pointedUserId as UserId });
    }

    // Fall back to the index for records written before the pointer existed.
    const response = await this.documents.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: 'byOriginalTransactionId',
        KeyConditionExpression: '#originalTransactionId = :value',
        ExpressionAttributeNames: { '#originalTransactionId': 'originalTransactionId' },
        ExpressionAttributeValues: { ':value': input.originalTransactionId },
        Limit: 1,
      }),
    );
    const first = (response.Items ?? []).at(0) as Attributes | undefined;
    return first === undefined ? null : toState(first);
  }

  async save(input: { state: SubscriptionState; effective: EffectiveSubscription }): Promise<void> {
    const primary =
      input.state.platforms.find((platform) => platform.source === input.effective.source) ??
      input.state.platforms.at(0);

    await this.documents.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          userId: input.state.userId,
          platforms: input.state.platforms,
          updatedAt: input.state.updatedAt,
          // Denormalised effective view, re-derived on every write so a reader
          // never has to interpret the platform array itself.
          plan: input.effective.plan,
          tier: input.effective.tier,
          status: input.effective.status,
          source: input.effective.source,
          expiresAt: input.effective.expiresAt,
          gracePeriodEndsAt: input.effective.gracePeriodEndsAt,
          willRenew: input.effective.willRenew,
          entitlements: input.effective.entitlements,
          originalTransactionId: primary?.originalTransactionId ?? undefined,
          refreshedAt: new Date().toISOString(),
        },
      }),
    );

    for (const platform of input.state.platforms) {
      if (platform.originalTransactionId === null) continue;
      await this.documents.send(
        new PutCommand({
          TableName: this.tableName,
          Item: {
            userId: transactionPointerKey(platform.originalTransactionId),
            ownerUserId: input.state.userId,
            source: platform.source,
            updatedAt: input.state.updatedAt,
          },
        }),
      );
    }
  }
}

export class DynamoInventoryReader implements InventoryReader {
  constructor(
    private readonly documents: DynamoDBDocumentClient,
    private readonly tables: { memberships: string; savedPlaces: string },
  ) {}

  async load(input: { userId: UserId }): Promise<SubscriptionInventory> {
    const families = await this.listFamilies(input.userId);
    const places: InventoryPlace[] = [];
    const members: InventoryMember[] = [];

    for (const familyId of families) {
      places.push(...(await this.listPlaces(familyId)));
      members.push(...(await this.listMembers(familyId)));
    }

    return { places, members };
  }

  private async listFamilies(userId: UserId): Promise<FamilyId[]> {
    const response = await this.documents.send(
      new QueryCommand({
        TableName: this.tables.memberships,
        IndexName: 'byUser',
        KeyConditionExpression: '#userId = :userId',
        ExpressionAttributeNames: { '#userId': 'userId' },
        ExpressionAttributeValues: { ':userId': userId },
      }),
    );
    const families: FamilyId[] = [];
    for (const raw of response.Items ?? []) {
      const item = raw as Attributes;
      if (item.status !== 'ACTIVE') continue;
      const familyId = readString(item, 'familyId');
      if (familyId !== null) families.push(familyId as FamilyId);
    }
    return families;
  }

  private async listPlaces(familyId: FamilyId): Promise<InventoryPlace[]> {
    const response = await this.documents.send(
      new QueryCommand({
        TableName: this.tables.savedPlaces,
        KeyConditionExpression: '#familyId = :familyId',
        ExpressionAttributeNames: { '#familyId': 'familyId' },
        ExpressionAttributeValues: { ':familyId': familyId },
      }),
    );
    const places: InventoryPlace[] = [];
    for (const raw of response.Items ?? []) {
      const item = raw as Attributes;
      const placeId = readString(item, 'placeId');
      if (placeId === null) continue;
      places.push({
        placeId: placeId as PlaceId,
        familyId,
        createdAt: readString(item, 'createdAt') ?? new Date(0).toISOString(),
        readOnly: item.readOnly === true,
      });
    }
    return places;
  }

  private async listMembers(familyId: FamilyId): Promise<InventoryMember[]> {
    const response = await this.documents.send(
      new QueryCommand({
        TableName: this.tables.memberships,
        KeyConditionExpression: '#familyId = :familyId',
        ExpressionAttributeNames: { '#familyId': 'familyId' },
        ExpressionAttributeValues: { ':familyId': familyId },
      }),
    );
    const members: InventoryMember[] = [];
    for (const raw of response.Items ?? []) {
      const item = raw as Attributes;
      if (item.status !== 'ACTIVE') continue;
      const userId = readString(item, 'userId');
      const role = FamilyRoleSchema.safeParse(item.role);
      if (userId === null || !role.success) continue;
      members.push({
        familyId,
        userId: userId as UserId,
        role: role.data,
        joinedAt: readString(item, 'joinedAt') ?? new Date(0).toISOString(),
        readOnly: item.readOnly === true,
      });
    }
    return members;
  }
}

/**
 * Applies the read-only plan. Deliberately only ever flips a boolean: there is
 * no delete path in this class, so a bug here cannot destroy a family's data.
 */
export class DynamoReadOnlyMarker implements ReadOnlyMarker {
  constructor(
    private readonly documents: DynamoDBDocumentClient,
    private readonly tables: { memberships: string; savedPlaces: string },
  ) {}

  async apply(plan: ReadOnlyPlan): Promise<void> {
    for (const place of plan.placesToMarkReadOnly) {
      await this.setPlaceReadOnly(place.familyId, place.placeId, true);
    }
    for (const place of plan.placesToRestore) {
      await this.setPlaceReadOnly(place.familyId, place.placeId, false);
    }
    for (const member of plan.membersToMarkReadOnly) {
      await this.setMemberReadOnly(member.familyId, member.userId, true);
    }
    for (const member of plan.membersToRestore) {
      await this.setMemberReadOnly(member.familyId, member.userId, false);
    }
  }

  private async setPlaceReadOnly(
    familyId: FamilyId,
    placeId: PlaceId,
    readOnly: boolean,
  ): Promise<void> {
    await this.documents.send(
      new UpdateCommand({
        TableName: this.tables.savedPlaces,
        Key: { familyId, placeId },
        UpdateExpression: 'SET #readOnly = :readOnly',
        ExpressionAttributeNames: { '#readOnly': 'readOnly' },
        ExpressionAttributeValues: { ':readOnly': readOnly },
        ConditionExpression: 'attribute_exists(placeId)',
      }),
    );
  }

  private async setMemberReadOnly(
    familyId: FamilyId,
    userId: UserId,
    readOnly: boolean,
  ): Promise<void> {
    await this.documents.send(
      new UpdateCommand({
        TableName: this.tables.memberships,
        Key: { familyId, userId },
        UpdateExpression: 'SET #readOnly = :readOnly',
        ExpressionAttributeNames: { '#readOnly': 'readOnly' },
        ExpressionAttributeValues: { ':readOnly': readOnly },
        ConditionExpression: 'attribute_exists(userId)',
      }),
    );
  }
}

export class DynamoIdempotencyStore implements IdempotencyStore {
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
