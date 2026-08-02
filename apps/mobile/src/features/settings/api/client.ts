import Constants from 'expo-constants';
import * as Crypto from 'expo-crypto';
import type { z } from 'zod';

import { AppError, ErrorCodeSchema } from '@family/contracts';

/**
 * The HTTP seam used by the settings, privacy and billing screens.
 *
 * The app-wide client is owned by `@family/api-client`, which is not published
 * yet. Rather than guess its surface, this module exposes a tiny transport with
 * one injection point: `configureSettingsApi`. When the shared client lands,
 * call `configureSettingsApi({ request: sharedClient.request })` once at
 * startup and every screen in this feature routes through it unchanged.
 *
 * PRIVACY: request paths, query strings and error messages are all
 * coordinate-free by construction — no endpoint in this feature accepts or
 * returns a position, so nothing here can leak one into a log or a URL.
 */

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export type ApiRequest = {
  method: HttpMethod;
  path: string;
  /** Serialised as a query string. Values are enumerated or numeric only. */
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Required on unsafe methods that must not be replayed. */
  idempotencyKey?: string;
  signal?: AbortSignal;
};

/** The single function a host client must provide. */
export type ApiTransport = (request: ApiRequest) => Promise<unknown>;

export type SettingsApiConfig = {
  /** Overrides the whole transport. Set this once `@family/api-client` exists. */
  transport?: ApiTransport;
  /** Used by the built-in transport only. */
  baseUrl?: string;
  /** Returns a valid access token, refreshing if necessary. */
  getAccessToken?: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
};

const DEFAULT_TIMEOUT_MS = 20_000;

let config: SettingsApiConfig = {};

/**
 * Wires the feature to the host app's auth and networking. Safe to call more
 * than once; later calls merge over earlier ones.
 */
export function configureSettingsApi(next: SettingsApiConfig): void {
  config = { ...config, ...next };
}

/** Test helper: drop all injected configuration. */
export function resetSettingsApi(): void {
  config = {};
}

function resolveBaseUrl(): string {
  const fromConfig = config.baseUrl;
  if (fromConfig) return fromConfig.replace(/\/+$/, '');

  const extra = Constants.expoConfig?.extra as { apiBaseUrl?: string } | undefined;
  const fromExtra = extra?.apiBaseUrl;
  if (fromExtra) return fromExtra.replace(/\/+$/, '');

  // Fail loudly rather than silently pointing at localhost in a shipped build.
  throw new AppError(
    'UPSTREAM_UNAVAILABLE',
    'The app is not configured to reach the server. Please update to the latest version.',
  );
}

function buildUrl(path: string, query: ApiRequest['query']): string {
  const url = `${resolveBaseUrl()}${path.startsWith('/') ? path : `/${path}`}`;
  if (!query) return url;

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    params.set(key, String(value));
  }
  const serialised = params.toString();
  return serialised ? `${url}?${serialised}` : url;
}

/**
 * Turns any failure into an `AppError` carrying a code the UI can branch on.
 * The server's message is user-safe by contract (spec §21) and is preferred to
 * a generic string so the user is told something actionable.
 */
async function toAppError(response: Response): Promise<AppError> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = undefined;
  }

  const envelope = (payload as { error?: { code?: unknown; message?: unknown } } | undefined)
    ?.error;
  const parsedCode = ErrorCodeSchema.safeParse(envelope?.code);
  const message =
    typeof envelope?.message === 'string' && envelope.message.length > 0
      ? envelope.message
      : 'Something went wrong. Please try again.';

  if (parsedCode.success) return new AppError(parsedCode.data, message);
  if (response.status === 401) return new AppError('UNAUTHENTICATED', message);
  if (response.status === 403) return new AppError('FORBIDDEN', message);
  if (response.status === 404) return new AppError('NOT_FOUND', message);
  return new AppError('INTERNAL_ERROR', message);
}

const builtInTransport: ApiTransport = async (request) => {
  const doFetch = config.fetchImpl ?? fetch;
  const token = (await config.getAccessToken?.()) ?? null;

  const headers: Record<string, string> = {
    accept: 'application/json',
  };
  if (request.body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  if (request.idempotencyKey) headers['idempotency-key'] = request.idempotencyKey;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  request.signal?.addEventListener('abort', () => controller.abort());

  let response: Response;
  try {
    response = await doFetch(buildUrl(request.path, request.query), {
      method: request.method,
      headers,
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      signal: controller.signal,
    });
  } catch {
    // A dropped connection is not an app bug; say so plainly.
    throw new AppError(
      'UPSTREAM_UNAVAILABLE',
      'We could not reach the server. Check your connection and try again.',
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) throw await toAppError(response);
  if (response.status === 204) return undefined;

  try {
    return await response.json();
  } catch {
    return undefined;
  }
};

/** Issues a request and validates the response against its contract. */
export async function apiRequest<TSchema extends z.ZodType>(
  request: ApiRequest,
  schema: TSchema,
): Promise<z.infer<TSchema>> {
  const transport = config.transport ?? builtInTransport;
  const raw = await transport(request);
  const parsed = schema.safeParse(raw);

  if (!parsed.success) {
    // Never echo the payload: it is the one thing we cannot prove is safe.
    throw new AppError(
      'INTERNAL_ERROR',
      'The server sent a response this version of the app does not understand. Please update the app.',
    );
  }
  return parsed.data;
}

/** Issues a request whose response body is intentionally ignored. */
export async function apiCommand(request: ApiRequest): Promise<void> {
  const transport = config.transport ?? builtInTransport;
  await transport(request);
}

/**
 * Opaque, non-guessable idempotency key. Deliberately derived from randomness
 * only — never from user data — so it cannot leak anything if it is logged.
 */
export function newIdempotencyKey(): string {
  return Crypto.randomUUID();
}
