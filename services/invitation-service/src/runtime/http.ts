import { AppError, type ApiError, type ErrorCode } from '@family/contracts';

/**
 * The slice of an API Gateway HTTP API (payload format 2.0) event this service
 * reads, declared structurally so the service does not take a dependency on an
 * ambient `@types/aws-lambda` package that is not pinned by the workspace.
 *
 * Error responses always use the @family/contracts envelope. The message is one
 * of a fixed set of sentences: a thrown error's own text is never surfaced,
 * because an upstream client error can contain a request body — and a request
 * body here contains coordinates.
 */

export type JwtAuthorizerContext = {
  readonly jwt?: {
    readonly claims?: Record<string, unknown> | null;
    readonly scopes?: string[] | null;
  } | null;
};

export type HttpRequestContext = {
  readonly requestId: string;
  readonly http: {
    readonly method: string;
    readonly path: string;
    readonly sourceIp?: string;
  };
  readonly authorizer?: JwtAuthorizerContext | null;
};

export type HttpRequest = {
  readonly version?: string;
  readonly routeKey?: string;
  readonly rawPath?: string;
  readonly headers?: Record<string, string | undefined> | null;
  readonly queryStringParameters?: Record<string, string | undefined> | null;
  readonly pathParameters?: Record<string, string | undefined> | null;
  readonly body?: string | null;
  readonly isBase64Encoded?: boolean;
  readonly requestContext: HttpRequestContext;
};

export type HttpResponse = {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
};

const JSON_HEADERS: Record<string, string> = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

/** Fixed, caller-safe sentences. Indexed by code so none can be interpolated. */
const ERROR_MESSAGES: Partial<Record<ErrorCode, string>> = {
  UNAUTHENTICATED: 'Authentication is required.',
  FORBIDDEN: 'You do not have access to this resource.',
  NOT_FOUND: 'The requested resource does not exist.',
  PAYLOAD_TOO_LARGE: 'The request body is larger than the maximum allowed size.',
  VALIDATION_FAILED: 'The request could not be validated.',
  RATE_LIMITED: 'Too many requests. Please try again shortly.',
  UPSTREAM_UNAVAILABLE: 'A dependency is temporarily unavailable. Please retry.',
  INTERNAL_ERROR: 'Something went wrong. Please try again.',
};

export function requestIdOf(event: HttpRequest): string {
  const candidate = event.requestContext?.requestId;
  return typeof candidate === 'string' && candidate !== '' ? candidate : 'unknown';
}

export function headerOf(event: HttpRequest, name: string): string | null {
  const headers = event.headers;
  if (headers === undefined || headers === null) {
    return null;
  }
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted && typeof value === 'string' && value !== '') {
      return value;
    }
  }
  return null;
}

/**
 * Decodes and parses the JSON body.
 *
 * The byte ceiling is applied to the *decoded* payload, before `JSON.parse`, so
 * an oversized batch is rejected without ever being materialised as objects.
 */
export function parseJsonBody(event: HttpRequest, maxBytes: number): unknown {
  const raw = event.body;
  if (raw === undefined || raw === null || raw === '') {
    throw new AppError(
      'VALIDATION_FAILED',
      ERROR_MESSAGES.VALIDATION_FAILED ?? 'Invalid request.',
      [{ path: '(root)', message: 'A request body is required.' }],
    );
  }

  const decoded =
    event.isBase64Encoded === true ? Buffer.from(raw, 'base64') : Buffer.from(raw, 'utf8');
  if (decoded.byteLength > maxBytes) {
    throw new AppError('PAYLOAD_TOO_LARGE', ERROR_MESSAGES.PAYLOAD_TOO_LARGE ?? 'Too large.');
  }

  try {
    return JSON.parse(decoded.toString('utf8')) as unknown;
  } catch {
    // The parser's message quotes the offending input, which is the batch body.
    throw new AppError(
      'VALIDATION_FAILED',
      ERROR_MESSAGES.VALIDATION_FAILED ?? 'Invalid request.',
      [{ path: '(root)', message: 'The request body is not valid JSON.' }],
    );
  }
}

export function jsonResponse(statusCode: number, body: unknown): HttpResponse {
  return { statusCode, headers: { ...JSON_HEADERS }, body: JSON.stringify(body) };
}

/** Builds the single error envelope every endpoint returns. */
export function apiErrorBody(error: AppError, requestId: string): ApiError {
  const message = ERROR_MESSAGES[error.code] ?? error.message;
  return {
    error: {
      code: error.code,
      message,
      ...(error.fields === undefined ? {} : { fields: error.fields }),
      requestId,
      ...(error.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: error.retryAfterSeconds }),
    },
  };
}

/**
 * Converts anything thrown by a handler into the error envelope. A non-`AppError`
 * collapses to INTERNAL_ERROR with a fixed sentence, so a stack trace, a DynamoDB
 * validation message, or a JSON parser echo can never reach a caller.
 */
export function errorResponse(error: unknown, requestId: string): HttpResponse {
  const appError =
    error instanceof AppError
      ? error
      : new AppError('INTERNAL_ERROR', ERROR_MESSAGES.INTERNAL_ERROR ?? 'Internal error.');

  const response = jsonResponse(appError.status, apiErrorBody(appError, requestId));
  if (appError.retryAfterSeconds !== undefined) {
    response.headers['retry-after'] = String(appError.retryAfterSeconds);
  }
  return response;
}
