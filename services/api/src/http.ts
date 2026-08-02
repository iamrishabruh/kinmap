import { isHttpMethod, type HttpRequest, type HttpResponse } from './types.js';

/**
 * The API Gateway HTTP API (payload format 2.0) adapter.
 *
 * The event shape is declared structurally rather than imported from
 * `@types/aws-lambda`, so this service depends on no ambient Lambda types and
 * the adapter can be exercised with a literal in a unit test.
 *
 * Two normalisations happen here and nowhere else: header names are lower-cased
 * (HTTP header names are case-insensitive, and a case-sensitive lookup deeper in
 * the stack is a bug that only shows up against a real client), and a base64
 * body is decoded before anything measures or parses it.
 */

export type ApiGatewayProxyEventV2 = {
  readonly version?: string;
  readonly rawPath?: string;
  readonly rawQueryString?: string;
  readonly headers?: Readonly<Record<string, string | undefined>>;
  readonly queryStringParameters?: Readonly<Record<string, string | undefined>>;
  readonly body?: string;
  readonly isBase64Encoded?: boolean;
  readonly requestContext?: {
    readonly requestId?: string;
    readonly http?: {
      readonly method?: string;
      readonly path?: string;
      readonly sourceIp?: string;
    };
  };
};

export type ApiGatewayProxyResultV2 = {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  isBase64Encoded: boolean;
};

export class UnsupportedMethodError extends Error {
  constructor(readonly method: string) {
    super('Unsupported HTTP method.');
    this.name = 'UnsupportedMethodError';
  }
}

export function toHttpRequest(event: ApiGatewayProxyEventV2): HttpRequest {
  const method = (event.requestContext?.http?.method ?? 'GET').toUpperCase();
  if (!isHttpMethod(method)) {
    throw new UnsupportedMethodError(method);
  }

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(event.headers ?? {})) {
    if (value !== undefined) {
      headers[name.toLowerCase()] = value;
    }
  }

  const query: Record<string, string> = {};
  for (const [name, value] of Object.entries(event.queryStringParameters ?? {})) {
    if (value !== undefined) {
      query[name] = value;
    }
  }

  return {
    method,
    path: event.rawPath ?? event.requestContext?.http?.path ?? '/',
    headers,
    query,
    rawBody: decodeBody(event),
    sourceIp: event.requestContext?.http?.sourceIp ?? null,
    gatewayRequestId: event.requestContext?.requestId ?? null,
  };
}

function decodeBody(event: ApiGatewayProxyEventV2): string | null {
  if (event.body === undefined) {
    return null;
  }
  if (event.isBase64Encoded !== true) {
    return event.body;
  }
  return Buffer.from(event.body, 'base64').toString('utf8');
}

export function toProxyResult(response: HttpResponse): ApiGatewayProxyResultV2 {
  return {
    statusCode: response.statusCode,
    headers: response.headers,
    body: response.body,
    isBase64Encoded: false,
  };
}
