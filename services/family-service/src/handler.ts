import { randomUUID } from 'node:crypto';

import {
  buildAuthorizationChecker,
  createCognitoAccessTokenVerifier,
  type TokenVerifier,
} from '@family/auth';
import { AppError } from '@family/contracts';
import { createLogger } from '@family/observability';
import {
  BlockPathSchema,
  BlockUserRequestSchema,
  CreateFamilyRequestSchema,
  FamilyMemberPathSchema,
  FamilyMembersPathSchema,
  FamilyPathSchema,
  ListFamilyMembersQuerySchema,
  RemoveFamilyMemberQuerySchema,
  ReportAbuseRequestSchema,
  TransferFamilyOwnershipRequestSchema,
  UpdateFamilyMemberRequestSchema,
  UpdateFamilyRequestSchema,
} from '@family/schemas';
import { parseOrThrow } from '@family/validation';

import { loadConfig } from './config.js';
import {
  createAuditWriter,
  createDeviceRepository,
  createFamilyStore,
  createMembershipStore,
  createSubscriptionReader,
  createUserAccountRepository,
} from './repositories/dynamo.js';
import { createFamilyEventPublisher } from './repositories/event-bus.js';
import { createInMemoryRateLimiter } from './repositories/rate-limiter.js';
import { authenticate } from './runtime/authentication.js';
import {
  errorResponse,
  jsonResponse,
  parseJsonBody,
  requestIdOf,
  type HttpRequest,
  type HttpResponse,
} from './runtime/http.js';
import {
  blockUser,
  createFamily,
  getFamily,
  listFamilies,
  listFamilyMembers,
  removeFamilyMember,
  reportAbuse,
  transferFamilyOwnership,
  unblockUser,
  updateFamily,
  updateFamilyMember,
  type FamilyServiceDependencies,
} from './service.js';

/**
 * Family, membership and safety routes.
 *
 * `POST   /v1/families`
 * `GET    /v1/families`
 * `GET    /v1/families/{familyId}`
 * `PATCH  /v1/families/{familyId}`
 * `GET    /v1/families/{familyId}/members`
 * `PATCH  /v1/families/{familyId}/members/{userId}`
 * `DELETE /v1/families/{familyId}/members/{userId}`
 * `POST   /v1/families/{familyId}/members/{userId}/transfer-ownership`
 * `POST   /v1/support/blocks`
 * `DELETE /v1/support/blocks/{userId}`
 * `POST   /v1/support/reports`
 */

/** Family payloads are small; this ceiling exists to bound parser work. */
const MAX_BODY_BYTES = 64 * 1024;

const config = loadConfig(process.env);

const logger = createLogger({
  service: config.serviceName,
  env: config.env,
  level: config.logLevel,
});

const memberships = createMembershipStore(config.familyMembershipsTable);
const accounts = createUserAccountRepository(config.usersTable);
const subscriptions = createSubscriptionReader(config.subscriptionsTable);

const checker = buildAuthorizationChecker({
  accounts,
  devices: createDeviceRepository(config.devicesTable),
  memberships,
  subscriptions,
  rateLimiter: createInMemoryRateLimiter(),
});

const verifier: TokenVerifier | null =
  config.userPoolId === null
    ? null
    : createCognitoAccessTokenVerifier({
        userPoolId: config.userPoolId,
        clientId: config.userPoolClientId,
      });

const dependencies: Omit<FamilyServiceDependencies, 'logger'> = {
  checker,
  accounts,
  families: createFamilyStore({
    familiesTable: config.familiesTable,
    membershipsTable: config.familyMembershipsTable,
  }),
  memberships,
  subscriptions,
  events: createFamilyEventPublisher({
    eventBusName: config.familyEventBusName,
    source: config.familyEventSource,
  }),
  audit: createAuditWriter(config.auditEventsTable),
  now: () => new Date(),
  newId: () => randomUUID(),
  safetyResourcesUrl: config.safetyResourcesUrl,
};

const FAMILIES = /^\/v1\/families$/;
const FAMILY = /^\/v1\/families\/([^/]+)$/;
const FAMILY_MEMBERS = /^\/v1\/families\/([^/]+)\/members$/;
const FAMILY_MEMBER = /^\/v1\/families\/([^/]+)\/members\/([^/]+)$/;
const TRANSFER_OWNERSHIP = /^\/v1\/families\/([^/]+)\/members\/([^/]+)\/transfer-ownership$/;
const BLOCKS = /^\/v1\/support\/blocks$/;
const BLOCK = /^\/v1\/support\/blocks\/([^/]+)$/;
const REPORTS = /^\/v1\/support\/reports$/;

function notFound(): AppError {
  return new AppError('NOT_FOUND', 'The requested resource does not exist.');
}

function pathOf(event: HttpRequest): string {
  return event.rawPath ?? event.requestContext.http.path;
}

function scalarParam(event: HttpRequest, name: string): string | undefined {
  const raw = event.queryStringParameters?.[name];
  return raw === undefined || raw === null || raw === '' ? undefined : raw;
}

/**
 * A flat route table rather than nested dispatchers: the whole surface of this
 * function is visible in one screen, which is what you want when every entry is
 * a permission boundary.
 */
export const handler = async (event: HttpRequest): Promise<HttpResponse> => {
  const requestId = requestIdOf(event);
  const requestLogger = logger.withRequestId(requestId);
  const deps: FamilyServiceDependencies = { ...dependencies, logger: requestLogger };

  try {
    const method = event.requestContext.http.method.toUpperCase();
    const path = pathOf(event);
    const auth = await authenticate(event, { verifier });

    if (FAMILIES.test(path)) {
      if (method === 'POST') {
        const body = parseOrThrow(CreateFamilyRequestSchema, parseJsonBody(event, MAX_BODY_BYTES));
        return jsonResponse(201, await createFamily({ auth, body }, deps));
      }
      if (method === 'GET') {
        return jsonResponse(200, await listFamilies({ auth }, deps));
      }
      throw notFound();
    }

    const transfer = TRANSFER_OWNERSHIP.exec(path);
    if (transfer !== null && method === 'POST') {
      const { familyId, userId } = parseOrThrow(FamilyMemberPathSchema, {
        familyId: event.pathParameters?.familyId ?? transfer[1],
        userId: event.pathParameters?.userId ?? transfer[2],
      });
      // Requires an explicit confirmation token; ownership never moves implicitly.
      parseOrThrow(TransferFamilyOwnershipRequestSchema, parseJsonBody(event, MAX_BODY_BYTES));
      return jsonResponse(
        200,
        await transferFamilyOwnership({ auth, familyId, targetUserId: userId }, deps),
      );
    }

    const memberMatch = FAMILY_MEMBER.exec(path);
    if (memberMatch !== null) {
      const { familyId, userId } = parseOrThrow(FamilyMemberPathSchema, {
        familyId: event.pathParameters?.familyId ?? memberMatch[1],
        userId: event.pathParameters?.userId ?? memberMatch[2],
      });
      if (method === 'PATCH') {
        const body = parseOrThrow(
          UpdateFamilyMemberRequestSchema,
          parseJsonBody(event, MAX_BODY_BYTES),
        );
        return jsonResponse(
          200,
          await updateFamilyMember({ auth, familyId, targetUserId: userId, body }, deps),
        );
      }
      if (method === 'DELETE') {
        const query = parseOrThrow(RemoveFamilyMemberQuerySchema, {
          deleteHistory: scalarParam(event, 'deleteHistory'),
        });
        return jsonResponse(
          200,
          await removeFamilyMember(
            { auth, familyId, targetUserId: userId, deleteHistory: query.deleteHistory },
            deps,
          ),
        );
      }
      throw notFound();
    }

    const membersMatch = FAMILY_MEMBERS.exec(path);
    if (membersMatch !== null && method === 'GET') {
      const { familyId } = parseOrThrow(FamilyMembersPathSchema, {
        familyId: event.pathParameters?.familyId ?? membersMatch[1],
      });
      const query = parseOrThrow(ListFamilyMembersQuerySchema, {
        status: scalarParam(event, 'status'),
        includeRemoved: scalarParam(event, 'includeRemoved'),
      });
      return jsonResponse(200, await listFamilyMembers({ auth, familyId, query }, deps));
    }

    const familyMatch = FAMILY.exec(path);
    if (familyMatch !== null) {
      const { familyId } = parseOrThrow(FamilyPathSchema, {
        familyId: event.pathParameters?.familyId ?? familyMatch[1],
      });
      if (method === 'GET') {
        return jsonResponse(200, await getFamily({ auth, familyId }, deps));
      }
      if (method === 'PATCH') {
        const body = parseOrThrow(UpdateFamilyRequestSchema, parseJsonBody(event, MAX_BODY_BYTES));
        return jsonResponse(200, await updateFamily({ auth, familyId, body }, deps));
      }
      throw notFound();
    }

    if (BLOCKS.test(path) && method === 'POST') {
      const body = parseOrThrow(BlockUserRequestSchema, parseJsonBody(event, MAX_BODY_BYTES));
      return jsonResponse(200, await blockUser({ auth, body }, deps));
    }

    const blockMatch = BLOCK.exec(path);
    if (blockMatch !== null && method === 'DELETE') {
      const { userId } = parseOrThrow(BlockPathSchema, {
        userId: event.pathParameters?.userId ?? blockMatch[1],
      });
      return jsonResponse(200, await unblockUser({ auth, blockedUserId: userId }, deps));
    }

    if (REPORTS.test(path) && method === 'POST') {
      const body = parseOrThrow(ReportAbuseRequestSchema, parseJsonBody(event, MAX_BODY_BYTES));
      return jsonResponse(201, await reportAbuse({ auth, body }, deps));
    }

    throw notFound();
  } catch (error) {
    requestLogger.error('family request failed', {
      errorName: error instanceof Error ? error.name : 'UnknownError',
      errorCode: error instanceof AppError ? error.code : null,
    });
    return errorResponse(error, requestId);
  }
};
