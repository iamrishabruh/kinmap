import {
  BATTERY,
  CONFIG_GUARDRAILS,
  LIMITS,
  type LocationEngineConfig,
  type RetryPolicy,
  type TrackingState,
} from '@family/contracts';

/**
 * The configuration the engine runs on when there is no trusted remote config:
 * first launch, an unverifiable signature, an unreachable config endpoint, or a
 * payload we could not parse.
 *
 * These values are deliberately conservative. Falling back to *tight* intervals
 * would drain a battery on the exact code path that runs when the backend is
 * broken, so every default here errs towards fewer fixes and longer waits.
 *
 * Every value is inside CONFIG_GUARDRAILS by construction, and
 * `config/guardrails.ts` asserts that in a test.
 */

/** Metres of movement required before a new fix is worth recording. */
const DEFAULT_DISTANCE_FILTERS: Record<TrackingState, number> = {
  DISABLED: CONFIG_GUARDRAILS.distanceFilterMeters.max,
  PERMISSION_REQUIRED: CONFIG_GUARDRAILS.distanceFilterMeters.max,
  STATIONARY: 250,
  PASSIVE: 150,
  WALKING: 60,
  TRANSIT: 250,
  LIVE: CONFIG_GUARDRAILS.distanceFilterMeters.min,
  LOW_BATTERY: 500,
  CRITICAL_BATTERY: 2000,
  OFFLINE: 150,
  STALE: 150,
};

/** Best-effort target seconds between stored points. Never a promise (spec §9). */
const DEFAULT_TARGET_FRESHNESS_SECONDS: Record<TrackingState, number> = {
  DISABLED: CONFIG_GUARDRAILS.targetFreshnessSeconds.max,
  PERMISSION_REQUIRED: CONFIG_GUARDRAILS.targetFreshnessSeconds.max,
  STATIONARY: 900,
  PASSIVE: 300,
  WALKING: 120,
  TRANSIT: 120,
  LIVE: 15,
  LOW_BATTERY: 1800,
  CRITICAL_BATTERY: 3600,
  OFFLINE: 300,
  STALE: 300,
};

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  baseDelayMs: 2_000,
  maxDelayMs: 300_000,
  multiplier: 2,
  /** ±30 % so a fleet coming back online after an outage does not synchronise. */
  jitterRatio: 0.3,
  maxAttempts: LIMITS.MAX_UPLOAD_ATTEMPTS,
};

/**
 * `configVersion: 0` is reserved for the built-in defaults, so any signed
 * config the backend issues (version >= 1) supersedes it and a rollback to
 * defaults is visible in device health.
 */
export const SAFE_DEFAULT_ENGINE_CONFIG: LocationEngineConfig = {
  configVersion: 0,
  distanceFilters: DEFAULT_DISTANCE_FILTERS,
  targetFreshnessSeconds: DEFAULT_TARGET_FRESHNESS_SECONDS,
  maxStaleSeconds: 3_600,
  liveSessionMaxSeconds: LIMITS.MAX_LIVE_SESSION_SECONDS,
  liveSessionUpdateIntervalSeconds: 15,
  lowBatteryThreshold: BATTERY.LOW_THRESHOLD,
  criticalBatteryThreshold: BATTERY.CRITICAL_THRESHOLD,
  uploadBatchSize: 50,
  minUploadIntervalSeconds: LIMITS.MIN_UPLOAD_INTERVAL_SECONDS,
  retry: DEFAULT_RETRY_POLICY,
  maxAcceptableAccuracyMeters: 200,
};

/** Defensive copy: callers mutate their config object at their peril. */
export function cloneEngineConfig(config: LocationEngineConfig): LocationEngineConfig {
  return {
    ...config,
    distanceFilters: { ...config.distanceFilters },
    targetFreshnessSeconds: { ...config.targetFreshnessSeconds },
    retry: { ...config.retry },
  };
}
