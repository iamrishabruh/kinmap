import {
  FAMILY_ROLE_RANK,
  type FamilyId,
  type FamilyRole,
  type MembershipStatus,
  type UserId,
} from '@family/contracts';

/**
 * What happens to each family when one of its members deletes their account.
 *
 * A family must never be left without an owner, and a family must never
 * silently survive with nobody in it. Those two rules produce exactly three
 * dispositions, decided here as a pure function so the succession rule is
 * testable without a table.
 */

export type MembershipRow = {
  readonly familyId: FamilyId;
  readonly userId: UserId;
  readonly role: FamilyRole;
  readonly status: MembershipStatus;
  readonly joinedAt: string;
};

export type FamilyDisposition =
  /** The subject was not the owner: simply remove their row. */
  | { readonly familyId: FamilyId; readonly action: 'LEAVE' }
  /** The subject owned a family with other members: hand it over, then leave. */
  | {
      readonly familyId: FamilyId;
      readonly action: 'TRANSFER_OWNERSHIP';
      readonly successorUserId: UserId;
    }
  /** The subject owned a family of one: the family goes with them. */
  | { readonly familyId: FamilyId; readonly action: 'DISSOLVE' };

/**
 * Picks the successor: the highest-ranked remaining member, oldest membership
 * first, with the user id as a final tie-break so the choice is deterministic
 * and a retry of the same job picks the same person.
 */
export function chooseSuccessor(candidates: readonly MembershipRow[]): UserId | null {
  const eligible = candidates.filter((member) => member.status === 'ACTIVE');
  if (eligible.length === 0) return null;

  const sorted = [...eligible].sort((a, b) => {
    const rank = FAMILY_ROLE_RANK[b.role] - FAMILY_ROLE_RANK[a.role];
    if (rank !== 0) return rank;
    const joined = Date.parse(a.joinedAt) - Date.parse(b.joinedAt);
    if (joined !== 0) return joined;
    return a.userId.localeCompare(b.userId);
  });

  return sorted[0]?.userId ?? null;
}

export function planMembershipRemoval(input: {
  userId: UserId;
  /** The subject's own membership rows. */
  memberships: readonly MembershipRow[];
  /** Every other member, per family. Missing means "nobody else". */
  otherMembersByFamily: ReadonlyMap<FamilyId, readonly MembershipRow[]>;
}): FamilyDisposition[] {
  const dispositions: FamilyDisposition[] = [];

  for (const membership of input.memberships) {
    if (membership.userId !== input.userId) continue;
    // A row that already ended still gets removed, but it cannot own anything.
    const others = input.otherMembersByFamily.get(membership.familyId) ?? [];
    const activeOthers = others.filter(
      (other) => other.userId !== input.userId && other.status === 'ACTIVE',
    );

    if (membership.role !== 'OWNER' || membership.status !== 'ACTIVE') {
      dispositions.push({ familyId: membership.familyId, action: 'LEAVE' });
      continue;
    }

    const successor = chooseSuccessor(activeOthers);
    if (successor === null) {
      dispositions.push({ familyId: membership.familyId, action: 'DISSOLVE' });
      continue;
    }

    dispositions.push({
      familyId: membership.familyId,
      action: 'TRANSFER_OWNERSHIP',
      successorUserId: successor,
    });
  }

  return dispositions;
}

/** Families that disappear entirely; their shared data goes with them. */
export function dissolvedFamilies(dispositions: readonly FamilyDisposition[]): FamilyId[] {
  return dispositions
    .filter((disposition) => disposition.action === 'DISSOLVE')
    .map((disposition) => disposition.familyId);
}

/**
 * Families that survive, with the member who inherits the subject's shared
 * artefacts. Saved places are family data, not personal data: deleting a
 * family's home address because one member left would be data loss for
 * everyone else, so ownership moves instead.
 */
export function survivingFamilies(
  dispositions: readonly FamilyDisposition[],
): Array<{ familyId: FamilyId; inheritorUserId: UserId | null }> {
  return dispositions
    .filter((disposition) => disposition.action !== 'DISSOLVE')
    .map((disposition) => ({
      familyId: disposition.familyId,
      inheritorUserId:
        disposition.action === 'TRANSFER_OWNERSHIP' ? disposition.successorUserId : null,
    }));
}
