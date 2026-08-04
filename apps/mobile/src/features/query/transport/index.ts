import type { FamilyApi } from '../api';

import { familiesApi } from './families';
import { invitationsApi } from './invitations';
import { liveSessionsApi } from './live-sessions';
import { locationsApi } from './locations';
import { placesApi } from './places';
import { sessionApi } from './session';

/**
 * The one `FamilyApi` the app runs on.
 *
 * `api.ts` has declared this interface and an `ApiProvider` that takes one since
 * the query layer was written, and no implementation existed anywhere in the
 * repository. Every hook, every query key and every screen was built against a
 * contract nothing satisfied, so the signed-in surface threw on mount — the
 * fourth thing in this codebase found to be carefully written and wired to
 * nothing.
 *
 * Composed from six modules rather than one file because the domains have
 * genuinely different rules: locations must never let a coordinate reach a log,
 * invitations carry a credential in the URL, live sessions must not resolve
 * optimistically when somebody withdraws consent. Splitting them keeps each
 * rule next to the code it constrains.
 *
 * Several methods are reachable only as far as the API allows today — see
 * `docs/operations/api-gaps.md`, which lists every one. They are documented
 * rather than silently returning empty, because a dead feature that looks alive
 * is worse than one that says what it cannot do.
 */
export const familyApi: FamilyApi = {
  ...sessionApi,
  ...familiesApi,
  ...locationsApi,
  ...placesApi,
  ...invitationsApi,
  ...liveSessionsApi,
};

export { createFamiliesApi } from './families';
export { createInvitationsApi } from './invitations';
export { createLiveSessionsApi } from './live-sessions';
export { createLocationsApi } from './locations';
export { createPlacesApi } from './places';
export { createSessionApi } from './session';
