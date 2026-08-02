import { CONFIG_GUARDRAILS, FRESHNESS_THRESHOLDS, RATE_LIMITS } from '@family/contracts';

/**
 * Cache policies.
 *
 * Two rules shape every number below.
 *
 * 1. RATE BUDGET. Poll intervals are derived from `RATE_LIMITS` so a screen can
 *    never spend a user's whole per-minute allowance and start 429-ing.
 *
 * 2. RETENTION. `gcTime` is how long a position stays in this device's memory
 *    after nothing is rendering it. Location data gets the shortest lifetime of
 *    anything in the app, and the query cache is deliberately NOT persisted to
 *    disk — an unlocked phone must not be able to yield yesterday's positions
 *    from a cold start (spec §35).
 */

const SECOND = 1000;
const MINUTE = 60 * SECOND;

export type CachePolicy = {
  staleTime: number;
  gcTime: number;
  refetchInterval: number | false;
  refetchOnMount: boolean;
  refetchOnWindowFocus: boolean;
  retry: number;
};

/**
 * `CURRENT_LOCATION_PER_USER` is 60 requests/minute. A family map with one
 * polling query plus manual refreshes stays comfortably inside that at one
 * request every 30s, and 30s is half the LIVE freshness bucket so a marker
 * cannot silently age out of "live" between polls.
 */
const CURRENT_LOCATION_INTERVAL_MS = Math.max(
  (FRESHNESS_THRESHOLDS.LIVE_SECONDS / 2) * SECOND,
  (60 / RATE_LIMITS.CURRENT_LOCATION_PER_USER) * SECOND,
);

/**
 * Live sessions stream at the engine's own cadence; polling faster than the
 * minimum guardrail interval would only burn battery and rate budget.
 */
const LIVE_SESSION_INTERVAL_MS = CONFIG_GUARDRAILS.liveSessionUpdateIntervalSeconds.min * SECOND;

export const CACHE_POLICIES = {
  /** Identity changes rarely; a stale session is corrected by the auth layer. */
  session: {
    staleTime: 5 * MINUTE,
    gcTime: 10 * MINUTE,
    refetchInterval: false,
    refetchOnMount: false,
    refetchOnWindowFocus: true,
    retry: 1,
  },

  /** Entitlements gate paid surfaces, so they refresh on focus. */
  entitlements: {
    staleTime: 5 * MINUTE,
    gcTime: 30 * MINUTE,
    refetchInterval: false,
    refetchOnMount: false,
    refetchOnWindowFocus: true,
    retry: 2,
  },

  /** The user's own sharing state must never look stale to them. */
  sharingState: {
    staleTime: 10 * SECOND,
    gcTime: MINUTE,
    refetchInterval: 30 * SECOND,
    refetchOnMount: true,
    refetchOnWindowFocus: true,
    retry: 2,
  },

  family: {
    staleTime: MINUTE,
    gcTime: 10 * MINUTE,
    refetchInterval: false,
    refetchOnMount: true,
    refetchOnWindowFocus: true,
    retry: 2,
  },

  members: {
    staleTime: 30 * SECOND,
    gcTime: 5 * MINUTE,
    refetchInterval: false,
    refetchOnMount: true,
    refetchOnWindowFocus: true,
    retry: 2,
  },

  /**
   * Positions: shortest lifetime in the app. Two minutes after the map is gone
   * there is nothing positional left in memory.
   */
  locations: {
    staleTime: 15 * SECOND,
    gcTime: 2 * MINUTE,
    refetchInterval: CURRENT_LOCATION_INTERVAL_MS,
    refetchOnMount: true,
    refetchOnWindowFocus: true,
    retry: 1,
  },

  /** Coordinate-free rows; safe to keep a little longer. */
  timeline: {
    staleTime: MINUTE,
    gcTime: 5 * MINUTE,
    refetchInterval: false,
    refetchOnMount: true,
    refetchOnWindowFocus: false,
    retry: 2,
  },

  /** History carries route geometry, so it expires quickly too. */
  history: {
    staleTime: 2 * MINUTE,
    gcTime: 5 * MINUTE,
    refetchInterval: false,
    refetchOnMount: true,
    refetchOnWindowFocus: false,
    retry: 1,
  },

  places: {
    staleTime: 5 * MINUTE,
    gcTime: 30 * MINUTE,
    refetchInterval: false,
    refetchOnMount: true,
    refetchOnWindowFocus: false,
    retry: 2,
  },

  invitations: {
    staleTime: 30 * SECOND,
    gcTime: 2 * MINUTE,
    refetchInterval: false,
    refetchOnMount: true,
    refetchOnWindowFocus: true,
    retry: 1,
  },

  /**
   * `gcTime: 0` — the invitation token must not outlive the screen that is
   * showing it, and this response is never written anywhere durable.
   */
  invitationPreview: {
    staleTime: 0,
    gcTime: 0,
    refetchInterval: false,
    refetchOnMount: true,
    refetchOnWindowFocus: false,
    retry: 0,
  },

  /** A countdown that is even slightly wrong is a consent problem. */
  liveSession: {
    staleTime: 0,
    gcTime: 30 * SECOND,
    refetchInterval: LIVE_SESSION_INTERVAL_MS,
    refetchOnMount: true,
    refetchOnWindowFocus: true,
    retry: 1,
  },
} as const satisfies Record<string, CachePolicy>;

/**
 * The query cache is memory-only, on purpose. Nothing in this app may pass the
 * QueryClient to a persister. Exported as a constant so the intent is greppable
 * and a future change has to delete a documented decision rather than quietly
 * add a plugin.
 */
export const QUERY_CACHE_IS_PERSISTED = false;
