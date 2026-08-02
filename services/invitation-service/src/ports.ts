import type { FamilyMembershipRecord } from '@family/auth';
import type { AuditEvent, FamilyId, MembershipStatus, UserId } from '@family/contracts';
import type { AssignableFamilyRole, InvitationStatus } from '@family/schemas';

import type { InvitationRecord } from './domain/invitation-rules.js';

/**
 * Storage seams.
 *
 * Note what the invitation store's interface does NOT contain: any method that
 * accepts or returns a raw token. Everything is keyed by the hash, so the
 * persistence layer is structurally incapable of storing the credential.
 */

export type FamilySummary = {
  readonly familyId: FamilyId;
  readonly name: string;
  readonly ownerUserId: UserId;
};

export interface FamilyReader {
  get(familyId: FamilyId): Promise<FamilySummary | null>;
}

export type MembershipSummary = FamilyMembershipRecord & {
  readonly displayName: string;
  readonly avatarUrl: string | null;
  readonly deviceCount: number;
  readonly lastSeenAt: string | null;
  readonly joinedAt: string | null;
  readonly invitedByUserId: UserId | null;
  readonly updatedAt: string;
};

export interface MembershipReader {
  get(familyId: FamilyId, userId: UserId): Promise<MembershipSummary | null>;
  listByFamily(familyId: FamilyId): Promise<MembershipSummary[]>;
}

export type NewMembership = {
  readonly familyId: FamilyId;
  readonly userId: UserId;
  readonly role: AssignableFamilyRole;
  readonly status: Extract<MembershipStatus, 'ACTIVE'>;
  readonly sharingStatus: FamilyMembershipRecord['sharingStatus'];
  readonly displayName: string;
  readonly invitedByUserId: UserId;
  readonly joinedAt: string;
  readonly acceptedTermsVersion: string;
};

/**
 * Outcome of the single transaction that consumes a token and creates a
 * membership. Every failure mode is a value rather than an exception, because
 * each one maps to a different, specific answer for the person holding the link.
 */
export type RedemptionOutcome =
  | { readonly kind: 'REDEEMED'; readonly membership: MembershipSummary }
  | { readonly kind: 'ALREADY_CONSUMED' }
  | { readonly kind: 'ALREADY_MEMBER' };

export interface InvitationStore {
  /** Conditional on the hash being unused. */
  create(record: InvitationRecord): Promise<void>;
  findByTokenHash(tokenHash: string): Promise<InvitationRecord | null>;
  listByFamily(familyId: FamilyId, status: InvitationStatus | null): Promise<InvitationRecord[]>;
  revoke(input: {
    familyId: FamilyId;
    invitationId: string;
    at: string;
  }): Promise<InvitationRecord | null>;
  /**
   * ONE `TransactWriteItems`: the token is consumed and the membership row is
   * created together, both conditionally. Two concurrent redemptions of the same
   * link therefore produce exactly one membership — the loser sees
   * ALREADY_CONSUMED rather than a second seat.
   */
  redeem(input: {
    tokenHash: string;
    membership: NewMembership;
    acceptedByUserId: UserId;
    acceptedAt: string;
    nowEpochSeconds: number;
  }): Promise<RedemptionOutcome>;
}

export interface AuditWriter {
  record(event: AuditEvent): Promise<void>;
}
