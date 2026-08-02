import { RATE_LIMITS, type Entitlements } from '@family/contracts';

import type { AnyRouteContext, HandlerResult, HttpMethod, RouteContext } from './types.js';

/**
 * The route table.
 *
 * Every route declares four things next to its handler rather than somewhere
 * else: whether it needs an authenticated principal, which entitlement (if any)
 * gates it, which rate-limit bucket it draws from, and whether an idempotency
 * key is mandatory. A reviewer can therefore answer "what protects this
 * endpoint?" by reading one object, which is the same property the CDK route
 * table is built around.
 *
 * Path templates use `{param}`. Parameter names are extracted at the type level,
 * so `context.params.deviceId` on a route registered as `/v1/devices/{deviceId}`
 * is checked by the compiler, and a typo is a build failure rather than an
 * `undefined` reaching a repository.
 */

/**
 * Per-principal ceilings, in requests per minute. The names are buckets rather
 * than routes so that several endpoints can share one budget, and the values
 * come from `@family/contracts` so tightening a limit there tightens it here.
 */
export const RATE_LIMIT_BUCKETS = {
  /** Authenticated reads that carry no location payload. */
  GENERAL_READ: 60,
  ACCOUNT_MUTATION: RATE_LIMITS.ACCOUNT_MUTATION_PER_USER,
  /** Privacy reads and exports: the same budget as a history read. */
  PRIVACY_READ: RATE_LIMITS.HISTORY_READ_PER_USER,
} as const;

export type RateLimitBucket = keyof typeof RATE_LIMIT_BUCKETS;

/**
 * Entitlement gates, expressed as predicates over the server-resolved
 * entitlement snapshot. A client-supplied plan is never an input.
 */
export const ENTITLEMENT_GATES = {
  HISTORY: (entitlements: Entitlements): boolean => entitlements.historyRetentionDays > 0,
  LIVE_SESSIONS: (entitlements: Entitlements): boolean => entitlements.liveSessionsEnabled,
  ARRIVAL_DEPARTURE_ALERTS: (entitlements: Entitlements): boolean =>
    entitlements.arrivalDepartureAlerts,
  PRIORITY_SUPPORT: (entitlements: Entitlements): boolean => entitlements.prioritySupport,
} as const;

export type EntitlementRequirement = keyof typeof ENTITLEMENT_GATES;

export type RouteMetadata = {
  readonly authRequired: boolean;
  /** Null when the route is available on every plan, including FREE. */
  readonly entitlement: EntitlementRequirement | null;
  readonly rateLimit: RateLimitBucket;
  /**
   * When true a request without an `idempotency-key` header is rejected. When
   * false a key is still honoured if one is supplied.
   */
  readonly idempotencyRequired: boolean;
};

export type RouteDefinition<TPath extends string> = RouteMetadata & {
  readonly method: HttpMethod;
  readonly path: TPath;
  readonly handler: (context: RouteContext<TPath>) => Promise<HandlerResult>;
};

export type RegisteredRoute = RouteMetadata & {
  readonly method: HttpMethod;
  readonly path: string;
  readonly handler: (context: AnyRouteContext) => Promise<HandlerResult>;
};

/**
 * Registers a route, keeping the path literal for parameter inference and
 * erasing it afterwards.
 *
 * The cast is the one place the two views of a context meet. It is sound
 * because the router only ever invokes a handler with the parameters extracted
 * from that handler's own template — there is no other call path.
 */
export function defineRoute<TPath extends string>(
  definition: RouteDefinition<TPath>,
): RegisteredRoute {
  return {
    method: definition.method,
    path: definition.path,
    authRequired: definition.authRequired,
    entitlement: definition.entitlement,
    rateLimit: definition.rateLimit,
    idempotencyRequired: definition.idempotencyRequired,
    handler: definition.handler as (context: AnyRouteContext) => Promise<HandlerResult>,
  };
}

export type RouteMatch =
  | {
      readonly kind: 'MATCHED';
      readonly route: RegisteredRoute;
      readonly params: Readonly<Record<string, string>>;
    }
  | { readonly kind: 'METHOD_NOT_ALLOWED'; readonly allowed: readonly HttpMethod[] }
  | { readonly kind: 'NOT_FOUND' };

export interface Router {
  readonly routes: readonly RegisteredRoute[];
  match(method: string, path: string): RouteMatch;
}

type Segment =
  | { readonly kind: 'LITERAL'; readonly value: string }
  | {
      readonly kind: 'PARAM';
      readonly name: string;
    };

type CompiledRoute = {
  readonly route: RegisteredRoute;
  readonly segments: readonly Segment[];
};

/**
 * Compiles a path template once, at construction. `/v1/devices/{deviceId}`
 * becomes `[LITERAL v1, LITERAL devices, PARAM deviceId]`.
 */
export function compilePath(path: string): Segment[] {
  if (!path.startsWith('/')) {
    throw new Error(`Route path must start with "/": ${path}`);
  }
  return splitPath(path).map((segment) => {
    const isParameter = segment.startsWith('{') && segment.endsWith('}');
    if (!isParameter) {
      if (segment.includes('{') || segment.includes('}')) {
        throw new Error(`Malformed path parameter in route: ${path}`);
      }
      return { kind: 'LITERAL', value: segment };
    }
    const name = segment.slice(1, -1);
    if (name === '' || !/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`Malformed path parameter in route: ${path}`);
    }
    return { kind: 'PARAM', name };
  });
}

/** Splits on `/`, dropping the leading empty segment and any trailing slash. */
function splitPath(path: string): string[] {
  const withoutQuery = path.split('?')[0] ?? path;
  const trimmed =
    withoutQuery.length > 1 && withoutQuery.endsWith('/')
      ? withoutQuery.slice(0, -1)
      : withoutQuery;
  return trimmed.split('/').filter((segment) => segment !== '');
}

export function createRouter(routes: readonly RegisteredRoute[]): Router {
  const seen = new Set<string>();
  const compiled: CompiledRoute[] = routes.map((route) => {
    const key = `${route.method} ${route.path}`;
    if (seen.has(key)) {
      throw new Error(`Duplicate route registered: ${key}`);
    }
    seen.add(key);
    return { route, segments: compilePath(route.path) };
  });

  return {
    routes,
    match(method: string, path: string): RouteMatch {
      const requestSegments = splitPath(path);
      const allowed = new Set<HttpMethod>();
      const normalisedMethod = method.toUpperCase();

      for (const candidate of compiled) {
        const params = matchSegments(candidate.segments, requestSegments);
        if (params === null) {
          continue;
        }
        allowed.add(candidate.route.method);
        if (candidate.route.method === normalisedMethod) {
          return { kind: 'MATCHED', route: candidate.route, params };
        }
      }

      return allowed.size > 0
        ? { kind: 'METHOD_NOT_ALLOWED', allowed: [...allowed] }
        : { kind: 'NOT_FOUND' };
    },
  };
}

/**
 * Returns the captured parameters, or null when the template does not match.
 *
 * A parameter never matches an empty segment and never spans a `/`, so
 * `/v1/devices/` cannot be read as a device id of `""`, and a percent-encoded
 * slash stays inside a single parameter instead of silently re-routing.
 */
function matchSegments(
  segments: readonly Segment[],
  requestSegments: readonly string[],
): Readonly<Record<string, string>> | null {
  if (segments.length !== requestSegments.length) {
    return null;
  }
  const params: Record<string, string> = {};
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const value = requestSegments[index];
    if (segment === undefined || value === undefined) {
      return null;
    }
    if (segment.kind === 'LITERAL') {
      if (segment.value !== value) {
        return null;
      }
      continue;
    }
    const decoded = decodeSegment(value);
    if (decoded === null || decoded === '') {
      return null;
    }
    params[segment.name] = decoded;
  }
  return params;
}

function decodeSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    // A malformed escape sequence is not a match; it is a bad URL.
    return null;
  }
}
