import { projectEntitlements } from '../domain/entitlements.js';
import { defineRoute, type RegisteredRoute } from '../router.js';

import { requireAuth } from './shared.js';

/**
 * Entitlements read.
 *
 * This is a projection of the stored subscription row and nothing else. The
 * client may cache the answer, but every entitlement decision on the server is
 * re-derived from the row at the moment it is needed (spec §23) — a cached tier
 * presented by a client is never accepted as input.
 *
 * Writes live in the billing service, which owns the provider secrets and
 * verifies each webhook signature before touching the table.
 */
export const subscriptionRoutes: RegisteredRoute[] = [
  defineRoute({
    method: 'GET',
    path: '/v1/subscriptions/entitlements',
    authRequired: true,
    entitlement: null,
    rateLimit: 'GENERAL_READ',
    idempotencyRequired: false,
    async handler(context) {
      const auth = requireAuth(context);
      const subscription = await context.services.subscriptions.getForUser(auth.userId);
      return {
        statusCode: 200,
        body: projectEntitlements({
          userId: auth.userId,
          subscription,
          now: context.now,
        }),
      };
    },
  }),
];
