import {
  buildAuthorizationChecker,
  createCognitoAccessTokenVerifier,
  type TokenVerifier,
} from '@family/auth';
import { AppError, type UserId } from '@family/contracts';
import { AwsKmsDataKeyProvider, EncryptionService } from '@family/crypto';
import { createLogger } from '@family/observability';
import {
  CurrentLocationsQuerySchema,
  FamilyLocationsPathSchema,
  LocationHistoryQuerySchema,
  UserLocationHistoryPathSchema,
} from '@family/schemas';
import { parseOrThrow } from '@family/validation';

import { loadConfig } from './config.js';
import {
  createAuditWriter,
  createCurrentLocationReader,
  createDeviceRepository,
  createHistoryReader,
  createMembershipDirectory,
  createSavedPlaceReader,
  createSubscriptionRepository,
  createUserAccountRepository,
} from './repositories/dynamo.js';
import { createInMemoryRateLimiter } from './repositories/rate-limiter.js';
import { authenticate } from './runtime/authentication.js';
import {
  errorResponse,
  jsonResponse,
  requestIdOf,
  type HttpRequest,
  type HttpResponse,
} from './runtime/http.js';
import { readCurrentLocations, readLocationHistory, type QueryDependencies } from './service.js';

/**
 * `GET /v1/families/{familyId}/locations/current`
 * `GET /v1/users/{userId}/locations/history`
 *
 * The only function in the platform holding `kms:Decrypt` on the coordinate key
 * besides the geofence worker. It can read the four tables it needs to answer
 * and to authorise, and it can only *append* to the audit log — so a compromised
 * query function cannot erase the record of what it read.
 */

const config = loadConfig(process.env);

const logger = createLogger({
  service: config.serviceName,
  env: config.env,
  level: config.logLevel,
});

const encryptionService = new EncryptionService({
  keyProvider: new AwsKmsDataKeyProvider({ keyId: config.coordinateKeyId }),
});

const memberships = createMembershipDirectory(config.familyMembershipsTable);

const checker = buildAuthorizationChecker({
  accounts: createUserAccountRepository(config.usersTable),
  devices: createDeviceRepository(config.devicesTable),
  memberships,
  subscriptions: createSubscriptionRepository(config.subscriptionsTable),
  rateLimiter: createInMemoryRateLimiter(),
});

const verifier: TokenVerifier | null =
  config.userPoolId === null
    ? null
    : createCognitoAccessTokenVerifier({
        userPoolId: config.userPoolId,
        clientId: config.userPoolClientId,
      });

const dependencies: Omit<QueryDependencies, 'logger'> = {
  checker,
  memberships,
  currentLocations: createCurrentLocationReader(config.currentLocationsTable),
  history: createHistoryReader(config.locationHistoryTable),
  savedPlaces:
    config.savedPlacesTable === null ? null : createSavedPlaceReader(config.savedPlacesTable),
  opener: encryptionService,
  audit: createAuditWriter(config.auditEventsTable),
  now: () => new Date(),
};

const CURRENT_LOCATIONS_ROUTE = /^\/v1\/families\/([^/]+)\/locations\/current$/;
const LOCATION_HISTORY_ROUTE = /^\/v1\/users\/([^/]+)\/locations\/history$/;

function pathOf(event: HttpRequest): string {
  return event.rawPath ?? event.requestContext.http.path;
}

/**
 * Comma-joined repeated query parameters, which is how API Gateway's payload
 * format 2.0 delivers `?userIds=a&userIds=b`.
 */
function listParam(event: HttpRequest, name: string): string[] | undefined {
  const raw = event.queryStringParameters?.[name];
  if (raw === undefined || raw === null || raw === '') {
    return undefined;
  }
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value !== '');
}

function scalarParam(event: HttpRequest, name: string): string | undefined {
  const raw = event.queryStringParameters?.[name];
  return raw === undefined || raw === null || raw === '' ? undefined : raw;
}

export const handler = async (event: HttpRequest): Promise<HttpResponse> => {
  const requestId = requestIdOf(event);
  const requestLogger = logger.withRequestId(requestId);
  const deps: QueryDependencies = { ...dependencies, logger: requestLogger };

  try {
    const method = event.requestContext.http.method.toUpperCase();
    const path = pathOf(event);

    if (method !== 'GET') {
      throw new AppError('NOT_FOUND', 'The requested resource does not exist.');
    }

    const currentMatch = CURRENT_LOCATIONS_ROUTE.exec(path);
    if (currentMatch !== null) {
      const { familyId } = parseOrThrow(FamilyLocationsPathSchema, {
        familyId: event.pathParameters?.familyId ?? currentMatch[1],
      });
      const query = parseOrThrow(CurrentLocationsQuerySchema, {
        userIds: listParam(event, 'userIds'),
      });

      const auth = await authenticate(event, { verifier });
      const response = await readCurrentLocations(
        {
          auth,
          familyId,
          userIds: query.userIds === undefined ? null : (query.userIds as UserId[]),
        },
        deps,
      );
      return jsonResponse(200, response);
    }

    const historyMatch = LOCATION_HISTORY_ROUTE.exec(path);
    if (historyMatch !== null) {
      const { userId } = parseOrThrow(UserLocationHistoryPathSchema, {
        userId: event.pathParameters?.userId ?? historyMatch[1],
      });
      const query = parseOrThrow(LocationHistoryQuerySchema, {
        from: scalarParam(event, 'from'),
        to: scalarParam(event, 'to'),
        cursor: scalarParam(event, 'cursor'),
        limit: scalarParam(event, 'limit'),
        familyId: scalarParam(event, 'familyId'),
      });

      const auth = await authenticate(event, { verifier });
      const response = await readLocationHistory({ auth, targetUserId: userId, query }, deps);
      return jsonResponse(200, response);
    }

    throw new AppError('NOT_FOUND', 'The requested resource does not exist.');
  } catch (error) {
    requestLogger.error('location read failed', {
      errorName: error instanceof Error ? error.name : 'UnknownError',
      errorCode: error instanceof AppError ? error.code : null,
    });
    return errorResponse(error, requestId);
  }
};
