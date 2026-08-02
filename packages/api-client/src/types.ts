import type { ZodType } from 'zod';

import type { AppEnv, RetryPolicy } from '@family/contracts';

/** Methods that mutate and therefore always carry an Idempotency-Key. */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export const MUTATING_METHODS: ReadonlySet<HttpMethod> = new Set<HttpMethod>([
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
]);

/**
 * Injectable `fetch`. Matches the global signature closely enough for the real
 * one to be passed directly, while staying trivial to fake in tests.
 */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/**
 * A query parameter value. An array is encoded as a repeated parameter
 * (`?userIds=a&userIds=b`) rather than a joined string, because that is what the
 * array-typed queries in `@family/schemas` expect to parse back.
 */
export type QueryValue =
  string | number | boolean | undefined | null | ReadonlyArray<string | number | boolean>;

/**
 * A logger sink. Structurally compatible with `@family/observability`'s
 * `Logger`, but declared here so the client stays dependency-light and can be
 * used inside the mobile app without pulling in a Node-shaped logger.
 *
 * The client only ever passes method, route *template*, status, attempt and
 * request id. Request and response bodies are never logged, because on this
 * product they contain coordinates (spec §20).
 */
export interface ClientLogger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export type ApiClientOptions = {
  /** e.g. `https://api.staging.family-location.app`. Trailing slash optional. */
  baseUrl: string;
  appEnv: AppEnv;

  /**
   * Returns the current access token, or null when signed out. Called before
   * every attempt so a token refreshed elsewhere is picked up immediately.
   */
  getAccessToken: () => string | null | Promise<string | null>;

  /**
   * Exchanges the refresh token for a new access token. Returning null means
   * "the session is gone" and the 401 is surfaced to the caller.
   *
   * Invocations are single-flighted: N concurrent 401s cause exactly one call.
   */
  refreshAccessToken?: () => Promise<string | null>;

  /** Invoked once when a request fails authentication even after a refresh. */
  onAuthenticationLost?: () => void | Promise<void>;

  fetch?: FetchLike;
  /** Per-attempt deadline, enforced with an AbortSignal. Default 15_000. */
  timeoutMs?: number;
  retry?: Partial<RetryPolicy>;
  /** Upper bound honoured for a server-provided Retry-After. Default 60_000. */
  maxRetryAfterMs?: number;
  defaultHeaders?: Record<string, string>;
  appVersion?: string;
  platform?: string;
  logger?: ClientLogger;

  generateRequestId?: () => string;
  generateIdempotencyKey?: () => string;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
};

export type RequestSpec<T> = {
  method: HttpMethod;
  /**
   * Route template with `{param}` placeholders, e.g.
   * `/v1/families/{familyId}/locations`. The template — never the interpolated
   * path — is what gets logged.
   */
  path: string;
  params?: Record<string, string>;
  query?: Record<string, QueryValue>;
  body?: unknown;
  /** Validates the response. A mismatch is a server contract violation. */
  schema?: ZodType<T>;
  /** Supply to make a retry across process restarts idempotent. */
  idempotencyKey?: string;
  requestId?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  retry?: Partial<RetryPolicy>;
  headers?: Record<string, string>;
  /** Skips the Authorization header (invitation preview, health checks). */
  anonymous?: boolean;
  expectNoContent?: boolean;
};

export const HEADER_REQUEST_ID = 'X-Request-Id';
export const HEADER_IDEMPOTENCY_KEY = 'Idempotency-Key';
export const HEADER_APP_ENV = 'X-App-Env';
export const HEADER_ATTEMPT = 'X-Attempt';
export const HEADER_APP_VERSION = 'X-App-Version';
export const HEADER_PLATFORM = 'X-Platform';
