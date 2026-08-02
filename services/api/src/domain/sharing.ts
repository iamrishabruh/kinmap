import { isVisibleTo } from '@family/auth';
import {
  opaqueAuthorizationError,
  type FamilyId,
  type SharingStatus,
  type UserId,
} from '@family/contracts';
import type { FamilySharingState, SharingSettings, UpdateSharingRequest } from '@family/schemas';

import {
  toAuthMembership,
  type MembershipRecord,
  type PausedScope,
  type SharingWrite,
} from '../repositories/families.js';

/**
 * Sharing is consent, and consent must take effect immediately.
 *
 * The authorization checker in `@family/auth` decides a location read by
 * looking at exactly one row: the target's membership in the family being read.
 * It consults no cache and no token claim. So a pause is only real if it is
 * written to that row — which is why a GLOBAL pause fans out to *every*
 * membership the user holds rather than only flipping a master flag on their
 * profile. The profile flag exists to render the UI; the membership rows are
 * what deny the next read.
 *
 * The inverse matters too: a global resume must not silently undo a pause the
 * user set for one specific family. `pausedScope` records which switch caused a
 * pause, so a global resume restores only what the global switch paused.
 */

export type SharingPlan = {
  readonly writes: SharingWrite[];
  readonly globalStatus: SharingStatus;
  readonly globalPausedUntil: string | null;
  /** Members who could see this user before the change and now cannot. */
  readonly affectedViewerUserIds: UserId[];
};

export function planSharingChange(input: {
  userId: UserId;
  request: UpdateSharingRequest;
  memberships: readonly MembershipRecord[];
  /** Every member of each affected family, used to compute lost viewers. */
  rosters: ReadonlyMap<FamilyId, readonly MembershipRecord[]>;
  currentGlobalStatus: SharingStatus;
  currentGlobalPausedUntil: string | null;
}): SharingPlan {
  const { request } = input;
  const scope = request.scope;

  const targeted =
    scope === 'GLOBAL'
      ? [...input.memberships]
      : input.memberships.filter((membership) => membership.familyId === request.familyId);

  if (scope === 'FAMILY' && targeted.length === 0) {
    // The caller named a family they are not a member of. Answering "no such
    // family" and "not your family" differently is exactly the probe the opaque
    // denial exists to prevent.
    throw opaqueAuthorizationError('');
  }

  const writes: SharingWrite[] = [];
  const affected = new Set<UserId>();

  for (const membership of targeted) {
    if (request.sharing) {
      // A family-scoped pause outlives a global resume: the user asked for that
      // family specifically, and a broad "resume" must not quietly override it.
      if (scope === 'GLOBAL' && membership.pausedScope === 'FAMILY') {
        continue;
      }
      if (membership.sharingStatus === 'SHARING' && membership.pausedUntil === null) {
        continue;
      }
      writes.push({
        familyId: membership.familyId,
        userId: input.userId,
        sharingStatus: 'SHARING',
        pausedUntil: null,
        pausedScope: null,
      });
      continue;
    }

    if (membership.sharingStatus === 'SHARING') {
      for (const viewer of viewersLosingSight(membership, input.rosters.get(membership.familyId))) {
        affected.add(viewer);
      }
    }
    writes.push({
      familyId: membership.familyId,
      userId: input.userId,
      sharingStatus: 'PAUSED',
      pausedUntil: request.pauseUntil,
      pausedScope: scope satisfies PausedScope,
    });
  }

  const globalChanged = scope === 'GLOBAL';
  return {
    writes,
    globalStatus: globalChanged
      ? request.sharing
        ? 'SHARING'
        : 'PAUSED'
      : input.currentGlobalStatus,
    globalPausedUntil: globalChanged
      ? request.sharing
        ? null
        : request.pauseUntil
      : input.currentGlobalPausedUntil,
    affectedViewerUserIds: [...affected].sort(),
  };
}

/**
 * Who could see this member a moment ago. Evaluated against the *previous*
 * membership row, because that is the state whose visibility is being withdrawn.
 */
function viewersLosingSight(
  membership: MembershipRecord,
  roster: readonly MembershipRecord[] | undefined,
): UserId[] {
  if (roster === undefined) {
    return [];
  }
  const previous = toAuthMembership(membership);
  return roster
    .filter(
      (member) =>
        member.userId !== membership.userId &&
        member.status === 'ACTIVE' &&
        isVisibleTo(previous, member.userId),
    )
    .map((member) => member.userId);
}

/** Applies a plan to an in-memory copy so the response reflects the new state. */
export function applySharingWrites(
  memberships: readonly MembershipRecord[],
  writes: readonly SharingWrite[],
  now: Date,
): MembershipRecord[] {
  const byFamily = new Map(writes.map((write) => [write.familyId, write]));
  const timestamp = now.toISOString();
  return memberships.map((membership) => {
    const write = byFamily.get(membership.familyId);
    if (write === undefined) {
      return membership;
    }
    return {
      ...membership,
      sharingStatus: write.sharingStatus,
      pausedUntil: write.pausedUntil,
      pausedScope: write.pausedScope,
      sharingChangedAt: timestamp,
      updatedAt: timestamp,
    };
  });
}

/**
 * Projects membership rows onto the API's sharing view.
 *
 * A family whose name cannot be resolved is omitted rather than rendered with a
 * placeholder: the list is a consent UI, and a row the user cannot identify is
 * worse than a row that is not there.
 */
export function projectSharingSettings(input: {
  userId: UserId;
  memberships: readonly MembershipRecord[];
  familyNames: ReadonlyMap<FamilyId, string>;
  globalStatus: SharingStatus;
  globalPausedUntil: string | null;
  updatedAt: string;
}): SharingSettings {
  const families: FamilySharingState[] = [];
  for (const membership of input.memberships) {
    const familyName = input.familyNames.get(membership.familyId);
    if (familyName === undefined) {
      continue;
    }
    families.push({
      familyId: membership.familyId,
      familyName,
      status: membership.sharingStatus,
      pausedUntil: membership.pausedUntil,
      changedAt: membership.sharingChangedAt,
    });
  }

  return {
    userId: input.userId,
    globalStatus: input.globalStatus,
    globalPausedUntil: input.globalPausedUntil,
    families,
    updatedAt: input.updatedAt,
  };
}
