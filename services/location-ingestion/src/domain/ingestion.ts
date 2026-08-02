import { AppError, LIMITS } from '@family/contracts';
import type { RejectedLocationEvent, StrictLocationEvent } from '@family/schemas';
import { isPlausibleLocation, type TimedGeoPoint } from '@family/validation';

import type { SharingDisposition } from './sharing.js';

/**
 * Batch acceptance planning.
 *
 * Pure: no clock, no I/O, no logging. Everything a batch decision depends on is
 * an argument, which is what makes the ordering and duplicate rules testable
 * without a table, a KMS key, or a Lambda.
 *
 * Ordering is load-bearing. Points are processed in `sequenceNumber` order —
 * the device's own monotonic counter — because the duplicate and derived-speed
 * checks each compare against the previously accepted point, and evaluating a
 * retransmitted batch in arrival order would make those comparisons meaningless.
 *
 * Every rejection carries a `LocationRejectionReason`: a fixed, digit-free
 * constant that is safe to log, to count as a metric dimension, and to return to
 * the device so it can drop a permanently-bad point instead of retrying it until
 * its queue overflows.
 */

export type IngestionPlanInput = {
  readonly events: readonly StrictLocationEvent[];
  /**
   * The last fix already stored for this device, when one is available in
   * plaintext. Ingestion holds an encrypt-only grant on the coordinate key, so
   * in production this is null and cross-batch comparison is handled by the
   * conditional current-fix write instead.
   */
  readonly previousFix: TimedGeoPoint | null;
  readonly disposition: SharingDisposition;
  readonly now: Date;
};

export type IngestionPlan = {
  /** In ascending `sequenceNumber` order. */
  readonly accepted: readonly StrictLocationEvent[];
  readonly rejected: readonly RejectedLocationEvent[];
  /** True when consent was absent: the request succeeded, the points were dropped. */
  readonly suppressed: boolean;
  /** Highest sequence number that will be durably stored; the device truncates below it. */
  readonly highWaterMarkSequenceNumber: number | null;
  /** The single accepted point that may advance the current fix, if any. */
  readonly newestAccepted: StrictLocationEvent | null;
};

/**
 * Deterministic total order over a batch. `sequenceNumber` first because that is
 * the device's own ordering; `capturedAt` and `eventId` only break ties so that
 * the same batch always plans identically.
 */
function compareEvents(left: StrictLocationEvent, right: StrictLocationEvent): number {
  if (left.sequenceNumber !== right.sequenceNumber) {
    return left.sequenceNumber - right.sequenceNumber;
  }
  if (left.capturedAt !== right.capturedAt) {
    return left.capturedAt < right.capturedAt ? -1 : 1;
  }
  return left.eventId < right.eventId ? -1 : left.eventId > right.eventId ? 1 : 0;
}

function toTimedPoint(event: StrictLocationEvent): TimedGeoPoint {
  return {
    latitude: event.latitude,
    longitude: event.longitude,
    capturedAt: event.capturedAt,
  };
}

export function planIngestion(input: IngestionPlanInput): IngestionPlan {
  if (input.events.length > LIMITS.MAX_EVENTS_PER_BATCH) {
    // The request schema enforces this too; keeping it here means the rule holds
    // for any caller of the domain, not just the HTTP one.
    throw new AppError(
      'PAYLOAD_TOO_LARGE',
      'The request body is larger than the maximum allowed size.',
    );
  }

  const ordered = [...input.events].sort(compareEvents);
  const rejected: RejectedLocationEvent[] = [];
  const rejectedIds = new Set<string>();

  const reject = (eventId: string, reason: RejectedLocationEvent['reason']): void => {
    if (rejectedIds.has(eventId)) {
      return;
    }
    rejectedIds.add(eventId);
    rejected.push({ eventId, reason });
  };

  if (input.disposition === 'SUPPRESS') {
    for (const event of ordered) {
      reject(event.eventId, 'SHARING_NOT_ACTIVE');
    }
    return {
      accepted: [],
      rejected,
      suppressed: true,
      highWaterMarkSequenceNumber: null,
      newestAccepted: null,
    };
  }

  const accepted: StrictLocationEvent[] = [];
  const seenEventIds = new Set<string>();
  let previous: TimedGeoPoint | null = input.previousFix;

  for (const event of ordered) {
    if (seenEventIds.has(event.eventId)) {
      // A retransmitted batch commonly repeats an id; that is not an error, but
      // it must not be stored twice or advance the high-water mark twice.
      reject(event.eventId, 'DUPLICATE_EVENT');
      continue;
    }
    seenEventIds.add(event.eventId);

    const verdict = isPlausibleLocation(event, { now: input.now, previous });
    if (!verdict.accepted) {
      reject(event.eventId, verdict.reason);
      continue;
    }

    accepted.push(event);
    previous = toTimedPoint(event);
  }

  let newestAccepted: StrictLocationEvent | null = null;
  let highWaterMarkSequenceNumber: number | null = null;
  for (const event of accepted) {
    if (
      newestAccepted === null ||
      event.capturedAt > newestAccepted.capturedAt ||
      (event.capturedAt === newestAccepted.capturedAt &&
        event.sequenceNumber > newestAccepted.sequenceNumber)
    ) {
      newestAccepted = event;
    }
    if (
      highWaterMarkSequenceNumber === null ||
      event.sequenceNumber > highWaterMarkSequenceNumber
    ) {
      highWaterMarkSequenceNumber = event.sequenceNumber;
    }
  }

  return {
    accepted,
    rejected,
    suppressed: false,
    highWaterMarkSequenceNumber,
    newestAccepted,
  };
}
