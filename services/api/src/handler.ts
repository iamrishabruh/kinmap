import { randomUUID } from 'node:crypto';

import { createCognitoAccessTokenVerifier } from '@family/auth';
import { AppError } from '@family/contracts';

import { loadApiConfig } from './env.js';
import {
  toHttpRequest,
  toProxyResult,
  UnsupportedMethodError,
  type ApiGatewayProxyEventV2,
  type ApiGatewayProxyResultV2,
} from './http.js';
import { toErrorResponse } from './middleware/errorMapper.js';
import { createTokenBucketRateLimiter } from './middleware/rateLimit.js';
import { createServiceLogger } from './middleware/requestContext.js';
import { createPipeline } from './pipeline.js';
import { createAccountsRepository } from './repositories/accounts.js';
import { createAuditRepository } from './repositories/audit.js';
import { createRemoteConfigurationRepository } from './repositories/configuration.js';
import { createDevicesRepository } from './repositories/devices.js';
import { createDynamoDocumentClient } from './repositories/dynamo-document-client.js';
import { createFamiliesRepository, createMembershipsRepository } from './repositories/families.js';
import { createIdempotencyStore, createTokenBucketStore } from './repositories/idempotency.js';
import { createJobsRepository } from './repositories/jobs.js';
import { createSubscriptionsRepository } from './repositories/subscriptions.js';
import { createSupportRepository } from './repositories/support.js';
import { createRouter } from './router.js';
import { routes } from './routes/index.js';
import type { ApiServices } from './services.js';

/**
 * Lambda entry point and composition root.
 *
 * Everything expensive is built once, at module scope, so a warm container
 * reuses the DynamoDB connections, the JWKS cache and the compiled route table
 * rather than rebuilding them per invocation. Configuration is validated here
 * too: a missing table name fails the cold start loudly instead of turning into
 * a table literally named "undefined" on the first request.
 *
 * The handler itself is four lines. All of the behaviour lives in the pipeline,
 * which takes a plain {@link HttpRequest} and can therefore be exercised end to
 * end in a unit test with no Lambda event and no AWS calls.
 */

const config = loadApiConfig(process.env);
const logger = createServiceLogger(config);

const documentClient = createDynamoDocumentClient();

const verifier = createCognitoAccessTokenVerifier({
  userPoolId: config.userPoolId,
  clientId: config.userPoolClientId,
});

const services: ApiServices = {
  config,
  accounts: createAccountsRepository(documentClient, config.tables.users),
  devices: createDevicesRepository(documentClient, config.tables.devices),
  families: createFamiliesRepository(documentClient, config.tables.families),
  memberships: createMembershipsRepository(documentClient, config.tables.familyMemberships),
  subscriptions: createSubscriptionsRepository(documentClient, config.tables.subscriptions),
  audit: createAuditRepository(
    documentClient,
    config.tables.auditEvents,
    config.auditRetentionDays,
  ),
  support: createSupportRepository(documentClient, config.tables.auditEvents),
  jobs: createJobsRepository(documentClient, config.tables.deletionJobs),
  configuration: createRemoteConfigurationRepository(
    documentClient,
    config.tables.remoteConfiguration,
  ),
  idempotency: createIdempotencyStore(
    documentClient,
    config.tables.idempotency,
    config.idempotencyTtlSeconds,
  ),
  rateLimiter: createTokenBucketRateLimiter(
    createTokenBucketStore(documentClient, config.tables.idempotency),
  ),
  clock: () => new Date(),
  newId: randomUUID,
};

const pipeline = createPipeline({
  router: createRouter(routes),
  services,
  logger,
  verifier,
});

// Warm the JWKS cache so the first authenticated request of a cold container
// does not pay for a fetch from the user pool.
void verifier.hydrate?.().catch(() => {
  // A failed pre-fetch is not fatal: the first verification retries it, and
  // logging the reason here would say nothing a request-scoped log will not.
});

export async function handler(event: ApiGatewayProxyEventV2): Promise<ApiGatewayProxyResultV2> {
  try {
    return toProxyResult(await pipeline(toHttpRequest(event)));
  } catch (error) {
    // Only reachable when the event itself is unusable — an unsupported method,
    // for instance. There is no route to name and no request context to bind,
    // so it leaves as the same NOT_FOUND an unknown endpoint would produce.
    const requestId = event.requestContext?.requestId ?? randomUUID();
    const failure =
      error instanceof UnsupportedMethodError
        ? new AppError('NOT_FOUND', 'No such endpoint.')
        : error;
    return toProxyResult(toErrorResponse(failure, requestId, logger));
  }
}
