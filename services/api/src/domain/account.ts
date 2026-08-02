import type { FamilyId } from '@family/contracts';
import type { Account, AccountStatus, UpdateAccountRequest } from '@family/schemas';

import type { AccountStatusRecord, ProfilePatch, UserRecord } from '../repositories/accounts.js';

/**
 * Account projection.
 *
 * The stored record has one more state than the API exposes: `DELETED`. A purged
 * account is not a status a caller can observe — it is a 404 — so the mapping
 * returns null and the route turns that into "no such account". Leaking
 * "this account used to exist" is a small thing on its own and a building block
 * for someone confirming that a person they are looking for was here.
 */
export function visibleAccountStatus(status: AccountStatusRecord): AccountStatus | null {
  switch (status) {
    case 'ACTIVE':
      return 'ACTIVE';
    case 'PENDING_DELETION':
      return 'PENDING_DELETION';
    case 'SUSPENDED':
      return 'SUSPENDED';
    case 'DELETED':
      return null;
  }
}

export function projectAccount(input: {
  user: UserRecord;
  familyIds: readonly FamilyId[];
  status: AccountStatus;
}): Account {
  return {
    userId: input.user.userId,
    displayName: input.user.displayName,
    avatarUrl: input.user.avatarUrl,
    // Only ever populated on the owner's own read; no other endpoint in this
    // service projects a `UserRecord`, so there is no path that returns
    // somebody else's address.
    email: input.user.email,
    phoneNumber: input.user.phoneNumber,
    locale: input.user.locale,
    timeZone: input.user.timeZone,
    status: input.status,
    familyIds: [...input.familyIds],
    acceptedTermsVersion: input.user.acceptedTermsVersion,
    acceptedPrivacyPolicyVersion: input.user.acceptedPrivacyPolicyVersion,
    createdAt: input.user.createdAt,
    updatedAt: input.user.updatedAt,
    scheduledPurgeAt: input.user.scheduledPurgeAt,
  };
}

/**
 * Narrows a validated patch to the fields that are actually writable. The
 * schema already rejects unknown keys; this makes the writable set explicit at
 * the point where it turns into an update expression.
 */
export function toProfilePatch(request: UpdateAccountRequest): ProfilePatch {
  return {
    displayName: request.displayName,
    avatarUrl: request.avatarUrl,
    locale: request.locale,
    timeZone: request.timeZone,
  };
}
