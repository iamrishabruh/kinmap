import { isVisibleTo } from '@family/auth';
import type { PlanTier, UserId } from '@family/contracts';
import type { Family, FamilyMember } from '@family/schemas';

import type { FamilyRecord, MembershipRow } from '../ports.js';

import { seatsInUse, type MemberSummary } from './membership-rules.js';

/**
 * Stored rows to API resources.
 *
 * A membership response carries the *status* of sharing and never a position:
 * reading a member's location always goes through the location endpoints, which
 * are separately authorised. `sharingWithCaller` is derived from the target's
 * own visibility choices, so an OWNER sees the same answer as any other member.
 */

export function toMemberSummary(row: MembershipRow): MemberSummary {
  return { userId: row.userId, role: row.role, status: row.status };
}

export function toFamilyMember(row: MembershipRow, callerUserId: UserId): FamilyMember {
  return {
    userId: row.userId,
    familyId: row.familyId,
    displayName: row.displayName,
    avatarUrl: row.avatarUrl,
    role: row.role,
    status: row.status,
    sharingStatus: row.sharingStatus,
    sharingWithCaller:
      row.userId === callerUserId ||
      (row.status === 'ACTIVE' &&
        row.sharingStatus === 'SHARING' &&
        isVisibleTo(row, callerUserId)),
    deviceCount: row.deviceCount,
    lastSeenAt: row.lastSeenAt,
    joinedAt: row.joinedAt,
    invitedByUserId: row.invitedByUserId,
    updatedAt: row.updatedAt,
  };
}

export function toFamily(
  record: FamilyRecord,
  members: readonly MembershipRow[],
  planTier: PlanTier,
): Family {
  return {
    familyId: record.familyId,
    name: record.name,
    ownerUserId: record.ownerUserId,
    timeZone: record.timeZone,
    memberCount: members.length,
    activeMemberCount: members.filter((member) => member.status === 'ACTIVE').length,
    pendingInvitationCount: record.pendingInvitationCount,
    savedPlaceCount: record.savedPlaceCount,
    // Server-derived from the family's subscription, never client-claimed.
    planTier,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    schemaVersion: record.schemaVersion,
  };
}

/** Seats consumed, for the "n of m members" affordance in the client. */
export function occupiedSeats(members: readonly MembershipRow[]): number {
  return seatsInUse(members.map(toMemberSummary));
}
