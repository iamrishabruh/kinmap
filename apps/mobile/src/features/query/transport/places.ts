import * as Crypto from 'expo-crypto';

import { AppError, type PlaceId, type SavedPlace } from '@family/contracts';
import {
  CreatePlaceResponseSchema,
  DeletePlaceResponseSchema,
  ListPlacesResponseSchema,
  UpdatePlaceResponseSchema,
  type CreatePlaceRequest,
  type UpdatePlaceRequest,
} from '@family/schemas';

import type { FamilyApi } from '@/features/query/api';
import type { CreatePlaceInput, UpdatePlaceInput } from '@/features/query/types';
import { request } from '@/lib/api';

/**
 * Saved places over the deployed route table.
 *
 *   GET    /v1/places?familyId=…
 *   POST   /v1/places
 *   PATCH  /v1/places/{placeId}
 *   DELETE /v1/places/{placeId}
 *
 * ---------------------------------------------------------------------------
 * THE CENTRE IS PLAINTEXT BY CONTRACT
 * ---------------------------------------------------------------------------
 * A saved place is family-authored data — somewhere the family chose and named —
 * not an observation of where a person is. `SavedPlaceSchema` in
 * @family/contracts is the canonical shape, and geofence-worker and
 * location-query both parse that shape directly. So the centre travels exactly
 * as the contract defines it: not sealed, not reshaped, not rounded. Rounding
 * here would silently move every fence and cost somebody an arrival alert.
 *
 * What is still true is that the coordinate never reaches an observer. Nothing
 * in this module logs, and nothing puts a latitude in a path or a query string:
 * the only identifiers on the wire are ids the server issued.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE SERVER OWNS
 * ---------------------------------------------------------------------------
 * `{placeId}` carries no family. The API resolves a place by walking the
 * caller's own active memberships, so "no such place" and "not your family"
 * leave through one opaque denial. That is why the update and delete calls send
 * no `familyId` — supplying one would be asking the server to trust a
 * client-named scope for an authorisation decision, and `UpdatePlaceRequest` is
 * a strict object that rejects the key outright.
 */

/**
 * Opaque, non-guessable idempotency key: randomness only, never user data, so
 * the header cannot carry anything about the place being written.
 */
function newIdempotencyKey(): string {
  return Crypto.randomUUID();
}

function placePath(placeId: PlaceId): string {
  return `/v1/places/${encodeURIComponent(placeId)}`;
}

export type PlacesApi = Pick<
  FamilyApi,
  'listPlaces' | 'getPlace' | 'createPlace' | 'updatePlace' | 'deletePlace'
>;

export const placesApi: PlacesApi = {
  async listPlaces(input, signal) {
    const response = await request({
      method: 'GET',
      path: '/v1/places',
      query: { familyId: input.familyId },
      schema: ListPlacesResponseSchema,
      signal,
    });
    return response.places;
  },

  /**
   * There is no `GET /v1/places/{placeId}` in the deployed route table, so a
   * single place is read out of the family's list rather than through a route
   * that does not exist. The list is bounded by `maxSavedPlaces`, and React
   * Query already holds it for the places screen, so this costs one small read
   * rather than a round trip per marker.
   *
   * A missing id is reported as NOT_FOUND — the same answer the API gives for a
   * place in a family the caller does not belong to, so this cannot be used to
   * tell the two apart either.
   */
  async getPlace(input, signal) {
    const response = await request({
      method: 'GET',
      path: '/v1/places',
      query: { familyId: input.familyId },
      schema: ListPlacesResponseSchema,
      signal,
    });

    const place = response.places.find((candidate) => candidate.placeId === input.placeId);
    if (place === undefined) {
      throw new AppError('NOT_FOUND', 'That saved place is no longer available.');
    }
    return place;
  },

  async createPlace(input: CreatePlaceInput): Promise<SavedPlace> {
    // Assembled field by field so nothing a caller happens to be carrying rides
    // along into a strict request body.
    const body: CreatePlaceRequest = {
      familyId: input.familyId,
      name: input.name,
      category: input.category,
      latitude: input.latitude,
      longitude: input.longitude,
      radiusMeters: input.radiusMeters,
      notifyOnArrival: input.notifyOnArrival,
      notifyOnDeparture: input.notifyOnDeparture,
    };

    const response = await request({
      method: 'POST',
      path: '/v1/places',
      body,
      schema: CreatePlaceResponseSchema,
      // A retried create must not leave a family with two copies of one anchor,
      // and two anchors mean duplicate arrival alerts on every device.
      idempotencyKey: newIdempotencyKey(),
    });
    return response.place;
  },

  async updatePlace(input: UpdatePlaceInput): Promise<SavedPlace> {
    // Only the fields the caller actually set. An explicit `undefined` would be
    // dropped by JSON serialisation anyway, but building the patch this way
    // keeps "not mentioned" distinct from "cleared" without relying on that.
    const patch: UpdatePlaceRequest = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.category !== undefined) patch.category = input.category;
    if (input.latitude !== undefined) patch.latitude = input.latitude;
    if (input.longitude !== undefined) patch.longitude = input.longitude;
    if (input.radiusMeters !== undefined) patch.radiusMeters = input.radiusMeters;
    if (input.notifyOnArrival !== undefined) patch.notifyOnArrival = input.notifyOnArrival;
    if (input.notifyOnDeparture !== undefined) patch.notifyOnDeparture = input.notifyOnDeparture;

    const response = await request({
      method: 'PATCH',
      path: placePath(input.placeId),
      body: patch,
      schema: UpdatePlaceResponseSchema,
      idempotencyKey: newIdempotencyKey(),
    });
    return response.place;
  },

  async deletePlace(input): Promise<void> {
    // Parsed and discarded: the interface returns void, but an unvalidated body
    // must never be the thing that decides a place is gone. The response also
    // names the geofences devices should unregister; that belongs to the
    // location feature, which re-reads the family's places after the
    // invalidation the caller performs on success.
    await request({
      method: 'DELETE',
      path: placePath(input.placeId),
      schema: DeletePlaceResponseSchema,
      idempotencyKey: newIdempotencyKey(),
    });
  },
};

/** Factory form, for composition alongside the other transport modules. */
export function createPlacesApi(): PlacesApi {
  return placesApi;
}
