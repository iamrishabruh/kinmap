import {
  SavedPlaceSchema,
  type FamilyId,
  type LocationEvent,
  type PlaceId,
  type SavedPlace,
  type UserId,
} from '@family/contracts';

import type { ApiClient } from './client.js';
import {
  CurrentLocationsResponseSchema,
  FamilyResponseSchema,
  LocationBatchResponseSchema,
  LocationHistoryResponseSchema,
  RegisterDeviceResponseSchema,
  SavedPlaceListResponseSchema,
  SharingStateResponseSchema,
  SubscriptionResponseSchema,
  type CreateSavedPlaceRequest,
  type CurrentLocationsResponse,
  type FamilyResponse,
  type HistoryQuery,
  type LocationBatchResponse,
  type LocationHistoryResponse,
  type RegisterDeviceRequest,
  type RegisterDeviceResponse,
  type SharingStateResponse,
  type SubscriptionResponse,
  type UpdateSavedPlaceRequest,
} from './wire.js';

/**
 * Feature-shaped wrappers over `ApiClient`.
 *
 * Each one names a route template, supplies the response schema, and returns a
 * contract type. Nothing here decides authorisation — the server does, and a
 * denial always arrives as an opaque FORBIDDEN (spec §34).
 */

export type RequestOptions = {
  signal?: AbortSignal;
  /** Supply to make a mutation idempotent across an app restart. */
  idempotencyKey?: string;
  timeoutMs?: number;
};

export function createLocationsResource(client: ApiClient) {
  return {
    /** Uploads a queued batch. Safe to retry: the batch carries stable ids. */
    uploadBatch(
      deviceId: string,
      events: LocationEvent[],
      options: RequestOptions = {},
    ): Promise<LocationBatchResponse> {
      return client.post({
        path: '/v1/locations/batch',
        body: { deviceId, events },
        schema: LocationBatchResponseSchema,
        ...options,
      });
    },

    /** Latest position for every member the caller is authorised to see. */
    current(familyId: FamilyId, options: RequestOptions = {}): Promise<CurrentLocationsResponse> {
      return client.get({
        path: '/v1/families/{familyId}/locations/current',
        params: { familyId },
        schema: CurrentLocationsResponseSchema,
        ...options,
      });
    },

    history(
      familyId: FamilyId,
      userId: UserId,
      query: HistoryQuery,
      options: RequestOptions = {},
    ): Promise<LocationHistoryResponse> {
      return client.get({
        path: '/v1/families/{familyId}/members/{userId}/locations/history',
        params: { familyId, userId },
        query: { ...query },
        schema: LocationHistoryResponseSchema,
        ...options,
      });
    },

    /** Erases the caller's own history. Irreversible by design (spec §18). */
    deleteOwnHistory(options: RequestOptions = {}): Promise<void> {
      return client.delete<void>({
        path: '/v1/locations/history',
        expectNoContent: true,
        ...options,
      });
    },
  };
}

export function createPlacesResource(client: ApiClient) {
  return {
    async list(familyId: FamilyId, options: RequestOptions = {}): Promise<SavedPlace[]> {
      const response = await client.get({
        path: '/v1/families/{familyId}/places',
        params: { familyId },
        schema: SavedPlaceListResponseSchema,
        ...options,
      });
      return response.places;
    },

    create(
      familyId: FamilyId,
      place: CreateSavedPlaceRequest,
      options: RequestOptions = {},
    ): Promise<SavedPlace> {
      return client.post({
        path: '/v1/families/{familyId}/places',
        params: { familyId },
        body: place,
        schema: SavedPlaceSchema,
        ...options,
      });
    },

    update(
      familyId: FamilyId,
      placeId: PlaceId,
      changes: UpdateSavedPlaceRequest,
      options: RequestOptions = {},
    ): Promise<SavedPlace> {
      return client.patch({
        path: '/v1/families/{familyId}/places/{placeId}',
        params: { familyId, placeId },
        body: changes,
        schema: SavedPlaceSchema,
        ...options,
      });
    },

    remove(familyId: FamilyId, placeId: PlaceId, options: RequestOptions = {}): Promise<void> {
      return client.delete<void>({
        path: '/v1/families/{familyId}/places/{placeId}',
        params: { familyId, placeId },
        expectNoContent: true,
        ...options,
      });
    },
  };
}

export function createSharingResource(client: ApiClient) {
  return {
    status(familyId: FamilyId, options: RequestOptions = {}): Promise<SharingStateResponse> {
      return client.get({
        path: '/v1/families/{familyId}/sharing',
        params: { familyId },
        schema: SharingStateResponseSchema,
        ...options,
      });
    },

    /** Pausing is always allowed and always immediate — it is a consent control. */
    pause(
      familyId: FamilyId,
      durationMinutes: number | null,
      options: RequestOptions = {},
    ): Promise<SharingStateResponse> {
      return client.post({
        path: '/v1/families/{familyId}/sharing/pause',
        params: { familyId },
        body: { durationMinutes },
        schema: SharingStateResponseSchema,
        ...options,
      });
    },

    resume(familyId: FamilyId, options: RequestOptions = {}): Promise<SharingStateResponse> {
      return client.post({
        path: '/v1/families/{familyId}/sharing/resume',
        params: { familyId },
        schema: SharingStateResponseSchema,
        ...options,
      });
    },
  };
}

export function createFamilyResource(client: ApiClient) {
  return {
    get(familyId: FamilyId, options: RequestOptions = {}): Promise<FamilyResponse> {
      return client.get({
        path: '/v1/families/{familyId}',
        params: { familyId },
        schema: FamilyResponseSchema,
        ...options,
      });
    },

    removeMember(familyId: FamilyId, userId: UserId, options: RequestOptions = {}): Promise<void> {
      return client.delete<void>({
        path: '/v1/families/{familyId}/members/{userId}',
        params: { familyId, userId },
        expectNoContent: true,
        ...options,
      });
    },

    leave(familyId: FamilyId, options: RequestOptions = {}): Promise<void> {
      return client.post<void>({
        path: '/v1/families/{familyId}/leave',
        params: { familyId },
        expectNoContent: true,
        ...options,
      });
    },
  };
}

export function createDevicesResource(client: ApiClient) {
  return {
    register(
      device: RegisterDeviceRequest,
      options: RequestOptions = {},
    ): Promise<RegisterDeviceResponse> {
      return client.post({
        path: '/v1/devices',
        body: device,
        schema: RegisterDeviceResponseSchema,
        ...options,
      });
    },

    revoke(deviceId: string, options: RequestOptions = {}): Promise<void> {
      return client.delete<void>({
        path: '/v1/devices/{deviceId}',
        params: { deviceId },
        expectNoContent: true,
        ...options,
      });
    },
  };
}

export function createSubscriptionResource(client: ApiClient) {
  return {
    get(options: RequestOptions = {}): Promise<SubscriptionResponse> {
      return client.get({
        path: '/v1/subscription',
        schema: SubscriptionResponseSchema,
        ...options,
      });
    },
  };
}

export type FamilyApi = {
  client: ApiClient;
  locations: ReturnType<typeof createLocationsResource>;
  places: ReturnType<typeof createPlacesResource>;
  sharing: ReturnType<typeof createSharingResource>;
  family: ReturnType<typeof createFamilyResource>;
  devices: ReturnType<typeof createDevicesResource>;
  subscription: ReturnType<typeof createSubscriptionResource>;
};

/** Bundles every resource over one transport. */
export function createFamilyApi(client: ApiClient): FamilyApi {
  return {
    client,
    locations: createLocationsResource(client),
    places: createPlacesResource(client),
    sharing: createSharingResource(client),
    family: createFamilyResource(client),
    devices: createDevicesResource(client),
    subscription: createSubscriptionResource(client),
  };
}
