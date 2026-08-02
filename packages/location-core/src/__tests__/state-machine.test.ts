import { describe, expect, it } from 'vitest';

import {
  BATTERY,
  CONFIG_GUARDRAILS,
  LIMITS,
  LOCATION_PRODUCING_STATES,
  MotionStateSchema,
  TRACKING_STATES,
  type LocationPermissionState,
  type MotionState,
  type TrackingState,
} from '@family/contracts';

import {
  CONSENT_EVENT_TYPES,
  LIVE_SESSION_LOW_BATTERY_MAX_SECONDS,
  TRACKING_EVENT_TYPES,
  TRACKING_POLICY,
  UNKNOWN_PERMISSION_STATE,
  ambientStateFor,
  createTrackingContext,
  effectiveBatteryTier,
  effectiveSharingStatus,
  grantedLiveSessionSeconds,
  isLocationProducing,
  isPermissionSufficient,
  liveSessionRemainingSeconds,
  nextBatteryTier,
  nextTrackingState,
  permissionDegradations,
  reduceTracking,
  reduceTrackingAll,
  trackingPolicyFor,
  type BatteryTier,
  type TrackingContext,
  type TrackingEvent,
} from '../state-machine.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const T0 = 1_700_000_000_000;
const MAX_STALE_MS = 3_600_000;

const GRANTED: LocationPermissionState = {
  authorization: 'ALWAYS',
  preciseLocationEnabled: true,
  locationServicesEnabled: true,
  notificationsEnabled: true,
  backgroundRefreshEnabled: true,
  foregroundServicePermissionGranted: true,
  batteryOptimizationIgnored: true,
};

const REVOKED: LocationPermissionState = {
  ...GRANTED,
  authorization: 'DENIED',
  preciseLocationEnabled: false,
  backgroundRefreshEnabled: false,
};

function sharingContext(over: Partial<Parameters<typeof createTrackingContext>[0]> = {}) {
  return createTrackingContext({
    nowMs: T0,
    sharing: 'SHARING',
    permission: GRANTED,
    motion: 'STATIONARY',
    lastFixAtMs: T0,
    ...over,
  });
}

/** A context whose derived state is exactly `state`. */
function contextIn(state: TrackingState): TrackingContext {
  switch (state) {
    case 'DISABLED':
      return createTrackingContext({
        nowMs: T0,
        sharing: 'PAUSED',
        permission: GRANTED,
        motion: 'STATIONARY',
        lastFixAtMs: T0,
      });
    case 'PERMISSION_REQUIRED':
      return createTrackingContext({
        nowMs: T0,
        sharing: 'SHARING',
        permission: REVOKED,
        motion: 'STATIONARY',
        lastFixAtMs: T0,
      });
    case 'STATIONARY':
      return sharingContext({ motion: 'STATIONARY' });
    case 'PASSIVE':
      return sharingContext({ motion: 'UNKNOWN' });
    case 'WALKING':
      return sharingContext({ motion: 'WALKING' });
    case 'TRANSIT':
      return sharingContext({ motion: 'AUTOMOTIVE' });
    case 'LIVE':
      return reduceTracking(sharingContext(), {
        type: 'LIVE_SESSION_STARTED',
        sessionId: 'session-fixture',
        requestedDurationSeconds: LIMITS.MAX_LIVE_SESSION_SECONDS,
        atMs: T0,
      });
    case 'LOW_BATTERY':
      return sharingContext({ batteryTier: 'LOW', batteryLevel: 0.18 });
    case 'CRITICAL_BATTERY':
      return sharingContext({ batteryTier: 'CRITICAL', batteryLevel: 0.05 });
    case 'OFFLINE':
      return sharingContext({ connectivity: 'OFFLINE' });
    case 'STALE':
      return sharingContext({ lastFixAtMs: T0 - (MAX_STALE_MS + 1_000) });
    default:
      throw new Error('unreachable: unhandled tracking state fixture');
  }
}

const EVENTS = {
  PERM_GRANT: { type: 'PERMISSION_CHANGED', permission: GRANTED, atMs: T0 },
  PERM_REVOKE: { type: 'PERMISSION_CHANGED', permission: REVOKED, atMs: T0 },
  PAUSE: { type: 'SHARING_PAUSED', atMs: T0 },
  RESUME: { type: 'SHARING_RESUMED', atMs: T0 },
  DISABLE: { type: 'SHARING_DISABLED', atMs: T0 },
  MOTION_STILL: { type: 'MOTION_CHANGED', motion: 'STATIONARY', atMs: T0 },
  MOTION_WALK: { type: 'MOTION_CHANGED', motion: 'WALKING', atMs: T0 },
  MOTION_DRIVE: { type: 'MOTION_CHANGED', motion: 'AUTOMOTIVE', atMs: T0 },
  MOTION_UNKNOWN: { type: 'MOTION_CHANGED', motion: 'UNKNOWN', atMs: T0 },
  BATTERY_OK: {
    type: 'BATTERY_CHANGED',
    level: 0.9,
    isCharging: false,
    isLowPowerMode: false,
    atMs: T0,
  },
  BATTERY_LOW: {
    type: 'BATTERY_CHANGED',
    level: 0.16,
    isCharging: false,
    isLowPowerMode: false,
    atMs: T0,
  },
  BATTERY_CRITICAL: {
    type: 'BATTERY_CHANGED',
    level: 0.05,
    isCharging: false,
    isLowPowerMode: false,
    atMs: T0,
  },
  LOW_POWER_MODE: {
    type: 'BATTERY_CHANGED',
    level: 0.9,
    isCharging: false,
    isLowPowerMode: true,
    atMs: T0,
  },
  GO_OFFLINE: { type: 'CONNECTIVITY_CHANGED', online: false, atMs: T0 },
  GO_ONLINE: { type: 'CONNECTIVITY_CHANGED', online: true, atMs: T0 },
  LIVE_START: {
    type: 'LIVE_SESSION_STARTED',
    sessionId: 'session-under-test',
    requestedDurationSeconds: 300,
    atMs: T0,
  },
  LIVE_STOP: { type: 'LIVE_SESSION_STOPPED', atMs: T0 },
  FIX: { type: 'LOCATION_RECORDED', atMs: T0 },
  CONFIG: { type: 'CONFIG_CHANGED', maxStaleSeconds: 1800, atMs: T0 },
  TICK_NOW: { type: 'TICK', atMs: T0 },
  TICK_AFTER_LIVE: { type: 'TICK', atMs: T0 + 601_000 },
  TICK_AFTER_STALE: { type: 'TICK', atMs: T0 + MAX_STALE_MS + 1_000 },
} as const satisfies Record<string, TrackingEvent>;

type EventKey = keyof typeof EVENTS;
const EVENT_KEYS = Object.keys(EVENTS) as EventKey[];

type Row = Record<EventKey, TrackingState>;

function constantRow(state: TrackingState): Row {
  const row = {} as Row;
  for (const key of EVENT_KEYS) row[key] = state;
  return row;
}

/** The four ambient motion states share one shape; `ambient` is the resting state. */
function ambientRow(ambient: TrackingState): Row {
  return {
    PERM_GRANT: ambient,
    PERM_REVOKE: 'PERMISSION_REQUIRED',
    PAUSE: 'DISABLED',
    RESUME: ambient,
    DISABLE: 'DISABLED',
    MOTION_STILL: 'STATIONARY',
    MOTION_WALK: 'WALKING',
    MOTION_DRIVE: 'TRANSIT',
    MOTION_UNKNOWN: 'PASSIVE',
    BATTERY_OK: ambient,
    BATTERY_LOW: 'LOW_BATTERY',
    BATTERY_CRITICAL: 'CRITICAL_BATTERY',
    LOW_POWER_MODE: 'LOW_BATTERY',
    GO_OFFLINE: 'OFFLINE',
    GO_ONLINE: ambient,
    LIVE_START: 'LIVE',
    LIVE_STOP: ambient,
    FIX: ambient,
    CONFIG: ambient,
    TICK_NOW: ambient,
    TICK_AFTER_LIVE: ambient,
    TICK_AFTER_STALE: 'STALE',
  };
}

/**
 * The complete transition matrix: every one of the 11 states crossed with every
 * event shape the reducer accepts. Written out by hand from the §10 rules so it
 * is an independent statement of intent, not a mirror of the implementation.
 */
const MATRIX: Record<TrackingState, Row> = {
  // Absorbing: only an explicit consent act (RESUME) can leave.
  DISABLED: { ...constantRow('DISABLED'), RESUME: 'STATIONARY' },

  // Absorbing: only an explicit permission grant can leave; a pause or a
  // disable is still honoured because both are *more* restrictive.
  PERMISSION_REQUIRED: {
    ...constantRow('PERMISSION_REQUIRED'),
    PERM_GRANT: 'STATIONARY',
    PAUSE: 'DISABLED',
    DISABLE: 'DISABLED',
  },

  STATIONARY: ambientRow('STATIONARY'),
  PASSIVE: ambientRow('PASSIVE'),
  WALKING: ambientRow('WALKING'),
  TRANSIT: ambientRow('TRANSIT'),

  LIVE: {
    PERM_GRANT: 'LIVE',
    PERM_REVOKE: 'PERMISSION_REQUIRED',
    PAUSE: 'DISABLED',
    RESUME: 'LIVE',
    DISABLE: 'DISABLED',
    MOTION_STILL: 'LIVE',
    MOTION_WALK: 'LIVE',
    MOTION_DRIVE: 'LIVE',
    MOTION_UNKNOWN: 'LIVE',
    BATTERY_OK: 'LIVE',
    // Low battery shortens a *new* session; it never interrupts a running one.
    BATTERY_LOW: 'LIVE',
    // Critical battery does interrupt it.
    BATTERY_CRITICAL: 'CRITICAL_BATTERY',
    LOW_POWER_MODE: 'LIVE',
    // Streaming keeps capturing while offline; the queue absorbs the gap.
    GO_OFFLINE: 'LIVE',
    GO_ONLINE: 'LIVE',
    LIVE_START: 'LIVE',
    LIVE_STOP: 'STATIONARY',
    FIX: 'LIVE',
    CONFIG: 'LIVE',
    TICK_NOW: 'LIVE',
    // Auto-expiry back to the ambient state.
    TICK_AFTER_LIVE: 'STATIONARY',
    TICK_AFTER_STALE: 'STALE',
  },

  LOW_BATTERY: {
    PERM_GRANT: 'LOW_BATTERY',
    PERM_REVOKE: 'PERMISSION_REQUIRED',
    PAUSE: 'DISABLED',
    RESUME: 'LOW_BATTERY',
    DISABLE: 'DISABLED',
    MOTION_STILL: 'LOW_BATTERY',
    MOTION_WALK: 'LOW_BATTERY',
    MOTION_DRIVE: 'LOW_BATTERY',
    MOTION_UNKNOWN: 'LOW_BATTERY',
    BATTERY_OK: 'STATIONARY',
    BATTERY_LOW: 'LOW_BATTERY',
    BATTERY_CRITICAL: 'CRITICAL_BATTERY',
    LOW_POWER_MODE: 'LOW_BATTERY',
    GO_OFFLINE: 'LOW_BATTERY',
    GO_ONLINE: 'LOW_BATTERY',
    LIVE_START: 'LIVE',
    LIVE_STOP: 'LOW_BATTERY',
    FIX: 'LOW_BATTERY',
    CONFIG: 'LOW_BATTERY',
    TICK_NOW: 'LOW_BATTERY',
    TICK_AFTER_LIVE: 'LOW_BATTERY',
    TICK_AFTER_STALE: 'LOW_BATTERY',
  },

  CRITICAL_BATTERY: {
    PERM_GRANT: 'CRITICAL_BATTERY',
    PERM_REVOKE: 'PERMISSION_REQUIRED',
    PAUSE: 'DISABLED',
    RESUME: 'CRITICAL_BATTERY',
    DISABLE: 'DISABLED',
    MOTION_STILL: 'CRITICAL_BATTERY',
    MOTION_WALK: 'CRITICAL_BATTERY',
    MOTION_DRIVE: 'CRITICAL_BATTERY',
    MOTION_UNKNOWN: 'CRITICAL_BATTERY',
    BATTERY_OK: 'STATIONARY',
    BATTERY_LOW: 'LOW_BATTERY',
    BATTERY_CRITICAL: 'CRITICAL_BATTERY',
    LOW_POWER_MODE: 'LOW_BATTERY',
    GO_OFFLINE: 'CRITICAL_BATTERY',
    GO_ONLINE: 'CRITICAL_BATTERY',
    // A live session may not begin on a critical battery.
    LIVE_START: 'CRITICAL_BATTERY',
    LIVE_STOP: 'CRITICAL_BATTERY',
    FIX: 'CRITICAL_BATTERY',
    CONFIG: 'CRITICAL_BATTERY',
    TICK_NOW: 'CRITICAL_BATTERY',
    TICK_AFTER_LIVE: 'CRITICAL_BATTERY',
    TICK_AFTER_STALE: 'CRITICAL_BATTERY',
  },

  OFFLINE: {
    PERM_GRANT: 'OFFLINE',
    PERM_REVOKE: 'PERMISSION_REQUIRED',
    PAUSE: 'DISABLED',
    RESUME: 'OFFLINE',
    DISABLE: 'DISABLED',
    MOTION_STILL: 'OFFLINE',
    MOTION_WALK: 'OFFLINE',
    MOTION_DRIVE: 'OFFLINE',
    MOTION_UNKNOWN: 'OFFLINE',
    BATTERY_OK: 'OFFLINE',
    BATTERY_LOW: 'LOW_BATTERY',
    BATTERY_CRITICAL: 'CRITICAL_BATTERY',
    LOW_POWER_MODE: 'LOW_BATTERY',
    GO_OFFLINE: 'OFFLINE',
    GO_ONLINE: 'STATIONARY',
    LIVE_START: 'LIVE',
    LIVE_STOP: 'OFFLINE',
    FIX: 'OFFLINE',
    CONFIG: 'OFFLINE',
    TICK_NOW: 'OFFLINE',
    TICK_AFTER_LIVE: 'OFFLINE',
    TICK_AFTER_STALE: 'OFFLINE',
  },

  STALE: {
    PERM_GRANT: 'STALE',
    PERM_REVOKE: 'PERMISSION_REQUIRED',
    PAUSE: 'DISABLED',
    RESUME: 'STALE',
    DISABLE: 'DISABLED',
    MOTION_STILL: 'STALE',
    MOTION_WALK: 'STALE',
    MOTION_DRIVE: 'STALE',
    MOTION_UNKNOWN: 'STALE',
    BATTERY_OK: 'STALE',
    BATTERY_LOW: 'LOW_BATTERY',
    BATTERY_CRITICAL: 'CRITICAL_BATTERY',
    LOW_POWER_MODE: 'LOW_BATTERY',
    GO_OFFLINE: 'OFFLINE',
    GO_ONLINE: 'STALE',
    LIVE_START: 'LIVE',
    LIVE_STOP: 'STALE',
    // A fresh fix is the only thing that clears staleness.
    FIX: 'STATIONARY',
    CONFIG: 'STALE',
    TICK_NOW: 'STALE',
    TICK_AFTER_LIVE: 'STALE',
    TICK_AFTER_STALE: 'STALE',
  },
};

// ---------------------------------------------------------------------------

const ALL_STATES: TrackingState[] = [...TRACKING_STATES];

describe('fixtures', () => {
  it.each(ALL_STATES)('builds a context that really is in %s', (state) => {
    expect(contextIn(state).state).toBe(state);
  });

  it('covers every event variant the reducer accepts', () => {
    const covered = new Set(EVENT_KEYS.map((key) => EVENTS[key].type));
    expect([...covered].sort()).toEqual([...TRACKING_EVENT_TYPES].sort());
  });
});

describe('transition matrix', () => {
  const cases: Array<[TrackingState, EventKey, TrackingState]> = [];
  for (const state of ALL_STATES) {
    for (const key of EVENT_KEYS) {
      cases.push([state, key, MATRIX[state][key]]);
    }
  }

  it('enumerates every state crossed with every event', () => {
    expect(cases).toHaveLength(ALL_STATES.length * EVENT_KEYS.length);
    expect(ALL_STATES).toHaveLength(11);
  });

  it.each(cases)('%s + %s -> %s', (from, key, expected) => {
    expect(reduceTracking(contextIn(from), EVENTS[key]).state).toBe(expected);
  });

  it.each(cases)('nextTrackingState agrees for %s + %s', (from, key, expected) => {
    expect(nextTrackingState(contextIn(from), EVENTS[key])).toBe(expected);
  });

  it('is deterministic: the same input always yields the same output', () => {
    for (const [from, key] of cases) {
      const a = reduceTracking(contextIn(from), EVENTS[key]);
      const b = reduceTracking(contextIn(from), EVENTS[key]);
      expect(a).toEqual(b);
    }
  });

  it('never mutates the context it is given', () => {
    for (const [from, key] of cases) {
      const before = contextIn(from);
      const snapshot = structuredClone(before);
      reduceTracking(Object.freeze(before), EVENTS[key]);
      expect(before).toEqual(snapshot);
    }
  });

  it('only ever produces one of the eleven contract states', () => {
    for (const [from, key] of cases) {
      expect(ALL_STATES).toContain(reduceTracking(contextIn(from), EVENTS[key]).state);
    }
  });
});

describe('absorbing states', () => {
  const ABSORBING: TrackingState[] = ['DISABLED', 'PERMISSION_REQUIRED'];
  const NON_CONSENT = EVENT_KEYS.filter((key) => !CONSENT_EVENT_TYPES.includes(EVENTS[key].type));

  it.each(ABSORBING)('%s cannot be left without an explicit consent event', (state) => {
    for (const key of NON_CONSENT) {
      const next = reduceTracking(contextIn(state), EVENTS[key]);
      expect(ABSORBING).toContain(next.state);
    }
  });

  it.each(ABSORBING)('%s never produces a location-producing state', (state) => {
    for (const key of NON_CONSENT) {
      const next = reduceTracking(contextIn(state), EVENTS[key]);
      expect(isLocationProducing(next.state)).toBe(false);
      expect(LOCATION_PRODUCING_STATES).not.toContain(next.state);
    }
  });

  it.each(ABSORBING)('%s survives long sequences of non-consent events', (state) => {
    let ctx = contextIn(state);
    // Three passes so ordering effects (battery banding, staleness, motion) all
    // get a chance to conspire.
    for (let pass = 0; pass < 3; pass += 1) {
      for (const key of NON_CONSENT) {
        ctx = reduceTracking(ctx, EVENTS[key]);
        expect(isLocationProducing(ctx.state)).toBe(false);
        expect(ctx.liveSession).toBeNull();
      }
    }
  });

  it('refuses to start a live session while absorbed', () => {
    for (const state of ABSORBING) {
      const next = reduceTracking(contextIn(state), EVENTS.LIVE_START);
      expect(next.liveSession).toBeNull();
      expect(next.lastLiveRejection).toBe(
        state === 'DISABLED' ? 'SHARING_DISABLED' : 'PERMISSION_REQUIRED',
      );
    }
  });

  it('does not resume sharing merely because permission was granted', () => {
    const next = reduceTracking(contextIn('DISABLED'), EVENTS.PERM_GRANT);
    expect(next.state).toBe('DISABLED');
    expect(next.sharing).toBe('PAUSED');
  });

  it('does not grant permission merely because sharing was resumed', () => {
    const next = reduceTracking(contextIn('PERMISSION_REQUIRED'), EVENTS.RESUME);
    expect(next.state).toBe('PERMISSION_REQUIRED');
  });
});

describe('permission downgrades', () => {
  it.each(ALL_STATES)('a downgrade from %s stops all location output', (state) => {
    const before = contextIn(state);
    const next = reduceTracking(before, EVENTS.PERM_REVOKE);
    expect(isLocationProducing(next.state)).toBe(false);
    expect(next.liveSession).toBeNull();
    expect(next.state).toBe(before.sharing === 'SHARING' ? 'PERMISSION_REQUIRED' : 'DISABLED');
  });

  const BLOCKING: readonly LocationPermissionState[] = [
    { ...GRANTED, authorization: 'DENIED' },
    { ...GRANTED, authorization: 'RESTRICTED' },
    { ...GRANTED, authorization: 'NOT_DETERMINED' },
    { ...GRANTED, locationServicesEnabled: false },
    UNKNOWN_PERMISSION_STATE,
  ];

  it('every blocking permission forces PERMISSION_REQUIRED from every sharing state', () => {
    for (const permission of BLOCKING) {
      expect(isPermissionSufficient(permission)).toBe(false);
      for (const state of ALL_STATES) {
        const before = contextIn(state);
        if (before.sharing !== 'SHARING') continue;
        const next = reduceTracking(before, {
          type: 'PERMISSION_CHANGED',
          permission,
          atMs: T0,
        });
        expect(next.state).toBe('PERMISSION_REQUIRED');
      }
    }
  });

  it('treats WHEN_IN_USE as sufficient but degraded', () => {
    const whenInUse: LocationPermissionState = { ...GRANTED, authorization: 'WHEN_IN_USE' };
    expect(isPermissionSufficient(whenInUse)).toBe(true);
    expect(permissionDegradations(whenInUse)).toContain('WHEN_IN_USE_ONLY');
    expect(
      reduceTracking(contextIn('STATIONARY'), {
        type: 'PERMISSION_CHANGED',
        permission: whenInUse,
        atMs: T0,
      }).state,
    ).toBe('STATIONARY');
  });

  it('reports soft degradations without blocking tracking', () => {
    const degraded: LocationPermissionState = {
      ...GRANTED,
      preciseLocationEnabled: false,
      backgroundRefreshEnabled: false,
      notificationsEnabled: false,
      foregroundServicePermissionGranted: false,
      batteryOptimizationIgnored: false,
    };
    expect(isPermissionSufficient(degraded)).toBe(true);
    expect(permissionDegradations(degraded)).toEqual([
      'BACKGROUND_REFRESH_DISABLED',
      'FOREGROUND_SERVICE_DENIED',
      'BATTERY_OPTIMIZATION_ACTIVE',
      'PRECISE_LOCATION_DISABLED',
      'NOTIFICATIONS_DISABLED',
    ]);
    expect(permissionDegradations(GRANTED)).toEqual([]);
    // A blocked permission reports no degradations — the block is the message.
    expect(permissionDegradations(REVOKED)).toEqual([]);
  });
});

describe('sharing pause', () => {
  it.each(ALL_STATES)('a pause from %s goes to DISABLED', (state) => {
    const next = reduceTracking(contextIn(state), EVENTS.PAUSE);
    expect(next.state).toBe('DISABLED');
    expect(next.liveSession).toBeNull();
    expect(effectiveSharingStatus(next)).toBe('PAUSED');
  });

  it.each(ALL_STATES)('a full disable from %s goes to DISABLED', (state) => {
    const next = reduceTracking(contextIn(state), EVENTS.DISABLE);
    expect(next.state).toBe('DISABLED');
    expect(effectiveSharingStatus(next)).toBe('DISABLED');
  });

  it('projects a consenting-but-unpermitted user as PERMISSION_BLOCKED', () => {
    expect(effectiveSharingStatus(contextIn('PERMISSION_REQUIRED'))).toBe('PERMISSION_BLOCKED');
    expect(effectiveSharingStatus(contextIn('STATIONARY'))).toBe('SHARING');
    expect(effectiveSharingStatus(createTrackingContext({ nowMs: T0, permission: GRANTED }))).toBe(
      'NEVER_ENABLED',
    );
  });

  it('ends a running live session when sharing is paused', () => {
    const next = reduceTracking(contextIn('LIVE'), EVENTS.PAUSE);
    expect(next.liveSession).toBeNull();
    expect(next.lastLiveEndReason).toBe('SHARING_DISABLED');
  });
});

describe('battery hysteresis', () => {
  const leaveLow = BATTERY.LOW_THRESHOLD + BATTERY.RECOVERY_MARGIN;
  const leaveCritical = BATTERY.CRITICAL_THRESHOLD + BATTERY.RECOVERY_MARGIN;

  function band(start: BatteryTier, readings: readonly number[]): BatteryTier[] {
    let tier = start;
    return readings.map((level) => {
      tier = nextBatteryTier(tier, level);
      return tier;
    });
  }

  it('enters LOW at the threshold and will not leave until the margin clears', () => {
    expect(nextBatteryTier('NORMAL', BATTERY.LOW_THRESHOLD)).toBe('LOW');
    expect(nextBatteryTier('LOW', BATTERY.LOW_THRESHOLD + 0.04)).toBe('LOW');
    expect(nextBatteryTier('LOW', leaveLow)).toBe('NORMAL');
  });

  it('enters CRITICAL at the threshold and will not leave until the margin clears', () => {
    expect(nextBatteryTier('LOW', BATTERY.CRITICAL_THRESHOLD)).toBe('CRITICAL');
    expect(nextBatteryTier('CRITICAL', BATTERY.CRITICAL_THRESHOLD + 0.04)).toBe('CRITICAL');
    expect(nextBatteryTier('CRITICAL', leaveCritical)).toBe('LOW');
    expect(nextBatteryTier('CRITICAL', leaveLow)).toBe('NORMAL');
  });

  it('does not oscillate on readings hovering at the LOW threshold', () => {
    const hovering = [0.21, 0.2, 0.19, 0.21, 0.22, 0.2, 0.24, 0.21, 0.199, 0.24];
    const observed = band('NORMAL', hovering);
    expect(observed).toEqual([
      'NORMAL',
      'LOW',
      'LOW',
      'LOW',
      'LOW',
      'LOW',
      'LOW',
      'LOW',
      'LOW',
      'LOW',
    ]);
    expect(countChanges(['NORMAL', ...observed])).toBe(1);
  });

  it('does not oscillate on readings hovering at the CRITICAL threshold', () => {
    const hovering = [0.11, 0.1, 0.09, 0.11, 0.14, 0.1, 0.149, 0.12];
    const observed = band('LOW', hovering);
    expect(observed).toEqual([
      'LOW',
      'CRITICAL',
      'CRITICAL',
      'CRITICAL',
      'CRITICAL',
      'CRITICAL',
      'CRITICAL',
      'CRITICAL',
    ]);
    expect(countChanges(['LOW', ...observed])).toBe(1);
  });

  it('does not oscillate the reported state either', () => {
    const hovering = [0.21, 0.2, 0.19, 0.21, 0.22, 0.2, 0.24, 0.21];
    let ctx = contextIn('STATIONARY');
    const states: TrackingState[] = [ctx.state];
    for (const level of hovering) {
      ctx = reduceTracking(ctx, {
        type: 'BATTERY_CHANGED',
        level,
        isCharging: false,
        isLowPowerMode: false,
        atMs: T0,
      });
      states.push(ctx.state);
    }
    expect(countChanges(states)).toBe(1);
    expect(ctx.state).toBe('LOW_BATTERY');
  });

  it('holds the current band when the level is unknown', () => {
    expect(nextBatteryTier('LOW', null)).toBe('LOW');
    expect(nextBatteryTier('CRITICAL', null)).toBe('CRITICAL');
    expect(nextBatteryTier('LOW', Number.NaN)).toBe('LOW');
  });

  it('clamps nonsense levels rather than trusting them', () => {
    expect(nextBatteryTier('NORMAL', -5)).toBe('CRITICAL');
    expect(nextBatteryTier('CRITICAL', 42)).toBe('NORMAL');
  });

  it('floors the band at LOW during Low Power Mode without corrupting hysteresis', () => {
    expect(effectiveBatteryTier('NORMAL', true)).toBe('LOW');
    expect(effectiveBatteryTier('LOW', true)).toBe('LOW');
    expect(effectiveBatteryTier('CRITICAL', true)).toBe('CRITICAL');
    expect(effectiveBatteryTier('NORMAL', false)).toBe('NORMAL');

    // Toggling Low Power Mode on and off returns to exactly the prior state.
    const start = contextIn('STATIONARY');
    const on = reduceTracking(start, EVENTS.LOW_POWER_MODE);
    expect(on.state).toBe('LOW_BATTERY');
    expect(on.batteryTier).toBe('NORMAL');
    const off = reduceTracking(on, EVENTS.BATTERY_OK);
    expect(off.state).toBe('STATIONARY');
  });
});

function countChanges(values: readonly string[]): number {
  let changes = 0;
  for (let index = 1; index < values.length; index += 1) {
    if (values[index] !== values[index - 1]) changes += 1;
  }
  return changes;
}

describe('live sessions', () => {
  const start = (
    ctx: TrackingContext,
    requestedDurationSeconds: number,
    atMs = T0,
  ): TrackingContext =>
    reduceTracking(ctx, {
      type: 'LIVE_SESSION_STARTED',
      sessionId: 'session-1',
      requestedDurationSeconds,
      atMs,
    });

  it('clamps a greedy request to the platform maximum', () => {
    const ctx = start(contextIn('STATIONARY'), 86_400);
    expect(ctx.state).toBe('LIVE');
    expect(ctx.liveSession?.grantedDurationSeconds).toBe(LIMITS.MAX_LIVE_SESSION_SECONDS);
    expect(ctx.liveSession?.expiresAtMs).toBe(T0 + LIMITS.MAX_LIVE_SESSION_SECONDS * 1000);
  });

  it('expires exactly at the boundary, not before', () => {
    const ctx = start(contextIn('STATIONARY'), LIMITS.MAX_LIVE_SESSION_SECONDS);
    const expiresAtMs = ctx.liveSession?.expiresAtMs ?? 0;

    const justBefore = reduceTracking(ctx, { type: 'TICK', atMs: expiresAtMs - 1 });
    expect(justBefore.state).toBe('LIVE');
    expect(liveSessionRemainingSeconds(justBefore)).toBe(1);

    const atBoundary = reduceTracking(ctx, { type: 'TICK', atMs: expiresAtMs });
    expect(atBoundary.state).toBe('STATIONARY');
    expect(atBoundary.liveSession).toBeNull();
    expect(atBoundary.lastLiveEndReason).toBe('EXPIRED');
    expect(liveSessionRemainingSeconds(atBoundary)).toBeNull();
  });

  it('auto-expires back to the ambient state it started from', () => {
    for (const ambient of ['STATIONARY', 'PASSIVE', 'WALKING', 'TRANSIT'] as const) {
      const before = contextIn(ambient);
      const live = start(before, LIMITS.MAX_LIVE_SESSION_SECONDS);
      expect(live.state).toBe('LIVE');
      expect(live.liveSession?.ambientStateAtStart).toBe(ambient);

      // A fix arrives during the session so expiry is not confounded by staleness.
      const withFix = reduceTracking(live, {
        type: 'LOCATION_RECORDED',
        atMs: T0 + LIMITS.MAX_LIVE_SESSION_SECONDS * 1000 - 1,
      });
      const expired = reduceTracking(withFix, {
        type: 'TICK',
        atMs: T0 + LIMITS.MAX_LIVE_SESSION_SECONDS * 1000,
      });
      expect(expired.state).toBe(ambient);
      expect(expired.state).toBe(live.liveSession?.ambientStateAtStart);
    }
  });

  it('expires even when the only event delivered is unrelated', () => {
    const ctx = start(contextIn('STATIONARY'), 60);
    const later = reduceTracking(ctx, {
      type: 'MOTION_CHANGED',
      motion: 'WALKING',
      atMs: T0 + 60_000,
    });
    expect(later.state).toBe('WALKING');
    expect(later.liveSession).toBeNull();
  });

  it('shortens a session started on a low battery', () => {
    const ctx = start(contextIn('LOW_BATTERY'), LIMITS.MAX_LIVE_SESSION_SECONDS);
    expect(ctx.state).toBe('LIVE');
    expect(ctx.liveSession?.grantedDurationSeconds).toBe(LIVE_SESSION_LOW_BATTERY_MAX_SECONDS);
    expect(LIVE_SESSION_LOW_BATTERY_MAX_SECONDS).toBeLessThan(LIMITS.MAX_LIVE_SESSION_SECONDS);

    const expired = reduceTracking(ctx, {
      type: 'TICK',
      atMs: T0 + LIVE_SESSION_LOW_BATTERY_MAX_SECONDS * 1000,
    });
    expect(expired.state).toBe('LOW_BATTERY');
  });

  it('shortens a session started in Low Power Mode', () => {
    const lpm = reduceTracking(contextIn('STATIONARY'), EVENTS.LOW_POWER_MODE);
    const ctx = start(lpm, LIMITS.MAX_LIVE_SESSION_SECONDS);
    expect(ctx.liveSession?.grantedDurationSeconds).toBe(LIVE_SESSION_LOW_BATTERY_MAX_SECONDS);
  });

  it('refuses to start on a critical battery', () => {
    const ctx = start(contextIn('CRITICAL_BATTERY'), 300);
    expect(ctx.state).toBe('CRITICAL_BATTERY');
    expect(ctx.liveSession).toBeNull();
    expect(ctx.lastLiveRejection).toBe('CRITICAL_BATTERY');
  });

  it('terminates a running session when the battery goes critical', () => {
    const ctx = start(contextIn('STATIONARY'), LIMITS.MAX_LIVE_SESSION_SECONDS);
    const critical = reduceTracking(ctx, EVENTS.BATTERY_CRITICAL);
    expect(critical.state).toBe('CRITICAL_BATTERY');
    expect(critical.liveSession).toBeNull();
    expect(critical.lastLiveEndReason).toBe('CRITICAL_BATTERY');
  });

  it('refuses a second concurrent session and keeps the first', () => {
    const first = start(contextIn('STATIONARY'), 120);
    const second = reduceTracking(first, {
      type: 'LIVE_SESSION_STARTED',
      sessionId: 'session-2',
      requestedDurationSeconds: 600,
      atMs: T0,
    });
    expect(second.lastLiveRejection).toBe('ALREADY_ACTIVE');
    expect(second.liveSession?.sessionId).toBe('session-1');
    expect(second.liveSession?.grantedDurationSeconds).toBe(120);
  });

  it('rejects a nonsensical duration', () => {
    for (const requested of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const ctx = start(contextIn('STATIONARY'), requested);
      expect(ctx.liveSession).toBeNull();
      expect(ctx.lastLiveRejection).toBe('INVALID_DURATION');
    }
  });

  it('clamps the granted duration for every tier', () => {
    expect(grantedLiveSessionSeconds(1_000_000, 'NORMAL')).toBe(LIMITS.MAX_LIVE_SESSION_SECONDS);
    expect(grantedLiveSessionSeconds(1_000_000, 'LOW')).toBe(LIVE_SESSION_LOW_BATTERY_MAX_SECONDS);
    expect(grantedLiveSessionSeconds(30, 'NORMAL')).toBe(30);
    expect(grantedLiveSessionSeconds(0.4, 'NORMAL')).toBe(1);
  });

  it('a manual stop returns to the ambient state', () => {
    const ctx = start(contextIn('WALKING'), 300);
    const stopped = reduceTracking(ctx, EVENTS.LIVE_STOP);
    expect(stopped.state).toBe('WALKING');
    expect(stopped.lastLiveEndReason).toBe('STOPPED');
  });

  it('stopping when nothing is running is a no-op', () => {
    const ctx = contextIn('STATIONARY');
    const stopped = reduceTracking(ctx, EVENTS.LIVE_STOP);
    expect(stopped.state).toBe('STATIONARY');
    expect(stopped.lastLiveEndReason).toBeNull();
  });
});

describe('clock handling', () => {
  it('never rewinds on a late-delivered event', () => {
    const ctx = reduceTracking(contextIn('STATIONARY'), { type: 'TICK', atMs: T0 + 120_000 });
    expect(ctx.nowMs).toBe(T0 + 120_000);
    const late = reduceTracking(ctx, { type: 'TICK', atMs: T0 });
    expect(late.nowMs).toBe(T0 + 120_000);
  });

  it('a late event cannot resurrect an expired live session', () => {
    const live = reduceTracking(contextIn('STATIONARY'), {
      type: 'LIVE_SESSION_STARTED',
      sessionId: 'session-1',
      requestedDurationSeconds: 60,
      atMs: T0,
    });
    const expired = reduceTracking(live, { type: 'TICK', atMs: T0 + 60_000 });
    expect(expired.liveSession).toBeNull();
    const late = reduceTracking(expired, { type: 'TICK', atMs: T0 });
    expect(late.liveSession).toBeNull();
    expect(late.nowMs).toBe(T0 + 60_000);
  });

  it('ignores a non-finite timestamp', () => {
    const ctx = reduceTracking(contextIn('STATIONARY'), {
      type: 'TICK',
      atMs: Number.NaN,
    });
    expect(ctx.nowMs).toBe(T0);
    expect(ctx.state).toBe('STATIONARY');
  });

  it('measures staleness from enablement when no fix has ever arrived', () => {
    const ctx = createTrackingContext({
      nowMs: T0,
      sharing: 'SHARING',
      permission: GRANTED,
      motion: 'STATIONARY',
    });
    expect(ctx.state).toBe('STATIONARY');
    expect(reduceTracking(ctx, { type: 'TICK', atMs: T0 + MAX_STALE_MS }).state).toBe('STATIONARY');
    expect(reduceTracking(ctx, { type: 'TICK', atMs: T0 + MAX_STALE_MS + 1 }).state).toBe('STALE');
  });

  it('honours a tightened staleness threshold from configuration', () => {
    const ctx = reduceTracking(contextIn('STATIONARY'), {
      type: 'CONFIG_CHANGED',
      maxStaleSeconds: 600,
      atMs: T0,
    });
    expect(ctx.maxStaleSeconds).toBe(600);
    expect(reduceTracking(ctx, { type: 'TICK', atMs: T0 + 600_000 }).state).toBe('STATIONARY');
    expect(reduceTracking(ctx, { type: 'TICK', atMs: T0 + 600_001 }).state).toBe('STALE');
  });

  it('clamps a hostile staleness threshold into the guardrail', () => {
    const wide = reduceTracking(contextIn('STATIONARY'), {
      type: 'CONFIG_CHANGED',
      maxStaleSeconds: 10_000_000,
      atMs: T0,
    });
    expect(wide.maxStaleSeconds).toBe(CONFIG_GUARDRAILS.maxStaleSeconds.max);

    const narrow = reduceTracking(contextIn('STATIONARY'), {
      type: 'CONFIG_CHANGED',
      maxStaleSeconds: 1,
      atMs: T0,
    });
    expect(narrow.maxStaleSeconds).toBe(CONFIG_GUARDRAILS.maxStaleSeconds.min);
  });

  it('replays a sequence identically to folding it by hand', () => {
    const sequence: TrackingEvent[] = [
      EVENTS.RESUME,
      EVENTS.MOTION_WALK,
      EVENTS.BATTERY_LOW,
      EVENTS.GO_OFFLINE,
      EVENTS.BATTERY_OK,
      EVENTS.GO_ONLINE,
      EVENTS.FIX,
    ];
    const start = contextIn('DISABLED');
    let manual = start;
    for (const event of sequence) manual = reduceTracking(manual, event);
    expect(reduceTrackingAll(start, sequence)).toEqual(manual);
    expect(manual.state).toBe('WALKING');
  });
});

describe('motion mapping', () => {
  const MOTION_CASES: Array<[MotionState, TrackingState]> = [
    ['STATIONARY', 'STATIONARY'],
    ['WALKING', 'WALKING'],
    ['RUNNING', 'WALKING'],
    ['CYCLING', 'TRANSIT'],
    ['AUTOMOTIVE', 'TRANSIT'],
    ['UNKNOWN', 'PASSIVE'],
  ];

  it.each(MOTION_CASES)('%s maps to the %s ambient state', (motion, expected) => {
    expect(ambientStateFor(motion)).toBe(expected);
    expect(
      reduceTracking(contextIn('STATIONARY'), { type: 'MOTION_CHANGED', motion, atMs: T0 }).state,
    ).toBe(expected);
  });

  it('covers every motion state in the contract', () => {
    expect(MOTION_CASES.map(([motion]) => motion).sort()).toEqual(
      [...MotionStateSchema.options].sort(),
    );
  });
});

describe('policy table', () => {
  it('has an entry for every contract state and no others', () => {
    expect(Object.keys(TRACKING_POLICY).sort()).toEqual([...ALL_STATES].sort());
  });

  it.each(ALL_STATES)('%s policy is self-consistent', (state) => {
    const policy = trackingPolicyFor(state);
    expect(policy.state).toBe(state);
    expect(policy.freshnessWindowSeconds.min).toBeLessThanOrEqual(policy.targetFreshnessSeconds);
    expect(policy.freshnessWindowSeconds.max).toBeGreaterThanOrEqual(policy.targetFreshnessSeconds);
    expect(policy.distanceFilterMeters).toBeGreaterThanOrEqual(
      CONFIG_GUARDRAILS.distanceFilterMeters.min,
    );
    expect(policy.distanceFilterMeters).toBeLessThanOrEqual(
      CONFIG_GUARDRAILS.distanceFilterMeters.max,
    );
    expect(policy.targetFreshnessSeconds).toBeGreaterThanOrEqual(
      CONFIG_GUARDRAILS.targetFreshnessSeconds.min,
    );
    expect(policy.targetFreshnessSeconds).toBeLessThanOrEqual(
      CONFIG_GUARDRAILS.targetFreshnessSeconds.max,
    );
  });

  it.each(ALL_STATES)('%s agrees with the contract on location output', (state) => {
    const policy = trackingPolicyFor(state);
    expect(policy.locationOutputAllowed).toBe(LOCATION_PRODUCING_STATES.includes(state));
    if (policy.locationOutputAllowed) expect(policy.capturesLocation).toBe(true);
  });

  it('only DISABLED and PERMISSION_REQUIRED forbid capture entirely', () => {
    const silent = ALL_STATES.filter((state) => !TRACKING_POLICY[state].capturesLocation);
    expect(silent.sort()).toEqual(['DISABLED', 'PERMISSION_REQUIRED']);
    for (const state of silent) {
      const policy = TRACKING_POLICY[state];
      expect(policy.desiredAccuracy).toBe('NONE');
      expect(policy.primaryTrigger).toBe('NONE');
      expect(policy.continuousGpsAllowed).toBe(false);
      expect(policy.geofencesActive).toBe(false);
      expect(policy.significantChangeMonitoringActive).toBe(false);
      expect(policy.uploadsAllowed).toBe(false);
    }
  });

  it('only LIVE may hold the GPS open continuously', () => {
    const continuous = ALL_STATES.filter((state) => TRACKING_POLICY[state].continuousGpsAllowed);
    expect(continuous).toEqual(['LIVE']);
    expect(TRACKING_POLICY.LIVE.desiredAccuracy).toBe('HIGH');
  });

  it('cannot upload while offline', () => {
    expect(TRACKING_POLICY.OFFLINE.uploadsAllowed).toBe(false);
    expect(TRACKING_POLICY.OFFLINE.capturesLocation).toBe(true);
  });

  it('matches the §10 duty cycles', () => {
    // stationary: no continuous GPS, 30-60 minute heartbeat
    expect(TRACKING_POLICY.STATIONARY.continuousGpsAllowed).toBe(false);
    expect(TRACKING_POLICY.STATIONARY.freshnessWindowSeconds).toEqual({
      min: 30 * 60,
      max: 60 * 60,
    });
    expect(TRACKING_POLICY.STATIONARY.primaryTrigger).toBe('SIGNIFICANT_CHANGE');

    // passive: balanced, 5-10 minutes
    expect(TRACKING_POLICY.PASSIVE.desiredAccuracy).toBe('BALANCED');
    expect(TRACKING_POLICY.PASSIVE.freshnessWindowSeconds).toEqual({
      min: 5 * 60,
      max: 10 * 60,
    });

    // walking: moderate accuracy, distance-based
    expect(TRACKING_POLICY.WALKING.desiredAccuracy).toBe('BALANCED');
    expect(TRACKING_POLICY.WALKING.primaryTrigger).toBe('DISTANCE');
    expect(TRACKING_POLICY.WALKING.distanceFilterMeters).toBeLessThan(
      TRACKING_POLICY.STATIONARY.distanceFilterMeters,
    );

    // transit: 2-5 minutes
    expect(TRACKING_POLICY.TRANSIT.freshnessWindowSeconds).toEqual({
      min: 2 * 60,
      max: 5 * 60,
    });

    // live: high accuracy, 10-30 seconds
    expect(TRACKING_POLICY.LIVE.freshnessWindowSeconds).toEqual({ min: 10, max: 30 });
    expect(TRACKING_POLICY.LIVE.targetFreshnessSeconds).toBeGreaterThanOrEqual(10);
    expect(TRACKING_POLICY.LIVE.targetFreshnessSeconds).toBeLessThanOrEqual(30);
  });

  it('spends less battery as the battery drains', () => {
    expect(TRACKING_POLICY.LOW_BATTERY.targetFreshnessSeconds).toBeGreaterThan(
      TRACKING_POLICY.PASSIVE.targetFreshnessSeconds,
    );
    expect(TRACKING_POLICY.CRITICAL_BATTERY.targetFreshnessSeconds).toBeGreaterThanOrEqual(
      TRACKING_POLICY.LOW_BATTERY.targetFreshnessSeconds,
    );
    expect(TRACKING_POLICY.CRITICAL_BATTERY.distanceFilterMeters).toBeGreaterThan(
      TRACKING_POLICY.LOW_BATTERY.distanceFilterMeters,
    );
  });
});
