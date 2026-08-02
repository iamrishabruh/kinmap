import { describe, expect, it } from 'vitest';

import { LIMITS } from '@family/contracts';

import {
  CreateFamilyRequestSchema,
  CreateInvitationRequestSchema,
  CreateLiveSessionRequestSchema,
  CreatePlaceRequestSchema,
  DeleteAccountRequestSchema,
  HiddenMemberLocationSchema,
  LocationBatchRequestSchema,
  LocationHistoryQuerySchema,
  MemberCurrentLocationSchema,
  PushPayloadSchema,
  RegisterDeviceRequestSchema,
  RevenueCatWebhookSchema,
  UpdateFamilyRequestSchema,
  UpdateSharingRequestSchema,
} from '../index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Deterministic, RFC 4122-valid UUIDs so tests never depend on randomness. */
function uuid(seed: number): string {
  return `00000000-0000-4000-8000-${seed.toString(16).padStart(12, '0')}`;
}

const DEVICE_ID = uuid(1);
const FAMILY_ID = uuid(2);
const TARGET_USER_ID = uuid(3);

const CAPTURED_AT = '2026-08-02T10:00:00.000Z';
const CREATED_AT = '2026-08-02T10:00:01.000Z';

function locationEvent(index: number, overrides: Record<string, unknown> = {}): unknown {
  return {
    eventId: uuid(1000 + index),
    deviceId: DEVICE_ID,
    sequenceNumber: index,
    latitude: 37.4219,
    longitude: -122.0841,
    horizontalAccuracy: 12,
    trackingMode: 'PASSIVE',
    capturedAt: CAPTURED_AT,
    createdAt: CREATED_AT,
    ...overrides,
  };
}

function batch(eventCount: number): Record<string, unknown> {
  return {
    deviceId: DEVICE_ID,
    uploadedAt: CREATED_AT,
    events: Array.from({ length: eventCount }, (_unused, index) => locationEvent(index)),
  };
}

/** Codes of every issue in a failed parse, whatever nesting level produced it. */
function issueCodes(error: {
  issues: ReadonlyArray<{ code?: string | undefined }>;
}): Array<string | undefined> {
  return error.issues.map((issue) => issue.code);
}

/** The minimum surface of a Zod schema these table-driven tests need. */
type ParsableSchema = {
  safeParse: (data: unknown) => { success: boolean };
};

// ---------------------------------------------------------------------------
// Batch size
// ---------------------------------------------------------------------------

describe('POST /v1/locations/batch — batch size', () => {
  it('accepts a batch at exactly MAX_EVENTS_PER_BATCH', () => {
    expect(LIMITS.MAX_EVENTS_PER_BATCH).toBe(100);

    const result = LocationBatchRequestSchema.safeParse(batch(LIMITS.MAX_EVENTS_PER_BATCH));

    expect(result.success).toBe(true);
  });

  it('rejects a batch of 101 events', () => {
    const result = LocationBatchRequestSchema.safeParse(batch(LIMITS.MAX_EVENTS_PER_BATCH + 1));

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((issue) => issue.path[0] === 'events')).toBe(true);
    expect(issueCodes(result.error)).toContain('too_big');
  });

  it('rejects an empty batch', () => {
    expect(LocationBatchRequestSchema.safeParse(batch(0)).success).toBe(false);
  });

  it('rejects a batch containing an event from another device', () => {
    const result = LocationBatchRequestSchema.safeParse({
      ...batch(1),
      events: [locationEvent(0), locationEvent(1, { deviceId: uuid(99) })],
    });

    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// History range
// ---------------------------------------------------------------------------

describe('GET /v1/users/{userId}/locations/history — range', () => {
  const base: Record<string, unknown> = {};

  it('accepts an optional family scope', () => {
    const result = LocationHistoryQuerySchema.safeParse({
      familyId: FAMILY_ID,
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-01-02T00:00:00.000Z',
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.familyId).toBe(FAMILY_ID);
  });

  it('accepts a range at exactly MAX_HISTORY_RANGE_DAYS', () => {
    expect(LIMITS.MAX_HISTORY_RANGE_DAYS).toBe(31);

    const result = LocationHistoryQuerySchema.safeParse({
      ...base,
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-02-01T00:00:00.000Z',
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.limit).toBe(LIMITS.DEFAULT_HISTORY_PAGE_SIZE);
    expect(result.data.cursor).toBeNull();
  });

  it('rejects a 32-day range', () => {
    const result = LocationHistoryQuerySchema.safeParse({
      ...base,
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-02-02T00:00:00.000Z',
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((issue) => issue.path.includes('to'))).toBe(true);
  });

  it('rejects an inverted range', () => {
    const result = LocationHistoryQuerySchema.safeParse({
      ...base,
      from: '2026-02-01T00:00:00.000Z',
      to: '2026-01-01T00:00:00.000Z',
    });

    expect(result.success).toBe(false);
  });

  it('rejects a page size above MAX_HISTORY_PAGE_SIZE', () => {
    const result = LocationHistoryQuerySchema.safeParse({
      ...base,
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-01-02T00:00:00.000Z',
      limit: LIMITS.MAX_HISTORY_PAGE_SIZE + 1,
    });

    expect(result.success).toBe(false);
  });

  it('coerces a query-string page size', () => {
    const result = LocationHistoryQuerySchema.safeParse({
      ...base,
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-01-02T00:00:00.000Z',
      limit: '25',
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.limit).toBe(25);
  });
});

// ---------------------------------------------------------------------------
// Coordinate bounds
// ---------------------------------------------------------------------------

describe('coordinate bounds', () => {
  it('rejects a latitude above 90 in an uploaded event', () => {
    const result = LocationBatchRequestSchema.safeParse({
      ...batch(1),
      events: [locationEvent(0, { latitude: 91 })],
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(
      result.error.issues.some(
        (issue) => issue.path.includes('latitude') && issue.code === 'too_big',
      ),
    ).toBe(true);
  });

  it('rejects a latitude below -90 in an uploaded event', () => {
    const result = LocationBatchRequestSchema.safeParse({
      ...batch(1),
      events: [locationEvent(0, { latitude: -90.0001 })],
    });

    expect(result.success).toBe(false);
  });

  it('rejects a longitude outside the valid range in an uploaded event', () => {
    const result = LocationBatchRequestSchema.safeParse({
      ...batch(1),
      events: [locationEvent(0, { longitude: 180.5 })],
    });

    expect(result.success).toBe(false);
  });

  it('rejects an out-of-range latitude on a saved place', () => {
    const result = CreatePlaceRequestSchema.safeParse({
      familyId: FAMILY_ID,
      name: 'Home',
      category: 'HOME',
      latitude: 91,
      longitude: 0,
      radiusMeters: 100,
      notifyOnArrival: true,
      notifyOnDeparture: false,
    });

    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Unknown-key policy
// ---------------------------------------------------------------------------

describe('unknown keys', () => {
  const firstPartyRequests: Array<[string, ParsableSchema, Record<string, unknown>]> = [
    [
      'CreateFamilyRequest',
      CreateFamilyRequestSchema,
      { name: 'Home', timeZone: 'America/New_York' },
    ],
    ['UpdateFamilyRequest', UpdateFamilyRequestSchema, { name: 'Home' }],
    ['CreateInvitationRequest', CreateInvitationRequestSchema, {}],
    [
      'CreatePlaceRequest',
      CreatePlaceRequestSchema,
      {
        familyId: FAMILY_ID,
        name: 'Home',
        category: 'HOME',
        latitude: 37.4219,
        longitude: -122.0841,
        radiusMeters: 100,
        notifyOnArrival: true,
        notifyOnDeparture: false,
      },
    ],
    [
      'CreateLiveSessionRequest',
      CreateLiveSessionRequestSchema,
      { familyId: FAMILY_ID, targetUserId: TARGET_USER_ID },
    ],
    ['UpdateSharingRequest', UpdateSharingRequestSchema, { scope: 'GLOBAL', sharing: false }],
    ['DeleteAccountRequest', DeleteAccountRequestSchema, { confirmation: 'DELETE' }],
    [
      'RegisterDeviceRequest',
      RegisterDeviceRequestSchema,
      {
        deviceId: DEVICE_ID,
        platform: 'IOS',
        osVersion: '18.2',
        appVersion: '1.0.0',
        appBuild: '42',
        modelIdentifier: 'iPhone16,2',
        locale: 'en-US',
        timeZone: 'America/New_York',
      },
    ],
    ['LocationBatchRequest', LocationBatchRequestSchema, batch(1)],
  ];

  for (const [name, schema, payload] of firstPartyRequests) {
    it(`${name} accepts its baseline payload`, () => {
      expect(schema.safeParse(payload).success).toBe(true);
    });

    it(`${name} rejects an unrecognised key rather than stripping it`, () => {
      expect(schema.safeParse({ ...payload, sneakyExtraField: 'nope' }).success).toBe(false);
    });
  }

  it('rejects an unrecognised key nested inside a batch event', () => {
    const result = LocationBatchRequestSchema.safeParse({
      ...batch(1),
      events: [locationEvent(0, { rawAddress: '1 Infinite Loop' })],
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(issueCodes(result.error)).toContain('unrecognized_keys');
  });

  it('rejects an unrecognised key nested two levels deep, inside device health', () => {
    const result = LocationBatchRequestSchema.safeParse({
      ...batch(1),
      health: {
        permission: {
          authorization: 'ALWAYS',
          preciseLocationEnabled: true,
          locationServicesEnabled: true,
          notificationsEnabled: true,
          backgroundRefreshEnabled: true,
          lastKnownLatitude: 37.4219,
        },
        trackingState: 'PASSIVE',
        batteryLevel: 0.8,
        isLowPowerMode: false,
        isCharging: null,
        pendingEventCount: 0,
        oldestPendingEventAt: null,
        lastAcceptedAt: null,
        lastUploadAttemptAt: null,
        lastUploadError: null,
        remoteConfigVersion: null,
      },
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(issueCodes(result.error)).toContain('unrecognized_keys');
  });

  it('preserves unknown keys on third-party webhooks, the one documented exception', () => {
    const result = RevenueCatWebhookSchema.safeParse({
      api_version: '1.0',
      event: {
        id: 'evt_1',
        type: 'INITIAL_PURCHASE',
        event_timestamp_ms: 1_770_000_000_000,
        app_user_id: TARGET_USER_ID,
        a_field_the_provider_added_last_week: true,
      },
      another_new_top_level_field: 'kept',
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect((result.data as Record<string, unknown>)['another_new_top_level_field']).toBe('kept');
  });
});

// ---------------------------------------------------------------------------
// Privacy: a paused user has no representable coordinate
// ---------------------------------------------------------------------------

describe('sharing-paused responses carry no coordinate', () => {
  const hidden = {
    visibility: 'HIDDEN',
    userId: TARGET_USER_ID,
    sharingStatus: 'PAUSED',
    freshness: 'UNKNOWN',
    sharingChangedAt: '2026-08-02T09:00:00.000Z',
  };

  it('parses a hidden member with no positional data', () => {
    const result = MemberCurrentLocationSchema.safeParse(hidden);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(Object.keys(result.data)).not.toContain('point');
  });

  it('refuses to attach a coordinate to a hidden member', () => {
    const result = HiddenMemberLocationSchema.safeParse({
      ...hidden,
      point: { latitude: 37.4219, longitude: -122.0841, horizontalAccuracy: 5 },
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(issueCodes(result.error)).toContain('unrecognized_keys');
  });

  it('refuses a bare latitude on a hidden member', () => {
    expect(HiddenMemberLocationSchema.safeParse({ ...hidden, latitude: 37.4219 }).success).toBe(
      false,
    );
  });

  it('will not let a paused member appear in the VISIBLE arm', () => {
    const result = MemberCurrentLocationSchema.safeParse({
      visibility: 'VISIBLE',
      userId: TARGET_USER_ID,
      sharingStatus: 'PAUSED',
      point: { latitude: 37.4219, longitude: -122.0841, horizontalAccuracy: 5 },
      freshness: 'FRESH',
      capturedAt: CAPTURED_AT,
      receivedAt: CREATED_AT,
      trackingState: 'PASSIVE',
      motionState: 'STATIONARY',
      batteryLevel: 0.5,
      isCharging: false,
      placeId: null,
      placeName: null,
      liveSessionExpiresAt: null,
    });

    expect(result.success).toBe(false);
  });

  it('accepts the VISIBLE arm only for a member who is actively sharing', () => {
    const result = MemberCurrentLocationSchema.safeParse({
      visibility: 'VISIBLE',
      userId: TARGET_USER_ID,
      sharingStatus: 'SHARING',
      point: { latitude: 37.4219, longitude: -122.0841, horizontalAccuracy: 5 },
      freshness: 'FRESH',
      capturedAt: CAPTURED_AT,
      receivedAt: CREATED_AT,
      trackingState: 'PASSIVE',
      motionState: 'STATIONARY',
      batteryLevel: 0.5,
      isCharging: false,
      placeId: null,
      placeName: null,
      liveSessionExpiresAt: null,
    });

    expect(result.success).toBe(true);
  });

  it('keeps coordinates out of push payloads', () => {
    const result = PushPayloadSchema.safeParse({
      kind: 'ARRIVAL',
      notificationId: uuid(7),
      familyId: FAMILY_ID,
      subjectUserId: TARGET_USER_ID,
      subjectDisplayName: 'Sam',
      placeId: uuid(8),
      placeName: 'Home',
      transition: 'ARRIVAL',
      liveSessionId: null,
      occurredAt: CAPTURED_AT,
      deepLinkPath: '/family/map',
      latitude: 37.4219,
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(issueCodes(result.error)).toContain('unrecognized_keys');
  });

  it('rejects a deep link that smuggles data in a query string', () => {
    const result = PushPayloadSchema.safeParse({
      kind: 'ARRIVAL',
      notificationId: uuid(7),
      familyId: FAMILY_ID,
      subjectUserId: TARGET_USER_ID,
      subjectDisplayName: 'Sam',
      placeId: null,
      placeName: null,
      transition: 'ARRIVAL',
      liveSessionId: null,
      occurredAt: CAPTURED_AT,
      deepLinkPath: '/family/map?lat=37.4219&lng=-122.0841',
    });

    expect(result.success).toBe(false);
  });
});
