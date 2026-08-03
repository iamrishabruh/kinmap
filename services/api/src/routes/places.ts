import { resolveEntitlements } from '@family/auth';
import {
  AppError,
  opaqueAuthorizationError,
  type Entitlements,
  type FamilyId,
  type PlaceId,
} from '@family/contracts';
import {
  CreatePlaceRequestSchema,
  ListPlacesQuerySchema,
  PlacePathSchema,
  UpdatePlaceRequestSchema,
  type CreatePlaceResponse,
  type DeletePlaceResponse,
  type ListPlacesResponse,
  type StrictSavedPlace,
  type UpdatePlaceResponse,
} from '@family/schemas';

import { validateBody, validateParams, validateQuery } from '../middleware/validation.js';
import { PLACE_RECORD_SCHEMA_VERSION, type SavedPlaceRecord } from '../repositories/places.js';
import { defineRoute, type RegisteredRoute } from '../router.js';
import type { AnyRouteContext } from '../types.js';

import { requireAuth } from './shared.js';

/**
 * Saved place endpoints.
 *
 * A saved place is a geofence anchor: a name, a centre and a radius. The centre
 * is stored in plaintext, and that is the contract rather than a shortcut. A
 * place is family-authored data — somewhere the family chose and named — not an
 * observation of where a person is, and `SavedPlaceSchema` in @family/contracts
 * defines it that way. Two deployed readers parse that shape directly:
 * geofence-worker skips any row it cannot match, which would mean a place that
 * silently produces no arrival alerts, and location-query drops it from the
 * nearby-place annotation. Sealing the row here would not be a stricter version
 * of the same design; it would disable geofencing for every place this API
 * creates, and report nothing while doing it.
 *
 * What must never be written down in the clear is an observed position, and
 * none is written here. The centre still never reaches a log line, a metric
 * dimension, an error message or an audit row.
 *
 * Three properties matter more than the CRUD:
 *
 *  - `{placeId}` carries no family, so a place is located by walking the
 *    caller's own memberships. A place in a family they do not belong to is
 *    therefore never even looked up, and "no such place" and "not your family"
 *    leave through one opaque denial — this endpoint cannot be used to probe
 *    who is in which family.
 *  - The allowance is re-derived from the family's stored subscription row on
 *    every create. A plan, receipt or cached tier named by the client is not an
 *    input, and the number itself comes from ENTITLEMENTS rather than from here.
 *  - Nothing writes an audit row. That trail answers "who looked at me", and
 *    managing a family's own anchors is not an access to anybody's position;
 *    an audit row would also be the one plausible place a coordinate could be
 *    attached, so there is deliberately no shape here that could carry one.
 */

/** Places are family-scoped: one payer sets the allowance for the whole family. */
async function familyEntitlements(
  context: AnyRouteContext,
  familyId: FamilyId,
): Promise<Entitlements> {
  const subscription = await context.services.subscriptions.getSubscriptionForFamily({ familyId });
  return resolveEntitlements(subscription).entitlements;
}

/**
 * Establishes that the caller is currently in the family they named.
 *
 * A membership that is not ACTIVE — removed, left, blocked, still pending — is
 * refused exactly like a family the caller never belonged to.
 */
async function requireActiveMembership(
  context: AnyRouteContext,
  familyId: FamilyId,
): Promise<void> {
  const auth = requireAuth(context);
  const membership = await context.services.memberships.getMembershipRecord({
    familyId,
    userId: auth.userId,
  });
  if (membership === null || membership.status !== 'ACTIVE') {
    throw opaqueAuthorizationError(context.requestId);
  }
}

/**
 * Finds a place by id inside the families the caller actually belongs to.
 *
 * The fan-out is bounded by the number of families one person can be in, which
 * `maxFamilies` caps at a handful. Scoping the lookup this way is what makes
 * authorisation structural rather than a check somebody has to remember: a row
 * outside the caller's families is unreachable, not merely refused.
 */
async function findPlaceForCaller(
  context: AnyRouteContext,
  placeId: PlaceId,
): Promise<SavedPlaceRecord> {
  const auth = requireAuth(context);
  const memberships = await context.services.memberships.listForUser(auth.userId);
  for (const membership of memberships) {
    if (membership.status !== 'ACTIVE') {
      continue;
    }
    const place = await context.services.places.get({ familyId: membership.familyId, placeId });
    if (place !== null) {
      return place;
    }
  }
  // Identical to the answer for a place that never existed.
  throw opaqueAuthorizationError(context.requestId);
}

/** The wire shape. Field by field, so an unknown attribute cannot ride along. */
function toSavedPlace(record: SavedPlaceRecord): StrictSavedPlace {
  return {
    placeId: record.placeId,
    familyId: record.familyId,
    name: record.name,
    category: record.category,
    latitude: record.latitude,
    longitude: record.longitude,
    radiusMeters: record.radiusMeters,
    notifyOnArrival: record.notifyOnArrival,
    notifyOnDeparture: record.notifyOnDeparture,
    createdBy: record.createdBy,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    schemaVersion: record.schemaVersion,
  };
}

export const placeRoutes: RegisteredRoute[] = [
  defineRoute({
    method: 'GET',
    path: '/v1/places',
    authRequired: true,
    entitlement: null,
    rateLimit: 'GENERAL_READ',
    idempotencyRequired: false,
    async handler(context) {
      const query = validateQuery(ListPlacesQuerySchema, context.request.query);
      await requireActiveMembership(context, query.familyId);

      const records = await context.services.places.listForFamily(query.familyId);
      // Sequential rather than concurrent: the places of one family share a data
      // key, so the first unwrap warms the cache every later one hits.
      const places: StrictSavedPlace[] = [];
      for (const record of records) {
        places.push(toSavedPlace(record));
      }

      const entitlements = await familyEntitlements(context, query.familyId);
      const response: ListPlacesResponse = {
        familyId: query.familyId,
        places,
        placeCount: records.length,
        maxPlaces: entitlements.maxSavedPlaces,
      };
      return { statusCode: 200, body: response };
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/v1/places',
    authRequired: true,
    entitlement: null,
    rateLimit: 'ACCOUNT_MUTATION',
    // A retried create must not leave a family with two copies of one anchor.
    idempotencyRequired: true,
    async handler(context) {
      const auth = requireAuth(context);
      const request = validateBody(CreatePlaceRequestSchema, context.body);
      await requireActiveMembership(context, request.familyId);

      const entitlements = await familyEntitlements(context, request.familyId);
      const existing = await context.services.places.listForFamily(request.familyId);
      if (existing.length >= entitlements.maxSavedPlaces) {
        throw new AppError(
          'PLAN_LIMIT_EXCEEDED',
          'This plan does not allow any more saved places.',
        );
      }

      const timestamp = context.now.toISOString();
      const record: SavedPlaceRecord = {
        familyId: request.familyId,
        placeId: context.services.newId(),
        name: request.name,
        category: request.category,
        latitude: request.latitude,
        longitude: request.longitude,
        radiusMeters: request.radiusMeters,
        notifyOnArrival: request.notifyOnArrival,
        notifyOnDeparture: request.notifyOnDeparture,
        readOnly: false,
        createdBy: auth.userId,
        createdAt: timestamp,
        updatedAt: timestamp,
        schemaVersion: PLACE_RECORD_SCHEMA_VERSION,
      };
      await context.services.places.create(record);

      const response: CreatePlaceResponse = {
        // Echoed from what the caller sent, so a create costs no unwrap.
        place: toSavedPlace(record),
        placeCount: existing.length + 1,
        maxPlaces: entitlements.maxSavedPlaces,
      };
      return { statusCode: 201, body: response };
    },
  }),

  defineRoute({
    method: 'PATCH',
    path: '/v1/places/{placeId}',
    authRequired: true,
    entitlement: null,
    rateLimit: 'ACCOUNT_MUTATION',
    idempotencyRequired: false,
    async handler(context) {
      const path = validateParams(PlacePathSchema, context.params);
      const request = validateBody(UpdatePlaceRequestSchema, context.body);

      const existing = await findPlaceForCaller(context, path.placeId);
      if (existing.readOnly) {
        throw new AppError(
          'PLAN_LIMIT_EXCEEDED',
          'This place is read-only until the plan covers it again.',
        );
      }

      const updated = await context.services.places.update({
        familyId: existing.familyId,
        placeId: existing.placeId,
        patch: {
          name: request.name,
          category: request.category,
          latitude: request.latitude,
          longitude: request.longitude,
          radiusMeters: request.radiusMeters,
          notifyOnArrival: request.notifyOnArrival,
          notifyOnDeparture: request.notifyOnDeparture,
        },
        now: context.now,
      });
      if (updated === null) {
        // Lost the race with a downgrade or a deletion between read and write.
        throw new AppError('CONFLICT', 'This place changed while the request was in flight.');
      }

      const response: UpdatePlaceResponse = { place: toSavedPlace(updated) };
      return { statusCode: 200, body: response };
    },
  }),

  defineRoute({
    method: 'DELETE',
    path: '/v1/places/{placeId}',
    authRequired: true,
    entitlement: null,
    rateLimit: 'ACCOUNT_MUTATION',
    idempotencyRequired: false,
    async handler(context) {
      const auth = requireAuth(context);
      const path = validateParams(PlacePathSchema, context.params);

      const existing = await findPlaceForCaller(context, path.placeId);
      // A place frozen by a downgrade is still deletable: refusing would trap a
      // family under its own cap with no way back.
      //
      // A false here means somebody deleted it first, which is precisely what
      // this caller asked for. Reporting a conflict would be pedantry.
      await context.services.places.remove({
        familyId: existing.familyId,
        placeId: existing.placeId,
      });

      const response: DeletePlaceResponse = {
        placeId: existing.placeId,
        familyId: existing.familyId,
        deletedAt: context.now.toISOString(),
        deletedByUserId: auth.userId,
        // Every device holding this fence must drop it. The id is all they need
        // — a device already knows the centre it registered.
        unregisterGeofenceIds: [existing.placeId],
      };
      return { statusCode: 200, body: response };
    },
  }),
];
