import {
  ACCEPTANCE,
  BATTERY,
  CONFIG_GUARDRAILS,
  LIMITS,
  TRACKING_STATES,
  type LocationEngineConfig,
  type RetryPolicy,
  type TrackingState,
} from '@family/contracts';

import { finiteOr, isPlainObject, type NumericRange } from './internal.js';
import { DEFAULT_RETRY_POLICY, RETRY_GUARDRAILS } from './queue.js';
import {
  DEFAULT_MAX_STALE_SECONDS,
  TRACKING_POLICY,
  type TrackingPolicy,
} from './state-machine.js';

/**
 * Remote-configuration clamping (spec §30).
 *
 * Configuration arrives over the network. Even signed, it is the single largest
 * remote-control surface in the product: a config that widened
 * `liveSessionMaxSeconds`, disabled the accuracy floor, or made a DISABLED
 * device sample would be a privacy incident, not a bug. So `clampConfig` is
 * written as a *whitelist*: it starts from a known-good base, copies across only
 * values it recognises, and clamps every one of them into `CONFIG_GUARDRAILS`
 * and the hard `LIMITS`. Anything unrecognised, malformed, or out of range is
 * reported and discarded rather than trusted.
 *
 * The function is total: it never throws and always returns a usable config.
 * A device that cannot parse its configuration must keep tracking safely, not
 * fall back to no tracking (which would silently break a family's alerts).
 */

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

function fromPolicy(pick: (policy: TrackingPolicy) => number): Record<TrackingState, number> {
  const out = {} as Record<TrackingState, number>;
  for (const state of TRACKING_STATES) out[state] = pick(TRACKING_POLICY[state]);
  return out;
}

/**
 * The config the device uses before it has ever fetched one, and the base every
 * remote config is merged onto. Derived from the §10 policy table so the two can
 * never drift apart.
 */
export const DEFAULT_LOCATION_ENGINE_CONFIG: LocationEngineConfig = {
  configVersion: 0,
  distanceFilters: fromPolicy((policy) => policy.distanceFilterMeters),
  targetFreshnessSeconds: fromPolicy((policy) => policy.targetFreshnessSeconds),
  maxStaleSeconds: DEFAULT_MAX_STALE_SECONDS,
  liveSessionMaxSeconds: LIMITS.MAX_LIVE_SESSION_SECONDS,
  liveSessionUpdateIntervalSeconds: TRACKING_POLICY.LIVE.targetFreshnessSeconds,
  lowBatteryThreshold: BATTERY.LOW_THRESHOLD,
  criticalBatteryThreshold: BATTERY.CRITICAL_THRESHOLD,
  uploadBatchSize: LIMITS.MAX_EVENTS_PER_BATCH,
  minUploadIntervalSeconds: LIMITS.MIN_UPLOAD_INTERVAL_SECONDS,
  retry: DEFAULT_RETRY_POLICY,
  maxAcceptableAccuracyMeters: ACCEPTANCE.MAX_HORIZONTAL_ACCURACY_METERS,
};

/**
 * States that must never sample, whatever configuration says. Their tunables are
 * pinned to the least aggressive legal values as defence in depth.
 */
const NON_SAMPLING_STATES: readonly TrackingState[] = ['DISABLED', 'PERMISSION_REQUIRED'];

// ---------------------------------------------------------------------------
// Adjustment reporting
// ---------------------------------------------------------------------------

export type ConfigAdjustmentReason =
  | 'INVALID'
  | 'BELOW_MIN'
  | 'ABOVE_MAX'
  | 'EXCEEDS_PLATFORM_LIMIT'
  | 'UNKNOWN_KEY'
  | 'FORBIDDEN_OVERRIDE'
  | 'INCONSISTENT';

export type ConfigAdjustment = {
  /** Dotted path of the offending field. Contains no values, only field names. */
  readonly path: string;
  readonly reason: ConfigAdjustmentReason;
};

export type ClampConfigResult = {
  readonly config: LocationEngineConfig;
  readonly adjustments: readonly ConfigAdjustment[];
  /** True when the remote config was usable exactly as delivered. */
  readonly accepted: boolean;
};

type Recorder = (path: string, reason: ConfigAdjustmentReason) => void;

/**
 * Read one number out of untrusted input and clamp it.
 *
 * An absent field is not an error: a partial config legitimately inherits the
 * base. A present-but-wrong field always is.
 */
function readClamped(
  raw: unknown,
  range: NumericRange,
  fallback: number,
  path: string,
  record: Recorder,
): number {
  if (raw === undefined || raw === null) return clampToRange(fallback, range);
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    record(path, 'INVALID');
    return clampToRange(fallback, range);
  }
  if (raw < range.min) {
    record(path, 'BELOW_MIN');
    return range.min;
  }
  if (raw > range.max) {
    record(path, 'ABOVE_MAX');
    return range.max;
  }
  return raw;
}

function clampToRange(value: number, range: NumericRange): number {
  if (!Number.isFinite(value)) return range.min;
  return Math.min(range.max, Math.max(range.min, value));
}

/** Apply a hard platform ceiling on top of the guardrail, reporting if it bites. */
function tightenMax(value: number, ceiling: number, path: string, record: Recorder): number {
  if (value > ceiling) {
    record(path, 'EXCEEDS_PLATFORM_LIMIT');
    return ceiling;
  }
  return value;
}

/** Apply a hard platform floor on top of the guardrail, reporting if it bites. */
function tightenMin(value: number, floor: number, path: string, record: Recorder): number {
  if (value < floor) {
    record(path, 'EXCEEDS_PLATFORM_LIMIT');
    return floor;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Per-state records
// ---------------------------------------------------------------------------

function readStateRecord(
  raw: unknown,
  range: NumericRange,
  base: Record<TrackingState, number>,
  path: string,
  record: Recorder,
  pinned: Readonly<Partial<Record<TrackingState, number>>> = {},
): Record<TrackingState, number> {
  const out = {} as Record<TrackingState, number>;

  if (raw !== undefined && raw !== null && !isPlainObject(raw)) {
    record(path, 'INVALID');
    for (const state of TRACKING_STATES) out[state] = clampToRange(base[state], range);
    applyPins(out, pinned, raw, path, record);
    return out;
  }

  const source = isPlainObject(raw) ? raw : {};
  for (const key of Object.keys(source)) {
    if (!(TRACKING_STATES as readonly string[]).includes(key)) {
      record(`${path}.${key}`, 'UNKNOWN_KEY');
    }
  }
  for (const state of TRACKING_STATES) {
    out[state] = readClamped(source[state], range, base[state], `${path}.${state}`, record);
  }
  applyPins(out, pinned, source, path, record);
  return out;
}

function applyPins(
  out: Record<TrackingState, number>,
  pinned: Readonly<Partial<Record<TrackingState, number>>>,
  source: unknown,
  path: string,
  record: Recorder,
): void {
  const provided = isPlainObject(source) ? source : {};
  for (const state of TRACKING_STATES) {
    const pin = pinned[state];
    if (pin === undefined) continue;
    const supplied = provided[state];
    if (typeof supplied === 'number' && supplied !== pin) {
      record(`${path}.${state}`, 'FORBIDDEN_OVERRIDE');
    }
    out[state] = pin;
  }
}

// ---------------------------------------------------------------------------
// Retry policy
// ---------------------------------------------------------------------------

function readRetryPolicy(raw: unknown, base: RetryPolicy, record: Recorder): RetryPolicy {
  if (raw !== undefined && raw !== null && !isPlainObject(raw)) {
    record('retry', 'INVALID');
    return base;
  }
  const source = isPlainObject(raw) ? raw : {};

  const baseDelayMs = readClamped(
    source['baseDelayMs'],
    RETRY_GUARDRAILS.baseDelayMs,
    base.baseDelayMs,
    'retry.baseDelayMs',
    record,
  );
  let maxDelayMs = readClamped(
    source['maxDelayMs'],
    RETRY_GUARDRAILS.maxDelayMs,
    base.maxDelayMs,
    'retry.maxDelayMs',
    record,
  );
  if (maxDelayMs < baseDelayMs) {
    record('retry.maxDelayMs', 'INCONSISTENT');
    maxDelayMs = baseDelayMs;
  }

  const maxAttempts = tightenMax(
    Math.round(
      readClamped(
        source['maxAttempts'],
        RETRY_GUARDRAILS.maxAttempts,
        base.maxAttempts,
        'retry.maxAttempts',
        record,
      ),
    ),
    LIMITS.MAX_UPLOAD_ATTEMPTS,
    'retry.maxAttempts',
    record,
  );

  return {
    baseDelayMs,
    maxDelayMs,
    multiplier: readClamped(
      source['multiplier'],
      RETRY_GUARDRAILS.multiplier,
      base.multiplier,
      'retry.multiplier',
      record,
    ),
    jitterRatio: readClamped(
      source['jitterRatio'],
      RETRY_GUARDRAILS.jitterRatio,
      base.jitterRatio,
      'retry.jitterRatio',
      record,
    ),
    maxAttempts,
  };
}

// ---------------------------------------------------------------------------
// clampConfig
// ---------------------------------------------------------------------------

/**
 * Merge an untrusted remote configuration onto `base` and clamp the result.
 *
 * Guarantees, all covered by tests:
 *  - the returned config always satisfies every range in `CONFIG_GUARDRAILS`;
 *  - it never exceeds the hard `LIMITS` (live session length, batch size, upload
 *    interval, retry attempts) or the `ACCEPTANCE` accuracy ceiling;
 *  - `criticalBatteryThreshold < lowBatteryThreshold` always holds, so the
 *    battery ladder cannot be inverted into "critical never triggers";
 *  - DISABLED and PERMISSION_REQUIRED tunables are pinned regardless of input;
 *  - the LIVE freshness target stays inside the live update-interval guardrail,
 *    so no config can turn a live session into a continuous high-accuracy fix
 *    stream at, say, one second.
 */
export function clampConfig(
  remote: unknown,
  base: LocationEngineConfig = DEFAULT_LOCATION_ENGINE_CONFIG,
): ClampConfigResult {
  const adjustments: ConfigAdjustment[] = [];
  const record: Recorder = (path, reason) => {
    adjustments.push({ path, reason });
  };

  if (remote !== undefined && remote !== null && !isPlainObject(remote)) {
    record('<root>', 'INVALID');
    return { config: normalise(base), adjustments, accepted: false };
  }
  const source = isPlainObject(remote) ? remote : {};

  // --- version -----------------------------------------------------------
  const rawVersion = source['configVersion'];
  let configVersion = base.configVersion;
  if (rawVersion !== undefined && rawVersion !== null) {
    if (typeof rawVersion !== 'number' || !Number.isInteger(rawVersion) || rawVersion < 0) {
      record('configVersion', 'INVALID');
    } else {
      configVersion = rawVersion;
    }
  }

  // --- per-state tunables -------------------------------------------------
  const pinnedDistance: Partial<Record<TrackingState, number>> = {};
  const pinnedFreshness: Partial<Record<TrackingState, number>> = {};
  for (const state of NON_SAMPLING_STATES) {
    pinnedDistance[state] = CONFIG_GUARDRAILS.distanceFilterMeters.max;
    pinnedFreshness[state] = CONFIG_GUARDRAILS.targetFreshnessSeconds.max;
  }

  const distanceFilters = readStateRecord(
    source['distanceFilters'],
    CONFIG_GUARDRAILS.distanceFilterMeters,
    base.distanceFilters,
    'distanceFilters',
    record,
    pinnedDistance,
  );

  const targetFreshnessSeconds = readStateRecord(
    source['targetFreshnessSeconds'],
    CONFIG_GUARDRAILS.targetFreshnessSeconds,
    base.targetFreshnessSeconds,
    'targetFreshnessSeconds',
    record,
    pinnedFreshness,
  );

  // A live session must not be pushed below the live update-interval floor.
  const liveTarget = targetFreshnessSeconds.LIVE;
  const clampedLiveTarget = clampToRange(
    liveTarget,
    CONFIG_GUARDRAILS.liveSessionUpdateIntervalSeconds,
  );
  if (clampedLiveTarget !== liveTarget) {
    record(
      'targetFreshnessSeconds.LIVE',
      liveTarget < CONFIG_GUARDRAILS.liveSessionUpdateIntervalSeconds.min
        ? 'BELOW_MIN'
        : 'ABOVE_MAX',
    );
    targetFreshnessSeconds.LIVE = clampedLiveTarget;
  }

  // --- scalars ------------------------------------------------------------
  const maxStaleSeconds = readClamped(
    source['maxStaleSeconds'],
    CONFIG_GUARDRAILS.maxStaleSeconds,
    base.maxStaleSeconds,
    'maxStaleSeconds',
    record,
  );

  const liveSessionMaxSeconds = tightenMax(
    readClamped(
      source['liveSessionMaxSeconds'],
      CONFIG_GUARDRAILS.liveSessionMaxSeconds,
      base.liveSessionMaxSeconds,
      'liveSessionMaxSeconds',
      record,
    ),
    LIMITS.MAX_LIVE_SESSION_SECONDS,
    'liveSessionMaxSeconds',
    record,
  );

  const liveSessionUpdateIntervalSeconds = readClamped(
    source['liveSessionUpdateIntervalSeconds'],
    CONFIG_GUARDRAILS.liveSessionUpdateIntervalSeconds,
    base.liveSessionUpdateIntervalSeconds,
    'liveSessionUpdateIntervalSeconds',
    record,
  );

  const lowBatteryThreshold = readClamped(
    source['lowBatteryThreshold'],
    CONFIG_GUARDRAILS.lowBatteryThreshold,
    base.lowBatteryThreshold,
    'lowBatteryThreshold',
    record,
  );

  let criticalBatteryThreshold = readClamped(
    source['criticalBatteryThreshold'],
    CONFIG_GUARDRAILS.criticalBatteryThreshold,
    base.criticalBatteryThreshold,
    'criticalBatteryThreshold',
    record,
  );
  if (criticalBatteryThreshold >= lowBatteryThreshold) {
    record('criticalBatteryThreshold', 'INCONSISTENT');
    criticalBatteryThreshold = clampToRange(
      lowBatteryThreshold - BATTERY.RECOVERY_MARGIN,
      CONFIG_GUARDRAILS.criticalBatteryThreshold,
    );
    if (criticalBatteryThreshold >= lowBatteryThreshold) {
      criticalBatteryThreshold = lowBatteryThreshold / 2;
    }
  }

  const uploadBatchSize = tightenMax(
    Math.round(
      readClamped(
        source['uploadBatchSize'],
        CONFIG_GUARDRAILS.uploadBatchSize,
        base.uploadBatchSize,
        'uploadBatchSize',
        record,
      ),
    ),
    LIMITS.MAX_EVENTS_PER_BATCH,
    'uploadBatchSize',
    record,
  );

  const minUploadIntervalSeconds = tightenMin(
    readClamped(
      source['minUploadIntervalSeconds'],
      CONFIG_GUARDRAILS.minUploadIntervalSeconds,
      base.minUploadIntervalSeconds,
      'minUploadIntervalSeconds',
      record,
    ),
    LIMITS.MIN_UPLOAD_INTERVAL_SECONDS,
    'minUploadIntervalSeconds',
    record,
  );

  const maxAcceptableAccuracyMeters = tightenMax(
    readClamped(
      source['maxAcceptableAccuracyMeters'],
      CONFIG_GUARDRAILS.maxAcceptableAccuracyMeters,
      base.maxAcceptableAccuracyMeters,
      'maxAcceptableAccuracyMeters',
      record,
    ),
    ACCEPTANCE.MAX_HORIZONTAL_ACCURACY_METERS,
    'maxAcceptableAccuracyMeters',
    record,
  );

  const retry = readRetryPolicy(source['retry'], base.retry, record);

  for (const key of Object.keys(source)) {
    if (!KNOWN_CONFIG_KEYS.has(key)) record(key, 'UNKNOWN_KEY');
  }

  return {
    config: {
      configVersion,
      distanceFilters,
      targetFreshnessSeconds,
      maxStaleSeconds,
      liveSessionMaxSeconds,
      liveSessionUpdateIntervalSeconds,
      lowBatteryThreshold,
      criticalBatteryThreshold,
      uploadBatchSize,
      minUploadIntervalSeconds,
      retry,
      maxAcceptableAccuracyMeters,
    },
    adjustments,
    accepted: adjustments.length === 0,
  };
}

const KNOWN_CONFIG_KEYS: ReadonlySet<string> = new Set<string>([
  'configVersion',
  'distanceFilters',
  'targetFreshnessSeconds',
  'maxStaleSeconds',
  'liveSessionMaxSeconds',
  'liveSessionUpdateIntervalSeconds',
  'lowBatteryThreshold',
  'criticalBatteryThreshold',
  'uploadBatchSize',
  'minUploadIntervalSeconds',
  'retry',
  'maxAcceptableAccuracyMeters',
]);

/** Clamp a config that is already structurally valid (used for the base). */
function normalise(config: LocationEngineConfig): LocationEngineConfig {
  return clampConfig(undefined, config).config;
}

// ---------------------------------------------------------------------------
// Projection back onto the policy table
// ---------------------------------------------------------------------------

/**
 * Overlay the tunable half of a clamped config onto the static §10 policy.
 *
 * The behavioural flags — continuous GPS, geofences, whether the state may
 * produce location at all — are deliberately *not* configurable. Those are the
 * privacy-bearing parts of the policy and they live in code, where they are
 * reviewed, rather than in a payload fetched at runtime.
 */
export function resolveTrackingPolicy(
  state: TrackingState,
  config: LocationEngineConfig = DEFAULT_LOCATION_ENGINE_CONFIG,
): TrackingPolicy {
  const policy = TRACKING_POLICY[state];
  const target = finiteOr(config.targetFreshnessSeconds[state], policy.targetFreshnessSeconds);
  return {
    ...policy,
    distanceFilterMeters: finiteOr(config.distanceFilters[state], policy.distanceFilterMeters),
    targetFreshnessSeconds: target,
    freshnessWindowSeconds: {
      min: Math.min(policy.freshnessWindowSeconds.min, target),
      max: Math.max(policy.freshnessWindowSeconds.max, target),
    },
  };
}
