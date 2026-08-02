import type { FamilyMembershipRecord } from '@family/auth';
import type { AuditEvent, FamilyId, FamilyRole, MembershipStatus, UserId } from '@family/contracts';

/**
 * Storage and messaging seams.
 *
 * Membership rows carry the display fields the family list renders, denormalised
 * on purpose: rendering a family must be one query, and a member's name inside a
 * family is a per-family label rather than a global profile field.
 */

export type FamilyRecord = {
  readonly familyId: FamilyId;
  readonly name: string;
  readonly ownerUserId: UserId;
  readonly timeZone: string;
  readonly savedPlaceCount: number;
  readonly pendingInvitationCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly schemaVersion: number;
};

export type MembershipRow = FamilyMembershipRecord & {
  readonly displayName: string;
  readonly avatarUrl: string | null;
  readonly deviceCount: number;
  readonly lastSeenAt: string | null;
  readonly joinedAt: string | null;
  readonly invitedByUserId: UserId | null;
  readonly sharingChangedAt: string | null;
  readonly updatedAt: string;
};

export type MembershipPatch = {
  readonly role?: FamilyRole;
  readonly status?: MembershipStatus;
  readonly displayName?: string;
};

export interface FamilyStore {
  get(familyId: FamilyId): Promise<FamilyRecord | null>;
  /** Conditional on the id being unused, so a replayed create cannot clobber. */
  create(record: FamilyRecord): Promise<void>;
  update(
    familyId: FamilyId,
    patch: { name?: string; timeZone?: string },
    updatedAt: string,
  ): Promise<FamilyRecord>;
  /**
   * Moves ownership atomically: the family record and both membership rows
   * change together, so a family is never observed with zero or two owners.
   */
  transferOwnership(input: {
    familyId: FamilyId;
    previousOwnerUserId: UserId;
    newOwnerUserId: UserId;
    previousOwnerRole: FamilyRole;
    at: string;
  }): Promise<void>;
}

export interface MembershipStore {
  get(familyId: FamilyId, userId: UserId): Promise<MembershipRow | null>;
  listByFamily(familyId: FamilyId): Promise<MembershipRow[]>;
  listByUser(userId: UserId): Promise<MembershipRow[]>;
  /** Conditional on there being no existing row for this (family, user). */
  create(row: MembershipRow): Promise<void>;
  patch(
    familyId: FamilyId,
    userId: UserId,
    patch: MembershipPatch,
    updatedAt: string,
  ): Promise<MembershipRow>;
  /**
   * Ends a membership AND revokes location access in the same write: the status
   * change alone is not enough, because a stale allow-list would still name the
   * removed member's viewers.
   */
  revoke(input: {
    familyId: FamilyId;
    userId: UserId;
    status: Extract<MembershipStatus, 'REMOVED' | 'LEFT'>;
    at: string;
  }): Promise<MembershipRow>;
  /** Symmetric visibility: each user is added to the other's deny-list. */
  setMutuallyHidden(input: {
    familyId: FamilyId;
    userId: UserId;
    otherUserId: UserId;
    hidden: boolean;
    at: string;
  }): Promise<void>;
}

export type FamilyDomainEvent =
  | {
      readonly kind: 'FAMILY_CREATED';
      readonly familyId: FamilyId;
      readonly ownerUserId: UserId;
      readonly occurredAt: string;
    }
  | {
      readonly kind: 'MEMBERSHIP_ENDED';
      readonly familyId: FamilyId;
      readonly userId: UserId;
      readonly actorUserId: UserId;
      readonly status: Extract<MembershipStatus, 'REMOVED' | 'LEFT'>;
      readonly occurredAt: string;
      /**
       * Instructs every client holding this family to drop cached positions for
       * the departed member immediately, rather than waiting for a poll.
       */
      readonly purgeCachedLocations: true;
      /** Asks the erasure worker to delete the departed member's history too. */
      readonly deleteHistory: boolean;
    }
  | {
      readonly kind: 'MEMBER_ROLE_CHANGED';
      readonly familyId: FamilyId;
      readonly userId: UserId;
      readonly actorUserId: UserId;
      readonly role: FamilyRole;
      readonly occurredAt: string;
    }
  | {
      readonly kind: 'OWNERSHIP_TRANSFERRED';
      readonly familyId: FamilyId;
      readonly previousOwnerUserId: UserId;
      readonly newOwnerUserId: UserId;
      readonly occurredAt: string;
    }
  | {
      readonly kind: 'USER_BLOCKED';
      readonly actorUserId: UserId;
      readonly blockedUserId: UserId;
      readonly familyIds: readonly FamilyId[];
      readonly occurredAt: string;
      readonly purgeCachedLocations: true;
    }
  | {
      readonly kind: 'ABUSE_REPORTED';
      readonly reportId: string;
      readonly reporterUserId: UserId;
      readonly familyId: FamilyId | null;
      readonly category: string;
      readonly occurredAt: string;
    };

export interface FamilyEventPublisher {
  publish(event: FamilyDomainEvent): Promise<void>;
}

export interface AuditWriter {
  record(event: AuditEvent): Promise<void>;
}
