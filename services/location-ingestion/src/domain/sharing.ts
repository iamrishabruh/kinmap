import type { AccountStatus, FamilyMembershipRecord } from '@family/auth';
import type { FamilyId, UserId } from '@family/contracts';

/**
 * Consent gate for ingestion (spec §11, §34).
 *
 * The device is told its batch was received either way — refusing the upload
 * would let an app work out that its owner's account is being deleted, and would
 * make the client retry forever — but nothing is persisted unless the *user* has
 * an active, sharing membership somewhere.
 *
 * A user with no family at all is SUPPRESSED, not permitted: there is no
 * consent record enabling storage, and a coordinate nobody is entitled to see is
 * a liability with no product value.
 */

export type SharingDisposition = 'STORE' | 'SUPPRESS';

/** Server-side only. Recorded on the audit/log line, never returned to a caller. */
export type SuppressionReason =
  'ACCOUNT_NOT_ACTIVE' | 'NO_ACTIVE_MEMBERSHIP' | 'SHARING_NOT_ENABLED';

export type DispositionInput = {
  readonly accountStatus: AccountStatus;
  readonly memberships: readonly FamilyMembershipRecord[];
};

export type DispositionResult = {
  readonly disposition: SharingDisposition;
  readonly reason: SuppressionReason | null;
  /** Memberships whose sharing switch is on. Empty when suppressed. */
  readonly sharingMemberships: readonly FamilyMembershipRecord[];
};

export function resolveDisposition(input: DispositionInput): DispositionResult {
  if (input.accountStatus !== 'ACTIVE') {
    // PENDING_DELETION, SUSPENDED and DELETED are one answer to the device.
    return { disposition: 'SUPPRESS', reason: 'ACCOUNT_NOT_ACTIVE', sharingMemberships: [] };
  }

  const active = input.memberships.filter((membership) => membership.status === 'ACTIVE');
  if (active.length === 0) {
    return { disposition: 'SUPPRESS', reason: 'NO_ACTIVE_MEMBERSHIP', sharingMemberships: [] };
  }

  const sharing = active.filter((membership) => membership.sharingStatus === 'SHARING');
  if (sharing.length === 0) {
    // PAUSED, DISABLED, PERMISSION_BLOCKED and NEVER_ENABLED all land here.
    return { disposition: 'SUPPRESS', reason: 'SHARING_NOT_ENABLED', sharingMemberships: [] };
  }

  return { disposition: 'STORE', reason: null, sharingMemberships: sharing };
}

/**
 * The family a stored coordinate's encryption context is bound to.
 *
 * A member can belong to several families, but a fix belongs to a *person*, so
 * one scope has to be chosen and recorded on the row. The lowest family id among
 * the user's sharing memberships is used because it is deterministic and stable:
 * a reader recovers the context from the row itself, never from the requester's
 * claim, so joining or leaving another family cannot make old rows unreadable.
 *
 * With no family, the user's own id is the scope. The encryption context also
 * carries `userId`, so `family=<userId>&user=<userId>` is unambiguous and cannot
 * collide with a real family's context.
 */
export function resolveCoordinateScope(
  userId: UserId,
  memberships: readonly FamilyMembershipRecord[],
): FamilyId {
  const candidates = memberships
    .filter((membership) => membership.status === 'ACTIVE')
    .map((membership) => membership.familyId)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

  return candidates[0] ?? userId;
}
