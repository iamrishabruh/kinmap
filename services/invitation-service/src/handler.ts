import { randomUUID } from 'node:crypto';

import {
  buildAuthorizationChecker,
  createCognitoAccessTokenVerifier,
  type TokenVerifier,
} from '@family/auth';
import { AppError } from '@family/contracts';
import { createLogger } from '@family/observability';
import {
  AcceptInvitationPathSchema,
  AcceptInvitationRequestSchema,
  CreateInvitationRequestSchema,
  FamilyInvitationPathSchema,
  FamilyInvitationsPathSchema,
  ListInvitationsQuerySchema,
} from '@family/schemas';
import { parseOrThrow } from '@family/validation';

import { loadConfig } from './config.js';
import {
  createAuditWriter,
  createDeviceRepository,
  createFamilyReader,
  createInvitationStore,
  createMembershipReader,
  createSubscriptionRepository,
  createUserAccountRepository,
} from './repositories/dynamo.js';
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
  acceptInvitation,
  createInvitation,
  listInvitations,
  previewInvitation,
  revokeInvitation,
  type InvitationDependencies,
} from './service.js';

/**
 * `POST   /v1/families/{familyId}/invitations`
 * `GET    /v1/families/{familyId}/invitations`
 * `DELETE /v1/families/{familyId}/invitations/{invitationId}`
 * `GET    /v1/invitations/{token}`
 * `POST   /v1/invitations/{token}/accept`
 *
 * The token appears in the request path on the last two routes, which is the one
 * place it is unavoidable for a universal link. Nothing here logs the path, and
 * the error handler below logs only an error name and code — never the route.
 */

const MAX_BODY_BYTES = 32 * 1024;

const config = loadConfig(process.env);

const logger = createLogger({
  service: config.serviceName,
  env: config.env,
  level: config.logLevel,
});

const accounts = createUserAccountRepository(config.usersTable);
const memberships = createMembershipReader(config.familyMembershipsTable);
const subscriptions = createSubscriptionRepository(config.subscriptionsTable);

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

const dependencies: Omit<InvitationDependencies, 'logger'> = {
  checker,
  accounts,
  subscriptions,
  families: createFamilyReader(config.familiesTable),
  memberships,
  invitations: createInvitationStore({
    invitationsTable: config.invitationsTable,
    membershipsTable: config.familyMembershipsTable,
  }),
  rateLimiter: createInMemoryRateLimiter(),
  audit: createAuditWriter(config.auditEventsTable),
  now: () => new Date(),
  newId: () => randomUUID(),
  inviteLinkBaseUrl: config.inviteLinkBaseUrl,
};

const FAMILY_INVITATIONS = /^\/v1\/families\/([^/]+)\/invitations$/;
const FAMILY_INVITATION = /^\/v1\/families\/([^/]+)\/invitations\/([^/]+)$/;
const INVITATION_ACCEPT = /^\/v1\/invitations\/([^/]+)\/accept$/;
const INVITATION_PREVIEW = /^\/v1\/invitations\/([^/]+)$/;

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

export const handler = async (event: HttpRequest): Promise<HttpResponse> => {
  const requestId = requestIdOf(event);
  const requestLogger = logger.withRequestId(requestId);
  const deps: InvitationDependencies = { ...dependencies, logger: requestLogger };

  try {
    const method = event.requestContext.http.method.toUpperCase();
    const path = pathOf(event);
    // An authenticated recipient is required on every route, including the
    // preview: an anonymous preview would let a scraped link disclose a family
    // name to anyone.
    const auth = await authenticate(event, { verifier });

    const acceptMatch = INVITATION_ACCEPT.exec(path);
    if (acceptMatch !== null && method === 'POST') {
      const { token } = parseOrThrow(AcceptInvitationPathSchema, {
        token: event.pathParameters?.token ?? decodeURIComponent(acceptMatch[1] ?? ''),
      });
      const body = parseOrThrow(
        AcceptInvitationRequestSchema,
        parseJsonBody(event, MAX_BODY_BYTES),
      );
      return jsonResponse(201, await acceptInvitation({ auth, token, body }, deps));
    }

    const invitationMatch = FAMILY_INVITATION.exec(path);
    if (invitationMatch !== null && method === 'DELETE') {
      const { familyId, invitationId } = parseOrThrow(FamilyInvitationPathSchema, {
        familyId: event.pathParameters?.familyId ?? invitationMatch[1],
        invitationId: event.pathParameters?.invitationId ?? invitationMatch[2],
      });
      return jsonResponse(200, await revokeInvitation({ auth, familyId, invitationId }, deps));
    }

    const invitationsMatch = FAMILY_INVITATIONS.exec(path);
    if (invitationsMatch !== null) {
      const { familyId } = parseOrThrow(FamilyInvitationsPathSchema, {
        familyId: event.pathParameters?.familyId ?? invitationsMatch[1],
      });
      if (method === 'POST') {
        const body = parseOrThrow(
          CreateInvitationRequestSchema,
          parseJsonBody(event, MAX_BODY_BYTES),
        );
        return jsonResponse(201, await createInvitation({ auth, familyId, body }, deps));
      }
      if (method === 'GET') {
        const query = parseOrThrow(ListInvitationsQuerySchema, {
          status: scalarParam(event, 'status'),
        });
        return jsonResponse(200, await listInvitations({ auth, familyId, query }, deps));
      }
      throw notFound();
    }

    const previewMatch = INVITATION_PREVIEW.exec(path);
    if (previewMatch !== null && method === 'GET') {
      const { token } = parseOrThrow(AcceptInvitationPathSchema, {
        token: event.pathParameters?.token ?? decodeURIComponent(previewMatch[1] ?? ''),
      });
      return jsonResponse(200, await previewInvitation({ auth, token }, deps));
    }

    throw notFound();
  } catch (error) {
    // Deliberately does not log the path: on two of these routes the path
    // contains the invitation token.
    requestLogger.error('invitation request failed', {
      errorName: error instanceof Error ? error.name : 'UnknownError',
      errorCode: error instanceof AppError ? error.code : null,
    });
    return errorResponse(error, requestId);
  }
};
