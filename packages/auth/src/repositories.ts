import type { DeviceId, FamilyId, UserId } from '@family/contracts';

import type {
  DeviceRecord,
  FamilyMembershipRecord,
  SubscriptionRecord,
  UserAccountRecord,
} from './types.js';

/**
 * Data-access seams (spec §18).
 *
 * This package deliberately imports no AWS SDK: authorization logic must be
 * exercisable in a unit test with no table, no network, and no credentials.
 * Services bind these interfaces to DynamoDB at the composition root.
 *
 * Every method returns `null` for "no such row" rather than throwing, because
 * the caller must convert absence into the same opaque denial as any other
 * failure.
 */

export interface UserAccountRepository {
  getUserAccount(input: { userId: UserId }): Promise<UserAccountRecord | null>;
}

export interface DeviceRepository {
  /**
   * Scoped by user on purpose: a device id alone must never be enough to look a
   * record up, or a stolen id would leak its owner.
   */
  getDevice(input: { userId: UserId; deviceId: DeviceId }): Promise<DeviceRecord | null>;
}

export interface FamilyMembershipRepository {
  getMembership(input: {
    familyId: FamilyId;
    userId: UserId;
  }): Promise<FamilyMembershipRecord | null>;
}

export interface SubscriptionRepository {
  /** Entitlements are family-scoped: one payer covers the whole family (spec §23). */
  getSubscriptionForFamily(input: { familyId: FamilyId }): Promise<SubscriptionRecord | null>;
}

export type RateLimitDecision = {
  allowed: boolean;
  /** Advisory only; the opaque denial never exposes it to the caller. */
  retryAfterSeconds?: number;
};

export interface RateLimiter {
  consume(input: {
    /** Pre-scoped key built by the checker. Never contains a coordinate. */
    key: string;
    limitPerMinute: number;
    requestId: string;
  }): Promise<RateLimitDecision>;
}

export type AuthorizationDecision = 'ALLOWED' | 'DENIED';

/**
 * Server-side record of an authorization outcome (spec §18).
 *
 * The `reason` is the one place a specific denial cause exists; it is written to
 * the audit store and never returned to the caller. Fields are ids and enums
 * only — no coordinates, ever.
 */
export type AuthorizationAuditEntry = {
  operation: string;
  decision: AuthorizationDecision;
  reason: string | null;
  actorUserId: UserId;
  targetUserId: UserId | null;
  familyId: FamilyId;
  deviceId: DeviceId | null;
  requestId: string;
  occurredAt: string;
};

export interface AuthorizationAuditSink {
  record(entry: AuthorizationAuditEntry): Promise<void>;
}
