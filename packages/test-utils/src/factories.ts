import type {
  AuditEvent,
  FamilyRole,
  LocationEvent,
  SavedPlace,
  SubscriptionStatus,
  TrackingState,
} from '@family/contracts';

import { createClock, type Clock } from './clock.js';
import { deviceId, eventId, familyId, placeId, userId } from './ids.js';

/**
 * Builders for the domain objects tests need. Each takes a partial override so
 * a test states only the field it cares about, which keeps the intent of a
 * failing assertion obvious.
 */

const clock: Clock = createClock();

export type Overrides<T> = Partial<T>;

export function buildLocationEvent(overrides: Overrides<LocationEvent> = {}): LocationEvent {
  const capturedAt = overrides.capturedAt ?? clock.nowIso();
  return {
    eventId: eventId(1),
    deviceId: deviceId(1),
    sequenceNumber: 1,
    // San Francisco city hall — a well-known public landmark, never a real user.
    latitude: 37.7793,
    longitude: -122.4193,
    horizontalAccuracy: 12,
    speed: 0,
    heading: 0,
    batteryLevel: 0.8,
    isLowPowerMode: false,
    motionState: 'STATIONARY',
    trackingMode: 'PASSIVE' as TrackingState,
    capturedAt,
    createdAt: capturedAt,
    ...overrides,
  };
}

/** A device's worth of ordered events, each `stepSeconds` apart. */
export function buildEventSequence(
  count: number,
  options: { stepSeconds?: number; startSequence?: number; device?: string } = {},
): LocationEvent[] {
  const step = (options.stepSeconds ?? 60) * 1000;
  const base = clock.nowMs();
  return Array.from({ length: count }, (_, i) =>
    buildLocationEvent({
      eventId: eventId(i + 1),
      deviceId: options.device ?? deviceId(1),
      sequenceNumber: (options.startSequence ?? 0) + i,
      capturedAt: new Date(base + i * step).toISOString(),
      createdAt: new Date(base + i * step).toISOString(),
    }),
  );
}

export function buildSavedPlace(overrides: Overrides<SavedPlace> = {}): SavedPlace {
  const now = clock.nowIso();
  return {
    placeId: placeId(1),
    familyId: familyId(1),
    name: 'Home',
    category: 'HOME',
    latitude: 37.7793,
    longitude: -122.4193,
    radiusMeters: 150,
    notifyOnArrival: true,
    notifyOnDeparture: true,
    createdBy: userId(1),
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1,
    ...overrides,
  };
}

export type MembershipRecord = {
  familyId: string;
  userId: string;
  role: FamilyRole;
  status: 'ACTIVE' | 'PENDING' | 'REMOVED' | 'LEFT' | 'BLOCKED';
  sharingEnabled: boolean;
  joinedAt: string;
};

export function buildMembership(overrides: Overrides<MembershipRecord> = {}): MembershipRecord {
  return {
    familyId: familyId(1),
    userId: userId(1),
    role: 'MEMBER',
    status: 'ACTIVE',
    sharingEnabled: true,
    joinedAt: clock.nowIso(),
    ...overrides,
  };
}

export type FamilyRecord = {
  familyId: string;
  name: string;
  ownerUserId: string;
  createdAt: string;
  memberCount: number;
};

export function buildFamily(overrides: Overrides<FamilyRecord> = {}): FamilyRecord {
  return {
    familyId: familyId(1),
    name: 'Test Family',
    ownerUserId: userId(1),
    createdAt: clock.nowIso(),
    memberCount: 2,
    ...overrides,
  };
}

export type SubscriptionRecord = {
  familyId: string;
  ownerUserId: string;
  plan: string;
  status: SubscriptionStatus;
  store: 'APPLE' | 'GOOGLE' | 'NONE';
  expiresAt: string | null;
  updatedAt: string;
};

export function buildSubscription(
  overrides: Overrides<SubscriptionRecord> = {},
): SubscriptionRecord {
  return {
    familyId: familyId(1),
    ownerUserId: userId(1),
    plan: 'FAMILY_MONTHLY',
    status: 'ACTIVE',
    store: 'APPLE',
    expiresAt: new Date(clock.nowMs() + 30 * 86_400_000).toISOString(),
    updatedAt: clock.nowIso(),
    ...overrides,
  };
}

export function buildAuditEvent(overrides: Overrides<AuditEvent> = {}): AuditEvent {
  return {
    auditId: eventId(99),
    action: 'LOCATION_CURRENT_READ',
    actorUserId: userId(1),
    targetUserId: userId(2),
    familyId: familyId(1),
    metadata: {},
    occurredAt: clock.nowIso(),
    requestId: 'req-test-0001',
    sourceIpHash: null,
    ...overrides,
  };
}
