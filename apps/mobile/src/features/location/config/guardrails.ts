import {
  CONFIG_GUARDRAILS,
  LIMITS,
  type LocationEngineConfig,
  TRACKING_STATES,
} from '@family/contracts';
import { clampConfig } from '@family/location-core';

import { cloneEngineConfig, DEFAULT_RETRY_POLICY, SAFE_DEFAULT_ENGINE_CONFIG } from './defaults';

/**
 * Guardrail enforcement for remote configuration (spec §30).
 *
 * `clampConfig` from `@family/location-core` is the shared clamp used by every
 * client, and it runs first. This module then *re-asserts* the result against
 * CONFIG_GUARDRAILS itself.
 *
 * That is not redundancy for its own sake. Remote configuration is attacker-
 * reachable input on the exact code path that governs how often a phone wakes
 * its GPS, and the native engine clamps a third time. Three independent clamps
 * mean a bug in any one of them cannot produce a battery-draining or privacy-
 * weakening config on a real device.
 */

export type ConfigAdjustment = {
  /** Dotted path, e.g. `distanceFilters.WALKING`. */
  field: string;
  received: number;
  applied: number;
};

export type GuardrailResult = {
  config: LocationEngineConfig;
  adjustments: ConfigAdjustment[];
};

type Range = { min: number; max: number };

function clampNumber(
  value: number,
  range: Range,
  fallback: number,
  field: string,
  adjustments: ConfigAdjustment[],
): number {
  if (!Number.isFinite(value)) {
    adjustments.push({ field, received: value, applied: fallback });
    return fallback;
  }
  const applied = Math.min(range.max, Math.max(range.min, value));
  if (applied !== value) {
    adjustments.push({ field, received: value, applied });
  }
  return applied;
}

function clampPerState(
  values: Record<string, number>,
  range: Range,
  fallbacks: Record<string, number>,
  prefix: string,
  adjustments: ConfigAdjustment[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const state of TRACKING_STATES) {
    const fallback = fallbacks[state] ?? range.max;
    const received = values[state];
    if (typeof received !== 'number') {
      adjustments.push({ field: `${prefix}.${state}`, received: Number.NaN, applied: fallback });
      out[state] = fallback;
      continue;
    }
    out[state] = clampNumber(received, range, fallback, `${prefix}.${state}`, adjustments);
  }
  return out;
}

/**
 * Applies the shared clamp, then enforces every guardrail locally.
 *
 * Never throws: a hostile config is *corrected*, not rejected, because
 * rejecting would leave the device on whatever it was running before, which an
 * attacker could exploit by shipping garbage to pin an old config in place.
 */
export function enforceGuardrails(candidate: LocationEngineConfig): GuardrailResult {
  const adjustments: ConfigAdjustment[] = [];
  // clampConfig reports what it changed alongside the config; the local
  // guardrail pass below re-derives its own adjustment list, so only the
  // corrected config is carried forward here.
  const shared = cloneEngineConfig(clampConfig(cloneEngineConfig(candidate)).config);

  const distanceFilters = clampPerState(
    shared.distanceFilters,
    CONFIG_GUARDRAILS.distanceFilterMeters,
    SAFE_DEFAULT_ENGINE_CONFIG.distanceFilters,
    'distanceFilters',
    adjustments,
  ) as LocationEngineConfig['distanceFilters'];

  const targetFreshnessSeconds = clampPerState(
    shared.targetFreshnessSeconds,
    CONFIG_GUARDRAILS.targetFreshnessSeconds,
    SAFE_DEFAULT_ENGINE_CONFIG.targetFreshnessSeconds,
    'targetFreshnessSeconds',
    adjustments,
  ) as LocationEngineConfig['targetFreshnessSeconds'];

  const lowBatteryThreshold = clampNumber(
    shared.lowBatteryThreshold,
    CONFIG_GUARDRAILS.lowBatteryThreshold,
    SAFE_DEFAULT_ENGINE_CONFIG.lowBatteryThreshold,
    'lowBatteryThreshold',
    adjustments,
  );

  let criticalBatteryThreshold = clampNumber(
    shared.criticalBatteryThreshold,
    CONFIG_GUARDRAILS.criticalBatteryThreshold,
    SAFE_DEFAULT_ENGINE_CONFIG.criticalBatteryThreshold,
    'criticalBatteryThreshold',
    adjustments,
  );
  if (criticalBatteryThreshold >= lowBatteryThreshold) {
    // An inverted pair would make the engine flip between LOW_BATTERY and
    // CRITICAL_BATTERY on every reading.
    adjustments.push({
      field: 'criticalBatteryThreshold',
      received: criticalBatteryThreshold,
      applied: SAFE_DEFAULT_ENGINE_CONFIG.criticalBatteryThreshold,
    });
    criticalBatteryThreshold = SAFE_DEFAULT_ENGINE_CONFIG.criticalBatteryThreshold;
  }

  const retry = {
    baseDelayMs: clampNumber(
      shared.retry?.baseDelayMs ?? Number.NaN,
      { min: 250, max: 60_000 },
      DEFAULT_RETRY_POLICY.baseDelayMs,
      'retry.baseDelayMs',
      adjustments,
    ),
    maxDelayMs: clampNumber(
      shared.retry?.maxDelayMs ?? Number.NaN,
      { min: 1_000, max: 3_600_000 },
      DEFAULT_RETRY_POLICY.maxDelayMs,
      'retry.maxDelayMs',
      adjustments,
    ),
    multiplier: clampNumber(
      shared.retry?.multiplier ?? Number.NaN,
      { min: 1, max: 8 },
      DEFAULT_RETRY_POLICY.multiplier,
      'retry.multiplier',
      adjustments,
    ),
    jitterRatio: clampNumber(
      shared.retry?.jitterRatio ?? Number.NaN,
      { min: 0, max: 1 },
      DEFAULT_RETRY_POLICY.jitterRatio,
      'retry.jitterRatio',
      adjustments,
    ),
    maxAttempts: Math.round(
      clampNumber(
        shared.retry?.maxAttempts ?? Number.NaN,
        { min: 1, max: LIMITS.MAX_UPLOAD_ATTEMPTS },
        DEFAULT_RETRY_POLICY.maxAttempts,
        'retry.maxAttempts',
        adjustments,
      ),
    ),
  };
  if (retry.maxDelayMs < retry.baseDelayMs) {
    adjustments.push({
      field: 'retry.maxDelayMs',
      received: retry.maxDelayMs,
      applied: retry.baseDelayMs,
    });
    retry.maxDelayMs = retry.baseDelayMs;
  }

  const config: LocationEngineConfig = {
    configVersion: Number.isFinite(shared.configVersion)
      ? Math.max(0, Math.floor(shared.configVersion))
      : 0,
    distanceFilters,
    targetFreshnessSeconds,
    maxStaleSeconds: clampNumber(
      shared.maxStaleSeconds,
      CONFIG_GUARDRAILS.maxStaleSeconds,
      SAFE_DEFAULT_ENGINE_CONFIG.maxStaleSeconds,
      'maxStaleSeconds',
      adjustments,
    ),
    liveSessionMaxSeconds: clampNumber(
      shared.liveSessionMaxSeconds,
      {
        min: CONFIG_GUARDRAILS.liveSessionMaxSeconds.min,
        // The platform ceiling wins even if the guardrail were ever loosened.
        max: Math.min(CONFIG_GUARDRAILS.liveSessionMaxSeconds.max, LIMITS.MAX_LIVE_SESSION_SECONDS),
      },
      SAFE_DEFAULT_ENGINE_CONFIG.liveSessionMaxSeconds,
      'liveSessionMaxSeconds',
      adjustments,
    ),
    liveSessionUpdateIntervalSeconds: clampNumber(
      shared.liveSessionUpdateIntervalSeconds,
      CONFIG_GUARDRAILS.liveSessionUpdateIntervalSeconds,
      SAFE_DEFAULT_ENGINE_CONFIG.liveSessionUpdateIntervalSeconds,
      'liveSessionUpdateIntervalSeconds',
      adjustments,
    ),
    lowBatteryThreshold,
    criticalBatteryThreshold,
    uploadBatchSize: Math.round(
      clampNumber(
        shared.uploadBatchSize,
        {
          min: CONFIG_GUARDRAILS.uploadBatchSize.min,
          max: Math.min(CONFIG_GUARDRAILS.uploadBatchSize.max, LIMITS.MAX_EVENTS_PER_BATCH),
        },
        SAFE_DEFAULT_ENGINE_CONFIG.uploadBatchSize,
        'uploadBatchSize',
        adjustments,
      ),
    ),
    minUploadIntervalSeconds: clampNumber(
      shared.minUploadIntervalSeconds,
      {
        // Never below the server-enforced floor, or every upload is rate limited.
        min: Math.max(
          CONFIG_GUARDRAILS.minUploadIntervalSeconds.min,
          LIMITS.MIN_UPLOAD_INTERVAL_SECONDS,
        ),
        max: CONFIG_GUARDRAILS.minUploadIntervalSeconds.max,
      },
      SAFE_DEFAULT_ENGINE_CONFIG.minUploadIntervalSeconds,
      'minUploadIntervalSeconds',
      adjustments,
    ),
    retry,
    maxAcceptableAccuracyMeters: clampNumber(
      shared.maxAcceptableAccuracyMeters,
      CONFIG_GUARDRAILS.maxAcceptableAccuracyMeters,
      SAFE_DEFAULT_ENGINE_CONFIG.maxAcceptableAccuracyMeters,
      'maxAcceptableAccuracyMeters',
      adjustments,
    ),
  };

  return { config, adjustments };
}

/** Predicate used by tests and by the provider's post-apply assertion. */
export function isWithinGuardrails(config: LocationEngineConfig): boolean {
  const inRange = (value: number, range: Range): boolean =>
    Number.isFinite(value) && value >= range.min && value <= range.max;

  for (const state of TRACKING_STATES) {
    if (!inRange(config.distanceFilters[state], CONFIG_GUARDRAILS.distanceFilterMeters)) {
      return false;
    }
    if (!inRange(config.targetFreshnessSeconds[state], CONFIG_GUARDRAILS.targetFreshnessSeconds)) {
      return false;
    }
  }

  return (
    inRange(config.maxStaleSeconds, CONFIG_GUARDRAILS.maxStaleSeconds) &&
    inRange(config.liveSessionMaxSeconds, CONFIG_GUARDRAILS.liveSessionMaxSeconds) &&
    config.liveSessionMaxSeconds <= LIMITS.MAX_LIVE_SESSION_SECONDS &&
    inRange(
      config.liveSessionUpdateIntervalSeconds,
      CONFIG_GUARDRAILS.liveSessionUpdateIntervalSeconds,
    ) &&
    inRange(config.lowBatteryThreshold, CONFIG_GUARDRAILS.lowBatteryThreshold) &&
    inRange(config.criticalBatteryThreshold, CONFIG_GUARDRAILS.criticalBatteryThreshold) &&
    config.criticalBatteryThreshold < config.lowBatteryThreshold &&
    inRange(config.uploadBatchSize, CONFIG_GUARDRAILS.uploadBatchSize) &&
    config.uploadBatchSize <= LIMITS.MAX_EVENTS_PER_BATCH &&
    inRange(config.minUploadIntervalSeconds, CONFIG_GUARDRAILS.minUploadIntervalSeconds) &&
    config.minUploadIntervalSeconds >= LIMITS.MIN_UPLOAD_INTERVAL_SECONDS &&
    inRange(config.maxAcceptableAccuracyMeters, CONFIG_GUARDRAILS.maxAcceptableAccuracyMeters) &&
    config.retry.maxAttempts >= 1 &&
    config.retry.maxAttempts <= LIMITS.MAX_UPLOAD_ATTEMPTS &&
    config.retry.jitterRatio >= 0 &&
    config.retry.jitterRatio <= 1 &&
    config.retry.maxDelayMs >= config.retry.baseDelayMs
  );
}
