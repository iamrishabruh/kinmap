import { randomUUID } from 'node:crypto';

import { createLogger, type Logger } from '@family/observability';
import { RequestIdSchema } from '@family/schemas';

import type { ApiConfig } from '../env.js';
import type { HttpRequest } from '../types.js';

/**
 * Per-request correlation.
 *
 * The bound logger carries the request id and the *route template*, never the
 * instantiated path. `/v1/devices/{deviceId}` is a useful log dimension;
 * `/v1/devices/6f3c…` is a device identifier in CloudWatch, and the access-log
 * format in the CDK stack makes exactly the same choice for the same reason.
 */

export type RequestContext = {
  readonly requestId: string;
  readonly logger: Logger;
};

export function createServiceLogger(config: ApiConfig): Logger {
  return createLogger({
    service: config.serviceName,
    env: config.env,
    level: config.logLevel,
  });
}

/**
 * Resolves the correlation id: a client-supplied `x-request-id` if it is
 * well-formed, then API Gateway's own id, then a fresh UUID. A client value is
 * validated rather than trusted, because it is echoed back in every error body.
 */
export function resolveRequestId(
  request: HttpRequest,
  fallback: () => string = randomUUID,
): string {
  const supplied = request.headers['x-request-id'];
  if (supplied !== undefined) {
    const parsed = RequestIdSchema.safeParse(supplied);
    if (parsed.success) {
      return parsed.data;
    }
  }
  return request.gatewayRequestId ?? fallback();
}

export function createRequestContext(input: {
  request: HttpRequest;
  logger: Logger;
  routeTemplate: string | null;
  requestId?: string;
}): RequestContext {
  const requestId = input.requestId ?? resolveRequestId(input.request);
  const logger = input.logger.withRequestId(requestId).child({
    method: input.request.method,
    route: input.routeTemplate ?? 'unmatched',
  });
  return { requestId, logger };
}
