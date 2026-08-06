import { describe, expect, it } from 'vitest';

import {
  POLICY_VERSIONS,
  AppError,
  ENTITLED_SUBSCRIPTION_STATUSES,
  ENTITLEMENTS,
  ERROR_STATUS,
  ErrorCodeSchema,
  FAMILY_ROLE_RANK,
  FamilyRoleSchema,
  LOCATION_PRODUCING_STATES,
  LocationEventSchema,
  PLAN_TIER,
  PlanSchema,
  SubscriptionStatusSchema,
  TRACKING_STATES,
  TrackingStateSchema,
  opaqueAuthorizationError,
} from '../index.js';
import { ACCEPTANCE, LIMITS } from '../limits.js';
import { CONFIG_GUARDRAILS } from '../location-engine.js';

describe('tracking states', () => {
  it('declares exactly the eleven states in the specification', () => {
    expect(TRACKING_STATES).toHaveLength(11);
    expect(new Set(TRACKING_STATES).size).toBe(11);
  });

  it('never treats DISABLED or PERMISSION_REQUIRED as location-producing', () => {
    // This is the core consent invariant: a user who has not enabled sharing,
    // or whose OS permission is missing, must produce no stored coordinate.
    expect(LOCATION_PRODUCING_STATES).not.toContain('DISABLED');
    expect(LOCATION_PRODUCING_STATES).not.toContain('PERMISSION_REQUIRED');
  });

  it('only lists real states as location-producing', () => {
    for (const state of LOCATION_PRODUCING_STATES) {
      expect(TrackingStateSchema.options).toContain(state);
    }
  });
});

describe('family roles', () => {
  it('ranks every declared role', () => {
    for (const role of FamilyRoleSchema.options) {
      expect(FAMILY_ROLE_RANK[role]).toBeGreaterThan(0);
    }
  });

  it('orders OWNER above ADMIN above ADULT above MEMBER', () => {
    expect(FAMILY_ROLE_RANK.OWNER).toBeGreaterThan(FAMILY_ROLE_RANK.ADMIN);
    expect(FAMILY_ROLE_RANK.ADMIN).toBeGreaterThan(FAMILY_ROLE_RANK.ADULT);
    expect(FAMILY_ROLE_RANK.ADULT).toBeGreaterThan(FAMILY_ROLE_RANK.MEMBER);
  });
});

describe('entitlements', () => {
  it('maps every plan to a tier', () => {
    for (const plan of PlanSchema.options) {
      expect(PLAN_TIER[plan]).toBeDefined();
      expect(ENTITLEMENTS[PLAN_TIER[plan]]).toBeDefined();
    }
  });

  it('gives the free tier no history retention', () => {
    expect(ENTITLEMENTS.FREE.historyRetentionDays).toBe(0);
    expect(ENTITLEMENTS.FREE.liveSessionsEnabled).toBe(false);
  });

  it('never exceeds the platform hard caps', () => {
    for (const tier of Object.values(ENTITLEMENTS)) {
      expect(tier.maxMembersPerFamily).toBeLessThanOrEqual(LIMITS.MAX_FAMILY_MEMBERS);
      expect(tier.maxSavedPlaces).toBeLessThanOrEqual(LIMITS.MAX_SAVED_PLACES);
      expect(tier.historyRetentionDays).toBeLessThanOrEqual(LIMITS.HISTORY_RETENTION_DAYS);
    }
  });

  it('treats grace period and billing retry as still entitled', () => {
    expect(ENTITLED_SUBSCRIPTION_STATUSES).toContain('IN_GRACE_PERIOD');
    expect(ENTITLED_SUBSCRIPTION_STATUSES).toContain('IN_BILLING_RETRY');
    // A refund or revocation must remove access immediately.
    expect(ENTITLED_SUBSCRIPTION_STATUSES).not.toContain('REVOKED');
    expect(ENTITLED_SUBSCRIPTION_STATUSES).not.toContain('REFUNDED');
    expect(ENTITLED_SUBSCRIPTION_STATUSES).not.toContain('EXPIRED');
    for (const status of ENTITLED_SUBSCRIPTION_STATUSES) {
      expect(SubscriptionStatusSchema.options).toContain(status);
    }
  });
});

describe('errors', () => {
  it('maps every error code to an HTTP status', () => {
    for (const code of ErrorCodeSchema.options) {
      expect(ERROR_STATUS[code]).toBeGreaterThanOrEqual(400);
    }
  });

  it('exposes the mapped status on AppError', () => {
    expect(new AppError('RATE_LIMITED', 'slow down').status).toBe(429);
    expect(new AppError('NOT_FOUND', 'gone').status).toBe(404);
  });

  it('produces an authorization denial that reveals nothing about the target', () => {
    const a = opaqueAuthorizationError('req-1');
    const b = opaqueAuthorizationError('req-2');
    // A stalker must not be able to distinguish "no such user" from "not in
    // your family" from "that person paused sharing".
    expect(a.message).toBe(b.message);
    expect(a.code).toBe('FORBIDDEN');
    expect(a.message).not.toMatch(/\d/);
  });
});

describe('limits and guardrails', () => {
  it('caps a live session at ten minutes', () => {
    expect(LIMITS.MAX_LIVE_SESSION_SECONDS).toBe(600);
    expect(CONFIG_GUARDRAILS.liveSessionMaxSeconds.max).toBeLessThanOrEqual(
      LIMITS.MAX_LIVE_SESSION_SECONDS,
    );
  });

  it('keeps every guardrail range internally consistent', () => {
    for (const [name, range] of Object.entries(CONFIG_GUARDRAILS)) {
      expect(range.min, `${name}.min < ${name}.max`).toBeLessThan(range.max);
    }
  });

  it('never lets remote configuration exceed the batch cap', () => {
    expect(CONFIG_GUARDRAILS.uploadBatchSize.max).toBeLessThanOrEqual(LIMITS.MAX_EVENTS_PER_BATCH);
  });

  it('bounds the history query window to the retention period plus a day', () => {
    expect(LIMITS.MAX_HISTORY_RANGE_DAYS).toBe(LIMITS.HISTORY_RETENTION_DAYS + 1);
  });
});

describe('LocationEventSchema', () => {
  const valid = {
    eventId: '00000000-0000-4000-8000-000000000001',
    deviceId: '00000000-0000-4000-8000-000000000002',
    sequenceNumber: 0,
    latitude: 37.7793,
    longitude: -122.4193,
    horizontalAccuracy: 12,
    trackingMode: 'PASSIVE',
    capturedAt: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
  };

  it('accepts a minimal valid event', () => {
    expect(LocationEventSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects an out-of-range latitude', () => {
    expect(LocationEventSchema.safeParse({ ...valid, latitude: 91 }).success).toBe(false);
  });

  it('rejects an out-of-range longitude', () => {
    expect(LocationEventSchema.safeParse({ ...valid, longitude: -181 }).success).toBe(false);
  });

  it('rejects negative accuracy, which both platforms use to mean "invalid fix"', () => {
    expect(LocationEventSchema.safeParse({ ...valid, horizontalAccuracy: -1 }).success).toBe(false);
    expect(ACCEPTANCE.MIN_HORIZONTAL_ACCURACY_METERS).toBe(0);
  });

  it('rejects a tracking mode outside the state machine', () => {
    expect(LocationEventSchema.safeParse({ ...valid, trackingMode: 'TURBO' }).success).toBe(false);
  });

  it('rejects a non-ISO capture timestamp', () => {
    expect(LocationEventSchema.safeParse({ ...valid, capturedAt: 'yesterday' }).success).toBe(
      false,
    );
  });
});

describe('policy versions', () => {
  it('are a single constant that both sides read', async () => {
    // The app and the Cognito PreSignUp trigger each carried their own literal
    // — 2026-05-01 and 2026-01-01 — and nothing compared them. The trigger
    // refuses a sign-up whose accepted versions are not current, so account
    // creation failed for everybody, and the client reported it as "Something
    // went wrong on our end".
    const mobile = await import('../../../../apps/mobile/src/features/consent/versions.js').catch(
      () => null,
    );
    if (mobile === null) return; // contracts must not require the app to build

    expect(mobile.CURRENT_TERMS_VERSION).toBe(POLICY_VERSIONS.termsVersion);
    expect(mobile.CURRENT_PRIVACY_POLICY_VERSION).toBe(POLICY_VERSIONS.privacyPolicyVersion);
  });

  it('is dated, so an acceptance record is legible without a lookup table', () => {
    for (const value of Object.values(POLICY_VERSIONS)) {
      expect(value).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    }
  });
});
