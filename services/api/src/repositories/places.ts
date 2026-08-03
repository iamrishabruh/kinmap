import { z } from 'zod';

import { AppError, SavedPlaceSchema, type FamilyId, type PlaceId } from '@family/contracts';

import { isConditionalCheckFailed, type DocumentClient, type Item } from './document-client.js';
import { buildSetExpression } from './expressions.js';

/**
 * The SavedPlaces table: partitioned by `familyId`, sorted by `placeId`.
 *
 * A saved place is family-scoped data authored by a member rather than an
 * observation of a person, so it legitimately carries a coordinate — but it is
 * still a coordinate, and spec §20 admits exactly one way to write one down.
 * The row carries the centre as the contract defines it, and nothing in this
 * module can produce a plaintext position. Revealing one is a separate,
 * deliberate step a caller has to ask the cipher for.
 *
 * `readOnly` is written by the subscription worker, never here: a downgrade
 * freezes the places over the new allowance instead of deleting them. The
 * condition on `update` enforces that server-side, so a frozen place cannot be
 * edited by a caller that skipped the check — while `remove` deliberately
 * carries no such condition, because deleting one is how a downgraded family
 * gets back under its cap.
 */

/** Payload layout of a stored place, recorded so a later change is detectable. */
export const PLACE_RECORD_SCHEMA_VERSION = 1;

/** Field shapes come from the contract; nothing about a place is re-typed here. */
const PlaceShape = SavedPlaceSchema.shape;

export const SavedPlaceRecordSchema = z.object({
  familyId: PlaceShape.familyId,
  placeId: PlaceShape.placeId,
  name: PlaceShape.name,
  category: PlaceShape.category,
  /**
   * The centre, as the contract defines it.
   *
   * A saved place is stored in plaintext, and that is deliberate rather than an
   * oversight: it is a family-authored anchor ("School", "Grandma's"), not an
   * observation of where a person is. `SavedPlaceSchema` in @family/contracts is
   * the canonical shape, and two deployed readers parse it directly —
   * geofence-worker skips any row that fails to match, which would mean a place
   * that produces no arrival alerts and reports nothing, and location-query
   * drops it from the nearby-place annotation.
   *
   * Sealing this row would therefore not be a stricter version of the same
   * design; it would silently disable geofencing for every place created
   * through this API. What must never be stored in plaintext is an observed
   * position, and none is stored here.
   */
  latitude: PlaceShape.latitude,
  longitude: PlaceShape.longitude,
  radiusMeters: PlaceShape.radiusMeters,
  notifyOnArrival: PlaceShape.notifyOnArrival,
  notifyOnDeparture: PlaceShape.notifyOnDeparture,
  /** Frozen by a downgrade: readable and deletable, but not editable. */
  readOnly: z.boolean().default(false),
  createdBy: PlaceShape.createdBy,
  createdAt: PlaceShape.createdAt,
  updatedAt: PlaceShape.updatedAt,
  schemaVersion: PlaceShape.schemaVersion,
});
export type SavedPlaceRecord = z.infer<typeof SavedPlaceRecordSchema>;

export type PlacePatch = {
  readonly name?: string;
  readonly category?: SavedPlaceRecord['category'];
  readonly latitude?: number;
  readonly longitude?: number;
  readonly radiusMeters?: number;
  readonly notifyOnArrival?: boolean;
  readonly notifyOnDeparture?: boolean;
};

export interface PlacesRepository {
  get(input: { familyId: FamilyId; placeId: PlaceId }): Promise<SavedPlaceRecord | null>;
  /** Every place in one family. The plan allowance caps this at a few hundred. */
  listForFamily(familyId: FamilyId): Promise<SavedPlaceRecord[]>;
  create(record: SavedPlaceRecord): Promise<void>;
  /** Resolves null when the place is gone or has been frozen by a downgrade. */
  update(input: {
    familyId: FamilyId;
    placeId: PlaceId;
    patch: PlacePatch;
    now: Date;
  }): Promise<SavedPlaceRecord | null>;
  /** False when the place was already gone, which is not an error. */
  remove(input: { familyId: FamilyId; placeId: PlaceId }): Promise<boolean>;
}

export function createPlacesRepository(
  client: DocumentClient,
  tableName: string,
): PlacesRepository {
  async function read(familyId: FamilyId, placeId: PlaceId): Promise<SavedPlaceRecord | null> {
    const result = await client.get({
      TableName: tableName,
      Key: { familyId, placeId },
      // A place drives a geofence on every member's device, so a read that is
      // one replica behind would keep alerting on a centre already moved.
      ConsistentRead: true,
    });
    return result.Item === undefined ? null : parsePlace(result.Item);
  }

  return {
    get: (input) => read(input.familyId, input.placeId),

    async listForFamily(familyId): Promise<SavedPlaceRecord[]> {
      const records: SavedPlaceRecord[] = [];
      let cursor: Item | undefined;
      do {
        const page = await client.query({
          TableName: tableName,
          KeyConditionExpression: '#f = :f',
          ExpressionAttributeNames: { '#f': 'familyId' },
          ExpressionAttributeValues: { ':f': familyId },
          ExclusiveStartKey: cursor,
        });
        for (const item of page.Items ?? []) {
          records.push(parsePlace(item));
        }
        cursor = page.LastEvaluatedKey;
      } while (cursor !== undefined);
      return records;
    },

    async create(record): Promise<void> {
      try {
        await client.put({
          TableName: tableName,
          Item: { ...record },
          // A create never overwrites. The id is server-minted, so this fires
          // only on a genuine collision — and a silent overwrite would destroy
          // a family's place without anybody asking for it.
          ConditionExpression: 'attribute_not_exists(placeId)',
        });
      } catch (error) {
        if (isConditionalCheckFailed(error)) {
          throw new AppError('CONFLICT', 'That place already exists.');
        }
        throw error;
      }
    },

    async update(input): Promise<SavedPlaceRecord | null> {
      const expression = buildSetExpression({
        name: input.patch.name,
        category: input.patch.category,
        latitude: input.patch.latitude,
        longitude: input.patch.longitude,
        radiusMeters: input.patch.radiusMeters,
        notifyOnArrival: input.patch.notifyOnArrival,
        notifyOnDeparture: input.patch.notifyOnDeparture,
        updatedAt: input.now.toISOString(),
      });
      if (expression === null) {
        // Unreachable: `updatedAt` is always part of the patch.
        return read(input.familyId, input.placeId);
      }

      try {
        const result = await client.update({
          TableName: tableName,
          Key: { familyId: input.familyId, placeId: input.placeId },
          UpdateExpression: expression.UpdateExpression,
          // A place frozen by a downgrade may not quietly edit itself back into
          // service. Rows written before the flag existed have no attribute at
          // all, which is not the same as being frozen.
          ConditionExpression:
            'attribute_exists(placeId) AND (attribute_not_exists(#readOnly) OR #readOnly = :false)',
          ExpressionAttributeNames: {
            ...expression.ExpressionAttributeNames,
            '#readOnly': 'readOnly',
          },
          ExpressionAttributeValues: {
            ...(expression.ExpressionAttributeValues ?? {}),
            ':false': false,
          },
          ReturnValues: 'ALL_NEW',
        });
        return result.Attributes === undefined ? null : parsePlace(result.Attributes);
      } catch (error) {
        if (isConditionalCheckFailed(error)) {
          return null;
        }
        throw error;
      }
    },

    async remove(input): Promise<boolean> {
      try {
        await client.delete({
          TableName: tableName,
          Key: { familyId: input.familyId, placeId: input.placeId },
          ConditionExpression: 'attribute_exists(placeId)',
        });
        return true;
      } catch (error) {
        if (isConditionalCheckFailed(error)) {
          return false;
        }
        throw error;
      }
    },
  };
}

function parsePlace(item: Item): SavedPlaceRecord {
  const parsed = SavedPlaceRecordSchema.safeParse(item);
  if (!parsed.success) {
    // The issues are dropped rather than attached: on this record they would
    // name the fields of a coordinate payload.
    throw new AppError('INTERNAL_ERROR', 'A saved place record could not be read.');
  }
  return parsed.data;
}
