import type { FamilyId, UserId } from '@family/contracts';

import type { MembershipRecord } from '../repositories/families.js';

/**
 * Blocking, expressed in terms of the tables that actually decide access.
 *
 * A block is *mutual invisibility*, written onto the `hiddenFromUserIds`
 * deny-list of both members' rows in every family they share. That is the field
 * the authorization checker already consults, and it wins over any allow-list,
 * so a block takes effect on the very next read without a new concept.
 *
 * What a block deliberately does NOT do is change the other person's
 * membership. `removeFromSharedFamilies` marks the *requester* as having LEFT;
 * it never evicts the person being blocked. Letting any member remove another by
 * calling `blocks` would be a privilege-escalation route wearing a safety label.
 */

export type VisibilityWrite = {
  readonly familyId: FamilyId;
  readonly userId: UserId;
  readonly hiddenFromUserIds: UserId[];
};

export type BlockPlan = {
  readonly visibilityWrites: VisibilityWrite[];
  /** Families the requester leaves, when they asked to. */
  readonly leftFamilyIds: FamilyId[];
  readonly sharedFamilyIds: FamilyId[];
};

export function planBlock(input: {
  actorUserId: UserId;
  blockedUserId: UserId;
  actorMemberships: readonly MembershipRecord[];
  blockedMemberships: readonly MembershipRecord[];
  removeFromSharedFamilies: boolean;
}): BlockPlan {
  const blockedByFamily = new Map(
    input.blockedMemberships.map((membership) => [membership.familyId, membership]),
  );

  const visibilityWrites: VisibilityWrite[] = [];
  const sharedFamilyIds: FamilyId[] = [];

  for (const membership of input.actorMemberships) {
    const counterpart = blockedByFamily.get(membership.familyId);
    if (counterpart === undefined) {
      continue;
    }
    sharedFamilyIds.push(membership.familyId);

    visibilityWrites.push({
      familyId: membership.familyId,
      userId: input.actorUserId,
      hiddenFromUserIds: withUser(membership.hiddenFromUserIds, input.blockedUserId),
    });
    visibilityWrites.push({
      familyId: counterpart.familyId,
      userId: input.blockedUserId,
      hiddenFromUserIds: withUser(counterpart.hiddenFromUserIds, input.actorUserId),
    });
  }

  return {
    visibilityWrites,
    sharedFamilyIds: [...sharedFamilyIds].sort(),
    leftFamilyIds: input.removeFromSharedFamilies ? [...sharedFamilyIds].sort() : [],
  };
}

export function planUnblock(input: {
  actorUserId: UserId;
  blockedUserId: UserId;
  actorMemberships: readonly MembershipRecord[];
  blockedMemberships: readonly MembershipRecord[];
}): VisibilityWrite[] {
  const blockedByFamily = new Map(
    input.blockedMemberships.map((membership) => [membership.familyId, membership]),
  );

  const writes: VisibilityWrite[] = [];
  for (const membership of input.actorMemberships) {
    const counterpart = blockedByFamily.get(membership.familyId);
    if (counterpart === undefined) {
      continue;
    }
    if (membership.hiddenFromUserIds.includes(input.blockedUserId)) {
      writes.push({
        familyId: membership.familyId,
        userId: input.actorUserId,
        hiddenFromUserIds: withoutUser(membership.hiddenFromUserIds, input.blockedUserId),
      });
    }
    if (counterpart.hiddenFromUserIds.includes(input.actorUserId)) {
      writes.push({
        familyId: counterpart.familyId,
        userId: input.blockedUserId,
        hiddenFromUserIds: withoutUser(counterpart.hiddenFromUserIds, input.actorUserId),
      });
    }
  }
  return writes;
}

function withUser(current: readonly UserId[], userId: UserId): UserId[] {
  return current.includes(userId) ? [...current] : [...current, userId].sort();
}

function withoutUser(current: readonly UserId[], userId: UserId): UserId[] {
  return current.filter((entry) => entry !== userId);
}
