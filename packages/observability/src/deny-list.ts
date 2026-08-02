/**
 * The single deny-list shared by the logger, the metric helper, the tracing
 * helpers, the Sentry scrubber and the repo-wide test assertions.
 *
 * Exported (rather than kept private to the redactor) precisely so that there
 * is exactly one place to change when a new sensitive field is introduced —
 * spec §20 requires that every sink apply the same list.
 */

/**
 * Mandated by the privacy spec. Keys matching any of these are DROPPED — not
 * masked — so that neither the key nor a placeholder hints at what was there.
 */
export const REDACTED_KEYS = [
  'latitude',
  'longitude',
  'lat',
  'lng',
  'coords',
  'coordinates',
  'address',
  'token',
  'accessToken',
  'refreshToken',
  'inviteToken',
  'email',
  'placeName',
  'familyName',
] as const;

export type RedactedKey = (typeof REDACTED_KEYS)[number];

/**
 * Defence in depth: near-synonyms and credential-shaped keys that are just as
 * damaging in a log line. Kept separate so the spec-mandated list stays
 * auditable on its own.
 */
export const ADDITIONAL_REDACTED_KEYS = [
  'lon',
  'latLng',
  'latLon',
  'latitudeE7',
  'longitudeE7',
  'geoPoint',
  'geolocation',
  'preciseLocation',
  'streetAddress',
  'homeAddress',
  'formattedAddress',
  'emailAddress',
  'phone',
  'phoneNumber',
  'idToken',
  'authToken',
  'sessionToken',
  'deviceToken',
  'pushToken',
  'apnsToken',
  'fcmToken',
  'authorization',
  'apiKey',
  'secret',
  'password',
  'displayName',
  'fullName',
] as const;

/** Everything every sink must drop. */
export const REDACTION_DENY_LIST: readonly string[] = [
  ...REDACTED_KEYS,
  ...ADDITIONAL_REDACTED_KEYS,
];

/**
 * Keys that specifically carry a precise fix. `assertNoCoordinates` in
 * `@family/test-utils` narrows to this subset so that a failure message says
 * "coordinate leak" and means it.
 */
export const COORDINATE_KEYS: readonly string[] = [
  'latitude',
  'longitude',
  'lat',
  'lng',
  'lon',
  'coords',
  'coordinates',
  'latLng',
  'latLon',
  'latitudeE7',
  'longitudeE7',
  'geoPoint',
  'geolocation',
  'preciseLocation',
];

/**
 * Case-, underscore- and dash-insensitive normalisation so that `accessToken`,
 * `access_token`, `ACCESS-TOKEN` and `Access Token` all collapse to one key.
 */
export function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const DENY_SET: ReadonlySet<string> = new Set(REDACTION_DENY_LIST.map(normalizeKey));
const COORDINATE_SET: ReadonlySet<string> = new Set(COORDINATE_KEYS.map(normalizeKey));

/** True when a key must be dropped from any telemetry payload. */
export function isRedactedKey(key: string): boolean {
  return DENY_SET.has(normalizeKey(key));
}

/** True when a key specifically denotes a precise location. */
export function isCoordinateKey(key: string): boolean {
  return COORDINATE_SET.has(normalizeKey(key));
}
