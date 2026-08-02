import { randomUUID } from 'node:crypto';

import type {
  AuthContext,
  DeviceRecord,
  DeviceRepository,
  SubscriptionRecord,
  SubscriptionRepository,
  UserAccountRecord,
  UserAccountRepository,
} from '@family/auth';
import type {
  AuditEvent,
  DeviceId,
  FamilyId,
  Plan,
  SubscriptionStatus,
  UserId,
} from '@family/contracts';
import type { EncryptedCoordinateRecord } from '@family/crypto';

import type {
  AuditWriter,
  CurrentLocationReader,
  FamilyMemberRow,
  HistoryPageRequest,
  HistoryReader,
  MembershipDirectory,
  SavedPlaceReader,
  SavedPlaceRow,
  SealedFixRow,
  SealedHistoryRow,
} from '../src/ports.js';

export const REQUESTER = '11111111-1111-4111-8111-111111111111' as UserId;
export const SHARER = '22222222-2222-4222-8222-222222222222' as UserId;
export const PAUSED = '33333333-3333-4333-8333-333333333333' as UserId;
export const HIDDEN_FROM_REQUESTER = '44444444-4444-4444-8444-444444444444' as UserId;
export const OUTSIDER = '55555555-5555-4555-8555-555555555555' as UserId;

export const FAMILY_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa' as FamilyId;
export const DEVICE_ID = 'dddddddd-1111-4111-8111-dddddddddddd' as DeviceId;

export const NOW = new Date('2026-08-02T12:00:00.000Z');

export function authContext(
  userId: UserId = REQUESTER,
  deviceId: DeviceId | null = DEVICE_ID,
): AuthContext {
  return {
    userId,
    deviceId,
    tokenUse: 'access',
    claims: {
      sub: userId,
      token_use: 'access',
      iss: 'https://cognito-idp.test/pool',
      exp: 4_102_444_800,
      iat: 1_700_000_000,
    },
    requestId: 'req-test',
  };
}

export function member(overrides: Partial<FamilyMemberRow> & { userId: UserId }): FamilyMemberRow {
  return {
    familyId: FAMILY_ID,
    role: 'MEMBER',
    status: 'ACTIVE',
    sharingStatus: 'SHARING',
    visibleToUserIds: null,
    sharingChangedAt: null,
    ...overrides,
  };
}

export class InMemoryAccounts implements UserAccountRepository {
  readonly accounts = new Map<string, UserAccountRecord>();

  add(userId: UserId, status: UserAccountRecord['status'] = 'ACTIVE'): this {
    this.accounts.set(userId, { userId, status });
    return this;
  }

  getUserAccount(input: { userId: UserId }): Promise<UserAccountRecord | null> {
    return Promise.resolve(this.accounts.get(input.userId) ?? null);
  }
}

export class InMemoryDevices implements DeviceRepository {
  readonly devices = new Map<string, DeviceRecord>();

  add(userId: UserId, deviceId: DeviceId, status: DeviceRecord['status'] = 'ACTIVE'): this {
    this.devices.set(`${userId}#${deviceId}`, { userId, deviceId, status });
    return this;
  }

  getDevice(input: { userId: UserId; deviceId: DeviceId }): Promise<DeviceRecord | null> {
    return Promise.resolve(this.devices.get(`${input.userId}#${input.deviceId}`) ?? null);
  }
}

export class InMemoryMemberships implements MembershipDirectory {
  readonly rows: FamilyMemberRow[] = [];

  add(row: FamilyMemberRow): this {
    this.rows.push(row);
    return this;
  }

  getMembership(input: { familyId: FamilyId; userId: UserId }): Promise<FamilyMemberRow | null> {
    return Promise.resolve(
      this.rows.find((row) => row.familyId === input.familyId && row.userId === input.userId) ??
        null,
    );
  }

  listFamilyMembers(familyId: FamilyId): Promise<FamilyMemberRow[]> {
    return Promise.resolve(this.rows.filter((row) => row.familyId === familyId));
  }

  listFamiliesForUser(userId: UserId): Promise<FamilyMemberRow[]> {
    return Promise.resolve(
      this.rows.filter((row) => row.userId === userId && row.status === 'ACTIVE'),
    );
  }
}

export class InMemorySubscriptions implements SubscriptionRepository {
  constructor(
    private readonly plan: Plan = 'FAMILY_MONTHLY',
    private readonly status: SubscriptionStatus = 'ACTIVE',
  ) {}

  getSubscriptionForFamily(input: { familyId: FamilyId }): Promise<SubscriptionRecord | null> {
    return Promise.resolve({ familyId: input.familyId, plan: this.plan, status: this.status });
  }
}

export class InMemoryCurrentLocations implements CurrentLocationReader {
  readonly rows = new Map<string, SealedFixRow>();

  set(row: SealedFixRow): this {
    this.rows.set(row.userId, row);
    return this;
  }

  latestForUser(userId: UserId): Promise<SealedFixRow | null> {
    return Promise.resolve(this.rows.get(userId) ?? null);
  }
}

export class InMemoryHistory implements HistoryReader {
  readonly rows: SealedHistoryRow[] = [];
  readonly requests: HistoryPageRequest[] = [];

  add(row: SealedHistoryRow): this {
    this.rows.push(row);
    return this;
  }

  queryDay(request: HistoryPageRequest): Promise<SealedHistoryRow[]> {
    this.requests.push(request);
    const matching = this.rows
      .filter((row) => row.userId === request.userId && row.day === request.day)
      .filter((row) => row.sortKey >= request.lowSortKey && row.sortKey <= request.highSortKey)
      .filter(
        (row) =>
          request.exclusiveStartSortKey === null || row.sortKey > request.exclusiveStartSortKey,
      )
      .sort((left, right) => (left.sortKey < right.sortKey ? -1 : 1));
    return Promise.resolve(matching.slice(0, request.limit));
  }
}

export class InMemorySavedPlaces implements SavedPlaceReader {
  readonly places: SavedPlaceRow[] = [];

  add(place: SavedPlaceRow): this {
    this.places.push(place);
    return this;
  }

  listForFamily(): Promise<SavedPlaceRow[]> {
    return Promise.resolve(this.places);
  }
}

export class RecordingAuditWriter implements AuditWriter {
  readonly events: AuditEvent[] = [];
  failNext = false;

  record(event: AuditEvent): Promise<void> {
    if (this.failNext) {
      return Promise.reject(new Error('audit unavailable'));
    }
    this.events.push(event);
    return Promise.resolve();
  }
}

export function sealedFixRow(input: {
  userId: UserId;
  sealed: EncryptedCoordinateRecord;
  capturedAt: string;
  scopeFamilyId?: FamilyId;
}): SealedFixRow {
  return {
    userId: input.userId,
    deviceId: DEVICE_ID,
    eventId: randomUUID(),
    capturedAt: input.capturedAt,
    receivedAt: input.capturedAt,
    trackingState: 'WALKING',
    motionState: 'WALKING',
    horizontalAccuracy: 8,
    altitude: null,
    heading: null,
    speed: null,
    batteryLevel: 0.72,
    isLowPowerMode: false,
    coordinateScopeFamilyId: input.scopeFamilyId ?? FAMILY_ID,
    sealed: input.sealed,
  };
}
