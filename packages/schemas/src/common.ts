import { z } from 'zod';

import {
  DeviceLocationHealthSchema,
  LatitudeSchema,
  LocationEventSchema,
  LocationPermissionStateSchema,
  LongitudeSchema,
  SavedPlaceSchema,
  SharingStatusSchema,
} from '@family/contracts';

/**
 * Primitives shared by every endpoint group.
 *
 * UNKNOWN-KEY POLICY (enforced by `src/__tests__/schemas.test.ts`)
 * ---------------------------------------------------------------
 * Every first-party request schema in this package is built with
 * `z.strictObject`, at the top level *and* at every nested level, so an
 * unrecognised key is always REJECTED rather than silently stripped. A
 * forgotten field name must fail loudly instead of being dropped on the floor.
 *
 * The single deliberate exception is a third-party webhook envelope
 * (`src/subscriptions.ts`), which the provider owns and extends without
 * notice; those use `z.looseObject` and say so at the definition site.
 *
 * PRIVACY POLICY
 * --------------
 * Coordinates appear in exactly two places in this package:
 *   - inbound: a device uploading its own points (`LocationBatchRequest`);
 *   - outbound: the VISIBLE arm of a location response, which is structurally
 *     unreachable unless the target's sharing status is SHARING.
 * No other response schema — membership, live session, notification payload,
 * audit entry, support ticket — carries a latitude or longitude.
 */

// ---------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------

/** RFC 3339 / ISO 8601 UTC instant, matching @family/contracts timestamps. */
export const IsoDateTimeSchema = z.string().datetime();

/** Opaque, server-issued pagination cursor. Never parsed by the client. */
export const CursorSchema = z.string().min(1).max(512);

/**
 * Client-supplied idempotency key for unsafe methods. Opaque and non-guessable;
 * never derived from user data so it cannot leak anything if logged.
 */
export const IdempotencyKeySchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, 'Must be a URL-safe token.');

export const RequestIdSchema = z.string().min(1).max(128);

export const DisplayNameSchema = z.string().min(1).max(80);

export const EmailSchema = z.string().email().max(254);

/** E.164. Stored hashed server-side; never logged in the clear. */
export const PhoneNumberSchema = z
  .string()
  .regex(/^\+[1-9]\d{6,14}$/, 'Must be an E.164 phone number.');

export const AvatarUrlSchema = z.string().url().max(2048);

/** BCP 47 subset the apps actually ship. */
export const LocaleSchema = z
  .string()
  .regex(/^[a-z]{2}(?:-[A-Z]{2})?$/, 'Must be a BCP 47 language tag.');

/** IANA time zone identifier. */
export const TimeZoneSchema = z
  .string()
  .min(3)
  .max(64)
  .regex(/^(?:UTC|[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){1,2})$/, 'Must be an IANA time zone identifier.');

export const AppVersionSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/, 'Must be a semantic version.');

export const PlatformSchema = z.enum(['IOS', 'ANDROID']);
export type Platform = z.infer<typeof PlatformSchema>;

/**
 * Query-string booleans. `z.coerce.boolean()` is unusable here because
 * `Boolean('false') === true`; this accepts only the four literal forms a
 * client may send and rejects everything else.
 */
export const BooleanQueryParamSchema = z.union([
  z.boolean(),
  z.enum(['true', 'false', '1', '0']).transform((raw) => raw === 'true' || raw === '1'),
]);

/** Version of the terms/privacy policy the user accepted. */
export const TermsVersionSchema = z.string().min(1).max(32);

// ---------------------------------------------------------------------------
// Envelope helpers
// ---------------------------------------------------------------------------

export const PageInfoSchema = z.strictObject({
  nextCursor: CursorSchema.nullable(),
  hasMore: z.boolean(),
});
export type PageInfo = z.infer<typeof PageInfoSchema>;

/** Response for endpoints whose only meaningful outcome is "it worked". */
export const AcknowledgedResponseSchema = z.strictObject({
  ok: z.literal(true),
  requestId: RequestIdSchema,
});
export type AcknowledgedResponse = z.infer<typeof AcknowledgedResponseSchema>;

/** Headers every mutating first-party request may carry. */
export const MutationHeadersSchema = z.strictObject({
  idempotencyKey: IdempotencyKeySchema.nullable().default(null),
});
export type MutationHeaders = z.infer<typeof MutationHeadersSchema>;

// ---------------------------------------------------------------------------
// Sharing visibility
// ---------------------------------------------------------------------------

/**
 * Every sharing status other than SHARING. Derived from the contract enum so a
 * new status added upstream is automatically treated as "no coordinates".
 */
export const HiddenSharingStatusSchema = SharingStatusSchema.exclude(['SHARING']);
export type HiddenSharingStatus = z.infer<typeof HiddenSharingStatusSchema>;

export const VisibilitySchema = z.enum(['VISIBLE', 'HIDDEN']);
export type Visibility = z.infer<typeof VisibilitySchema>;

// ---------------------------------------------------------------------------
// Coordinates
// ---------------------------------------------------------------------------

/**
 * The ONLY response-side carrier of a raw coordinate. It is reachable solely
 * from the VISIBLE arm of a location response, which requires
 * `sharingStatus: 'SHARING'`.
 */
export const LocationPointSchema = z.strictObject({
  latitude: LatitudeSchema,
  longitude: LongitudeSchema,
  horizontalAccuracy: z.number().nonnegative(),
  altitude: z.number().nullable().default(null),
  heading: z.number().min(0).max(360).nullable().default(null),
  speed: z.number().nullable().default(null),
});
export type LocationPoint = z.infer<typeof LocationPointSchema>;

/**
 * Coarse geohash used for metrics and abuse signals. Capped at six characters
 * (~1 km cell) so it can never be treated as a precise location.
 */
export const CoarseGeohashSchema = z
  .string()
  .min(1)
  .max(6)
  .regex(/^[0-9bcdefghjkmnpqrstuvwxyz]+$/, 'Must be a base32 geohash.');

// ---------------------------------------------------------------------------
// Strict re-wraps of @family/contracts objects
//
// The contract schemas are `z.object`, which strips unknown keys. Requests in
// this package must reject them instead, so we re-wrap the *same shapes* —
// field definitions are still owned by @family/contracts, never duplicated.
// ---------------------------------------------------------------------------

export const StrictLocationEventSchema = z.strictObject(LocationEventSchema.shape);
export type StrictLocationEvent = z.infer<typeof StrictLocationEventSchema>;

export const StrictLocationPermissionStateSchema = z.strictObject(
  LocationPermissionStateSchema.shape,
);

export const StrictDeviceLocationHealthSchema = z.strictObject({
  ...DeviceLocationHealthSchema.shape,
  permission: StrictLocationPermissionStateSchema,
});
export type StrictDeviceLocationHealth = z.infer<typeof StrictDeviceLocationHealthSchema>;

export const StrictSavedPlaceSchema = z.strictObject(SavedPlaceSchema.shape);
export type StrictSavedPlace = z.infer<typeof StrictSavedPlaceSchema>;
