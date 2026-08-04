import type { FamilyId } from '@family/contracts';
import { EntitlementsResponseSchema, GetAccountResponseSchema } from '@family/schemas';

import type { FamilyApi } from '@/features/query/api';
import type { AuthenticatedSession, EntitlementsView } from '@/features/query/types';
import { request } from '@/lib/api';

/**
 * The session slice of {@link FamilyApi}: who the caller is, and what the server
 * says they are entitled to.
 *
 * Two deployed routes back this module and nothing else:
 *
 *   `GET /v1/account`                     -> `GetAccountResponseSchema`
 *   `GET /v1/subscriptions/entitlements`  -> `EntitlementsResponseSchema`
 *
 * Both are declared in `infrastructure/stacks/api-stack.ts` and served by
 * `services/api/src/routes/{account,subscriptions}.ts`.
 *
 * ---------------------------------------------------------------------------
 * THE ENTITLEMENT RULE (spec §23)
 * ---------------------------------------------------------------------------
 * `getEntitlements` copies `plan`, `tier`, `status` and `entitlements` straight
 * off the parsed response. It does not derive a tier from a product id, a
 * receipt, a RevenueCat customer-info object, or a previously cached view, and
 * it does not widen anything the server sent. The server re-derives every
 * entitlement decision from the stored subscription row at the moment it needs
 * it, so a tier asserted by a device would be a value the server never accepts
 * anyway — computing one here would only mean showing a user a paid surface
 * that the next request closes again.
 *
 * ---------------------------------------------------------------------------
 * PRIVACY
 * ---------------------------------------------------------------------------
 * Neither endpoint accepts or returns a coordinate, and neither takes a path or
 * query parameter, so no identifier reaches a URL. Nothing in this module logs:
 * not the account, not the entitlement view, not a failure. `request()` already
 * declines to echo a body that failed validation, and there is nothing here
 * worth adding to that.
 */

/** Exactly the two methods this module owns. */
export type SessionApi = Pick<FamilyApi, 'getSession' | 'getEntitlements'>;

/**
 * Picks the family the app opens on.
 *
 * `GET /v1/account` has no `activeFamilyId` field — the wire contract
 * (`AccountSchema`) carries only `familyIds`, and there is no route that stores
 * or returns a "current family" per device. The server answers with the
 * caller's ACTIVE memberships already sorted ascending
 * (`services/api/src/routes/account.ts`), so taking the first one is stable
 * across refetches rather than shuffling the map under the user between polls.
 *
 * This is a placeholder for a real selection, not a substitute for one. A user
 * in two families gets whichever id sorts first until either the account
 * response gains the field or the app persists an explicit choice locally; see
 * the gap reported alongside this module.
 */
function chooseActiveFamilyId(familyIds: readonly FamilyId[]): FamilyId | null {
  return familyIds[0] ?? null;
}

export function createSessionApi(): SessionApi {
  return {
    async getSession(signal?: AbortSignal): Promise<AuthenticatedSession> {
      const response = await request({
        method: 'GET',
        path: '/v1/account',
        schema: GetAccountResponseSchema,
        signal,
      });

      const { account } = response;
      return {
        userId: account.userId,
        displayName: account.displayName,
        activeFamilyId: chooseActiveFamilyId(account.familyIds),
        // Copied, not aliased: the parsed response is discarded here and the
        // view must not share a mutable array with it.
        familyIds: [...account.familyIds],
      };
    },

    async getEntitlements(signal?: AbortSignal): Promise<EntitlementsView> {
      const response = await request({
        method: 'GET',
        path: '/v1/subscriptions/entitlements',
        schema: EntitlementsResponseSchema,
        signal,
      });

      // Server-derived, field for field. The response carries more than the view
      // needs (source, trial and renewal state, the store management URL); those
      // belong to the subscription screen, not to the entitlement snapshot every
      // gate in the app reads.
      return {
        plan: response.plan,
        tier: response.tier,
        status: response.status,
        entitlements: response.entitlements,
      };
    },
  };
}

/** The composed instance; `createSessionApi()` exists for tests that want a fresh one. */
export const sessionApi: SessionApi = createSessionApi();
