import { describe, expect, it } from 'vitest';

import { ACCEPTANCE, LOCATION_PRODUCING_STATES, TRACKING_STATES } from '@family/contracts';

import {
  isDuplicate,
  isPlausibleLocation,
  type LocationAcceptance,
  METERS_PER_DEGREE_LATITUDE,
  type PlausibilityCandidate,
  type TimedGeoPoint,
} from '../index.js';

const NOW = new Date('2026-08-02T12:00:00.000Z');
const NOW_MS = NOW.getTime();

function at(offsetSeconds: number): string {
  return new Date(NOW_MS + offsetSeconds * 1000).toISOString();
}

function candidate(overrides: Partial<PlausibilityCandidate> = {}): PlausibilityCandidate {
  return {
    latitude: 37.4219,
    longitude: -122.0841,
    horizontalAccuracy: 12,
    capturedAt: at(-30),
    trackingMode: 'PASSIVE',
    ...overrides,
  };
}

function judge(
  overrides: Partial<PlausibilityCandidate> = {},
  previous?: TimedGeoPoint | null,
): LocationAcceptance<PlausibilityCandidate> {
  return isPlausibleLocation(candidate(overrides), { now: NOW, previous });
}

/** A point `meters` due north. Exact under the spherical model used here. */
function northOf(base: TimedGeoPoint, meters: number, capturedAt: string): TimedGeoPoint {
  return {
    latitude: base.latitude + meters / METERS_PER_DEGREE_LATITUDE,
    longitude: base.longitude,
    capturedAt,
  };
}

// ---------------------------------------------------------------------------
// Acceptance
// ---------------------------------------------------------------------------

describe('isPlausibleLocation — acceptance', () => {
  it('accepts a healthy fix and returns the original event', () => {
    const event = candidate();
    const result = isPlausibleLocation(event, { now: NOW });

    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.event).toBe(event);
  });

  it('accepts every location-producing tracking state', () => {
    for (const trackingMode of LOCATION_PRODUCING_STATES) {
      expect(judge({ trackingMode }).accepted).toBe(true);
    }
  });

  it('works without a previous point', () => {
    expect(judge({}, null).accepted).toBe(true);
    expect(judge({}, undefined).accepted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Coordinates
// ---------------------------------------------------------------------------

describe('isPlausibleLocation — coordinates', () => {
  it('rejects a latitude above the pole', () => {
    const result = judge({ latitude: 91 });

    expect(result.accepted).toBe(false);
    if (result.accepted) return;
    expect(result.reason).toBe('COORDINATE_OUT_OF_RANGE');
  });

  it('rejects a latitude below the pole', () => {
    const result = judge({ latitude: -90.5 });

    expect(result.accepted).toBe(false);
    if (result.accepted) return;
    expect(result.reason).toBe('COORDINATE_OUT_OF_RANGE');
  });

  it('rejects a longitude outside the valid range', () => {
    const result = judge({ longitude: 180.5 });

    expect(result.accepted).toBe(false);
    if (result.accepted) return;
    expect(result.reason).toBe('COORDINATE_OUT_OF_RANGE');
  });

  it('rejects a non-finite coordinate', () => {
    const result = judge({ latitude: Number.NaN });

    expect(result.accepted).toBe(false);
    if (result.accepted) return;
    expect(result.reason).toBe('COORDINATE_OUT_OF_RANGE');
  });

  it('accepts the exact poles and antimeridian', () => {
    expect(judge({ latitude: 90, longitude: 180 }).accepted).toBe(true);
    expect(judge({ latitude: -90, longitude: -180 }).accepted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Accuracy
// ---------------------------------------------------------------------------

describe('isPlausibleLocation — accuracy', () => {
  it('rejects a negative accuracy, the platform sentinel for an invalid fix', () => {
    const result = judge({ horizontalAccuracy: -1 });

    expect(result.accepted).toBe(false);
    if (result.accepted) return;
    expect(result.reason).toBe('ACCURACY_INVALID');
  });

  it('rejects a non-finite accuracy', () => {
    const result = judge({ horizontalAccuracy: Number.POSITIVE_INFINITY });

    expect(result.accepted).toBe(false);
    if (result.accepted) return;
    expect(result.reason).toBe('ACCURACY_INVALID');
  });

  it('rejects an accuracy above the threshold', () => {
    const result = judge({
      horizontalAccuracy: ACCEPTANCE.MAX_HORIZONTAL_ACCURACY_METERS + 1,
    });

    expect(result.accepted).toBe(false);
    if (result.accepted) return;
    expect(result.reason).toBe('ACCURACY_OUT_OF_BOUNDS');
  });

  it('accepts both ends of the accuracy band', () => {
    expect(judge({ horizontalAccuracy: ACCEPTANCE.MIN_HORIZONTAL_ACCURACY_METERS }).accepted).toBe(
      true,
    );
    expect(judge({ horizontalAccuracy: ACCEPTANCE.MAX_HORIZONTAL_ACCURACY_METERS }).accepted).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// Timestamps
// ---------------------------------------------------------------------------

describe('isPlausibleLocation — timestamps', () => {
  it('rejects an unparseable timestamp', () => {
    const result = judge({ capturedAt: 'yesterday-ish' });

    expect(result.accepted).toBe(false);
    if (result.accepted) return;
    expect(result.reason).toBe('TIMESTAMP_MALFORMED');
  });

  it('rejects a non-string timestamp', () => {
    const result = judge({ capturedAt: 1_770_000_000_000 as unknown as string });

    expect(result.accepted).toBe(false);
    if (result.accepted) return;
    expect(result.reason).toBe('MALFORMED_EVENT');
  });

  it('rejects a clock-skewed future timestamp', () => {
    const result = judge({
      capturedAt: at(ACCEPTANCE.MAX_CLOCK_SKEW_FUTURE_SECONDS + 1),
    });

    expect(result.accepted).toBe(false);
    if (result.accepted) return;
    expect(result.reason).toBe('TIMESTAMP_IN_FUTURE');
  });

  it('tolerates skew right up to the allowance', () => {
    expect(judge({ capturedAt: at(ACCEPTANCE.MAX_CLOCK_SKEW_FUTURE_SECONDS) }).accepted).toBe(true);
  });

  it('rejects an event older than the queue may hold', () => {
    const result = judge({ capturedAt: at(-(ACCEPTANCE.MAX_EVENT_AGE_SECONDS + 1)) });

    expect(result.accepted).toBe(false);
    if (result.accepted) return;
    expect(result.reason).toBe('TIMESTAMP_TOO_OLD');
  });

  it('accepts an event exactly at the age limit', () => {
    expect(judge({ capturedAt: at(-ACCEPTANCE.MAX_EVENT_AGE_SECONDS) }).accepted).toBe(true);
  });

  it('defaults to the current instant when no clock is injected', () => {
    const result = isPlausibleLocation(candidate({ capturedAt: new Date().toISOString() }));

    expect(result.accepted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tracking state
// ---------------------------------------------------------------------------

describe('isPlausibleLocation — tracking state', () => {
  const nonProducing = TRACKING_STATES.filter(
    (state) => !LOCATION_PRODUCING_STATES.includes(state),
  );

  it('covers every state that must not produce a stored point', () => {
    expect(nonProducing).toContain('DISABLED');
    expect(nonProducing).toContain('PERMISSION_REQUIRED');
  });

  it('rejects a fix captured in a non-producing state', () => {
    for (const trackingMode of nonProducing) {
      const result = judge({ trackingMode });

      expect(result.accepted).toBe(false);
      if (result.accepted) continue;
      expect(result.reason).toBe('TRACKING_STATE_NOT_SHAREABLE');
    }
  });
});

// ---------------------------------------------------------------------------
// Speed
// ---------------------------------------------------------------------------

describe('isPlausibleLocation — speed', () => {
  it('rejects a reported speed above the plausible ceiling', () => {
    const result = judge({ speed: ACCEPTANCE.MAX_PLAUSIBLE_SPEED_MPS + 1 });

    expect(result.accepted).toBe(false);
    if (result.accepted) return;
    expect(result.reason).toBe('IMPLAUSIBLE_SPEED');
  });

  it('accepts a reported speed exactly at the ceiling', () => {
    expect(judge({ speed: ACCEPTANCE.MAX_PLAUSIBLE_SPEED_MPS }).accepted).toBe(true);
  });

  it('treats a negative speed as the platform "unknown" sentinel', () => {
    expect(judge({ speed: -1 }).accepted).toBe(true);
  });

  it('rejects a non-finite reported speed as malformed', () => {
    const result = judge({ speed: Number.NaN });

    expect(result.accepted).toBe(false);
    if (result.accepted) return;
    expect(result.reason).toBe('MALFORMED_EVENT');
  });

  it('rejects an implausible speed derived from the previous point', () => {
    const previous: TimedGeoPoint = { latitude: 0, longitude: 0, capturedAt: at(-60) };
    const result = isPlausibleLocation(
      candidate({ latitude: 1, longitude: 0, capturedAt: at(0) }),
      { now: NOW, previous },
    );

    expect(result.accepted).toBe(false);
    if (result.accepted) return;
    expect(result.reason).toBe('IMPLAUSIBLE_SPEED');
  });

  it('accepts a realistic derived speed', () => {
    const previous: TimedGeoPoint = { latitude: 0, longitude: 0, capturedAt: at(-60) };
    const next = northOf(previous, 1000, at(0));
    const result = isPlausibleLocation(
      candidate({ latitude: next.latitude, longitude: next.longitude, capturedAt: at(0) }),
      { now: NOW, previous },
    );

    expect(result.accepted).toBe(true);
  });

  it('skips the derived check when the previous point is not a real coordinate', () => {
    const previous = { latitude: 999, longitude: 0, capturedAt: at(-60) };
    const result = isPlausibleLocation(candidate({ latitude: 1, longitude: 0 }), {
      now: NOW,
      previous,
    });

    expect(result.accepted).toBe(true);
  });

  it('skips the derived check when the two points share a timestamp', () => {
    const previous: TimedGeoPoint = { latitude: 0, longitude: 0, capturedAt: at(0) };
    const result = isPlausibleLocation(
      candidate({ latitude: 1, longitude: 0, capturedAt: at(0) }),
      { now: NOW, previous },
    );

    expect(result.accepted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Duplicates
// ---------------------------------------------------------------------------

describe('isDuplicate', () => {
  const anchor: TimedGeoPoint = {
    latitude: 37.4219,
    longitude: -122.0841,
    capturedAt: at(-30),
  };

  it('assumes the documented thresholds', () => {
    expect(ACCEPTANCE.DUPLICATE_DISTANCE_METERS).toBe(20);
    expect(ACCEPTANCE.DUPLICATE_WINDOW_SECONDS).toBe(60);
  });

  it('is false when there is no previous point', () => {
    expect(isDuplicate(null, anchor)).toBe(false);
    expect(isDuplicate(undefined, anchor)).toBe(false);
  });

  it('is true for the same point moments later', () => {
    expect(isDuplicate(anchor, { ...anchor, capturedAt: at(-20) })).toBe(true);
  });

  it('is true at exactly the time window, since both bounds are inclusive', () => {
    const next = { ...anchor, capturedAt: at(-30 + ACCEPTANCE.DUPLICATE_WINDOW_SECONDS) };

    expect(isDuplicate(anchor, next)).toBe(true);
  });

  it('is false just outside the time window, even at zero distance', () => {
    const next = {
      ...anchor,
      capturedAt: new Date(
        Date.parse(anchor.capturedAt) + ACCEPTANCE.DUPLICATE_WINDOW_SECONDS * 1000 + 1,
      ).toISOString(),
    };

    expect(isDuplicate(anchor, next)).toBe(false);
  });

  it('is true just inside the distance threshold', () => {
    const next = northOf(anchor, ACCEPTANCE.DUPLICATE_DISTANCE_METERS - 0.1, at(-25));

    expect(isDuplicate(anchor, next)).toBe(true);
  });

  it('is false just outside the distance threshold', () => {
    const next = northOf(anchor, ACCEPTANCE.DUPLICATE_DISTANCE_METERS + 0.1, at(-25));

    expect(isDuplicate(anchor, next)).toBe(false);
  });

  it('needs both bounds: far apart inside the window is not a duplicate', () => {
    const next = northOf(anchor, 500, at(-25));

    expect(isDuplicate(anchor, next)).toBe(false);
  });

  it('needs both bounds: close together outside the window is not a duplicate', () => {
    const next = northOf(anchor, 1, at(-30 + ACCEPTANCE.DUPLICATE_WINDOW_SECONDS + 10));

    expect(isDuplicate(anchor, next)).toBe(false);
  });

  it('ignores the order of the two timestamps', () => {
    const earlier = { ...anchor, capturedAt: at(-40) };

    expect(isDuplicate(anchor, earlier)).toBe(true);
  });

  it('is false rather than true when a coordinate is unusable', () => {
    expect(isDuplicate({ ...anchor, latitude: 999 }, anchor)).toBe(false);
    expect(isDuplicate(anchor, { ...anchor, longitude: Number.NaN })).toBe(false);
  });

  it('is false rather than true when a timestamp is unusable', () => {
    expect(isDuplicate({ ...anchor, capturedAt: 'not-a-date' }, anchor)).toBe(false);
    expect(isDuplicate(anchor, { ...anchor, capturedAt: '' })).toBe(false);
  });
});

describe('isPlausibleLocation — duplicate integration', () => {
  it('rejects a fix that duplicates the previous point', () => {
    const previous: TimedGeoPoint = {
      latitude: 37.4219,
      longitude: -122.0841,
      capturedAt: at(-40),
    };
    const result = judge({ capturedAt: at(-30) }, previous);

    expect(result.accepted).toBe(false);
    if (result.accepted) return;
    expect(result.reason).toBe('DUPLICATE_EVENT');
  });

  it('accepts a fix that has moved beyond the duplicate radius', () => {
    const previous: TimedGeoPoint = {
      latitude: 37.4219,
      longitude: -122.0841,
      capturedAt: at(-40),
    };
    const moved = northOf(previous, 100, at(-30));
    const result = judge(
      { latitude: moved.latitude, longitude: moved.longitude, capturedAt: at(-30) },
      previous,
    );

    expect(result.accepted).toBe(true);
  });
});
