import {
  BATTERY,
  CONFIG_GUARDRAILS,
  FRESHNESS_THRESHOLDS,
  LIMITS,
  LOCATION_PRODUCING_STATES,
  type LocationPermissionState,
  type MotionState,
  type SharingStatus,
  type TrackingState,
} from '@family/contracts';

import { assertNever, clampInto } from './internal.js';

/**
 * The tracking state machine (spec §10).
 *
 * The eleven states in `TrackingStateSchema` mix six orthogonal concerns:
 * consent, OS permission, battery, connectivity, staleness and motion. Encoding
 * that as 11 × 11 hand-written edges would be both unreadable and unprovable, so
 * the machine is modelled as:
 *
 *   1. a `TrackingContext` holding the orthogonal facts, and
 *   2. a total, pure reducer `(context, event) => context`, and
 *   3. a single strict precedence ladder that derives the one reported
 *      `TrackingState` from the context.
 *
 * The ladder is what makes the safety invariants provable rather than merely
 * tested: a state that is unreachable in the ladder is unreachable, full stop.
 *
 *   DISABLED > PERMISSION_REQUIRED > CRITICAL_BATTERY > LIVE > LOW_BATTERY
 *            > OFFLINE > STALE > {STATIONARY | WALKING | TRANSIT | PASSIVE}
 *
 * Precedence notes:
 *  - DISABLED outranks PERMISSION_REQUIRED. Both suppress all location output,
 *    so neither ordering can leak a fix; consent is reported first because it is
 *    the user's own decision and the more durable of the two.
 *  - CRITICAL_BATTERY outranks LIVE. This is the mechanism that makes
 *    "critical battery forbids LIVE" true even for a session already running.
 *  - LIVE outranks LOW_BATTERY: low battery shortens a session, it does not
 *    forbid one.
 *  - OFFLINE outranks STALE because it is the cause rather than the symptom.
 *
 * NOTHING IN THIS MODULE MAY LOG. It never receives a coordinate — only the
 * timestamp at which one was recorded.
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** Hysteretic battery banding. Derived from level; never stored by the OS. */
export type BatteryTier = 'NORMAL' | 'LOW' | 'CRITICAL';

export type Connectivity = 'ONLINE' | 'OFFLINE';

/** The user's own consent decision, independent of OS permission. */
export type SharingConsent = 'NEVER_ENABLED' | 'SHARING' | 'PAUSED' | 'DISABLED';

/** What primarily causes a fix to be recorded in a given state. */
export type CaptureTrigger = 'NONE' | 'TIME' | 'DISTANCE' | 'SIGNIFICANT_CHANGE';

export type DesiredAccuracy = 'NONE' | 'LOW' | 'BALANCED' | 'HIGH';

export type LiveSessionRejection =
  | 'SHARING_DISABLED'
  | 'PERMISSION_REQUIRED'
  | 'CRITICAL_BATTERY'
  | 'ALREADY_ACTIVE'
  | 'INVALID_DURATION';

export type LiveSessionEndReason =
  'EXPIRED' | 'STOPPED' | 'CRITICAL_BATTERY' | 'SHARING_DISABLED' | 'PERMISSION_REQUIRED';

export type LiveSession = {
  readonly sessionId: string;
  readonly startedAtMs: number;
  readonly expiresAtMs: number;
  readonly grantedDurationSeconds: number;
  readonly requestedDurationSeconds: number;
  /** Ambient state the machine returns to when the session ends. */
  readonly ambientStateAtStart: TrackingState;
};

// ---------------------------------------------------------------------------
// Tunables owned by this module (config.ts builds its defaults from these)
// ---------------------------------------------------------------------------

/**
 * Device-side staleness threshold. Deliberately equal to the viewer-side
 * `RECENT` boundary so "the device thinks it is stale" and "the viewer sees
 * STALE" agree.
 */
export const DEFAULT_MAX_STALE_SECONDS: number = FRESHNESS_THRESHOLDS.RECENT_SECONDS;

/**
 * A live session started while the battery is LOW is granted half the normal
 * ceiling. It is shortened, never rejected — rejection is reserved for CRITICAL.
 */
export const LIVE_SESSION_LOW_BATTERY_MAX_SECONDS: number = Math.floor(
  LIMITS.MAX_LIVE_SESSION_SECONDS / 2,
);

// ---------------------------------------------------------------------------
// Policy table (spec §10)
// ---------------------------------------------------------------------------

export type TrackingPolicy = {
  readonly state: TrackingState;
  readonly desiredAccuracy: DesiredAccuracy;
  readonly distanceFilterMeters: number;
  /** Best-effort seconds between stored points. Feeds `LocationEngineConfig`. */
  readonly targetFreshnessSeconds: number;
  /** The acceptable band around the target, i.e. the §10 "30-60 min" ranges. */
  readonly freshnessWindowSeconds: { readonly min: number; readonly max: number };
  readonly primaryTrigger: CaptureTrigger;
  /** Only LIVE may hold the GPS chip open continuously. */
  readonly continuousGpsAllowed: boolean;
  readonly geofencesActive: boolean;
  readonly significantChangeMonitoringActive: boolean;
  /** Whether the engine may obtain a fix at all (into the local queue). */
  readonly capturesLocation: boolean;
  /**
   * Whether this state may emit a stored, uploadable location. Mirrors
   * `LOCATION_PRODUCING_STATES` exactly — OFFLINE and STALE capture into the
   * queue but by definition have no fresh location to publish.
   */
  readonly locationOutputAllowed: boolean;
  readonly uploadsAllowed: boolean;
};

const NO_CAPTURE = {
  desiredAccuracy: 'NONE',
  // Guardrail maxima: the least aggressive legal values, so that even a bug
  // that hands these to the native layer cannot cause sampling.
  distanceFilterMeters: CONFIG_GUARDRAILS.distanceFilterMeters.max,
  targetFreshnessSeconds: CONFIG_GUARDRAILS.targetFreshnessSeconds.max,
  freshnessWindowSeconds: {
    min: CONFIG_GUARDRAILS.targetFreshnessSeconds.max,
    max: CONFIG_GUARDRAILS.targetFreshnessSeconds.max,
  },
  primaryTrigger: 'NONE',
  continuousGpsAllowed: false,
  geofencesActive: false,
  significantChangeMonitoringActive: false,
  capturesLocation: false,
  locationOutputAllowed: false,
  uploadsAllowed: false,
} as const satisfies Omit<TrackingPolicy, 'state'>;

export const TRACKING_POLICY: Readonly<Record<TrackingState, TrackingPolicy>> = {
  DISABLED: { state: 'DISABLED', ...NO_CAPTURE },
  PERMISSION_REQUIRED: { state: 'PERMISSION_REQUIRED', ...NO_CAPTURE },

  /** §10 stationary: no continuous GPS, 30-60 minute heartbeat. */
  STATIONARY: {
    state: 'STATIONARY',
    desiredAccuracy: 'LOW',
    distanceFilterMeters: 250,
    targetFreshnessSeconds: 2700,
    freshnessWindowSeconds: { min: 1800, max: 3600 },
    primaryTrigger: 'SIGNIFICANT_CHANGE',
    continuousGpsAllowed: false,
    geofencesActive: true,
    significantChangeMonitoringActive: true,
    capturesLocation: true,
    locationOutputAllowed: true,
    uploadsAllowed: true,
  },

  /** §10 passive: balanced accuracy, 5-10 minutes. */
  PASSIVE: {
    state: 'PASSIVE',
    desiredAccuracy: 'BALANCED',
    distanceFilterMeters: 150,
    targetFreshnessSeconds: 450,
    freshnessWindowSeconds: { min: 300, max: 600 },
    primaryTrigger: 'TIME',
    continuousGpsAllowed: false,
    geofencesActive: true,
    significantChangeMonitoringActive: true,
    capturesLocation: true,
    locationOutputAllowed: true,
    uploadsAllowed: true,
  },

  /** §10 walking: moderate accuracy, distance-driven rather than time-driven. */
  WALKING: {
    state: 'WALKING',
    desiredAccuracy: 'BALANCED',
    distanceFilterMeters: 50,
    targetFreshnessSeconds: 300,
    freshnessWindowSeconds: { min: 120, max: 600 },
    primaryTrigger: 'DISTANCE',
    continuousGpsAllowed: false,
    geofencesActive: true,
    significantChangeMonitoringActive: true,
    capturesLocation: true,
    locationOutputAllowed: true,
    uploadsAllowed: true,
  },

  /** §10 transit: 2-5 minutes. */
  TRANSIT: {
    state: 'TRANSIT',
    desiredAccuracy: 'BALANCED',
    distanceFilterMeters: 250,
    targetFreshnessSeconds: 210,
    freshnessWindowSeconds: { min: 120, max: 300 },
    primaryTrigger: 'TIME',
    continuousGpsAllowed: false,
    geofencesActive: true,
    significantChangeMonitoringActive: true,
    capturesLocation: true,
    locationOutputAllowed: true,
    uploadsAllowed: true,
  },

  /** §10 live: high accuracy, 10-30 seconds. The only continuous-GPS state. */
  LIVE: {
    state: 'LIVE',
    desiredAccuracy: 'HIGH',
    distanceFilterMeters: CONFIG_GUARDRAILS.distanceFilterMeters.min,
    targetFreshnessSeconds: 15,
    freshnessWindowSeconds: {
      min: CONFIG_GUARDRAILS.liveSessionUpdateIntervalSeconds.min,
      max: CONFIG_GUARDRAILS.liveSessionUpdateIntervalSeconds.max,
    },
    primaryTrigger: 'TIME',
    continuousGpsAllowed: true,
    geofencesActive: true,
    // Significant-change monitoring is redundant while streaming.
    significantChangeMonitoringActive: false,
    capturesLocation: true,
    locationOutputAllowed: true,
    uploadsAllowed: true,
  },

  LOW_BATTERY: {
    state: 'LOW_BATTERY',
    desiredAccuracy: 'LOW',
    distanceFilterMeters: 500,
    targetFreshnessSeconds: 1800,
    freshnessWindowSeconds: { min: 900, max: 3600 },
    primaryTrigger: 'SIGNIFICANT_CHANGE',
    continuousGpsAllowed: false,
    geofencesActive: true,
    significantChangeMonitoringActive: true,
    capturesLocation: true,
    locationOutputAllowed: true,
    uploadsAllowed: true,
  },

  CRITICAL_BATTERY: {
    state: 'CRITICAL_BATTERY',
    desiredAccuracy: 'LOW',
    distanceFilterMeters: 1000,
    targetFreshnessSeconds: 3600,
    freshnessWindowSeconds: { min: 1800, max: 3600 },
    primaryTrigger: 'SIGNIFICANT_CHANGE',
    continuousGpsAllowed: false,
    // Geofence and significant-change monitoring are OS-managed and effectively
    // free; keeping them is cheaper than losing arrival alerts entirely.
    geofencesActive: true,
    significantChangeMonitoringActive: true,
    capturesLocation: true,
    locationOutputAllowed: true,
    uploadsAllowed: true,
  },

  /** Capture continues into the encrypted local queue; nothing can be sent. */
  OFFLINE: {
    state: 'OFFLINE',
    desiredAccuracy: 'BALANCED',
    distanceFilterMeters: 150,
    targetFreshnessSeconds: 600,
    freshnessWindowSeconds: { min: 300, max: 900 },
    primaryTrigger: 'TIME',
    continuousGpsAllowed: false,
    geofencesActive: true,
    significantChangeMonitoringActive: true,
    capturesLocation: true,
    locationOutputAllowed: false,
    uploadsAllowed: false,
  },

  /** Actively trying to reacquire; leaves the moment a fix is recorded. */
  STALE: {
    state: 'STALE',
    desiredAccuracy: 'BALANCED',
    distanceFilterMeters: 100,
    targetFreshnessSeconds: 300,
    freshnessWindowSeconds: { min: 120, max: 600 },
    primaryTrigger: 'TIME',
    continuousGpsAllowed: false,
    geofencesActive: true,
    significantChangeMonitoringActive: true,
    capturesLocation: true,
    locationOutputAllowed: false,
    uploadsAllowed: true,
  },
};

export function trackingPolicyFor(state: TrackingState): TrackingPolicy {
  return TRACKING_POLICY[state];
}

export function isLocationProducing(state: TrackingState): boolean {
  return LOCATION_PRODUCING_STATES.includes(state);
}

// ---------------------------------------------------------------------------
// Permission evaluation
// ---------------------------------------------------------------------------

export const UNKNOWN_PERMISSION_STATE: LocationPermissionState = {
  authorization: 'NOT_DETERMINED',
  preciseLocationEnabled: false,
  locationServicesEnabled: false,
  notificationsEnabled: false,
  backgroundRefreshEnabled: false,
  foregroundServicePermissionGranted: null,
  batteryOptimizationIgnored: null,
};

/**
 * Hard blockers only. Anything the OS still lets us sample under — coarse
 * location, no background refresh, notifications off — is a *degradation*, not
 * a block; reporting those as PERMISSION_REQUIRED would train users to ignore
 * the prompt.
 */
export function isPermissionSufficient(permission: LocationPermissionState): boolean {
  if (!permission.locationServicesEnabled) return false;
  switch (permission.authorization) {
    case 'ALWAYS':
    case 'WHEN_IN_USE':
      return true;
    case 'NOT_DETERMINED':
    case 'DENIED':
    case 'RESTRICTED':
      return false;
    default:
      return assertNever(permission.authorization, 'Unhandled location authorization');
  }
}

export type PermissionDegradation =
  | 'WHEN_IN_USE_ONLY'
  | 'BACKGROUND_REFRESH_DISABLED'
  | 'PRECISE_LOCATION_DISABLED'
  | 'NOTIFICATIONS_DISABLED'
  | 'FOREGROUND_SERVICE_DENIED'
  | 'BATTERY_OPTIMIZATION_ACTIVE';

/**
 * Soft problems worth surfacing in the UI. Order is stable so the app can show
 * the first item as the primary nudge.
 */
export function permissionDegradations(
  permission: LocationPermissionState,
): readonly PermissionDegradation[] {
  const out: PermissionDegradation[] = [];
  if (!isPermissionSufficient(permission)) return out;
  if (permission.authorization === 'WHEN_IN_USE') out.push('WHEN_IN_USE_ONLY');
  if (!permission.backgroundRefreshEnabled) out.push('BACKGROUND_REFRESH_DISABLED');
  if (permission.foregroundServicePermissionGranted === false) {
    out.push('FOREGROUND_SERVICE_DENIED');
  }
  if (permission.batteryOptimizationIgnored === false) out.push('BATTERY_OPTIMIZATION_ACTIVE');
  if (!permission.preciseLocationEnabled) out.push('PRECISE_LOCATION_DISABLED');
  if (!permission.notificationsEnabled) out.push('NOTIFICATIONS_DISABLED');
  return out;
}

// ---------------------------------------------------------------------------
// Battery banding with hysteresis
// ---------------------------------------------------------------------------

/**
 * Band a battery level, holding the previous band until the level has recovered
 * past `BATTERY.RECOVERY_MARGIN`. Without the margin a device resting on a
 * threshold flaps between bands on every OS callback, which in turn flaps the
 * sampling policy and burns the very battery we are protecting.
 *
 * Entering a worse band is immediate (`<=` the raw threshold); leaving one
 * requires clearing `threshold + RECOVERY_MARGIN`.
 *
 * A null/unknown level holds the current band rather than optimistically
 * assuming NORMAL.
 */
export function nextBatteryTier(current: BatteryTier, level: number | null): BatteryTier {
  if (level === null || !Number.isFinite(level)) return current;
  const value = Math.min(1, Math.max(0, level));
  const margin = BATTERY.RECOVERY_MARGIN;
  const leaveCritical = BATTERY.CRITICAL_THRESHOLD + margin;
  const leaveLow = BATTERY.LOW_THRESHOLD + margin;

  switch (current) {
    case 'CRITICAL':
      if (value >= leaveLow) return 'NORMAL';
      if (value >= leaveCritical) return 'LOW';
      return 'CRITICAL';
    case 'LOW':
      if (value <= BATTERY.CRITICAL_THRESHOLD) return 'CRITICAL';
      if (value >= leaveLow) return 'NORMAL';
      return 'LOW';
    case 'NORMAL':
      if (value <= BATTERY.CRITICAL_THRESHOLD) return 'CRITICAL';
      if (value <= BATTERY.LOW_THRESHOLD) return 'LOW';
      return 'NORMAL';
    default:
      return assertNever(current, 'Unhandled battery tier');
  }
}

/**
 * OS Low Power Mode floors the band at LOW: the OS is already throttling our
 * background work, so pretending we are in a normal duty cycle just produces
 * missed fixes. It is applied *after* hysteresis so that toggling Low Power
 * Mode can never perturb the hysteretic band derived from the level.
 */
export function effectiveBatteryTier(tier: BatteryTier, isLowPowerMode: boolean): BatteryTier {
  if (!isLowPowerMode) return tier;
  return tier === 'NORMAL' ? 'LOW' : tier;
}

// ---------------------------------------------------------------------------
// Motion mapping
// ---------------------------------------------------------------------------

export function ambientStateFor(motion: MotionState): TrackingState {
  switch (motion) {
    case 'STATIONARY':
      return 'STATIONARY';
    case 'WALKING':
    case 'RUNNING':
      return 'WALKING';
    case 'CYCLING':
    case 'AUTOMOTIVE':
      return 'TRANSIT';
    case 'UNKNOWN':
      return 'PASSIVE';
    default:
      return assertNever(motion, 'Unhandled motion state');
  }
}

// ---------------------------------------------------------------------------
// Context and events
// ---------------------------------------------------------------------------

export type TrackingContext = {
  /** Derived. Never assign directly — it is recomputed on every reduction. */
  readonly state: TrackingState;
  readonly sharing: SharingConsent;
  readonly permission: LocationPermissionState;
  readonly motion: MotionState;
  readonly batteryLevel: number | null;
  /** Hysteretic band derived from `batteryLevel`, excluding Low Power Mode. */
  readonly batteryTier: BatteryTier;
  readonly isCharging: boolean | null;
  readonly isLowPowerMode: boolean;
  readonly connectivity: Connectivity;
  readonly liveSession: LiveSession | null;
  readonly lastFixAtMs: number | null;
  /** When tracking last became permitted; the staleness clock's origin. */
  readonly enabledAtMs: number | null;
  readonly isStale: boolean;
  readonly maxStaleSeconds: number;
  readonly nowMs: number;
  readonly lastLiveRejection: LiveSessionRejection | null;
  readonly lastLiveEndReason: LiveSessionEndReason | null;
};

export type TrackingEvent =
  | {
      readonly type: 'PERMISSION_CHANGED';
      readonly permission: LocationPermissionState;
      readonly atMs: number;
    }
  | { readonly type: 'SHARING_RESUMED'; readonly atMs: number }
  | { readonly type: 'SHARING_PAUSED'; readonly atMs: number }
  | { readonly type: 'SHARING_DISABLED'; readonly atMs: number }
  | { readonly type: 'MOTION_CHANGED'; readonly motion: MotionState; readonly atMs: number }
  | {
      readonly type: 'BATTERY_CHANGED';
      readonly level: number | null;
      readonly isCharging: boolean | null;
      readonly isLowPowerMode: boolean;
      readonly atMs: number;
    }
  | { readonly type: 'CONNECTIVITY_CHANGED'; readonly online: boolean; readonly atMs: number }
  | {
      readonly type: 'LIVE_SESSION_STARTED';
      readonly sessionId: string;
      readonly requestedDurationSeconds: number;
      readonly atMs: number;
    }
  | { readonly type: 'LIVE_SESSION_STOPPED'; readonly atMs: number }
  | { readonly type: 'LOCATION_RECORDED'; readonly atMs: number }
  | { readonly type: 'CONFIG_CHANGED'; readonly maxStaleSeconds: number; readonly atMs: number }
  | { readonly type: 'TICK'; readonly atMs: number };

export type TrackingEventType = TrackingEvent['type'];

export const TRACKING_EVENT_TYPES: readonly TrackingEventType[] = [
  'PERMISSION_CHANGED',
  'SHARING_RESUMED',
  'SHARING_PAUSED',
  'SHARING_DISABLED',
  'MOTION_CHANGED',
  'BATTERY_CHANGED',
  'CONNECTIVITY_CHANGED',
  'LIVE_SESSION_STARTED',
  'LIVE_SESSION_STOPPED',
  'LOCATION_RECORDED',
  'CONFIG_CHANGED',
  'TICK',
];

/**
 * The only events that may move the machine *out* of an absorbing state. Both
 * represent an explicit act of consent: granting an OS permission, or turning
 * sharing back on. Everything else is inert while absorbed.
 */
export const CONSENT_EVENT_TYPES: readonly TrackingEventType[] = [
  'PERMISSION_CHANGED',
  'SHARING_RESUMED',
];

export type TrackingContextInit = {
  readonly nowMs: number;
  readonly sharing?: SharingConsent;
  readonly permission?: LocationPermissionState;
  readonly motion?: MotionState;
  readonly batteryLevel?: number | null;
  readonly batteryTier?: BatteryTier;
  readonly isCharging?: boolean | null;
  readonly isLowPowerMode?: boolean;
  readonly connectivity?: Connectivity;
  readonly liveSession?: LiveSession | null;
  readonly lastFixAtMs?: number | null;
  readonly enabledAtMs?: number | null;
  readonly maxStaleSeconds?: number;
};

/**
 * Build a fully derived context. `nowMs` is required so that construction —
 * including rehydration from disk on app launch — stays pure and testable.
 */
export function createTrackingContext(init: TrackingContextInit): TrackingContext {
  const batteryLevel = init.batteryLevel ?? null;
  const seeded: TrackingContext = {
    state: 'DISABLED',
    sharing: init.sharing ?? 'NEVER_ENABLED',
    permission: init.permission ?? UNKNOWN_PERMISSION_STATE,
    motion: init.motion ?? 'UNKNOWN',
    batteryLevel,
    batteryTier: init.batteryTier ?? nextBatteryTier('NORMAL', batteryLevel),
    isCharging: init.isCharging ?? null,
    isLowPowerMode: init.isLowPowerMode ?? false,
    connectivity: init.connectivity ?? 'ONLINE',
    liveSession: init.liveSession ?? null,
    lastFixAtMs: init.lastFixAtMs ?? null,
    enabledAtMs: init.enabledAtMs ?? null,
    isStale: false,
    maxStaleSeconds: clampInto(
      init.maxStaleSeconds ?? DEFAULT_MAX_STALE_SECONDS,
      CONFIG_GUARDRAILS.maxStaleSeconds,
    ),
    nowMs: init.nowMs,
    lastLiveRejection: null,
    lastLiveEndReason: null,
  };
  return derive(expireLiveSession(seeded, init.nowMs), init.nowMs);
}

// ---------------------------------------------------------------------------
// Live session admission
// ---------------------------------------------------------------------------

/**
 * Clamp a requested live-session duration. The client never gets more than
 * `LIMITS.MAX_LIVE_SESSION_SECONDS`, and only half of that on a LOW battery.
 */
export function grantedLiveSessionSeconds(requestedSeconds: number, tier: BatteryTier): number {
  const ceiling =
    tier === 'LOW' ? LIVE_SESSION_LOW_BATTERY_MAX_SECONDS : LIMITS.MAX_LIVE_SESSION_SECONDS;
  const requested = Math.floor(requestedSeconds);
  return Math.min(Math.max(1, requested), ceiling);
}

/** Why a live session may not start now, or null if it may. */
export function liveSessionRejection(
  ctx: TrackingContext,
  requestedDurationSeconds: number,
): LiveSessionRejection | null {
  if (ctx.sharing !== 'SHARING') return 'SHARING_DISABLED';
  if (!isPermissionSufficient(ctx.permission)) return 'PERMISSION_REQUIRED';
  if (effectiveBatteryTier(ctx.batteryTier, ctx.isLowPowerMode) === 'CRITICAL') {
    return 'CRITICAL_BATTERY';
  }
  if (ctx.liveSession !== null) return 'ALREADY_ACTIVE';
  if (!Number.isFinite(requestedDurationSeconds) || requestedDurationSeconds <= 0) {
    return 'INVALID_DURATION';
  }
  return null;
}

// ---------------------------------------------------------------------------
// The reducer
// ---------------------------------------------------------------------------

/**
 * Pure reducer. Every reduction: advances a monotonic clock, expires a due live
 * session, applies the event, then re-derives the reported state. The input
 * context is never mutated.
 */
export function reduceTracking(ctx: TrackingContext, event: TrackingEvent): TrackingContext {
  const proposed = Number.isFinite(event.atMs) ? event.atMs : ctx.nowMs;
  // Monotonic: a late-delivered OS callback must not rewind the staleness or
  // live-expiry clocks.
  const nowMs = Math.max(ctx.nowMs, proposed);
  const ticked = expireLiveSession({ ...ctx, nowMs }, nowMs);
  return derive(applyEvent(ticked, event, nowMs), nowMs);
}

/** Convenience for callers that only need the resulting state. */
export function nextTrackingState(ctx: TrackingContext, event: TrackingEvent): TrackingState {
  return reduceTracking(ctx, event).state;
}

/** Fold a sequence of events; useful for replaying a persisted event log. */
export function reduceTrackingAll(
  ctx: TrackingContext,
  events: readonly TrackingEvent[],
): TrackingContext {
  let current = ctx;
  for (const event of events) current = reduceTracking(current, event);
  return current;
}

function expireLiveSession(ctx: TrackingContext, nowMs: number): TrackingContext {
  const session = ctx.liveSession;
  if (session === null || nowMs < session.expiresAtMs) return ctx;
  return { ...ctx, liveSession: null, lastLiveEndReason: 'EXPIRED' };
}

function applyEvent(ctx: TrackingContext, event: TrackingEvent, nowMs: number): TrackingContext {
  switch (event.type) {
    case 'PERMISSION_CHANGED':
      return { ...ctx, permission: event.permission };

    case 'SHARING_RESUMED':
      return { ...ctx, sharing: 'SHARING' };

    case 'SHARING_PAUSED':
      return { ...ctx, sharing: 'PAUSED' };

    case 'SHARING_DISABLED':
      return { ...ctx, sharing: 'DISABLED' };

    case 'MOTION_CHANGED':
      return { ...ctx, motion: event.motion };

    case 'BATTERY_CHANGED':
      return {
        ...ctx,
        batteryLevel: event.level,
        batteryTier: nextBatteryTier(ctx.batteryTier, event.level),
        isCharging: event.isCharging,
        isLowPowerMode: event.isLowPowerMode,
      };

    case 'CONNECTIVITY_CHANGED':
      return { ...ctx, connectivity: event.online ? 'ONLINE' : 'OFFLINE' };

    case 'LIVE_SESSION_STARTED': {
      const rejection = liveSessionRejection(ctx, event.requestedDurationSeconds);
      if (rejection !== null) return { ...ctx, lastLiveRejection: rejection };
      const granted = grantedLiveSessionSeconds(
        event.requestedDurationSeconds,
        effectiveBatteryTier(ctx.batteryTier, ctx.isLowPowerMode),
      );
      return {
        ...ctx,
        lastLiveRejection: null,
        lastLiveEndReason: null,
        liveSession: {
          sessionId: event.sessionId,
          startedAtMs: nowMs,
          expiresAtMs: nowMs + granted * 1000,
          grantedDurationSeconds: granted,
          requestedDurationSeconds: event.requestedDurationSeconds,
          ambientStateAtStart: ambientStateFor(ctx.motion),
        },
      };
    }

    case 'LIVE_SESSION_STOPPED':
      if (ctx.liveSession === null) return ctx;
      return { ...ctx, liveSession: null, lastLiveEndReason: 'STOPPED' };

    case 'LOCATION_RECORDED':
      return { ...ctx, lastFixAtMs: nowMs };

    case 'CONFIG_CHANGED':
      return {
        ...ctx,
        maxStaleSeconds: clampInto(event.maxStaleSeconds, CONFIG_GUARDRAILS.maxStaleSeconds),
      };

    case 'TICK':
      return ctx;

    default:
      return assertNever(event, 'Unhandled tracking event');
  }
}

/**
 * The precedence ladder. This is the single place a `TrackingState` is decided,
 * which is what makes the safety invariants structural rather than incidental.
 */
function derive(ctx: TrackingContext, nowMs: number): TrackingContext {
  const permissionOk = isPermissionSufficient(ctx.permission);
  const sharingActive = ctx.sharing === 'SHARING';
  const tier = effectiveBatteryTier(ctx.batteryTier, ctx.isLowPowerMode);

  // A running session cannot survive loss of consent, loss of permission, or a
  // critical battery — belt and braces alongside the ladder below.
  let liveSession = ctx.liveSession;
  let lastLiveEndReason = ctx.lastLiveEndReason;
  if (liveSession !== null) {
    if (!sharingActive) {
      liveSession = null;
      lastLiveEndReason = 'SHARING_DISABLED';
    } else if (!permissionOk) {
      liveSession = null;
      lastLiveEndReason = 'PERMISSION_REQUIRED';
    } else if (tier === 'CRITICAL') {
      liveSession = null;
      lastLiveEndReason = 'CRITICAL_BATTERY';
    }
  }

  if (!sharingActive || !permissionOk) {
    return {
      ...ctx,
      liveSession,
      lastLiveEndReason,
      enabledAtMs: null,
      isStale: false,
      nowMs,
      state: !sharingActive ? 'DISABLED' : 'PERMISSION_REQUIRED',
    };
  }

  const enabledAtMs = ctx.enabledAtMs ?? nowMs;
  // Before the first fix, staleness is measured from the moment tracking became
  // permitted — otherwise a device that never reports would look healthy.
  const reference = ctx.lastFixAtMs ?? enabledAtMs;
  const isStale = nowMs - reference > ctx.maxStaleSeconds * 1000;

  let state: TrackingState;
  if (tier === 'CRITICAL') state = 'CRITICAL_BATTERY';
  else if (liveSession !== null) state = 'LIVE';
  else if (tier === 'LOW') state = 'LOW_BATTERY';
  else if (ctx.connectivity === 'OFFLINE') state = 'OFFLINE';
  else if (isStale) state = 'STALE';
  else state = ambientStateFor(ctx.motion);

  return { ...ctx, liveSession, lastLiveEndReason, enabledAtMs, isStale, nowMs, state };
}

// ---------------------------------------------------------------------------
// Projections
// ---------------------------------------------------------------------------

/**
 * Project the context onto the shared `SharingStatus` vocabulary. Note that a
 * consenting user whose OS permission has lapsed reports PERMISSION_BLOCKED,
 * not PAUSED — the distinction drives very different UI copy.
 */
export function effectiveSharingStatus(ctx: TrackingContext): SharingStatus {
  switch (ctx.sharing) {
    case 'NEVER_ENABLED':
      return 'NEVER_ENABLED';
    case 'PAUSED':
      return 'PAUSED';
    case 'DISABLED':
      return 'DISABLED';
    case 'SHARING':
      return isPermissionSufficient(ctx.permission) ? 'SHARING' : 'PERMISSION_BLOCKED';
    default:
      return assertNever(ctx.sharing, 'Unhandled sharing consent');
  }
}

/** Seconds remaining on the active live session, or null when there is none. */
export function liveSessionRemainingSeconds(ctx: TrackingContext): number | null {
  if (ctx.liveSession === null) return null;
  return Math.max(0, Math.ceil((ctx.liveSession.expiresAtMs - ctx.nowMs) / 1000));
}
