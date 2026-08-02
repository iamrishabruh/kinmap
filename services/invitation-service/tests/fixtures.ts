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
import type { InvitationStatus } from '@family/schemas';

import type { InvitationRecord } from '../src/domain/invitation-rules.js';
import type {
  AuditWriter,
  FamilyReader,
  FamilySummary,
  InvitationStore,
  MembershipReader,
  MembershipSummary,
  NewMembership,
  RedemptionOutcome,
} from '../src/ports.js';

export const OWNER = '11111111-1111-4111-8111-111111111111' as UserId;
export const ADMIN = '22222222-2222-4222-8222-222222222222' as UserId;
export const RECIPIENT = '33333333-3333-4333-8333-333333333333' as UserId;
export const SECOND_RECIPIENT = '44444444-4444-4444-8444-444444444444' as UserId;
export const OUTSIDER = '55555555-5555-4555-8555-555555555555' as UserId;

export const FAMILY_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa' as FamilyId;
export const DEVICE_ID = 'dddddddd-1111-4111-8111-dddddddddddd' as DeviceId;

export const NOW = new Date('2026-08-02T12:00:00.000Z');

export function authContext(userId: UserId, deviceId: DeviceId | null = DEVICE_ID): AuthContext {
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

export function membershipSummary(input: {
  userId: UserId;
  role?: FamilyRole;
  status?: MembershipStatus;
  displayName?: string;
}): MembershipSummary {
  return {
    familyId: FAMILY_ID,
    userId: input.userId,
    role: input.role ?? 'MEMBER',
    status: input.status ?? 'ACTIVE',
    sharingStatus: 'SHARING',
    visibleToUserIds: null,
    displayName: input.displayName ?? 'Member',
    avatarUrl: null,
    deviceCount: 1,
    lastSeenAt: null,
    joinedAt: '2026-01-01T00:00:00.000Z',
    invitedByUserId: null,
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

export class InMemorySubscriptions implements SubscriptionRepository {
  constructor(
    private readonly plan: Plan = 'FAMILY_MONTHLY',
    private readonly status: SubscriptionStatus = 'ACTIVE',
  ) {}

  getSubscriptionForFamily(input: { familyId: FamilyId }): Promise<SubscriptionRecord | null> {
    return Promise.resolve({ familyId: input.familyId, plan: this.plan, status: this.status });
  }
}

export class InMemoryFamilies implements FamilyReader {
  readonly families = new Map<string, FamilySummary>([
    [FAMILY_ID, { familyId: FAMILY_ID, name: 'The Chouhans', ownerUserId: OWNER }],
  ]);

  get(familyId: FamilyId): Promise<FamilySummary | null> {
    return Promise.resolve(this.families.get(familyId) ?? null);
  }
}

export class InMemoryMemberships implements MembershipReader {
  readonly rows: MembershipSummary[] = [];

  seed(row: MembershipSummary): this {
    this.rows.push(row);
    return this;
  }

  getMembership(input: { familyId: FamilyId; userId: UserId }): Promise<MembershipSummary | null> {
    return this.get(input.familyId, input.userId);
  }

  get(familyId: FamilyId, userId: UserId): Promise<MembershipSummary | null> {
    return Promise.resolve(
      this.rows.find((row) => row.familyId === familyId && row.userId === userId) ?? null,
    );
  }

  listByFamily(familyId: FamilyId): Promise<MembershipSummary[]> {
    return Promise.resolve(this.rows.filter((row) => row.familyId === familyId));
  }
}

/**
 * Faithful in-memory model of the DynamoDB invitation table.
 *
 * `redeem` performs its check-and-mutate SYNCHRONOUSLY before returning a
 * resolved promise, which is exactly the serialisability the real
 * `TransactWriteItems` provides. That is what makes the concurrent-redemption
 * test meaningful rather than an artefact of the fake.
 */
export class InMemoryInvitations implements InvitationStore {
  readonly records = new Map<string, InvitationRecord>();
  readonly memberships: InMemoryMemberships;
  /** Everything ever handed to the storage layer, for leak assertions. */
  readonly writes: unknown[] = [];

  constructor(memberships: InMemoryMemberships) {
    this.memberships = memberships;
  }

  create(record: InvitationRecord): Promise<void> {
    if (this.records.has(record.tokenHash)) {
      return Promise.reject(new AppError('CONFLICT', 'Please try again.'));
    }
    this.records.set(record.tokenHash, record);
    this.writes.push(record);
    return Promise.resolve();
  }

  findByTokenHash(tokenHash: string): Promise<InvitationRecord | null> {
    return Promise.resolve(this.records.get(tokenHash) ?? null);
  }

  listByFamily(familyId: FamilyId, status: InvitationStatus | null): Promise<InvitationRecord[]> {
    const all = [...this.records.values()].filter((record) => record.familyId === familyId);
    return Promise.resolve(
      status === null ? all : all.filter((record) => record.status === status),
    );
  }

  revoke(input: {
    familyId: FamilyId;
    invitationId: string;
    at: string;
  }): Promise<InvitationRecord | null> {
    for (const record of this.records.values()) {
      if (record.familyId !== input.familyId || record.invitationId !== input.invitationId) {
        continue;
      }
      if (record.status !== 'PENDING') {
        return Promise.resolve(record);
      }
      const next: InvitationRecord = { ...record, status: 'REVOKED', revokedAt: input.at };
      this.records.set(record.tokenHash, next);
      this.writes.push(next);
      return Promise.resolve(next);
    }
    return Promise.resolve(null);
  }

  redeem(input: {
    tokenHash: string;
    membership: NewMembership;
    acceptedByUserId: UserId;
    acceptedAt: string;
    nowEpochSeconds: number;
  }): Promise<RedemptionOutcome> {
    const record = this.records.get(input.tokenHash);

    // Condition on the invitation row.
    if (
      record === undefined ||
      record.status !== 'PENDING' ||
      record.redemptionCount >= record.maxRedemptions ||
      record.revokedAt !== null ||
      record.expiresAt <= input.nowEpochSeconds
    ) {
      return Promise.resolve({ kind: 'ALREADY_CONSUMED' });
    }

    // Condition on the membership row.
    const alreadyMember = this.memberships.rows.some(
      (row) => row.familyId === input.membership.familyId && row.userId === input.membership.userId,
    );
    if (alreadyMember) {
      return Promise.resolve({ kind: 'ALREADY_MEMBER' });
    }

    // Both conditions held: commit atomically.
    const consumed: InvitationRecord = {
      ...record,
      status: 'ACCEPTED',
      redemptionCount: record.redemptionCount + 1,
      acceptedByUserId: input.acceptedByUserId,
      acceptedAt: input.acceptedAt,
    };
    this.records.set(input.tokenHash, consumed);
    this.writes.push(consumed);

    const membership: MembershipSummary = {
      familyId: input.membership.familyId,
      userId: input.membership.userId,
      role: input.membership.role,
      status: input.membership.status,
      sharingStatus: input.membership.sharingStatus,
      visibleToUserIds: null,
      displayName: input.membership.displayName,
      avatarUrl: null,
      deviceCount: 0,
      lastSeenAt: null,
      joinedAt: input.membership.joinedAt,
      invitedByUserId: input.membership.invitedByUserId,
      updatedAt: input.acceptedAt,
    };
    this.memberships.seed(membership);
    this.writes.push(membership);

    return Promise.resolve({ kind: 'REDEEMED', membership });
  }
}

export class RecordingAudit implements AuditWriter {
  readonly events: AuditEvent[] = [];

  record(event: AuditEvent): Promise<void> {
    this.events.push(event);
    return Promise.resolve();
  }
}

export const newId = (): string => randomUUID();
