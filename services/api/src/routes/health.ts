import { defineRoute, type RegisteredRoute } from '../router.js';

/**
 * Liveness probe.
 *
 * This is the one route besides the provider webhooks that answers without a
 * token, because the thing probing it is a CloudWatch Synthetics canary running
 * outside the account with no way to obtain one. It is what turns "the stack
 * deployed" into "the API is actually reachable over its real hostname with a
 * valid certificate" — the two are not the same, and only the second matters to
 * a user.
 *
 * Two deliberate restraints:
 *
 * 1. **It reports nothing about itself.** No version, no build, no commit, no
 *    dependency list, no environment name. An unauthenticated endpoint that
 *    enumerates internals is reconnaissance, and the canary needs none of it.
 *
 * 2. **It is shallow.** It does not touch DynamoDB, Cognito or any other
 *    dependency. A health check that fans out to every backing service turns an
 *    open endpoint into a free amplifier and makes the canary alarm for reasons
 *    the canary cannot distinguish. The backing services have their own alarms;
 *    this route answers exactly one question — is the edge serving traffic.
 *
 * It is still rate limited by source IP like every other route.
 */
export const healthRoutes: RegisteredRoute[] = [
  defineRoute({
    method: 'GET',
    path: '/v1/health',
    authRequired: false,
    entitlement: null,
    rateLimit: 'GENERAL_READ',
    idempotencyRequired: false,
    handler() {
      return Promise.resolve({ statusCode: 200, body: { status: 'ok' } });
    },
  }),
];
