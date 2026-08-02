import { scrubText, scrubUrl } from './coordinates.js';
import { isRedactedKey } from './deny-list.js';
import { redact } from './redaction.js';

/**
 * Sentry `beforeSend` / `beforeBreadcrumb` scrubbers.
 *
 * Sentry is the sink most likely to receive a raw domain object: an unhandled
 * rejection carries whatever the promise was working on, and breadcrumbs
 * capture every fetch the app made. Everything therefore goes through the same
 * deny-list as the logger — imported, not re-declared, so the two can never
 * drift (spec §20).
 *
 * The Sentry event shape is described structurally so this package does not
 * depend on `@sentry/*`; the types below are a compatible subset.
 */

export type SentryBreadcrumb = {
  type?: string;
  category?: string;
  level?: string;
  message?: string;
  timestamp?: number;
  data?: Record<string, unknown>;
};

export type SentryException = {
  type?: string;
  value?: string;
  module?: string;
  stacktrace?: unknown;
  mechanism?: Record<string, unknown>;
};

export type SentryRequest = {
  url?: string;
  method?: string;
  query_string?: unknown;
  data?: unknown;
  cookies?: unknown;
  headers?: Record<string, string>;
  env?: Record<string, unknown>;
};

export type SentryUser = {
  id?: string;
  email?: string;
  username?: string;
  ip_address?: string;
  [key: string]: unknown;
};

export type SentryEvent = {
  event_id?: string;
  message?: string | { message?: string; formatted?: string };
  level?: string;
  environment?: string;
  release?: string;
  transaction?: string;
  tags?: Record<string, unknown>;
  extra?: Record<string, unknown>;
  contexts?: Record<string, unknown>;
  user?: SentryUser;
  request?: SentryRequest;
  breadcrumbs?: SentryBreadcrumb[];
  exception?: { values?: SentryException[] };
  [key: string]: unknown;
};

export type SentryBeforeSend = (event: SentryEvent) => SentryEvent | null;
export type SentryBeforeBreadcrumb = (breadcrumb: SentryBreadcrumb) => SentryBreadcrumb | null;

export type SentryScrubberOptions = {
  /**
   * Drop breadcrumbs of these categories outright. `fetch`/`xhr` breadcrumbs
   * are kept but have their URLs stripped; `console` breadcrumbs are the ones
   * most likely to carry raw payloads.
   */
  dropBreadcrumbCategories?: readonly string[];
  /** Keep `user.id` (a UUID) while always removing email/username/IP. */
  keepUserId?: boolean;
};

const DEFAULT_DROPPED_CATEGORIES: readonly string[] = ['console'];

/** Header names that carry credentials regardless of casing. */
const SENSITIVE_HEADERS: readonly string[] = [
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'idempotency-key',
  'proxy-authorization',
];

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function scrubRecord(
  value: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!value) return undefined;
  const redacted = asRecord(redact(value));
  return redacted;
}

/**
 * Tags are indexed and searchable in Sentry, so a leaked tag is permanently
 * queryable. Values are additionally flattened to strings.
 */
function scrubTags(tags: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!tags) return undefined;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(tags)) {
    if (isRedactedKey(key)) continue;
    if (value === null || value === undefined) continue;
    result[key] = typeof value === 'string' ? scrubText(value) : value;
  }
  return result;
}

function scrubHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (SENSITIVE_HEADERS.includes(lower) || isRedactedKey(key)) continue;
    result[key] = scrubText(value);
  }
  return result;
}

function scrubUser(user: SentryUser | undefined, keepUserId: boolean): SentryUser | undefined {
  if (!user) return undefined;
  const result: SentryUser = {};
  if (keepUserId && typeof user.id === 'string') result.id = user.id;
  // email / username / ip_address are never useful enough to justify keeping.
  return Object.keys(result).length > 0 ? result : undefined;
}

function scrubRequest(request: SentryRequest | undefined): SentryRequest | undefined {
  if (!request) return undefined;
  const result: SentryRequest = {};
  if (request.method) result.method = request.method;
  if (typeof request.url === 'string') result.url = scrubUrl(request.url);
  const headers = scrubHeaders(request.headers);
  if (headers) result.headers = headers;
  if (request.data !== undefined) result.data = redact(request.data);
  // Query strings and cookies are dropped wholesale: neither is worth the risk.
  return result;
}

function scrubExceptionValues(
  exception: { values?: SentryException[] } | undefined,
): { values?: SentryException[] } | undefined {
  if (!exception?.values) return exception;
  return {
    ...exception,
    values: exception.values.map((value) => ({
      ...value,
      value: typeof value.value === 'string' ? scrubText(value.value) : value.value,
      mechanism: scrubRecord(value.mechanism) as SentryException['mechanism'],
    })),
  };
}

function scrubMessage(message: SentryEvent['message']): SentryEvent['message'] {
  if (typeof message === 'string') return scrubText(message);
  if (message && typeof message === 'object') {
    return {
      ...message,
      message: message.message === undefined ? undefined : scrubText(message.message),
      formatted: message.formatted === undefined ? undefined : scrubText(message.formatted),
    };
  }
  return message;
}

/** Scrubs a single breadcrumb. Returns `null` when the crumb must be dropped. */
export function scrubBreadcrumb(
  breadcrumb: SentryBreadcrumb,
  options: SentryScrubberOptions = {},
): SentryBreadcrumb | null {
  const dropped = options.dropBreadcrumbCategories ?? DEFAULT_DROPPED_CATEGORIES;
  if (breadcrumb.category && dropped.includes(breadcrumb.category)) return null;

  const data = breadcrumb.data ? { ...breadcrumb.data } : undefined;
  if (data && typeof data.url === 'string') data.url = scrubUrl(data.url);

  return {
    ...breadcrumb,
    message: breadcrumb.message === undefined ? undefined : scrubText(breadcrumb.message),
    data: scrubRecord(data),
  };
}

/** Scrubs a whole Sentry event in place of the SDK's default serialisation. */
export function scrubEvent(event: SentryEvent, options: SentryScrubberOptions = {}): SentryEvent {
  const scrubbed: SentryEvent = {
    ...event,
    message: scrubMessage(event.message),
    tags: scrubTags(event.tags),
    extra: scrubRecord(event.extra),
    contexts: scrubRecord(event.contexts),
    user: scrubUser(event.user, options.keepUserId ?? true),
    request: scrubRequest(event.request),
    exception: scrubExceptionValues(event.exception),
    breadcrumbs: event.breadcrumbs
      ?.map((crumb) => scrubBreadcrumb(crumb, options))
      .filter((crumb): crumb is SentryBreadcrumb => crumb !== null),
  };

  // `transaction` is a route name; strip any interpolated id or coordinate.
  if (typeof event.transaction === 'string') {
    scrubbed.transaction = scrubUrl(event.transaction);
  }

  for (const key of Object.keys(scrubbed)) {
    if (isRedactedKey(key)) delete scrubbed[key];
    else if (scrubbed[key] === undefined) delete scrubbed[key];
  }

  return scrubbed;
}

/**
 * Builds the `beforeSend` hook.
 *
 *   Sentry.init({ beforeSend: buildSentryBeforeSend(), beforeBreadcrumb: buildSentryBeforeBreadcrumb() })
 */
export function buildSentryBeforeSend(options: SentryScrubberOptions = {}): SentryBeforeSend {
  return (event) => {
    try {
      return scrubEvent(event, options);
    } catch {
      // A scrubber that throws would send the raw event, so fail closed.
      return null;
    }
  };
}

/** Builds the `beforeBreadcrumb` hook using the same deny-list. */
export function buildSentryBeforeBreadcrumb(
  options: SentryScrubberOptions = {},
): SentryBeforeBreadcrumb {
  return (breadcrumb) => {
    try {
      return scrubBreadcrumb(breadcrumb, options);
    } catch {
      return null;
    }
  };
}

/** Both hooks at once, for spreading straight into `Sentry.init`. */
export function buildSentryScrubbers(options: SentryScrubberOptions = {}): {
  beforeSend: SentryBeforeSend;
  beforeBreadcrumb: SentryBeforeBreadcrumb;
} {
  return {
    beforeSend: buildSentryBeforeSend(options),
    beforeBreadcrumb: buildSentryBeforeBreadcrumb(options),
  };
}
