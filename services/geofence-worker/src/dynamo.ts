import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';

import {
  MembershipStatusSchema,
  SavedPlaceSchema,
  SharingStatusSchema,
  type FamilyId,
  type PlaceId,
  type SavedPlace,
  type UserId,
} from '@family/contracts';

import type { GeofenceState } from './geofence.js';
import type {
  EvaluableMembership,
  GeofenceStateStore,
  MembershipReader,
  SavedPlaceReader,
} from './ports.js';

/**
 * DynamoDB bindings for the ports in `ports.js`.
 *
 * Clients are created at module scope by `handler.ts` and injected here so a
 * warm container reuses connections.
 */

export function createDocumentClient(client?: DynamoDBClient): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(client ?? new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true, convertClassInstanceToMap: false },
  });
}

type Attributes = Record<string, unknown>;

function readString(item: Attributes, key: string): string | null {
  const value = item[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readNumber(item: Attributes, key: string, fallback: number): number {
  const value = item[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function readBoolean(item: Attributes, key: string): boolean | null {
  const value = item[key];
  return typeof value === 'boolean' ? value : null;
}

export class DynamoMembershipReader implements MembershipReader {
  constructor(
    private readonly documents: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  /**
   * Server-side authorisation input: only ACTIVE memberships whose owner is
   * currently SHARING are returned. Everything else — paused, removed, blocked,
   * never enabled — yields no fences, and therefore no notifications.
   */
  async listEvaluableFamilies(input: { userId: UserId }): Promise<EvaluableMembership[]> {
    const evaluable: EvaluableMembership[] = [];
    let exclusiveStartKey: Attributes | undefined;

    do {
      const response = await this.documents.send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: 'byUser',
          KeyConditionExpression: '#userId = :userId',
          ExpressionAttributeNames: { '#userId': 'userId' },
          ExpressionAttributeValues: { ':userId': input.userId },
          ExclusiveStartKey: exclusiveStartKey,
        }),
      );

      for (const raw of response.Items ?? []) {
        const item = raw as Attributes;
        const familyId = readString(item, 'familyId');
        if (familyId === null) continue;

        const status = MembershipStatusSchema.safeParse(item.status);
        if (!status.success || status.data !== 'ACTIVE') continue;

        const sharing = SharingStatusSchema.safeParse(item.sharingStatus);
        if (!sharing.success || sharing.data !== 'SHARING') continue;

        evaluable.push({ familyId: familyId as FamilyId, userId: input.userId });
      }

      exclusiveStartKey = response.LastEvaluatedKey as Attributes | undefined;
    } while (exclusiveStartKey !== undefined);

    return evaluable;
  }
}

export class DynamoSavedPlaceReader implements SavedPlaceReader {
  constructor(
    private readonly documents: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async listPlaces(input: { familyId: FamilyId }): Promise<SavedPlace[]> {
    const places: SavedPlace[] = [];
    let exclusiveStartKey: Attributes | undefined;

    do {
      const response = await this.documents.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: '#familyId = :familyId',
          ExpressionAttributeNames: { '#familyId': 'familyId' },
          ExpressionAttributeValues: { ':familyId': input.familyId },
          ExclusiveStartKey: exclusiveStartKey,
        }),
      );

      for (const item of response.Items ?? []) {
        // A row that no longer matches the contract is skipped rather than
        // thrown on: one malformed place must not stop the whole family's
        // geofencing, and the parse failure carries no coordinate to report.
        const parsed = SavedPlaceSchema.safeParse(item);
        if (parsed.success) places.push(parsed.data);
      }

      exclusiveStartKey = response.LastEvaluatedKey as Attributes | undefined;
    } while (exclusiveStartKey !== undefined);

    return places;
  }
}

export class DynamoGeofenceStateStore implements GeofenceStateStore {
  constructor(
    private readonly documents: DynamoDBDocumentClient,
    private readonly tableName: string,
    private readonly ttlDays: number,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async get(input: { userId: UserId; placeId: PlaceId }): Promise<GeofenceState | null> {
    const response = await this.documents.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { userId: input.userId, placeId: input.placeId },
        ConsistentRead: true,
      }),
    );
    const item = response.Item as Attributes | undefined;
    if (item === undefined) return null;

    const inside = readBoolean(item, 'inside');
    const confirmedAt = readString(item, 'confirmedAt');
    if (inside === null || confirmedAt === null) return null;

    return {
      userId: input.userId,
      placeId: input.placeId,
      inside,
      confirmedAt,
      pendingInside: readBoolean(item, 'pendingInside'),
      pendingSince: readString(item, 'pendingSince'),
      lastEventId: readString(item, 'lastEventId'),
      lastCapturedAt: readString(item, 'lastCapturedAt'),
      version: readNumber(item, 'version', 0),
    };
  }

  async put(input: { state: GeofenceState; expectedVersion: number | null }): Promise<boolean> {
    const nextVersion = (input.expectedVersion ?? 0) + 1;
    const expiresAt =
      Math.floor(this.now().getTime() / 1000) + Math.round(this.ttlDays * 24 * 60 * 60);

    const condition =
      input.expectedVersion === null
        ? 'attribute_not_exists(#userId)'
        : '#version = :expectedVersion';

    try {
      await this.documents.send(
        new PutCommand({
          TableName: this.tableName,
          Item: {
            userId: input.state.userId,
            placeId: input.state.placeId,
            inside: input.state.inside,
            confirmedAt: input.state.confirmedAt,
            pendingInside: input.state.pendingInside,
            pendingSince: input.state.pendingSince,
            lastEventId: input.state.lastEventId,
            lastCapturedAt: input.state.lastCapturedAt,
            version: nextVersion,
            expiresAt,
          },
          ConditionExpression: condition,
          ExpressionAttributeNames:
            input.expectedVersion === null ? { '#userId': 'userId' } : { '#version': 'version' },
          ExpressionAttributeValues:
            input.expectedVersion === null
              ? undefined
              : { ':expectedVersion': input.expectedVersion },
        }),
      );
      return true;
    } catch (error) {
      if (isConditionalCheckFailure(error)) return false;
      throw error;
    }
  }
}

export function isConditionalCheckFailure(error: unknown): boolean {
  return error instanceof Error && error.name === 'ConditionalCheckFailedException';
}
