import { createLogger } from '@family/observability';

import { createTriggerHandler } from './dispatch.js';
import { createDynamoDocumentClient } from './dynamo-document-client.js';
import { loadAuthEventsConfig } from './env.js';
import type { UnknownTriggerEvent } from './events.js';
import { createUserProfileRepository } from './users-repository.js';

/**
 * Lambda entry point and composition root for all four Cognito user-pool
 * triggers.
 *
 * Everything expensive is built once, at module scope, so a warm container
 * reuses the DynamoDB connection rather than rebuilding it per trigger — which
 * matters here because a trigger sits directly in the user's sign-in latency.
 * Configuration is validated at cold start, so a missing table name fails
 * loudly instead of becoming a table literally named "undefined".
 */

const config = loadAuthEventsConfig(process.env);

const logger = createLogger({
  service: config.serviceName,
  env: config.env,
  level: config.logLevel,
});

const dispatch = createTriggerHandler({
  config,
  users: createUserProfileRepository(createDynamoDocumentClient(), config.usersTable),
  logger,
  now: () => new Date(),
});

export async function handler(event: UnknownTriggerEvent): Promise<UnknownTriggerEvent> {
  return dispatch(event);
}
