import { createCognitoAccessTokenVerifier, type TokenVerifier } from '@family/auth';
import { LIMITS } from '@family/contracts';
import { AwsKmsDataKeyProvider, EncryptionService } from '@family/crypto';
import { createLogger, createMetrics } from '@family/observability';
import { LocationBatchRequestSchema } from '@family/schemas';
import { parseOrThrow } from '@family/validation';

import { loadConfig } from './config.js';
import {
  createAccountReader,
  createCurrentLocationStore,
  createDeviceReader,
  createHistoryWriter,
  createMembershipReader,
  createUploadWindowGate,
} from './repositories/dynamo.js';
import { createAcceptedLocationPublisher } from './repositories/event-bus.js';
import { authenticate } from './runtime/authentication.js';
import {
  errorResponse,
  jsonResponse,
  parseJsonBody,
  requestIdOf,
  type HttpRequest,
  type HttpResponse,
} from './runtime/http.js';
import { ingestLocationBatch, type IngestionDependencies } from './service.js';

/**
 * `POST /v1/locations/batch`
 *
 * Composition root. Everything expensive — the SDK clients, the KMS data-key
 * cache, the JWKS cache — is built once per container and reused; the handler
 * itself stays thin: parse and validate, then hand off to the pipeline.
 */

const config = loadConfig(process.env);

const logger = createLogger({
  service: config.serviceName,
  env: config.env,
  level: config.logLevel,
});

const metrics = createMetrics({
  namespace: config.metricsNamespace,
  dimensions: { service: config.serviceName, env: config.env },
});

const encryptionService = new EncryptionService({
  keyProvider: new AwsKmsDataKeyProvider({ keyId: config.coordinateKeyId }),
});

const verifier: TokenVerifier | null =
  config.userPoolId === null
    ? null
    : createCognitoAccessTokenVerifier({
        userPoolId: config.userPoolId,
        clientId: config.userPoolClientId,
      });

const dependencies: Omit<IngestionDependencies, 'logger'> = {
  accounts: createAccountReader(config.usersTable),
  devices: config.devicesTable === null ? null : createDeviceReader(config.devicesTable),
  memberships: createMembershipReader(config.familyMembershipsTable),
  uploadWindow: createUploadWindowGate(config.idempotencyTable),
  currentLocations: createCurrentLocationStore(config.currentLocationsTable),
  history: createHistoryWriter(config.locationHistoryTable),
  publisher: createAcceptedLocationPublisher({
    eventBusName: config.locationEventBusName,
    source: config.locationEventSource,
  }),
  sealer: encryptionService,
  retentionDays: config.historyRetentionDays,
  now: () => new Date(),
};

export const handler = async (event: HttpRequest): Promise<HttpResponse> => {
  const requestId = requestIdOf(event);
  const requestLogger = logger.withRequestId(requestId);

  try {
    const auth = await authenticate(event, { verifier });
    const body = parseJsonBody(event, LIMITS.MAX_BATCH_PAYLOAD_BYTES);
    const batch = parseOrThrow(LocationBatchRequestSchema, body);

    const response = await ingestLocationBatch(
      { auth, batch },
      { ...dependencies, logger: requestLogger },
    );

    // The throughput signal the ingestion alarms watch. Without it a pipeline
    // that has stopped accepting anything is indistinguishable from one nobody
    // is using — which is precisely the outage those alarms exist to catch.
    //
    // Rejection reasons are a closed enum defined in @family/schemas and
    // deliberately carry no payload, so they are safe as a dimension. A
    // coordinate never reaches this call.
    metrics.count('LocationEventAccepted', response.acceptedCount);
    if (response.rejectedCount > 0) {
      metrics.count('LocationEventRejected', response.rejectedCount);
      for (const rejection of response.rejected) {
        if (rejection.reason === 'DUPLICATE_EVENT') {
          metrics.count('LocationEventDuplicate', 1);
        } else if (
          rejection.reason === 'ACCURACY_INVALID' ||
          rejection.reason === 'ACCURACY_OUT_OF_BOUNDS'
        ) {
          metrics.count('LocationEventInvalidAccuracy', 1);
        }
      }
    }

    return jsonResponse(200, response);
  } catch (error) {
    // The message is never taken from the thrown error: a validation failure on
    // this endpoint would otherwise echo part of a location payload.
    requestLogger.error('location batch failed', {
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
    return errorResponse(error, requestId);
  }
};
