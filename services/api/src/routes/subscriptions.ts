import { SubmitReceiptRequestSchema, type SubmitReceiptResponse } from '@family/schemas';

import { projectEntitlements } from '../domain/entitlements.js';
import { validateBody } from '../middleware/validation.js';
import { defineRoute, type RegisteredRoute } from '../router.js';

import { requireAuth } from './shared.js';

/**
 * Entitlements read, and the receipt hand-off.
 *
 * The read is a projection of the stored subscription row and nothing else. The
 * client may cache the answer, but every entitlement decision on the server is
 * re-derived from the row at the moment it is needed (spec §23) — a cached tier
 * presented by a client is never accepted as input.
 *
 * The write is deliberately not a write to that row. Verifying a StoreKit or
 * Play receipt needs the provider credentials, which live in Secrets Manager
 * and are held by services/subscription-worker; this function has neither the
 * secret nor a grant to write the Subscriptions table. So a submitted receipt is
 * parked for the worker and the response reports the entitlements the server
 * currently derives — which, moments after a purchase, is usually still the old
 * ones. That is the honest answer: the alternative is telling a client it is
 * entitled because it said so, which is the exact hole the whole design closes.
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

  defineRoute({
    method: 'POST',
    path: '/v1/subscriptions/receipt',
    authRequired: true,
    // Submitting a receipt is how a caller stops being unentitled, so gating it
    // on an entitlement would be a lock whose key is inside the box.
    entitlement: null,
    rateLimit: 'ACCOUNT_MUTATION',
    idempotencyRequired: true,
    async handler(context) {
      const auth = requireAuth(context);
      const request = validateBody(SubmitReceiptRequestSchema, context.body);

      // Recorded before the read, so a slow projection cannot lose the one part
      // of this request that is not reconstructable: the receipt itself. The
      // outcome is not reported to the caller — whether this receipt was already
      // queued says nothing they can act on, and answering differently would
      // turn the endpoint into an oracle for what the worker is holding.
      const outcome = await context.services.subscriptions.submitReceipt({
        userId: auth.userId,
        submissionId: context.services.newId(),
        platform: request.platform,
        productId: request.productId,
        receipt: request.receipt,
        requestId: context.requestId,
        now: context.now,
      });

      // Ids and an outcome. The receipt, its digest and the product the client
      // claims to have bought stay out of the log line.
      context.logger.info('Accepted a subscription receipt for verification.', { outcome });

      // Server-derived, from the stored row. `request.productId` had no part in
      // it, and neither did anything else the client sent.
      const subscription = await context.services.subscriptions.getForUser(auth.userId);
      const response: SubmitReceiptResponse = projectEntitlements({
        userId: auth.userId,
        subscription,
        now: context.now,
      });
      // 202: the receipt has been accepted for verification, not verified.
      return { statusCode: 202, body: response };
    },
  }),
];
