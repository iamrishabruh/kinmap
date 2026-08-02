/**
 * @family/schemas — request and response schemas for every v1 endpoint.
 *
 * Domain vocabulary (ids, enums, `LocationEventSchema`, `SavedPlaceSchema`,
 * `LIMITS`, `ACCEPTANCE`, ...) lives in @family/contracts and is imported, never
 * duplicated. This package adds only the HTTP-shaped wrappers: paths, queries,
 * bodies and responses.
 *
 * Two invariants hold across the whole surface and are covered by
 * `src/__tests__/schemas.test.ts`:
 *
 *  1. Unknown keys are rejected on every first-party request, at every nesting
 *     level. The one documented exception is third-party webhook bodies.
 *  2. A coordinate is only representable in a response through the VISIBLE arm
 *     of a location union, which requires `sharingStatus: 'SHARING'`.
 */

export * from './common.js';
export * from './account.js';
export * from './auth.js';
export * from './configuration.js';
export * from './devices.js';
export * from './families.js';
export * from './invitations.js';
export * from './live-sessions.js';
export * from './locations.js';
export * from './memberships.js';
export * from './notifications.js';
export * from './places.js';
export * from './privacy.js';
export * from './subscriptions.js';
export * from './support.js';
