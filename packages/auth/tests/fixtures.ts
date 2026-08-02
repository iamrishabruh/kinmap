import type { FamilyRole, MembershipStatus, Plan, SharingStatus } from '@family/contracts';

import type {
  AccountStatus,
  AuthContext,
  AuthorizationAuditEntry,
  AuthorizationDeps,
  DeviceRecord,
  DeviceStatus,
  FamilyMembershipRecord,
  SubscriptionRecord,
  UserAccountRecord,
} from '../src/index.js';

/**
 * A fully-permitted world plus knobs to break exactly one thing at a time.
 * Every §18 test starts from "allowed" and mutates a single fact, so a failure
 * names the check that regressed.
 */

export const FAMILY_ID = 'f1000000-0000-4000-8000-000000000001';
export const OTHER_FAMILY_ID = 'f1000000-0000-4000-8000-000000000002';
export const REQUESTER_ID = 'a1000000-0000-4000-8000-000000000001';
export const TARGET_ID = 'a1000000-0000-4000-8000-000000000002';
export const OUTSIDER_ID = 'a1000000-0000-4000-8000-000000000003';
export const REQUESTER_DEVICE_ID = 'd1000000-0000-4000-8000-000000000001';
export const REQUEST_ID = 'req-0000-0001';

export const NOW = new Date('2026-08-02T12:00:00.000Z');

export function authContext(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: REQUESTER_ID,
    deviceId: REQUESTER_DEVICE_ID,
    tokenUse: 'access',
    claims: {
      sub: REQUESTER_ID,
      token_use: 'access',
      iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_test',
      exp: Math.floor(NOW.getTime() / 1000) + 3600,
      iat: Math.floor(NOW.getTime() / 1000),
    },
    requestId: REQUEST_ID,
    ...overrides,
  };
}

export function membership(
  overrides: Partial<FamilyMembershipRecord> & { userId: string },
): FamilyMembershipRecord {
  return {
    familyId: FAMILY_ID,
    role: 'MEMBER',
    status: 'ACTIVE',
    sharingStatus: 'SHARING',
    visibleToUserIds: null,
    ...overrides,
  };
}

export type World = {
  deps: AuthorizationDeps;
  audit: AuthorizationAuditEntry[];
  /** Set of repository calls, so tests can assert ordering/short-circuiting. */
  calls: string[];
  setAccountStatus(userId: string, status: AccountStatus): void;
  removeAccount(userId: string): void;
  setDeviceStatus(deviceId: string, status: DeviceStatus): void;
  removeDevice(deviceId: string): void;
  setMembershipStatus(userId: string, status: MembershipStatus): void;
  setMembershipRole(userId: string, role: FamilyRole): void;
  setSharingStatus(userId: string, sharingStatus: SharingStatus): void;
  setVisibility(userId: string, visibleToUserIds: string[] | null): void;
  setHiddenFrom(userId: string, hiddenFromUserIds: string[]): void;
  removeMembership(userId: string): void;
  setPlan(plan: Plan | null): void;
  setSubscriptionStatus(status: SubscriptionRecord['status']): void;
  denyRateLimit(): void;
  failAuditWrites(): void;
};

export type WorldOptions = {
  plan?: Plan | null;
  withAuditSink?: boolean;
  deviceRequirements?: AuthorizationDeps['deviceRequirements'];
};

export function createWorld(options: WorldOptions = {}): World {
  const accounts = new Map<string, UserAccountRecord>([
    [REQUESTER_ID, { userId: REQUESTER_ID, status: 'ACTIVE' }],
    [TARGET_ID, { userId: TARGET_ID, status: 'ACTIVE' }],
    [OUTSIDER_ID, { userId: OUTSIDER_ID, status: 'ACTIVE' }],
  ]);

  const devices = new Map<string, DeviceRecord>([
    [
      REQUESTER_DEVICE_ID,
      { deviceId: REQUESTER_DEVICE_ID, userId: REQUESTER_ID, status: 'ACTIVE' },
    ],
  ]);

  const memberships = new Map<string, FamilyMembershipRecord>([
    [`${FAMILY_ID}:${REQUESTER_ID}`, membership({ userId: REQUESTER_ID, role: 'ADMIN' })],
    [`${FAMILY_ID}:${TARGET_ID}`, membership({ userId: TARGET_ID, role: 'MEMBER' })],
  ]);

  let subscription: SubscriptionRecord | null =
    options.plan === null
      ? null
      : { familyId: FAMILY_ID, plan: options.plan ?? 'FAMILY_MONTHLY', status: 'ACTIVE' };

  let rateLimitAllowed = true;
  let auditWritesFail = false;
  const audit: AuthorizationAuditEntry[] = [];
  const calls: string[] = [];

  const deps: AuthorizationDeps = {
    accounts: {
      getUserAccount({ userId }) {
        calls.push(`accounts:${userId}`);
        return Promise.resolve(accounts.get(userId) ?? null);
      },
    },
    devices: {
      getDevice({ userId, deviceId }) {
        calls.push(`devices:${deviceId}`);
        const record = devices.get(deviceId);
        if (record === undefined || record.userId !== userId) {
          return Promise.resolve(null);
        }
        return Promise.resolve(record);
      },
    },
    memberships: {
      getMembership({ familyId, userId }) {
        calls.push(`memberships:${familyId}:${userId}`);
        return Promise.resolve(memberships.get(`${familyId}:${userId}`) ?? null);
      },
    },
    subscriptions: {
      getSubscriptionForFamily({ familyId }) {
        calls.push(`subscriptions:${familyId}`);
        if (subscription === null || subscription.familyId !== familyId) {
          return Promise.resolve(null);
        }
        return Promise.resolve(subscription);
      },
    },
    rateLimiter: {
      consume({ key }) {
        calls.push(`rate:${key}`);
        return Promise.resolve(
          rateLimitAllowed ? { allowed: true } : { allowed: false, retryAfterSeconds: 30 },
        );
      },
    },
    now: () => NOW,
  };

  if (options.withAuditSink !== false) {
    deps.auditSink = {
      record(entry) {
        if (auditWritesFail) {
          return Promise.reject(new Error('audit store unavailable'));
        }
        audit.push(entry);
        return Promise.resolve();
      },
    };
  }
  if (options.deviceRequirements !== undefined) {
    deps.deviceRequirements = options.deviceRequirements;
  }

  function mutateMembership(
    userId: string,
    change: (record: FamilyMembershipRecord) => FamilyMembershipRecord,
  ): void {
    const key = `${FAMILY_ID}:${userId}`;
    const existing = memberships.get(key);
    if (existing === undefined) {
      throw new Error(`test set-up error: no membership for ${userId}`);
    }
    memberships.set(key, change(existing));
  }

  return {
    deps,
    audit,
    calls,
    setAccountStatus(userId, status) {
      const existing = accounts.get(userId);
      if (existing === undefined) {
        throw new Error(`test set-up error: no account for ${userId}`);
      }
      accounts.set(userId, { ...existing, status });
    },
    removeAccount(userId) {
      accounts.delete(userId);
    },
    setDeviceStatus(deviceId, status) {
      const existing = devices.get(deviceId);
      if (existing === undefined) {
        throw new Error(`test set-up error: no device ${deviceId}`);
      }
      devices.set(deviceId, { ...existing, status });
    },
    removeDevice(deviceId) {
      devices.delete(deviceId);
    },
    setMembershipStatus(userId, status) {
      mutateMembership(userId, (record) => ({ ...record, status }));
    },
    setMembershipRole(userId, role) {
      mutateMembership(userId, (record) => ({ ...record, role }));
    },
    setSharingStatus(userId, sharingStatus) {
      mutateMembership(userId, (record) => ({ ...record, sharingStatus }));
    },
    setVisibility(userId, visibleToUserIds) {
      mutateMembership(userId, (record) => ({ ...record, visibleToUserIds }));
    },
    setHiddenFrom(userId, hiddenFromUserIds) {
      mutateMembership(userId, (record) => ({ ...record, hiddenFromUserIds }));
    },
    removeMembership(userId) {
      memberships.delete(`${FAMILY_ID}:${userId}`);
    },
    setPlan(plan) {
      subscription = plan === null ? null : { familyId: FAMILY_ID, plan, status: 'ACTIVE' };
    },
    setSubscriptionStatus(status) {
      if (subscription === null) {
        throw new Error('test set-up error: no subscription');
      }
      subscription = { ...subscription, status };
    },
    denyRateLimit() {
      rateLimitAllowed = false;
    },
    failAuditWrites() {
      auditWritesFail = true;
    },
  };
}

/** A window comfortably inside the 30-day retention of a paid plan. */
export const VALID_RANGE = {
  from: '2026-07-28T00:00:00.000Z',
  to: '2026-08-02T00:00:00.000Z',
};
