import { z } from 'zod';

import {
  FamilyIdSchema,
  LIMITS,
  PlaceIdSchema,
  SavedPlaceSchema,
  UserIdSchema,
} from '@family/contracts';

import { IsoDateTimeSchema, StrictSavedPlaceSchema } from './common.js';

/**
 * Saved place endpoints.
 *
 * `POST   /v1/places`
 * `GET    /v1/places`
 * `PATCH  /v1/places/{placeId}`
 * `DELETE /v1/places/{placeId}`
 *
 * A saved place is family-scoped data authored by a member, not an observation
 * of a person, so it legitimately carries a coordinate. It is still only
 * readable by an authorised member of the owning family.
 */

export const PlacePathSchema = z.strictObject({
  placeId: PlaceIdSchema,
});
export type PlacePath = z.infer<typeof PlacePathSchema>;

/** Fields a client may author. Shapes come from the contract, never re-typed. */
const PlaceWritableShape = SavedPlaceSchema.pick({
  name: true,
  category: true,
  latitude: true,
  longitude: true,
  radiusMeters: true,
  notifyOnArrival: true,
  notifyOnDeparture: true,
}).shape;

// ---------------------------------------------------------------------------
// POST /v1/places
// ---------------------------------------------------------------------------

export const CreatePlaceRequestSchema = z.strictObject({
  familyId: FamilyIdSchema,
  ...PlaceWritableShape,
});
export type CreatePlaceRequest = z.infer<typeof CreatePlaceRequestSchema>;

export const CreatePlaceResponseSchema = z.strictObject({
  place: StrictSavedPlaceSchema,
  /** Remaining headroom under the plan, so the UI can warn before the wall. */
  placeCount: z.number().int().nonnegative(),
  maxPlaces: z.number().int().positive().max(LIMITS.MAX_SAVED_PLACES),
});
export type CreatePlaceResponse = z.infer<typeof CreatePlaceResponseSchema>;

// ---------------------------------------------------------------------------
// GET /v1/places
// ---------------------------------------------------------------------------

export const ListPlacesQuerySchema = z.strictObject({
  familyId: FamilyIdSchema,
});
export type ListPlacesQuery = z.infer<typeof ListPlacesQuerySchema>;

export const ListPlacesResponseSchema = z.strictObject({
  familyId: FamilyIdSchema,
  places: z.array(StrictSavedPlaceSchema),
  placeCount: z.number().int().nonnegative(),
  maxPlaces: z.number().int().positive().max(LIMITS.MAX_SAVED_PLACES),
});
export type ListPlacesResponse = z.infer<typeof ListPlacesResponseSchema>;

// ---------------------------------------------------------------------------
// PATCH /v1/places/{placeId}
// ---------------------------------------------------------------------------

export const UpdatePlaceRequestSchema = z
  .strictObject({
    name: PlaceWritableShape.name.optional(),
    category: PlaceWritableShape.category.optional(),
    latitude: PlaceWritableShape.latitude.optional(),
    longitude: PlaceWritableShape.longitude.optional(),
    radiusMeters: PlaceWritableShape.radiusMeters.optional(),
    notifyOnArrival: PlaceWritableShape.notifyOnArrival.optional(),
    notifyOnDeparture: PlaceWritableShape.notifyOnDeparture.optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, {
    message: 'At least one field must be provided.',
  })
  .refine((patch) => (patch.latitude === undefined) === (patch.longitude === undefined), {
    message: 'Latitude and longitude must be changed together.',
    path: ['longitude'],
  });
export type UpdatePlaceRequest = z.infer<typeof UpdatePlaceRequestSchema>;

export const UpdatePlaceResponseSchema = z.strictObject({
  place: StrictSavedPlaceSchema,
});
export type UpdatePlaceResponse = z.infer<typeof UpdatePlaceResponseSchema>;

// ---------------------------------------------------------------------------
// DELETE /v1/places/{placeId}
// ---------------------------------------------------------------------------

export const DeletePlaceResponseSchema = z.strictObject({
  placeId: PlaceIdSchema,
  familyId: FamilyIdSchema,
  deletedAt: IsoDateTimeSchema,
  deletedByUserId: UserIdSchema,
  /** Geofences the devices must unregister. */
  unregisterGeofenceIds: z.array(PlaceIdSchema),
});
export type DeletePlaceResponse = z.infer<typeof DeletePlaceResponseSchema>;
