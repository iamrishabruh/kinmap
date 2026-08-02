import { AppError } from '@family/contracts';

import { appErrorFromCode, isAbortError, isRetryableStatus, mapErrorResponse } from './errors.js';
import { generateIdempotencyKey, generateRequestId } from './ids.js';
import {
  DEFAULT_MAX_RETRY_AFTER_MS,
  computeBackoffDelayMs,
  defaultSleep,
  parseRetryAfter,
  resolveRetryPolicy,
} from './retry.js';
import { TokenManager } from './tokens.js';
import {
  HEADER_APP_ENV,
  HEADER_APP_VERSION,
  HEADER_ATTEMPT,
  HEADER_IDEMPOTENCY_KEY,
  HEADER_PLATFORM,
  HEADER_REQUEST_ID,
  MUTATING_METHODS,
  type ApiClientOptions,
  type ClientLogger,
  type FetchLike,
  type QueryValue,
  type RequestSpec,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Substitutes `{param}` placeholders and encodes each value, so an id
 * containing a slash cannot escape its path segment.
 */
export function interpolatePath(template: string, params: Record<string, string> = {}): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => {
    const value = params[key];
    if (value === undefined) {
      throw new AppError('INTERNAL_ERROR', 'The app tried to call an incomplete route.');
    }
    return encodeURIComponent(value);
  });
}

export function buildUrl(
  baseUrl: string,
  path: string,
  query: Record<string, QueryValue> = {},
): string {
  const normalizedBase = baseUrl.replace(/\/+$/, '');
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;

  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      // Repeated key per element; an empty array contributes nothing.
      for (const entry of value) search.append(key, String(entry));
      continue;
    }
    search.append(key, String(value));
  }
  const queryString = search.toString();
  return queryString.length > 0
    ? `${normalizedBase}${normalizedPath}?${queryString}`
    : `${normalizedBase}${normalizedPath}`;
}

type RequestDeadline = {
  signal: AbortSignal;
  dispose: () => void;
  timedOut: () => boolean;
};

/**
 * Combines the caller's signal with a per-attempt deadline.
 *
 * `AbortSignal.any` would do this in one line on Node, but it is not present in
 * every Hermes build the app ships to, so the linkage is manual.
 */
function createDeadline(timeoutMs: number, external?: AbortSignal): RequestDeadline {
  const controller = new AbortController();
  let timedOut = false;

  const onExternalAbort = (): void => {
    controller.abort();
  };

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  if (external) {
    if (external.aborted) onExternalAbort();
    else external.addEventListener('abort', onExternalAbort, { once: true });
  }

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      external?.removeEventListener('abort', onExternalAbort);
    },
  };
}

/**
 * The transport every feature module is built on.
 *
 * Guarantees, in order of application:
 *   - a stable `X-Request-Id` and (for mutations) `Idempotency-Key` across all
 *     retries of one logical request;
 *   - exactly one token refresh per request on 401, single-flighted globally;
 *   - exponential backoff with jitter on 429/5xx, honouring `Retry-After`;
 *   - a per-attempt abort deadline;
 *   - every failure surfaced as `AppError`;
 *   - no request or response body ever reaching a log sink.
 */
export class ApiClient {
  readonly #options: ApiClientOptions;
  readonly #fetch: FetchLike;
  readonly #tokens: TokenManager;
  readonly #logger: ClientLogger | undefined;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #random: () => number;
  readonly #now: () => number;

  constructor(options: ApiClientOptions) {
    this.#options = options;
    const globalFetch = (globalThis as { fetch?: FetchLike }).fetch;
    const resolvedFetch = options.fetch ?? globalFetch;
    if (!resolvedFetch) {
      throw new Error('ApiClient requires a fetch implementation.');
    }
    this.#fetch = resolvedFetch;
    this.#logger = options.logger;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#random = options.random ?? Math.random;
    this.#now = options.now ?? Date.now;
    this.#tokens = new TokenManager({
      getAccessToken: options.getAccessToken,
      refreshAccessToken: options.refreshAccessToken,
      onRefreshFailed: () => {
        this.#logger?.warn('api.token_refresh_failed');
      },
    });
  }

  get appEnv(): ApiClientOptions['appEnv'] {
    return this.#options.appEnv;
  }

  /** Forgets cached refresh state. Call on sign-out. */
  resetAuthState(): void {
    this.#tokens.reset();
  }

  async request<T>(spec: RequestSpec<T>): Promise<T> {
    const requestId = spec.requestId ?? (this.#options.generateRequestId ?? generateRequestId)();
    const policy = resolveRetryPolicy(this.#options.retry, spec.retry);
    const timeoutMs = spec.timeoutMs ?? this.#options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxRetryAfterMs = this.#options.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS;

    // Generated once, reused by every retry — that is what makes retrying a
    // mutation safe.
    const idempotencyKey = MUTATING_METHODS.has(spec.method)
      ? (spec.idempotencyKey ?? (this.#options.generateIdempotencyKey ?? generateIdempotencyKey)())
      : undefined;

    const url = buildUrl(
      this.#options.baseUrl,
      interpolatePath(spec.path, spec.params),
      spec.query ?? {},
    );
    const body = spec.body === undefined ? undefined : JSON.stringify(spec.body);

    let attempt = 0;
    let authRetryUsed = false;

    for (;;) {
      attempt += 1;

      const token = spec.anonymous ? null : await this.#tokens.get();
      const deadline = createDeadline(timeoutMs, spec.signal);

      let response: Response | undefined;
      let transportError: unknown;
      let transportFailed = false;

      try {
        response = await this.#fetch(url, {
          method: spec.method,
          headers: this.#buildHeaders({
            requestId,
            attempt,
            token,
            idempotencyKey,
            hasBody: body !== undefined,
            extra: spec.headers,
          }),
          body,
          signal: deadline.signal,
        });
      } catch (error) {
        transportError = error;
        transportFailed = true;
      } finally {
        deadline.dispose();
      }

      if (transportFailed || response === undefined) {
        // The caller cancelled: propagate verbatim so `AbortError` handling in
        // React effects keeps working.
        if (spec.signal?.aborted) throw transportError;

        const timedOut = deadline.timedOut() || isAbortError(transportError);
        this.#logger?.warn('api.transport_failed', {
          requestId,
          method: spec.method,
          route: spec.path,
          attempt,
          timedOut,
        });

        if (attempt < policy.maxAttempts) {
          await this.#sleep(
            computeBackoffDelayMs({ attempt, policy, random: this.#random, maxRetryAfterMs }),
          );
          continue;
        }
        throw new AppError(
          'UPSTREAM_UNAVAILABLE',
          timedOut
            ? 'The request timed out. Please try again.'
            : 'We could not reach the server. Please check your connection.',
        );
      }

      const httpResponse = response;

      if (
        httpResponse.status === 401 &&
        !spec.anonymous &&
        !authRetryUsed &&
        this.#tokens.canRefresh
      ) {
        authRetryUsed = true;
        const refreshed = await this.#tokens.refresh(token);
        if (refreshed !== null) {
          this.#logger?.debug('api.token_refreshed', {
            requestId,
            method: spec.method,
            route: spec.path,
          });
          // A refresh is not a failed attempt; it must not consume retry budget.
          attempt -= 1;
          continue;
        }
      }

      if (!httpResponse.ok) {
        const error = await mapErrorResponse(httpResponse);
        const retryAfterMs = parseRetryAfter(httpResponse.headers.get('retry-after'), this.#now());

        this.#logger?.warn('api.request_failed', {
          requestId,
          method: spec.method,
          route: spec.path,
          status: httpResponse.status,
          code: error.code,
          attempt,
        });

        if (isRetryableStatus(httpResponse.status) && attempt < policy.maxAttempts) {
          // Header first, then the envelope's own hint, then plain backoff.
          const envelopeRetryMs =
            error.retryAfterSeconds === undefined ? null : error.retryAfterSeconds * 1_000;
          const delayMs = computeBackoffDelayMs({
            attempt,
            policy,
            retryAfterMs: retryAfterMs ?? envelopeRetryMs,
            maxRetryAfterMs,
            random: this.#random,
          });
          await this.#sleep(delayMs);
          continue;
        }

        if (httpResponse.status === 401) {
          await this.#options.onAuthenticationLost?.();
        }
        throw error;
      }

      this.#logger?.debug('api.request_succeeded', {
        requestId,
        method: spec.method,
        route: spec.path,
        status: httpResponse.status,
        attempt,
      });

      return await this.#parseSuccess(httpResponse, spec, requestId);
    }
  }

  get<T>(spec: Omit<RequestSpec<T>, 'method'>): Promise<T> {
    return this.request<T>({ ...spec, method: 'GET' });
  }

  post<T>(spec: Omit<RequestSpec<T>, 'method'>): Promise<T> {
    return this.request<T>({ ...spec, method: 'POST' });
  }

  put<T>(spec: Omit<RequestSpec<T>, 'method'>): Promise<T> {
    return this.request<T>({ ...spec, method: 'PUT' });
  }

  patch<T>(spec: Omit<RequestSpec<T>, 'method'>): Promise<T> {
    return this.request<T>({ ...spec, method: 'PATCH' });
  }

  delete<T>(spec: Omit<RequestSpec<T>, 'method'>): Promise<T> {
    return this.request<T>({ ...spec, method: 'DELETE' });
  }

  #buildHeaders(input: {
    requestId: string;
    attempt: number;
    token: string | null;
    idempotencyKey: string | undefined;
    hasBody: boolean;
    extra: Record<string, string> | undefined;
  }): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      [HEADER_REQUEST_ID]: input.requestId,
      [HEADER_APP_ENV]: this.#options.appEnv,
      [HEADER_ATTEMPT]: String(input.attempt),
      ...(this.#options.defaultHeaders ?? {}),
      ...(input.extra ?? {}),
    };

    if (input.hasBody) headers['Content-Type'] = 'application/json';
    if (input.token) headers.Authorization = `Bearer ${input.token}`;
    if (input.idempotencyKey) headers[HEADER_IDEMPOTENCY_KEY] = input.idempotencyKey;
    if (this.#options.appVersion) headers[HEADER_APP_VERSION] = this.#options.appVersion;
    if (this.#options.platform) headers[HEADER_PLATFORM] = this.#options.platform;

    return headers;
  }

  async #parseSuccess<T>(response: Response, spec: RequestSpec<T>, requestId: string): Promise<T> {
    if (response.status === 204 || spec.expectNoContent) {
      return undefined as T;
    }

    let raw: string;
    try {
      raw = await response.text();
    } catch {
      throw appErrorFromCode('UPSTREAM_UNAVAILABLE');
    }

    if (raw.length === 0) return undefined as T;

    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new AppError('INTERNAL_ERROR', 'The server returned an unreadable response.');
    }

    if (!spec.schema) return payload as T;

    const parsed = spec.schema.safeParse(payload);
    if (parsed.success) return parsed.data;

    // Only issue *paths* are logged. The offending values are exactly the
    // coordinates this product must never write down.
    this.#logger?.error('api.response_contract_violation', {
      requestId,
      method: spec.method,
      route: spec.path,
      issuePaths: parsed.error.issues.map((issue) => issue.path.map(String).join('.')),
    });
    throw new AppError('INTERNAL_ERROR', 'The server returned an unexpected response.');
  }
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  return new ApiClient(options);
}
