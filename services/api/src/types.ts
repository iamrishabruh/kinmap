import type { AuthContext } from '@family/auth';
import type { Logger } from '@family/observability';

import type { ApiServices } from './services.js';

/**
 * The transport-shaped types the router and the middleware work on.
 *
 * Nothing here is an API Gateway type. The adapter in `http.ts` normalises a
 * v2 proxy event into an {@link HttpRequest}, which means every route, every
 * middleware and every test in this service runs without a Lambda event fixture.
 */

export const HTTP_METHODS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export function isHttpMethod(value: string): value is HttpMethod {
  return (HTTP_METHODS as readonly string[]).includes(value);
}

export type HttpRequest = {
  readonly method: HttpMethod;
  readonly path: string;
  /** Header names are lower-cased by the adapter, so lookups are exact. */
  readonly headers: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string>>;
  /** Decoded UTF-8 body, or null when the request carried none. */
  readonly rawBody: string | null;
  readonly sourceIp: string | null;
  /** API Gateway's own request id, used as the correlation id when present. */
  readonly gatewayRequestId: string | null;
};

export type HttpResponse = {
  readonly statusCode: number;
  readonly headers: Record<string, string>;
  readonly body: string;
};

/** What a route returns. Serialisation and the standard headers happen once. */
export type HandlerResult = {
  readonly statusCode: number;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
};

/**
 * Extracts `{param}` names from a path template at the type level, so
 * `context.params.deviceId` is checked against the template the route was
 * registered under rather than against a bag of strings.
 */
export type ExtractPathParams<TPath extends string> =
  TPath extends `${string}{${infer Param}}${infer Rest}` ? Param | ExtractPathParams<Rest> : never;

export type PathParams<TPath extends string> = Readonly<Record<ExtractPathParams<TPath>, string>>;

export type RouteContext<TPath extends string> = {
  readonly request: HttpRequest;
  readonly params: PathParams<TPath>;
  /** Null only on a route whose metadata says authentication is not required. */
  readonly auth: AuthContext | null;
  readonly requestId: string;
  readonly logger: Logger;
  /** Parsed JSON body, or null. Validation is the route's job. */
  readonly body: unknown;
  readonly now: Date;
  readonly services: ApiServices;
};

/** The erased context the router hands to a registered handler. */
export type AnyRouteContext = RouteContext<string> & {
  readonly params: Readonly<Record<string, string>>;
};
