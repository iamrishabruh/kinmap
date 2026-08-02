import {
  ACCEPTANCE,
  type GeofenceTransition,
  type PlaceId,
  type SavedPlace,
  type UserId,
} from '@family/contracts';
import { haversineMeters, isValidCoordinate } from '@family/validation';

/**
 * Arrival / departure detection with hysteresis (spec §13).
 *
 * This module is deliberately pure: no AWS SDK, no clock, no logger, no
 * network. Everything it needs arrives as an argument and everything it decides
 * comes back as a value, so the flapping, dwell, accuracy and ordering rules
 * below are exercised by unit tests rather than by staring at CloudWatch.
 *
 * Three independent defences stop a boundary from flapping:
 *
 *  1. ACCURACY GATE — a fix whose reported horizontal accuracy is not better
 *     than the geofence radius cannot distinguish inside from outside at all,
 *     so it is never allowed to move the state machine.
 *  2. HYSTERESIS BAND — readings within +/- `hysteresisMeters` of the boundary
 *     are "ambiguous" and are treated as no observation. Crossing in requires
 *     getting meaningfully inside; crossing out requires getting meaningfully
 *     outside.
 *  3. DWELL CONFIRMATION — a candidate side must be observed continuously for
 *     the dwell period before the transition fires. Returning to the confirmed
 *     side clears the candidate.
 *
 * Nothing here formats, logs or returns a coordinate. The only location-derived
 * value that escapes is a distance in metres relative to a place the family
 * authored, and even that stays inside the returned evaluation for tests.
 */

/** Which side of the fence a single fix places the subject on. */
export type FenceSide = 'INSIDE' | 'OUTSIDE' | 'AMBIGUOUS';

export type GeofenceOutcome =
  /** No prior state: this fix only establishes the baseline, it never fires. */
  | 'INITIALIZED'
  /** This exact event was already applied to this (user, place). */
  | 'DUPLICATE'
  /** The fix is older than the last one applied; applying it would rewrite history. */
  | 'OUT_OF_ORDER'
  /** Unusable timestamp or coordinate. */
  | 'INVALID_FIX'
  /** Accuracy is too coarse to be trusted against a fence of this radius. */
  | 'LOW_ACCURACY'
  /** Observed side agrees with the confirmed side, or sits in the hysteresis band. */
  | 'UNCHANGED'
  /** A candidate transition is accumulating dwell time but has not confirmed. */
  | 'PENDING'
  | 'ARRIVAL'
  | 'DEPARTURE';

/** Per-(user, place) row persisted in the GeofenceState table. */
export type GeofenceState = {
  readonly userId: UserId;
  readonly placeId: PlaceId;
  /** The confirmed verdict. Only a completed dwell changes this. */
  readonly inside: boolean;
  readonly confirmedAt: string;
  /** Candidate side awaiting dwell confirmation; null when there is none. */
  readonly pendingInside: boolean | null;
  readonly pendingSince: string | null;
  /** Last event applied, so a redelivered SQS message is a no-op. */
  readonly lastEventId: string | null;
  readonly lastCapturedAt: string | null;
  /** Optimistic-concurrency guard; incremented on every persisted write. */
  readonly version: number;
};

/** The already-decrypted fix. Held in memory only, never logged or persisted. */
export type GeofenceFix = {
  readonly eventId: string;
  readonly userId: UserId;
  readonly latitude: number;
  readonly longitude: number;
  readonly horizontalAccuracy: number;
  readonly capturedAt: string;
};

export type GeofenceTuning = {
  /** Hysteresis band as a fraction of the fence radius. */
  readonly hysteresisRatio: number;
  readonly minHysteresisMeters: number;
  readonly maxHysteresisMeters: number;
  readonly arrivalDwellSeconds: number;
  readonly departureDwellSeconds: number;
  /** Ceiling applied on top of the per-fence radius rule. */
  readonly maxAccuracyMeters: number;
};

export const DEFAULT_GEOFENCE_TUNING: GeofenceTuning = {
  hysteresisRatio: 0.15,
  minHysteresisMeters: 20,
  maxHysteresisMeters: 200,
  // A minute standing still is enough to mean "arrived" without announcing a
  // pass-by; departures get longer because losing GPS indoors looks exactly
  // like walking out of the door.
  arrivalDwellSeconds: 60,
  departureDwellSeconds: 120,
  maxAccuracyMeters: ACCEPTANCE.MAX_HORIZONTAL_ACCURACY_METERS,
};

export type GeofenceEvaluation = {
  readonly outcome: GeofenceOutcome;
  readonly transition: GeofenceTransition | null;
  /** Row to persist. Null means "there is nothing worth writing". */
  readonly nextState: GeofenceState | null;
  readonly stateChanged: boolean;
  /** Seconds the current candidate has dwelled, or null when there is none. */
  readonly dwellSeconds: number | null;
};

/**
 * Half-width of the ambiguous band around the boundary.
 *
 * Never wider than half the radius, so the inner boundary stays comfortably
 * positive even for the smallest fence the contract allows (50 m).
 */
export function hysteresisMeters(
  radiusMeters: number,
  tuning: GeofenceTuning = DEFAULT_GEOFENCE_TUNING,
): number {
  const proportional = radiusMeters * tuning.hysteresisRatio;
  const bounded = Math.min(
    Math.max(proportional, tuning.minHysteresisMeters),
    tuning.maxHysteresisMeters,
  );
  return Math.min(bounded, radiusMeters / 2);
}

/** Classifies one distance against the fence, applying the hysteresis band. */
export function observeSide(
  distanceMeters: number,
  radiusMeters: number,
  bandMeters: number,
): FenceSide {
  if (distanceMeters <= radiusMeters - bandMeters) return 'INSIDE';
  if (distanceMeters >= radiusMeters + bandMeters) return 'OUTSIDE';
  return 'AMBIGUOUS';
}

/**
 * True when the fix is precise enough to be trusted against this fence.
 *
 * "Better than the radius" is the operative rule: a fix with 200 m of error
 * says nothing at all about a 150 m fence, and acting on it is how a family
 * gets told someone came home while they are still on the motorway.
 */
export function isAccurateEnough(
  horizontalAccuracy: number,
  radiusMeters: number,
  tuning: GeofenceTuning = DEFAULT_GEOFENCE_TUNING,
): boolean {
  if (!Number.isFinite(horizontalAccuracy)) return false;
  if (horizontalAccuracy < ACCEPTANCE.MIN_HORIZONTAL_ACCURACY_METERS) return false;
  if (horizontalAccuracy > tuning.maxAccuracyMeters) return false;
  return horizontalAccuracy < radiusMeters;
}

function parseMs(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function unchanged(state: GeofenceState | null, outcome: GeofenceOutcome): GeofenceEvaluation {
  return { outcome, transition: null, nextState: state, stateChanged: false, dwellSeconds: null };
}

/**
 * Applies one fix to one fence.
 *
 * @param fix       the decrypted, already-accepted location fix
 * @param place     the family's saved place, straight from the contract type
 * @param state     the previous verdict for this (user, place), or null
 * @param tuning    dwell/hysteresis knobs, injected so tests are deterministic
 */
export function evaluateGeofence(
  fix: GeofenceFix,
  place: Pick<SavedPlace, 'placeId' | 'latitude' | 'longitude' | 'radiusMeters'>,
  state: GeofenceState | null,
  tuning: GeofenceTuning = DEFAULT_GEOFENCE_TUNING,
): GeofenceEvaluation {
  const capturedMs = parseMs(fix.capturedAt);
  if (capturedMs === null) {
    return unchanged(state, 'INVALID_FIX');
  }

  // --- Idempotence -------------------------------------------------------
  // SQS is at-least-once and EventBridge retries. Re-applying the event that
  // produced the current row must not re-announce the transition.
  if (state !== null && state.lastEventId === fix.eventId) {
    return unchanged(state, 'DUPLICATE');
  }

  // --- Ordering ----------------------------------------------------------
  // A device flushing a backlog can deliver yesterday's fix after today's.
  // Applying it would let a stale point undo a real arrival.
  const lastMs = state === null ? null : parseMs(state.lastCapturedAt);
  if (lastMs !== null && capturedMs < lastMs) {
    return unchanged(state, 'OUT_OF_ORDER');
  }

  if (!isValidCoordinate(fix) || !isValidCoordinate(place)) {
    return unchanged(state, 'INVALID_FIX');
  }

  // --- Accuracy gate -----------------------------------------------------
  // Deliberately before any state mutation: a fix we cannot trust must not even
  // start a dwell timer, or a drifting indoor fix would eventually confirm.
  if (!isAccurateEnough(fix.horizontalAccuracy, place.radiusMeters, tuning)) {
    return unchanged(state, 'LOW_ACCURACY');
  }

  const distance = haversineMeters(fix, place);
  const band = hysteresisMeters(place.radiusMeters, tuning);
  const side = observeSide(distance, place.radiusMeters, band);

  const touched = {
    lastEventId: fix.eventId,
    lastCapturedAt: fix.capturedAt,
  } as const;

  // --- First sighting ----------------------------------------------------
  // Establish the baseline silently. Announcing on the first fix would mean a
  // cold start, a newly created place, or a re-created state row all fire an
  // arrival for someone who has not moved.
  if (state === null) {
    const inside = side === 'AMBIGUOUS' ? distance <= place.radiusMeters : side === 'INSIDE';
    return {
      outcome: 'INITIALIZED',
      transition: null,
      nextState: {
        userId: fix.userId,
        placeId: place.placeId,
        inside,
        confirmedAt: fix.capturedAt,
        pendingInside: null,
        pendingSince: null,
        ...touched,
        version: 0,
      },
      stateChanged: true,
      dwellSeconds: null,
    };
  }

  // --- Ambiguous: inside the hysteresis band -----------------------------
  // Not evidence either way. Record that we saw the event (so a redelivery is a
  // duplicate) but leave both the confirmed verdict and the candidate alone.
  if (side === 'AMBIGUOUS') {
    return {
      outcome: 'UNCHANGED',
      transition: null,
      nextState: { ...state, ...touched, version: state.version },
      stateChanged: true,
      dwellSeconds: null,
    };
  }

  const observedInside = side === 'INSIDE';

  // --- Agrees with the confirmed verdict: cancel any candidate -----------
  if (observedInside === state.inside) {
    return {
      outcome: 'UNCHANGED',
      transition: null,
      nextState: {
        ...state,
        pendingInside: null,
        pendingSince: null,
        ...touched,
        version: state.version,
      },
      stateChanged: true,
      dwellSeconds: null,
    };
  }

  // --- Candidate transition: accumulate dwell ---------------------------
  const candidateContinues = state.pendingInside === observedInside && state.pendingSince !== null;
  const pendingSince = candidateContinues ? (state.pendingSince ?? fix.capturedAt) : fix.capturedAt;
  const pendingSinceMs = parseMs(pendingSince) ?? capturedMs;
  const dwellSeconds = Math.max(0, (capturedMs - pendingSinceMs) / 1000);
  const requiredDwell = observedInside ? tuning.arrivalDwellSeconds : tuning.departureDwellSeconds;

  if (dwellSeconds < requiredDwell) {
    return {
      outcome: 'PENDING',
      transition: null,
      nextState: {
        ...state,
        pendingInside: observedInside,
        pendingSince,
        ...touched,
        version: state.version,
      },
      stateChanged: true,
      dwellSeconds,
    };
  }

  return {
    outcome: observedInside ? 'ARRIVAL' : 'DEPARTURE',
    transition: observedInside ? 'ARRIVAL' : 'DEPARTURE',
    nextState: {
      ...state,
      inside: observedInside,
      confirmedAt: fix.capturedAt,
      pendingInside: null,
      pendingSince: null,
      ...touched,
      version: state.version,
    },
    stateChanged: true,
    dwellSeconds,
  };
}

/** Outcomes that represent a confirmed, announceable transition. */
export function isTransition(outcome: GeofenceOutcome): outcome is 'ARRIVAL' | 'DEPARTURE' {
  return outcome === 'ARRIVAL' || outcome === 'DEPARTURE';
}
