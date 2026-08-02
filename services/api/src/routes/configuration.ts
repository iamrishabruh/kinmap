import { AppError } from '@family/contracts';
import { ConfigurationQuerySchema } from '@family/schemas';

import { isConfigurationExpired, isConfigurationUnchanged } from '../domain/configuration.js';
import { validateQuery } from '../middleware/validation.js';
import { defineRoute, type RegisteredRoute } from '../router.js';

/**
 * Remote configuration.
 *
 * The documents are authored out of band, clamped by the schema in
 * `@family/schemas` to the guardrails in `@family/contracts`, and signed. This
 * service only chooses which version to serve — it never synthesises a
 * configuration, so a bug here cannot widen a privacy control or drain a
 * battery. If the stored document no longer validates, nothing is served and
 * the device keeps the last one it verified.
 *
 * `/bootstrap` is described in the schemas package as a pre-authentication
 * payload but is served behind the authorizer, matching the CDK route table:
 * webhooks are the only unauthenticated routes this API exposes.
 */
export const configurationRoutes: RegisteredRoute[] = [
  defineRoute({
    method: 'GET',
    path: '/v1/configuration',
    authRequired: true,
    entitlement: null,
    rateLimit: 'GENERAL_READ',
    idempotencyRequired: false,
    async handler(context) {
      const query = validateQuery(ConfigurationQuerySchema, context.request.query);

      const configuration = await context.services.configuration.getEngineConfiguration();
      if (configuration === null) {
        throw new AppError('UPSTREAM_UNAVAILABLE', 'Configuration is temporarily unavailable.');
      }
      if (isConfigurationExpired(configuration, context.now)) {
        throw new AppError('UPSTREAM_UNAVAILABLE', 'Configuration is temporarily unavailable.');
      }

      if (
        isConfigurationUnchanged({
          clientVersion: query.currentConfigVersion,
          servedVersion: configuration.configVersion,
        })
      ) {
        return { statusCode: 304 };
      }
      return { statusCode: 200, body: configuration };
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/v1/configuration/bootstrap',
    authRequired: true,
    entitlement: null,
    rateLimit: 'GENERAL_READ',
    idempotencyRequired: false,
    async handler(context) {
      const bootstrap = await context.services.configuration.getBootstrapConfiguration();
      if (bootstrap === null) {
        throw new AppError('UPSTREAM_UNAVAILABLE', 'Configuration is temporarily unavailable.');
      }
      return { statusCode: 200, body: bootstrap };
    },
  }),
];
