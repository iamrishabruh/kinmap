import { randomUUID } from 'node:crypto';

import type {
  AuthContext,
  DeviceRecord,
  DeviceRepository,
  SubscriptionRecord,
  UserAccountRecord,
  UserAccountRepository,
} from '@family/auth';
import {
  AppError,
  type AuditEvent,
  type DeviceId,
  type FamilyId,
  type FamilyRole,
  type MembershipStatus,
  type Plan,
  type SubscriptionStatus,
  type UserId,
} from '@family/contracts';

import type {
  AuditWriter,
  FamilyDomainEvent,
  FamilyEventPublisher,
  FamilyRecord,
  FamilyStore,
  MembershipPatch,
  MembershipRow,
  MembershipStore,
} from '../src/ports.js';
import type { SubscriptionReader } from '../src/service.js';

export const OWNER = '11111111-1111-4111-8111-111111111111' as UserId;
export const ADMIN = '22222222-2222-4222-8222-222222222222' as UserId;
export const MEMBER = '33333333-3333-4333-8333-333333333333' as UserId;
export const SECOND_ADMIN = '44444444-4444-4444-8444-444444444444' as UserId;
export const OUTSIDER = '55555555-5555-4555-8555-555555555555' as UserId;

export const FAMILY_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa' as FamilyId;
export const DEVICE_ID = 'dddddddd-1111-4111-8111-dddddddddddd' as DeviceId;

export const NOW = new Date('2026-08-02T12:00:00.000Z');

export function authContext(
  userId: UserId,
  deviceId: DeviceId | null = DEVICE_ID,
  requestId = 'req-test',
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
    requestId,
  };
}

export function membershipRow(input: {
  userId: UserId;
  role?: FamilyRole;
  status?: MembershipStatus;
  familyId?: FamilyId;
  hiddenFromUserIds?: UserId[];
}): MembershipRow {
  return {
    familyId: input.familyId ?? FAMILY_ID,
    userId: input.userId,
    role: input.role ?? 'MEMBER',
    status: input.status ?? 'ACTIVE',
    sharingStatus: 'SHARING',
    visibleToUserIds: null,
    ...(input.hiddenFromUserIds === undefined
      ? {}
      : { hiddenFromUserIds: input.hiddenFromUserIds }),
    displayName: 'Member',
    avatarUrl: null,
    deviceCount: 1,
    lastSeenAt: null,
    joinedAt: '2026-01-01T00:00:00.000Z',
    invitedByUserId: null,
    sharingChangedAt: null,
    updatedAt: '2026-01-01T00:00:00.000Z',
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

  add(userId: UserId, deviceId: DeviceId = DEVICE_ID): this {
    this.devices.set(`${userId}#${deviceId}`, { userId, deviceId, status: 'ACTIVE' });
    return this;
  }

  getDevice(input: { userId: UserId; deviceId: DeviceId }): Promise<DeviceRecord | null> {
    return Promise.resolve(this.devices.get(`${input.userId}#${input.deviceId}`) ?? null);
  }
}

export class InMemorySubscriptions implements SubscriptionReader {
  constructor(
    private readonly plan: Plan = 'FAMILY_MONTHLY',
    private readonly status: SubscriptionStatus = 'ACTIVE',
  ) {}

  getSubscriptionForFamily(input: { familyId: FamilyId }): Promise<SubscriptionRecord | null> {
    return Promise.resolve({ familyId: input.familyId, plan: this.plan, status: this.status });
  }

  getSubscriptionForUser(): Promise<SubscriptionRecord | null> {
    return Promise.resolve({ familyId: FAMILY_ID, plan: this.plan, status: this.status });
  }
}

export class InMemoryFamilies implements FamilyStore {
  readonly records = new Map<string, FamilyRecord>();
  readonly memberships: InMemoryMemberships;

  constructor(memberships: InMemoryMemberships) {
    this.memberships = memberships;
  }

  seed(record: FamilyRecord): this {
    this.records.set(record.familyId, record);
    return this;
  }

  get(familyId: FamilyId): Promise<FamilyRecord | null> {
    return Promise.resolve(this.records.get(familyId) ?? null);
  }

  create(record: FamilyRecord): Promise<void> {
    if (this.records.has(record.familyId)) {
      return Promise.reject(new AppError('CONFLICT', 'This family already exists.'));
    }
    this.records.set(record.familyId, record);
    return Promise.resolve();
  }

  update(
    familyId: FamilyId,
    patch: { name?: string; timeZone?: string },
    updatedAt: string,
  ): Promise<FamilyRecord> {
    const existing = this.records.get(familyId);
    if (existing === undefined) {
      return Promise.reject(new AppError('NOT_FOUND', 'The requested resource does not exist.'));
    }
    const next: FamilyRecord = {
      ...existing,
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.timeZone === undefined ? {} : { timeZone: patch.timeZone }),
      updatedAt,
    };
    this.records.set(familyId, next);
    return Promise.resolve(next);
  }

  /** Mirrors the DynamoDB transaction: all three rows move or none do. */
  transferOwnership(input: {
    familyId: FamilyId;
    previousOwnerUserId: UserId;
    newOwnerUserId: UserId;
    previousOwnerRole: FamilyRole;
    at: string;
  }): Promise<void> {
    const family = this.records.get(input.familyId);
    const previous = this.memberships.find(input.familyId, input.previousOwnerUserId);
    const next = this.memberships.find(input.familyId, input.newOwnerUserId);

    if (
      family === undefined ||
      family.ownerUserId !== input.previousOwnerUserId ||
      previous === undefined ||
      previous.role !== 'OWNER' ||
      next === undefined ||
      next.status !== 'ACTIVE' ||
      next.role === 'OWNER'
    ) {
      return Promise.reject(new AppError('CONFLICT', 'This family changed while in flight.'));
    }

    this.records.set(input.familyId, {
      ...family,
      ownerUserId: input.newOwnerUserId,
      updatedAt: input.at,
    });
    this.memberships.replace({ ...previous, role: input.previousOwnerRole, updatedAt: input.at });
    this.memberships.replace({ ...next, role: 'OWNER', updatedAt: input.at });
    return Promise.resolve();
  }
}

export class InMemoryMemberships implements MembershipStore {
  readonly rows: MembershipRow[] = [];

  seed(row: MembershipRow): this {
    this.rows.push(row);
    return this;
  }

  find(familyId: FamilyId, userId: UserId): MembershipRow | undefined {
    return this.rows.find((row) => row.familyId === familyId && row.userId === userId);
  }

  replace(row: MembershipRow): void {
    const index = this.rows.findIndex(
      (candidate) => candidate.familyId === row.familyId && candidate.userId === row.userId,
    );
    if (index >= 0) {
      this.rows[index] = row;
    } else {
      this.rows.push(row);
    }
  }

  getMembership(input: { familyId: FamilyId; userId: UserId }): Promise<MembershipRow | null> {
    return Promise.resolve(this.find(input.familyId, input.userId) ?? null);
  }

  get(familyId: FamilyId, userId: UserId): Promise<MembershipRow | null> {
    return Promise.resolve(this.find(familyId, userId) ?? null);
  }

  listByFamily(familyId: FamilyId): Promise<MembershipRow[]> {
    return Promise.resolve(this.rows.filter((row) => row.familyId === familyId));
  }

  listByUser(userId: UserId): Promise<MembershipRow[]> {
    return Promise.resolve(this.rows.filter((row) => row.userId === userId));
  }

  create(row: MembershipRow): Promise<void> {
    if (this.find(row.familyId, row.userId) !== undefined) {
      return Promise.reject(new AppError('CONFLICT', 'This membership already exists.'));
    }
    this.rows.push(row);
    return Promise.resolve();
  }

  patch(
    familyId: FamilyId,
    userId: UserId,
    patch: MembershipPatch,
    updatedAt: string,
  ): Promise<MembershipRow> {
    const existing = this.find(familyId, userId);
    if (existing === undefined) {
      return Promise.reject(new AppError('NOT_FOUND', 'The requested resource does not exist.'));
    }
    const next: MembershipRow = {
      ...existing,
      ...(patch.role === undefined ? {} : { role: patch.role }),
      ...(patch.status === undefined ? {} : { status: patch.status }),
      ...(patch.displayName === undefined ? {} : { displayName: patch.displayName }),
      updatedAt,
    };
    this.replace(next);
    return Promise.resolve(next);
  }

  revoke(input: {
    familyId: FamilyId;
    userId: UserId;
    status: Extract<MembershipStatus, 'REMOVED' | 'LEFT'>;
    at: string;
  }): Promise<MembershipRow> {
    const existing = this.find(input.familyId, input.userId);
    if (existing === undefined) {
      return Promise.reject(new AppError('NOT_FOUND', 'The requested resource does not exist.'));
    }
    const next: MembershipRow = {
      ...existing,
      status: input.status,
      sharingStatus: 'DISABLED',
      visibleToUserIds: [],
      sharingChangedAt: input.at,
      updatedAt: input.at,
    };
    this.replace(next);
    return Promise.resolve(next);
  }

  setMutuallyHidden(input: {
    familyId: FamilyId;
    userId: UserId;
    otherUserId: UserId;
    hidden: boolean;
    at: string;
  }): Promise<void> {
    const mine = this.find(input.familyId, input.userId);
    const theirs = this.find(input.familyId, input.otherUserId);
    if (mine === undefined || theirs === undefined) {
      return Promise.reject(new AppError('CONFLICT', 'This family changed while in flight.'));
    }

    const apply = (row: MembershipRow, other: UserId): void => {
      const hidden = new Set(row.hiddenFromUserIds ?? []);
      if (input.hidden) {
        hidden.add(other);
      } else {
        hidden.delete(other);
      }
      this.replace({ ...row, hiddenFromUserIds: [...hidden].sort(), updatedAt: input.at });
    };

    apply(mine, input.otherUserId);
    apply(theirs, input.userId);
    return Promise.resolve();
  }
}

export class RecordingEvents implements FamilyEventPublisher {
  readonly events: FamilyDomainEvent[] = [];

  publish(event: FamilyDomainEvent): Promise<void> {
    this.events.push(event);
    return Promise.resolve();
  }

  of<TKind extends FamilyDomainEvent['kind']>(
    kind: TKind,
  ): Array<Extract<FamilyDomainEvent, { kind: TKind }>> {
    return this.events.filter(
      (event): event is Extract<FamilyDomainEvent, { kind: TKind }> => event.kind === kind,
    );
  }
}

export class RecordingAudit implements AuditWriter {
  readonly events: AuditEvent[] = [];

  record(event: AuditEvent): Promise<void> {
    this.events.push(event);
    return Promise.resolve();
  }
}

export function familyRecord(overrides: Partial<FamilyRecord> = {}): FamilyRecord {
  return {
    familyId: FAMILY_ID,
    name: 'The Chouhans',
    ownerUserId: OWNER,
    timeZone: 'Europe/London',
    savedPlaceCount: 0,
    pendingInvitationCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    schemaVersion: 1,
    ...overrides,
  };
}

export const newId = (): string => randomUUID();
