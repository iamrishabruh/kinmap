import { describe, expect, it } from 'vitest';

import { parseAcceptedLocationEvent } from '../src/messages.js';

/**
 * The producer and this consumer talk over an EventBridge bus, so nothing
 * type-checks between them. They had drifted in three ways at once — a renamed
 * field, a restructured ciphertext, and five extra fields a strict object
 * rejects — and because the rule delivered to a queue, every message simply
 * failed to parse and was dead-lettered. Geofence evaluation had never run, and
 * no alarm could say so: the queue was being drained, just into the DLQ.
 *
 * This is the exact payload `services/location-ingestion` puts on the bus. It
 * is duplicated here on purpose: the point of the test is to fail when one side
 * changes without the other, which a shared import would defeat.
 */
const PUBLISHED_BY_LOCATION_INGESTION = {
  subjectUserId: '018f3a2b-4c5d-7e8f-9a0b-1c2d3e4f5a6b',
  deviceId: '018f3a2b-4c5d-7e8f-9a0b-1c2d3e4f0000',
  eventId: '018f3a2b-4c5d-7e8f-9a0b-1c2d3e4f1111',
  sequenceNumber: 42,
  capturedAt: '2026-08-03T12:00:00.000Z',
  receivedAt: '2026-08-03T12:00:01.000Z',
  trackingMode: 'BALANCED',
  motionState: 'WALKING',
  horizontalAccuracy: 12.5,
  coordinateScopeFamilyId: '018f3a2b-4c5d-7e8f-9a0b-1c2d3e4f2222',
  sealed: {
    ciphertext: 'Y2lwaGVydGV4dA==',
    iv: 'aXZpdml2',
    authTag: 'YXV0aFRhZw==',
    encryptedDataKey: 'ZGF0YUtleQ==',
    keyId: 'arn:aws:kms:us-east-1:000000000000:key/abc',
    algorithm: 'AES-256-GCM',
    schemaVersion: 1,
  },
} as const;

describe('the accepted-location wire contract', () => {
  it('parses exactly what location-ingestion publishes', () => {
    const event = parseAcceptedLocationEvent(PUBLISHED_BY_LOCATION_INGESTION);

    expect(event.eventId).toBe(PUBLISHED_BY_LOCATION_INGESTION.eventId);
    expect(event.userId).toBe(PUBLISHED_BY_LOCATION_INGESTION.subjectUserId);
    expect(event.encryptedCoordinate).toEqual(PUBLISHED_BY_LOCATION_INGESTION.sealed);
  });

  it('reconstructs the key context the coordinate was sealed under', () => {
    // The producer seals with { familyId: scopeFamilyId, userId } and that pair
    // is the KMS encryption context and the GCM additional authenticated data.
    // Reconstructing it wrongly does not fail here — it fails at decrypt, on a
    // real coordinate, in production.
    const event = parseAcceptedLocationEvent(PUBLISHED_BY_LOCATION_INGESTION);

    expect(event.keyContext).toEqual({
      familyId: PUBLISHED_BY_LOCATION_INGESTION.coordinateScopeFamilyId,
      userId: PUBLISHED_BY_LOCATION_INGESTION.subjectUserId,
    });
  });

  it('parses the same payload wrapped in an EventBridge envelope', () => {
    const event = parseAcceptedLocationEvent({
      version: '0',
      'detail-type': 'location.accepted',
      source: 'kinmap.location',
      detail: PUBLISHED_BY_LOCATION_INGESTION,
    });

    expect(event.userId).toBe(PUBLISHED_BY_LOCATION_INGESTION.subjectUserId);
  });

  it('rejects a payload carrying a plaintext coordinate', () => {
    // Strictness is the control: a field nobody declared must never reach a
    // decrypt call or a log line, and a latitude arriving on this bus at all
    // would mean the sealing step had been bypassed upstream.
    expect(() =>
      parseAcceptedLocationEvent({ ...PUBLISHED_BY_LOCATION_INGESTION, latitude: 51.5 }),
    ).toThrow();
  });
});
