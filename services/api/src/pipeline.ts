import type { AuthContext, TokenVerifier } from '@family/auth';
import { AppError } from '@family/contracts';
import { type createMetrics, type Logger } from '@family/observability';

import { projectEntitlements } from './domain/entitlements.js';
import { parseBody } from './middleware/bodyParser.js';
import { RESPONSE_HEADERS, toErrorResponse, toSuccessResponse } from './middleware/errorMapper.js';
import {
  fingerprint,
  missingIdempotencyKeyError,
  readIdempotencyKey,
  scopedKey,
  withIdempotency,
  REPLAY_HEADER,
} from './middleware/idempotency.js';
import { authenticate } from './middleware/jwtAuth.js';
import { enforceRateLimit, principalOf } from './middleware/rateLimit.js';
import { createRequestContext } from './middleware/requestContext.js';
import { ENTITLEMENT_GATES, type RegisteredRoute, type Router } from './router.js';
import type { ApiServices } from './services.js';
/**
 * Failures that mean "you may not do this", as opposed to "that was malformed".
 * FORBIDDEN and NOT_FOUND are both here because an authorization denial is
 * deliberately reported as one or the other at random-looking boundaries, so
 * counting only FORBIDDEN would miss half of them.
 */
const DENIAL_CODES: ReadonlySet<string> = new Set(['FORBIDDEN', 'UNAUTHORIZED', 'NOT_FOUND']);
import type { AnyRouteContext, HttpRequest, HttpResponse } from './types.js';

/**
 * The request pipeline, in the order the checks have to happen.
 *
 *   route → correlation id → authentication → rate limit → entitlement
 *        → body (size, then JSON) → idempotency → handler → response
 *
 * The ordering is load-bearing. Authentication precedes the rate limit because
 * a bucket keyed by an unauthenticated caller is a bucket an attacker chooses.
 * The size check precedes JSON parsing so an oversized body is rejected before
 * anything tries to parse it. Idempotency wraps the handler and nothing else, so
 * a replayed response is byte-identical to the first one rather than being
 * re-derived from state that has since moved on.
 *
 * Every failure leaves through one mapper, so there is exactly one error shape
 * on the wire — and no route can accidentally invent a second.
 */

/** Methods whose bodies are read. Everything else ignores a supplied body. */
const BODY_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/** Methods for which an idempotency key is honoured. */
const UNSAFE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

export type Pipeline = (request: HttpRequest) => Promise<HttpResponse>;

export function createPipeline(input: {
  router: Router;
  services: ApiServices;
  logger: Logger;
  verifier: TokenVerifier;
  /** Optional so existing tests can construct a pipeline without telemetry. */
  metrics?: ReturnType<typeof createMetrics>;
}): Pipeline {
  return async function handle(request: HttpRequest): Promise<HttpResponse> {
    const match = input.router.match(request.method, request.path);
    const route = match.kind === 'MATCHED' ? match.route : null;

    const { requestId, logger } = createRequestContext({
      request,
      logger: input.logger,
      routeTemplate: route?.path ?? null,
    });

    try {
      if (route === null) {
        // A method mismatch and an unknown path answer identically. The route
        // table is not something a caller gets to enumerate.
        throw new AppError('NOT_FOUND', 'No such endpoint.');
      }

      const auth = route.authRequired
        ? await authenticate({ request, verifier: input.verifier, requestId, logger })
        : null;

      await enforceRateLimit({
        limiter: input.services.rateLimiter,
        bucket: route.rateLimit,
        principal: principalOf({ userId: auth?.userId ?? null, sourceIp: request.sourceIp }),
        requestId,
      });

      await assertEntitled(route, auth, input.services);

      const body = BODY_METHODS.has(request.method) ? parseBody(request) : null;

      const context: AnyRouteContext = {
        request,
        params: match.kind === 'MATCHED' ? match.params : {},
        auth,
        requestId,
        logger,
        body,
        now: input.services.clock(),
        services: input.services,
      };

      const clientKey = readIdempotencyKey(request);
      if (route.idempotencyRequired && clientKey === null) {
        throw missingIdempotencyKeyError();
      }

      if (clientKey === null || !UNSAFE_METHODS.has(request.method)) {
        const result = await route.handler(context);
        return toSuccessResponse({
          statusCode: result.statusCode,
          body: result.body,
          requestId,
          headers: result.headers,
        });
      }

      const outcome = await withIdempotency({
        store: input.services.idempotency,
        key: scopedKey(auth?.userId ?? null, clientKey),
        fingerprint: fingerprint(request),
        now: context.now,
        run: async () => {
          const result = await route.handler(context);
          return {
            statusCode: result.statusCode,
            body: result.body === undefined ? '' : JSON.stringify(result.body),
          };
        },
      });

      return {
        statusCode: outcome.statusCode,
        headers: {
          ...RESPONSE_HEADERS,
          'x-request-id': requestId,
          ...(outcome.replayed ? { [REPLAY_HEADER]: 'true' } : {}),
        },
        body: outcome.body,
      };
    } catch (error) {
      // The control from spec §34: authorization denials are deliberately
      // opaque to the caller, so probing for whether a user exists, is in a
      // family, or has merely paused sharing looks identical from outside. That
      // is exactly why the denials have to be counted on this side — the rate
      // is the only signal that someone is enumerating, and the alarm on it was
      // watching a metric nothing emitted.
      //
      // The route template is a fixed string from the route table, never a
      // caller-supplied path, so it is safe as a dimension.
      if (error instanceof AppError && DENIAL_CODES.has(error.code)) {
        input.metrics?.count('AuthorizationDenied', 1, {
          code: error.code,
          route: route?.path ?? 'unknown',
        });
      }
      return toErrorResponse(error, requestId, logger);
    }
  };
}

/**
 * Entitlement gate.
 *
 * The snapshot is always re-derived from the stored subscription row; a plan or
 * receipt presented by the client is never an input. A route with no gate skips
 * the read entirely, which is every route in this service today — the paid
 * features (history, live sessions) are owned by other functions, and the check
 * lives here so that moving one of them behind this API needs a metadata change
 * and nothing else.
 */
async function assertEntitled(
  route: RegisteredRoute,
  auth: AuthContext | null,
  services: ApiServices,
): Promise<void> {
  if (route.entitlement === null) {
    return;
  }
  if (auth === null) {
    throw new AppError('ENTITLEMENT_REQUIRED', 'This feature requires a subscription.');
  }
  const subscription = await services.subscriptions.getForUser(auth.userId);
  const entitlements = projectEntitlements({
    userId: auth.userId,
    subscription,
    now: services.clock(),
  }).entitlements;

  if (!ENTITLEMENT_GATES[route.entitlement](entitlements)) {
    throw new AppError('ENTITLEMENT_REQUIRED', 'This feature requires a subscription.');
  }
}
