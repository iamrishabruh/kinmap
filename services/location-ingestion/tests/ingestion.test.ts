import { describe, expect, it } from 'vitest';

import { AppError, LIMITS } from '@family/contracts';

import { planIngestion } from '../src/domain/ingestion.js';

import { makeEvent, NOW } from './fixtures.js';

describe('planIngestion', () => {
  it('orders acceptance by sequenceNumber regardless of arrival order', () => {
    const first = makeEvent({ sequenceNumber: 10, capturedAt: '2026-08-02T11:00:00.000Z' });
    const second = makeEvent({ sequenceNumber: 20, capturedAt: '2026-08-02T11:05:00.000Z' });
    const third = makeEvent({ sequenceNumber: 30, capturedAt: '2026-08-02T11:10:00.000Z' });

    const plan = planIngestion({
      events: [third, first, second],
      previousFix: null,
      disposition: 'STORE',
      now: NOW,
    });

    expect(plan.accepted.map((event) => event.sequenceNumber)).toEqual([10, 20, 30]);
    expect(plan.highWaterMarkSequenceNumber).toBe(30);
    expect(plan.newestAccepted?.sequenceNumber).toBe(30);
  });

  it('rejects a repeated eventId once, with a permanent reason code', () => {
    const original = makeEvent({ sequenceNumber: 1, latitude: 37.4, longitude: -122.1 });
    const replay = { ...original, sequenceNumber: 2 };

    const plan = planIngestion({
      events: [original, replay],
      previousFix: null,
      disposition: 'STORE',
      now: NOW,
    });

    expect(plan.accepted).toHaveLength(1);
    expect(plan.rejected).toEqual([{ eventId: original.eventId, reason: 'DUPLICATE_EVENT' }]);
  });

  it('drops a point that is a spatial and temporal duplicate of the previous one', () => {
    const first = makeEvent({
      sequenceNumber: 1,
      latitude: 37.4,
      longitude: -122.1,
      capturedAt: '2026-08-02T11:00:00.000Z',
    });
    // Same place, ten seconds later: inside both ACCEPTANCE duplicate bounds.
    const second = makeEvent({
      sequenceNumber: 2,
      latitude: 37.4,
      longitude: -122.1,
      capturedAt: '2026-08-02T11:00:10.000Z',
    });

    const plan = planIngestion({
      events: [first, second],
      previousFix: null,
      disposition: 'STORE',
      now: NOW,
    });

    expect(plan.accepted.map((event) => event.sequenceNumber)).toEqual([1]);
    expect(plan.rejected).toEqual([{ eventId: second.eventId, reason: 'DUPLICATE_EVENT' }]);
  });

  it('rejects an unusable point with a reason the device can act on', () => {
    const tooInaccurate = makeEvent({ horizontalAccuracy: 5_000 });
    const notShareable = makeEvent({ trackingMode: 'DISABLED' });
    const fromTheFuture = makeEvent({ capturedAt: '2026-08-02T13:00:00.000Z' });

    const plan = planIngestion({
      events: [tooInaccurate, notShareable, fromTheFuture],
      previousFix: null,
      disposition: 'STORE',
      now: NOW,
    });

    expect(plan.accepted).toHaveLength(0);
    expect(plan.rejected).toEqual([
      { eventId: tooInaccurate.eventId, reason: 'ACCURACY_OUT_OF_BOUNDS' },
      { eventId: notShareable.eventId, reason: 'TRACKING_STATE_NOT_SHAREABLE' },
      { eventId: fromTheFuture.eventId, reason: 'TIMESTAMP_IN_FUTURE' },
    ]);
  });

  it('never emits a reason code containing a digit or a coordinate', () => {
    const plan = planIngestion({
      events: [makeEvent({ horizontalAccuracy: -1 })],
      previousFix: null,
      disposition: 'STORE',
      now: NOW,
    });

    for (const rejection of plan.rejected) {
      expect(rejection.reason).toMatch(/^[A-Z_]+$/);
    }
  });

  it('discards every point when consent is absent, but reports the batch as handled', () => {
    const events = [makeEvent({ sequenceNumber: 1 }), makeEvent({ sequenceNumber: 2 })];

    const plan = planIngestion({
      events,
      previousFix: null,
      disposition: 'SUPPRESS',
      now: NOW,
    });

    expect(plan.suppressed).toBe(true);
    expect(plan.accepted).toHaveLength(0);
    expect(plan.highWaterMarkSequenceNumber).toBeNull();
    expect(plan.rejected.map((entry) => entry.reason)).toEqual([
      'SHARING_NOT_ACTIVE',
      'SHARING_NOT_ACTIVE',
    ]);
  });

  it('refuses a batch larger than the platform ceiling', () => {
    const events = Array.from({ length: LIMITS.MAX_EVENTS_PER_BATCH + 1 }, (_unused, index) =>
      makeEvent({ sequenceNumber: index }),
    );

    expect(() =>
      planIngestion({ events, previousFix: null, disposition: 'STORE', now: NOW }),
    ).toThrowError(AppError);
  });

  it('chains the plausibility check so an implausible jump inside a batch is caught', () => {
    const start = makeEvent({
      sequenceNumber: 1,
      latitude: 37.4,
      longitude: -122.1,
      capturedAt: '2026-08-02T11:00:00.000Z',
    });
    // Half the planet away, one second later.
    const teleport = makeEvent({
      sequenceNumber: 2,
      latitude: -37.4,
      longitude: 57.9,
      capturedAt: '2026-08-02T11:00:01.000Z',
    });

    const plan = planIngestion({
      events: [start, teleport],
      previousFix: null,
      disposition: 'STORE',
      now: NOW,
    });

    expect(plan.accepted.map((event) => event.sequenceNumber)).toEqual([1]);
    expect(plan.rejected).toEqual([{ eventId: teleport.eventId, reason: 'IMPLAUSIBLE_SPEED' }]);
  });
});
