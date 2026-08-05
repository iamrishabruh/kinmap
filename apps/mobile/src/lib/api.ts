import { Platform } from 'react-native';
import type { z } from 'zod';
import { AppError, type ErrorCode } from '@family/contracts';
import { createApiClient } from '@family/api-client';

import { env, requireEnv } from '@/config/env';

/**
 * The app's single HTTP entry point.
 *
 * ---------------------------------------------------------------------------
 * SINGLE SWAP POINT
 * ---------------------------------------------------------------------------
 * This is the only module in the auth/consent surface that imports
 * `@family/api-client`. Everything else calls `request()`.
 *
 * Errors are `AppError` from `@family/contracts` — the canonical envelope every
 * service already speaks — so no feature has to know how the transport reports
 * failure.
 *
 * ---------------------------------------------------------------------------
 * THE AUTH BRIDGE
 * ---------------------------------------------------------------------------
 * Attaching a token and refreshing on 401 are auth concerns, but they have to
 * happen inside the transport. Rather than have this module import the auth
 * feature (which imports this module), the auth feature installs itself here at
 * startup via `setAuthBridge`. Until it does, every request is anonymous —
 * which fails closed: an un-bridged app can talk to the sign-in endpoints and
 * nothing else.
 */

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export type RequestSpec<TResponse> = {
  method: HttpMethod;
  /** Path only, e.g. `/v1/account`. Never a full URL, never with a query token. */
  path: string;
  body?: unknown;
  /** Response contract. Parsing is mandatory: unvalidated JSON never escapes. */
  schema: z.ZodType<TResponse>;
  query?: Record<string, string | number | boolean | undefined>;
  /** Auth endpoints run without a bearer token and without the refresh cycle. */
  anonymous?: boolean;
  idempotencyKey?: string;
  signal?: AbortSignal;
};

export type AuthBridge = {
  /** Current bearer token, refreshing first if it is expired or near expiry. */
  getAccessToken: () => Promise<string | null>;
  /** Force a refresh after a 401. Returns the new token, or null if it failed. */
  refreshAccessToken: () => Promise<string | null>;
  /** Called once when the session is unrecoverable, to tear everything down. */
  onAuthenticationLost: () => void;
};

let authBridge: AuthBridge | null = null;

export function setAuthBridge(bridge: AuthBridge): void {
  authBridge = bridge;
}

/** Test seam. */
export function clearAuthBridge(): void {
  authBridge = null;
}

const client = createApiClient({
  get baseUrl() {
    return requireEnv('apiBaseUrl');
  },
  appEnv: env.appEnv,
  // Token access is delegated to the auth bridge rather than captured once, so
  // a sign-out or refresh that happens elsewhere takes effect on the very next
  // request instead of leaving a revoked token in a closure.
  getAccessToken: () => authBridge?.getAccessToken() ?? null,
  refreshAccessToken: () => authBridge?.refreshAccessToken() ?? Promise.resolve(null),
  onAuthenticationLost: () => authBridge?.onAuthenticationLost(),
  defaultHeaders: {
    'X-App-Version': env.appVersion,
    'X-Platform': Platform.OS === 'ios' ? 'IOS' : 'ANDROID',
  },
  timeoutMs: 20_000,
});

function toAppError(cause: unknown): AppError {
  if (cause instanceof AppError) return cause;
  // A transport failure (airplane mode, DNS, TLS) is never the user's fault and
  // never carries a server message worth showing.
  return new AppError(
    'UPSTREAM_UNAVAILABLE',
    'We could not reach Family Location. Check your connection and try again.',
  );
}

async function send<TResponse>(
  spec: RequestSpec<TResponse>,
  accessToken: string | null,
): Promise<TResponse> {
  const headers: Record<string, string> = {};
  if (accessToken !== null) {
    headers.Authorization = `Bearer ${accessToken}`;
  }
  if (spec.idempotencyKey !== undefined) {
    headers['Idempotency-Key'] = spec.idempotencyKey;
  }

  const raw: unknown = await client.request({
    method: spec.method,
    path: spec.path,
    body: spec.body,
    query: spec.query,
    headers,
    signal: spec.signal,
  });

  const parsed = spec.schema.safeParse(raw);
  if (!parsed.success) {
    // The body is not shown or logged: a response that failed validation is
    // exactly the kind of payload most likely to contain something sensitive.
    throw new AppError(
      'INTERNAL_ERROR',
      'Family Location received an unexpected response. Please try again.',
    );
  }
  return parsed.data;
}

const UNAUTHENTICATED_CODES: readonly ErrorCode[] = ['UNAUTHENTICATED', 'SESSION_EXPIRED'];

export function isUnauthenticated(error: unknown): boolean {
  return error instanceof AppError && UNAUTHENTICATED_CODES.includes(error.code);
}

/**
 * Performs a request, refreshing the access token at most once on a 401.
 *
 * The retry is deliberately capped at one attempt. A refresh that yields a
 * token the server also rejects means the session is genuinely gone, and
 * looping would turn a revoked device — including one revoked precisely because
 * someone wanted it to stop reporting — into a retry storm.
 */
export async function request<TResponse>(spec: RequestSpec<TResponse>): Promise<TResponse> {
  if (spec.anonymous === true || authBridge === null) {
    try {
      return await send(spec, null);
    } catch (cause) {
      throw toAppError(cause);
    }
  }

  const bridge = authBridge;
  let token = await bridge.getAccessToken();

  try {
    return await send(spec, token);
  } catch (cause) {
    const error = toAppError(cause);
    if (!isUnauthenticated(error)) throw error;

    // A refresh that fails for a transient reason (offline, 503) THROWS and is
    // surfaced as such. Only a definitive answer — the refresh token is gone or
    // revoked — comes back as null, and only that tears the session down. A
    // user in a tunnel must not be signed out of a safety product.
    try {
      token = await bridge.refreshAccessToken();
    } catch (refreshCause) {
      throw toAppError(refreshCause);
    }

    if (token === null) {
      bridge.onAuthenticationLost();
      throw error;
    }

    try {
      return await send(spec, token);
    } catch (retryCause) {
      const retryError = toAppError(retryCause);
      if (isUnauthenticated(retryError)) {
        bridge.onAuthenticationLost();
      }
      throw retryError;
    }
  }
}

/**
 * A message safe to render.
 *
 * Server messages are already user-safe by contract (spec §21), but a few codes
 * deserve wording that tells the user what to DO rather than what went wrong.
 */
export function describeError(error: unknown): string {
  if (!(error instanceof AppError)) {
    return 'Something went wrong. Please try again.';
  }
  switch (error.code) {
    case 'RATE_LIMITED': {
      const seconds = error.retryAfterSeconds ?? 60;
      return `Too many attempts. Try again in about ${Math.ceil(seconds / 60)} minute(s).`;
    }
    case 'UPSTREAM_UNAVAILABLE':
      return 'We could not reach Family Location. Check your connection and try again.';
    case 'INTERNAL_ERROR':
      return 'Something went wrong on our side. Please try again.';
    default:
      return error.message;
  }
}
