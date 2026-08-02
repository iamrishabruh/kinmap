import {
  AppError,
  FAMILY_ROLE_RANK,
  LIMITS,
  opaqueAuthorizationError,
  type Entitlements,
  type FamilyRole,
  type MembershipStatus,
  type UserId,
} from '@family/contracts';
import type { AssignableFamilyRole } from '@family/schemas';

/**
 * The family membership rules (spec §17).
 *
 * Pure and exhaustive, because these are the rules that decide who can watch
 * whom. Four invariants hold for every family, at every moment:
 *
 *  1. There is exactly ONE owner.
 *  2. Only an OWNER or an ADMIN may invite or remove.
 *  3. NOBODY may remove the owner — not an admin, not the owner themself.
 *     Ownership moves only through an explicit transfer, so a family can never
 *     be left without one.
 *  4. Membership is capped by the family's entitlement, and by the platform
 *     ceiling regardless of plan.
 *
 * Failures split deliberately. A rule the caller could not have known about
 * (they are not senior enough, the target outranks them) is an opaque FORBIDDEN,
 * because leaking "you are not an admin here" tells an outsider that the family
 * exists. A rule about the caller's *own* family that they can act on — "the
 * owner must transfer first", "this family is full" — is a specific code,
 * because they are already inside and need to know what to do next.
 */

export type MemberSummary = {
  readonly userId: UserId;
  readonly role: FamilyRole;
  readonly status: MembershipStatus;
};

const OWNER_IMMOVABLE_MESSAGE =
  'The family owner cannot be removed. Transfer ownership to another member first.';

function forbidden(requestId: string): AppError {
  return opaqueAuthorizationError(requestId);
}

/** Roles permitted to invite new members or remove existing ones. */
export function canManageMembers(role: FamilyRole): boolean {
  return role === 'OWNER' || role === 'ADMIN';
}

/** Exactly one OWNER, always. Used as an assertion after every mutation plan. */
export function ownersOf(members: readonly MemberSummary[]): MemberSummary[] {
  return members.filter((member) => member.role === 'OWNER' && member.status === 'ACTIVE');
}

export function assertExactlyOneOwner(members: readonly MemberSummary[]): void {
  if (ownersOf(members).length !== 1) {
    throw new AppError('CONFLICT', 'This family is in an inconsistent state.');
  }
}

// ---------------------------------------------------------------------------
// Capacity
// ---------------------------------------------------------------------------

/** Statuses that occupy a seat: an outstanding invitation holds one too. */
const OCCUPIES_SEAT: readonly MembershipStatus[] = ['ACTIVE', 'PENDING'];

export function seatsInUse(members: readonly MemberSummary[]): number {
  return members.filter((member) => OCCUPIES_SEAT.includes(member.status)).length;
}

export function memberCapacity(entitlements: Entitlements): number {
  // The plan sets the limit, but never above the platform ceiling.
  return Math.min(entitlements.maxMembersPerFamily, LIMITS.MAX_FAMILY_MEMBERS);
}

/** @throws AppError('PLAN_LIMIT_EXCEEDED') when the family is already full. */
export function assertSeatAvailable(
  members: readonly MemberSummary[],
  entitlements: Entitlements,
): void {
  if (seatsInUse(members) >= memberCapacity(entitlements)) {
    throw new AppError(
      'PLAN_LIMIT_EXCEEDED',
      'This family has reached the maximum number of members for its plan.',
    );
  }
}

// ---------------------------------------------------------------------------
// Inviting
// ---------------------------------------------------------------------------

export function assertCanInvite(input: {
  readonly actor: MemberSummary;
  readonly members: readonly MemberSummary[];
  readonly entitlements: Entitlements;
  readonly requestId: string;
}): void {
  if (input.actor.status !== 'ACTIVE' || !canManageMembers(input.actor.role)) {
    throw forbidden(input.requestId);
  }
  assertSeatAvailable(input.members, input.entitlements);
}

// ---------------------------------------------------------------------------
// Removal and leaving
// ---------------------------------------------------------------------------

export type RemovalPlan = {
  /** LEFT when someone removed themself; REMOVED when an admin acted. */
  readonly resultingStatus: Extract<MembershipStatus, 'REMOVED' | 'LEFT'>;
  readonly selfInitiated: boolean;
};

export function planRemoval(input: {
  readonly actor: MemberSummary;
  readonly target: MemberSummary;
  readonly requestId: string;
}): RemovalPlan {
  const selfInitiated = input.actor.userId === input.target.userId;

  // Checked before anything else, and before the privilege check, so that the
  // answer is the same whoever asks: the owner is simply not removable.
  if (input.target.role === 'OWNER') {
    throw new AppError('CONFLICT', OWNER_IMMOVABLE_MESSAGE);
  }

  if (selfInitiated) {
    // Leaving needs no role at all; it is the exit every member must have.
    return { resultingStatus: 'LEFT', selfInitiated: true };
  }

  if (input.actor.status !== 'ACTIVE' || !canManageMembers(input.actor.role)) {
    throw forbidden(input.requestId);
  }
  // Strictly greater: an ADMIN may not remove another ADMIN.
  if (FAMILY_ROLE_RANK[input.actor.role] <= FAMILY_ROLE_RANK[input.target.role]) {
    throw forbidden(input.requestId);
  }

  return { resultingStatus: 'REMOVED', selfInitiated: false };
}

// ---------------------------------------------------------------------------
// Role changes
// ---------------------------------------------------------------------------

export function assertCanChangeRole(input: {
  readonly actor: MemberSummary;
  readonly target: MemberSummary;
  readonly nextRole: AssignableFamilyRole;
  readonly requestId: string;
}): void {
  if (input.actor.userId === input.target.userId) {
    // Nobody promotes themself, including the owner.
    throw forbidden(input.requestId);
  }
  if (input.target.role === 'OWNER') {
    throw new AppError(
      'CONFLICT',
      'The family owner’s role cannot be changed. Transfer ownership instead.',
    );
  }
  if (input.actor.status !== 'ACTIVE' || !canManageMembers(input.actor.role)) {
    throw forbidden(input.requestId);
  }

  const actorRank = FAMILY_ROLE_RANK[input.actor.role];
  // Outrank the target's current role AND the role being granted, so an ADMIN
  // cannot mint a peer who could then act on them.
  if (actorRank <= FAMILY_ROLE_RANK[input.target.role]) {
    throw forbidden(input.requestId);
  }
  if (actorRank <= FAMILY_ROLE_RANK[input.nextRole]) {
    throw forbidden(input.requestId);
  }
}

// ---------------------------------------------------------------------------
// Ownership transfer
// ---------------------------------------------------------------------------

export type OwnershipTransferPlan = {
  readonly previousOwnerUserId: UserId;
  readonly newOwnerUserId: UserId;
  /** The outgoing owner keeps administrative rights, not ownership. */
  readonly previousOwnerRole: FamilyRole;
};

export function planOwnershipTransfer(input: {
  readonly actor: MemberSummary;
  readonly target: MemberSummary;
  readonly requestId: string;
}): OwnershipTransferPlan {
  if (input.actor.role !== 'OWNER' || input.actor.status !== 'ACTIVE') {
    throw forbidden(input.requestId);
  }
  if (input.actor.userId === input.target.userId) {
    throw new AppError('CONFLICT', 'You already own this family.');
  }
  if (input.target.status !== 'ACTIVE') {
    // An invitation that has not been accepted cannot receive a family.
    throw forbidden(input.requestId);
  }

  return {
    previousOwnerUserId: input.actor.userId,
    newOwnerUserId: input.target.userId,
    previousOwnerRole: 'ADMIN',
  };
}

// ---------------------------------------------------------------------------
// Family creation
// ---------------------------------------------------------------------------

/** @throws AppError('PLAN_LIMIT_EXCEEDED') when the plan allows no more families. */
export function assertCanCreateFamily(input: {
  readonly existingFamilyCount: number;
  readonly entitlements: Entitlements;
}): void {
  if (input.existingFamilyCount >= input.entitlements.maxFamilies) {
    throw new AppError(
      'PLAN_LIMIT_EXCEEDED',
      'Your plan does not allow another family. Upgrade to create more.',
    );
  }
}
