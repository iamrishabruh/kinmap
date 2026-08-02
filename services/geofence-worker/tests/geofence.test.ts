import { describe, expect, it } from 'vitest';

import type { SavedPlace } from '@family/contracts';
import { METERS_PER_DEGREE_LATITUDE } from '@family/validation';

import {
  DEFAULT_GEOFENCE_TUNING,
  evaluateGeofence,
  hysteresisMeters,
  isAccurateEnough,
  observeSide,
  type GeofenceEvaluation,
  type GeofenceFix,
  type GeofenceState,
} from '../src/geofence.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const PLACE_ID = '22222222-2222-4222-8222-222222222222';
const FAMILY_ID = '33333333-3333-4333-8333-333333333333';

const PLACE_LATITUDE = 37.5;
const PLACE_LONGITUDE = -122.25;
const RADIUS_METERS = 200;

const place: SavedPlace = {
  placeId: PLACE_ID,
  familyId: FAMILY_ID,
  name: 'Home',
  category: 'HOME',
  latitude: PLACE_LATITUDE,
  longitude: PLACE_LONGITUDE,
  radiusMeters: RADIUS_METERS,
  notifyOnArrival: true,
  notifyOnDeparture: true,
  createdBy: USER_ID,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  schemaVersion: 1,
};

const EPOCH = Date.parse('2026-06-01T12:00:00.000Z');

function at(offsetSeconds: number): string {
  return new Date(EPOCH + offsetSeconds * 1000).toISOString();
}

/** Builds a fix `distanceMeters` due north of the place. */
function fixAt(options: {
  distanceMeters: number;
  offsetSeconds: number;
  accuracy?: number;
  eventId?: string;
}): GeofenceFix {
  return {
    eventId: options.eventId ?? `event-${String(options.offsetSeconds)}`,
    userId: USER_ID,
    latitude: PLACE_LATITUDE + options.distanceMeters / METERS_PER_DEGREE_LATITUDE,
    longitude: PLACE_LONGITUDE,
    horizontalAccuracy: options.accuracy ?? 15,
    capturedAt: at(options.offsetSeconds),
  };
}

/** Drives a sequence of fixes through the evaluator, threading the state. */
function drive(fixes: readonly GeofenceFix[]): {
  outcomes: string[];
  transitions: string[];
  state: GeofenceState | null;
  evaluations: GeofenceEvaluation[];
} {
  let state: GeofenceState | null = null;
  const outcomes: string[] = [];
  const transitions: string[] = [];
  const evaluations: GeofenceEvaluation[] = [];

  for (const fix of fixes) {
    const evaluation = evaluateGeofence(fix, place, state, DEFAULT_GEOFENCE_TUNING);
    evaluations.push(evaluation);
    outcomes.push(evaluation.outcome);
    if (evaluation.transition !== null) transitions.push(evaluation.transition);
    if (evaluation.stateChanged && evaluation.nextState !== null) {
      state = { ...evaluation.nextState, version: evaluation.nextState.version + 1 };
    }
  }

  return { outcomes, transitions, state, evaluations };
}

describe('hysteresis band', () => {
  it('is proportional but clamped, and never wider than half the radius', () => {
    expect(hysteresisMeters(200)).toBe(30);
    // 15% of 50 m is below the floor, and the floor is capped at radius/2.
    expect(hysteresisMeters(50)).toBe(20);
    // 15% of 10 km exceeds the ceiling.
    expect(hysteresisMeters(10_000)).toBe(200);
  });

  it('treats the band around the boundary as ambiguous', () => {
    expect(observeSide(150, 200, 30)).toBe('INSIDE');
    expect(observeSide(170, 200, 30)).toBe('INSIDE');
    expect(observeSide(200, 200, 30)).toBe('AMBIGUOUS');
    expect(observeSide(229, 200, 30)).toBe('AMBIGUOUS');
    expect(observeSide(230, 200, 30)).toBe('OUTSIDE');
  });
});

describe('accuracy gate', () => {
  it('requires accuracy strictly better than the fence radius', () => {
    expect(isAccurateEnough(199, 200)).toBe(true);
    expect(isAccurateEnough(200, 200)).toBe(false);
    expect(isAccurateEnough(201, 200)).toBe(false);
  });

  it('rejects a nonsensical accuracy outright', () => {
    expect(isAccurateEnough(Number.NaN, 200)).toBe(false);
    expect(isAccurateEnough(-1, 200)).toBe(false);
    // Above the platform-wide acceptance ceiling even for a huge fence.
    expect(isAccurateEnough(600, 10_000)).toBe(false);
  });

  it('does not let a low-accuracy fix start a dwell timer or fire', () => {
    const { outcomes, transitions, state } = drive([
      fixAt({ distanceMeters: 500, offsetSeconds: 0 }),
      // Reports being at the centre, but with 250 m of error against a 200 m
      // fence: unusable, so nothing at all should move.
      fixAt({ distanceMeters: 0, offsetSeconds: 60, accuracy: 250 }),
      fixAt({ distanceMeters: 0, offsetSeconds: 300, accuracy: 250 }),
      fixAt({ distanceMeters: 0, offsetSeconds: 600, accuracy: 250 }),
    ]);

    expect(outcomes).toEqual(['INITIALIZED', 'LOW_ACCURACY', 'LOW_ACCURACY', 'LOW_ACCURACY']);
    expect(transitions).toEqual([]);
    expect(state?.inside).toBe(false);
    expect(state?.pendingSince).toBeNull();
  });
});

describe('first sighting', () => {
  it('establishes a baseline without announcing anything', () => {
    const { outcomes, transitions, state } = drive([
      fixAt({ distanceMeters: 10, offsetSeconds: 0 }),
    ]);

    expect(outcomes).toEqual(['INITIALIZED']);
    expect(transitions).toEqual([]);
    expect(state?.inside).toBe(true);
  });
});

describe('dwell confirmation', () => {
  it('withholds the arrival until the dwell period has elapsed', () => {
    const { outcomes, transitions, evaluations } = drive([
      fixAt({ distanceMeters: 500, offsetSeconds: -30 }),
      fixAt({ distanceMeters: 20, offsetSeconds: 0 }),
      fixAt({ distanceMeters: 20, offsetSeconds: 30 }),
      fixAt({ distanceMeters: 20, offsetSeconds: 59 }),
      fixAt({ distanceMeters: 20, offsetSeconds: 60 }),
    ]);

    expect(outcomes).toEqual(['INITIALIZED', 'PENDING', 'PENDING', 'PENDING', 'ARRIVAL']);
    expect(transitions).toEqual(['ARRIVAL']);
    expect(evaluations.at(-2)?.dwellSeconds).toBe(59);
    expect(evaluations.at(-1)?.dwellSeconds).toBe(60);
  });

  it('requires a longer dwell before announcing a departure', () => {
    const { outcomes, transitions } = drive([
      fixAt({ distanceMeters: 500, offsetSeconds: -60 }),
      fixAt({ distanceMeters: 20, offsetSeconds: 0 }),
      fixAt({ distanceMeters: 20, offsetSeconds: 60 }),
      fixAt({ distanceMeters: 500, offsetSeconds: 120 }),
      fixAt({ distanceMeters: 500, offsetSeconds: 200 }),
      fixAt({ distanceMeters: 500, offsetSeconds: 240 }),
    ]);

    expect(outcomes).toEqual([
      'INITIALIZED',
      'PENDING',
      'ARRIVAL',
      'PENDING',
      'PENDING',
      'DEPARTURE',
    ]);
    expect(transitions).toEqual(['ARRIVAL', 'DEPARTURE']);
  });
});

describe('flapping suppression', () => {
  it('fires nothing while a device oscillates across the boundary', () => {
    const fixes: GeofenceFix[] = [fixAt({ distanceMeters: 500, offsetSeconds: -30 })];
    for (let cycle = 0; cycle < 8; cycle += 1) {
      fixes.push(fixAt({ distanceMeters: 20, offsetSeconds: cycle * 60 }));
      fixes.push(fixAt({ distanceMeters: 500, offsetSeconds: cycle * 60 + 30 }));
    }

    const { transitions, outcomes } = drive(fixes);

    expect(transitions).toEqual([]);
    expect(outcomes.filter((outcome) => outcome === 'ARRIVAL' || outcome === 'DEPARTURE')).toEqual(
      [],
    );
  });

  it('ignores readings inside the hysteresis band entirely', () => {
    const { outcomes, transitions, state } = drive([
      fixAt({ distanceMeters: 500, offsetSeconds: 0 }),
      // 210 m from a 200 m fence with a 30 m band: neither in nor out.
      fixAt({ distanceMeters: 210, offsetSeconds: 120 }),
      fixAt({ distanceMeters: 210, offsetSeconds: 600 }),
    ]);

    expect(outcomes).toEqual(['INITIALIZED', 'UNCHANGED', 'UNCHANGED']);
    expect(transitions).toEqual([]);
    expect(state?.pendingInside).toBeNull();
  });

  it('cancels a candidate as soon as the subject returns to the confirmed side', () => {
    const { outcomes, state } = drive([
      fixAt({ distanceMeters: 500, offsetSeconds: 0 }),
      fixAt({ distanceMeters: 20, offsetSeconds: 30 }),
      fixAt({ distanceMeters: 500, offsetSeconds: 40 }),
    ]);

    expect(outcomes).toEqual(['INITIALIZED', 'PENDING', 'UNCHANGED']);
    expect(state?.pendingInside).toBeNull();
    expect(state?.pendingSince).toBeNull();
  });
});

describe('ordering', () => {
  it('produces an arrival before the matching departure and never the reverse', () => {
    const { transitions } = drive([
      fixAt({ distanceMeters: 500, offsetSeconds: 0 }),
      fixAt({ distanceMeters: 20, offsetSeconds: 60 }),
      fixAt({ distanceMeters: 20, offsetSeconds: 121 }),
      fixAt({ distanceMeters: 500, offsetSeconds: 180 }),
      fixAt({ distanceMeters: 500, offsetSeconds: 301 }),
    ]);

    expect(transitions).toEqual(['ARRIVAL', 'DEPARTURE']);
  });

  it('refuses a fix older than the last one applied', () => {
    const first = fixAt({ distanceMeters: 500, offsetSeconds: 0 });
    const second = fixAt({ distanceMeters: 20, offsetSeconds: 600 });
    const late = fixAt({ distanceMeters: 20, offsetSeconds: 60, eventId: 'late-event' });

    let state = evaluateGeofence(first, place, null, DEFAULT_GEOFENCE_TUNING).nextState;
    state = evaluateGeofence(second, place, state, DEFAULT_GEOFENCE_TUNING).nextState;

    const stale = evaluateGeofence(late, place, state, DEFAULT_GEOFENCE_TUNING);

    expect(stale.outcome).toBe('OUT_OF_ORDER');
    expect(stale.stateChanged).toBe(false);
  });

  it('rejects an unparseable capture timestamp', () => {
    const broken: GeofenceFix = {
      ...fixAt({ distanceMeters: 20, offsetSeconds: 0 }),
      capturedAt: 'not-a-time',
    };
    expect(evaluateGeofence(broken, place, null, DEFAULT_GEOFENCE_TUNING).outcome).toBe(
      'INVALID_FIX',
    );
  });
});

describe('idempotent reprocessing', () => {
  it('treats a redelivered event as a duplicate and fires once', () => {
    const arrival = fixAt({ distanceMeters: 20, offsetSeconds: 121, eventId: 'arrival-event' });

    const first = drive([
      fixAt({ distanceMeters: 500, offsetSeconds: 0 }),
      fixAt({ distanceMeters: 20, offsetSeconds: 60 }),
      arrival,
    ]);

    expect(first.transitions).toEqual(['ARRIVAL']);
    const afterArrival = first.state;
    expect(afterArrival).not.toBeNull();

    const replay = evaluateGeofence(arrival, place, afterArrival, DEFAULT_GEOFENCE_TUNING);

    expect(replay.outcome).toBe('DUPLICATE');
    expect(replay.transition).toBeNull();
    expect(replay.stateChanged).toBe(false);
    expect(replay.nextState).toBe(afterArrival);
  });

  it('is stable when the whole sequence is replayed from the persisted state', () => {
    const fixes = [
      fixAt({ distanceMeters: 500, offsetSeconds: 0 }),
      fixAt({ distanceMeters: 20, offsetSeconds: 60 }),
      fixAt({ distanceMeters: 20, offsetSeconds: 121 }),
    ];

    const first = drive(fixes);
    expect(first.transitions).toEqual(['ARRIVAL']);

    // Replaying the identical batch against the state it produced yields the
    // duplicate/out-of-order path, not a second announcement.
    let state = first.state;
    const replayTransitions: string[] = [];
    for (const fix of fixes) {
      const evaluation = evaluateGeofence(fix, place, state, DEFAULT_GEOFENCE_TUNING);
      if (evaluation.transition !== null) replayTransitions.push(evaluation.transition);
      if (evaluation.stateChanged && evaluation.nextState !== null) state = evaluation.nextState;
    }

    expect(replayTransitions).toEqual([]);
    expect(state?.inside).toBe(true);
  });
});
