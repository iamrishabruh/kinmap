import type { DeviceRecord, FamilyMembershipRecord, UserAccountRecord } from '@family/auth';
import type { DeviceId, FamilyId, UserId } from '@family/contracts';
import type { StrictLocationEvent } from '@family/schemas';

export const USER_ID = '11111111-1111-4111-8111-111111111111' as UserId;
export const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222' as UserId;
export const DEVICE_ID = '33333333-3333-4333-8333-333333333333' as DeviceId;
export const FAMILY_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa' as FamilyId;
export const FAMILY_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb' as FamilyId;

export const NOW = new Date('2026-08-02T12:00:00.000Z');

let eventCounter = 0;

/** Deterministic v4-shaped ids so tests can assert on ordering without churn. */
export function eventId(index: number): string {
  const suffix = index.toString(16).padStart(12, '0');
  return `44444444-4444-4444-8444-${suffix}`;
}

export function makeEvent(overrides: Partial<StrictLocationEvent> = {}): StrictLocationEvent {
  eventCounter += 1;
  return {
    eventId: eventId(eventCounter),
    deviceId: DEVICE_ID,
    sequenceNumber: eventCounter,
    latitude: 37.4,
    longitude: -122.1,
    horizontalAccuracy: 12,
    trackingMode: 'WALKING',
    capturedAt: NOW.toISOString(),
    createdAt: NOW.toISOString(),
    ...overrides,
  };
}

export function activeAccount(): UserAccountRecord {
  return { userId: USER_ID, status: 'ACTIVE' };
}

export function activeDevice(): DeviceRecord {
  return { userId: USER_ID, deviceId: DEVICE_ID, status: 'ACTIVE' };
}

export function sharingMembership(
  familyId: FamilyId = FAMILY_A,
  overrides: Partial<FamilyMembershipRecord> = {},
): FamilyMembershipRecord {
  return {
    familyId,
    userId: USER_ID,
    role: 'MEMBER',
    status: 'ACTIVE',
    sharingStatus: 'SHARING',
    visibleToUserIds: null,
    ...overrides,
  };
}
