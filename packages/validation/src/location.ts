import { ACCEPTANCE, LOCATION_PRODUCING_STATES, type TrackingState } from '@family/contracts';
import type { LocationRejectionReason } from '@family/schemas';

import { haversineMeters, isValidCoordinate, type TimedGeoPoint } from './geo.js';

/**
 * Location acceptance rules (spec §11).
 *
 * Every rejection is reported as one of the `LocationRejectionReason` constants
 * from @family/schemas. Those are fixed, digit-free identifiers, so a rejection
 * can be logged, counted as a metric dimension, and returned to the uploading
 * device without any part of the fix leaking. This module never formats a
 * coordinate, a distance, or a timestamp into a string.
 */

const MILLISECONDS_PER_SECOND = 1000;

/**
 * The minimum an event must look like to be judged. Deliberately structural
 * rather than `LocationEvent`, so a partially-decoded payload can be screened
 * before the full schema parse.
 */
export type PlausibilityCandidate = {
  readonly latitude: number;
  readonly longitude: number;
  readonly horizontalAccuracy: number;
  readonly capturedAt: string;
  readonly trackingMode: TrackingState;
  /** Platform sentinel: a negative value means "speed unknown". */
  readonly speed?: number | undefined;
};

export type PlausibilityOptions = {
  /** Injected for deterministic tests; defaults to the current instant. */
  readonly now?: Date;
  /**
   * The last point already accepted from this device. Supplying it enables the
   * derived-speed and duplicate checks; omitting it skips both.
   */
  readonly previous?: TimedGeoPoint | null | undefined;
};

export type LocationRejection = {
  readonly accepted: false;
  readonly reason: LocationRejectionReason;
};

export type LocationAcceptance<TEvent> =
  { readonly accepted: true; readonly event: TEvent } | LocationRejection;

function reject(reason: LocationRejectionReason): LocationRejection {
  return { accepted: false, reason };
}

/** Milliseconds since epoch, or null when the value is not a usable instant. */
function parseInstant(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Applies the ACCEPTANCE thresholds to a single fix.
 *
 * Checks run cheapest-and-most-structural first so a corrupt payload is never
 * fed to the trigonometry, and so the reported reason is the most specific one
 * that applies.
 */
export function isPlausibleLocation<TEvent extends PlausibilityCandidate>(
  event: TEvent,
  options: PlausibilityOptions = {},
): LocationAcceptance<TEvent> {
  if (typeof event.capturedAt !== 'string' || typeof event.trackingMode !== 'string') {
    return reject('MALFORMED_EVENT');
  }

  if (!isValidCoordinate(event)) {
    return reject('COORDINATE_OUT_OF_RANGE');
  }

  const { horizontalAccuracy } = event;
  if (!Number.isFinite(horizontalAccuracy)) {
    return reject('ACCURACY_INVALID');
  }
  // Both platforms report a negative accuracy to mean "this fix is invalid".
  if (horizontalAccuracy < ACCEPTANCE.MIN_HORIZONTAL_ACCURACY_METERS) {
    return reject('ACCURACY_INVALID');
  }
  if (horizontalAccuracy > ACCEPTANCE.MAX_HORIZONTAL_ACCURACY_METERS) {
    return reject('ACCURACY_OUT_OF_BOUNDS');
  }

  const capturedAtMs = parseInstant(event.capturedAt);
  if (capturedAtMs === null) {
    return reject('TIMESTAMP_MALFORMED');
  }

  const nowMs = (options.now ?? new Date()).getTime();
  const ageSeconds = (nowMs - capturedAtMs) / MILLISECONDS_PER_SECOND;

  if (-ageSeconds > ACCEPTANCE.MAX_CLOCK_SKEW_FUTURE_SECONDS) {
    return reject('TIMESTAMP_IN_FUTURE');
  }
  if (ageSeconds > ACCEPTANCE.MAX_EVENT_AGE_SECONDS) {
    return reject('TIMESTAMP_TOO_OLD');
  }

  // A fix captured while tracking was off must never be stored, whatever the
  // device claims about the rest of the payload.
  if (!LOCATION_PRODUCING_STATES.includes(event.trackingMode)) {
    return reject('TRACKING_STATE_NOT_SHAREABLE');
  }

  const reportedSpeed = event.speed;
  if (reportedSpeed !== undefined) {
    if (!Number.isFinite(reportedSpeed)) {
      return reject('MALFORMED_EVENT');
    }
    if (reportedSpeed > ACCEPTANCE.MAX_PLAUSIBLE_SPEED_MPS) {
      return reject('IMPLAUSIBLE_SPEED');
    }
  }

  const previous = options.previous;
  if (previous !== null && previous !== undefined && isValidCoordinate(previous)) {
    const candidate: TimedGeoPoint = {
      latitude: event.latitude,
      longitude: event.longitude,
      capturedAt: event.capturedAt,
    };

    if (isDuplicate(previous, candidate)) {
      return reject('DUPLICATE_EVENT');
    }

    const previousMs = parseInstant(previous.capturedAt);
    if (previousMs !== null) {
      const elapsedSeconds = Math.abs(capturedAtMs - previousMs) / MILLISECONDS_PER_SECOND;
      if (elapsedSeconds > 0) {
        const derivedSpeed = haversineMeters(previous, candidate) / elapsedSeconds;
        if (derivedSpeed > ACCEPTANCE.MAX_PLAUSIBLE_SPEED_MPS) {
          return reject('IMPLAUSIBLE_SPEED');
        }
      }
    }
  }

  return { accepted: true, event };
}

/**
 * Duplicate rule (ACCEPTANCE): two fixes are duplicates when they are close in
 * space AND close in time. Both bounds are inclusive, so a point exactly at a
 * threshold is treated as a duplicate — the conservative choice, since storing
 * a redundant point costs money and reveals nothing new.
 *
 * Returns false when there is no previous point, when either point is not a
 * real coordinate, or when either timestamp is unusable: "cannot tell" must
 * never be reported as "is a duplicate", or real movement would be dropped.
 */
export function isDuplicate(
  previous: TimedGeoPoint | null | undefined,
  next: TimedGeoPoint,
): boolean {
  if (previous === null || previous === undefined) {
    return false;
  }
  if (!isValidCoordinate(previous) || !isValidCoordinate(next)) {
    return false;
  }

  const previousMs = parseInstant(previous.capturedAt);
  const nextMs = parseInstant(next.capturedAt);
  if (previousMs === null || nextMs === null) {
    return false;
  }

  const elapsedSeconds = Math.abs(nextMs - previousMs) / MILLISECONDS_PER_SECOND;
  if (elapsedSeconds > ACCEPTANCE.DUPLICATE_WINDOW_SECONDS) {
    return false;
  }

  return haversineMeters(previous, next) <= ACCEPTANCE.DUPLICATE_DISTANCE_METERS;
}
