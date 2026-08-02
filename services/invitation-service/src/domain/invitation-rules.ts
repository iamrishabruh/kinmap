import { AppError, LIMITS, type ErrorCode, type FamilyId, type UserId } from '@family/contracts';
import type { AssignableFamilyRole, Invitation, InvitationStatus } from '@family/schemas';

import { timingSafeHashEquals } from './token.js';

/**
 * Invitation lifecycle rules.
 *
 * Pure, so every acceptance path — expired, revoked, already used, wrong hash —
 * is testable without a table.
 *
 * On disclosure: an invitation failure DOES report why, unlike an authorization
 * denial. That is deliberate and safe. The caller already holds the link, so
 * "this invite expired" tells them nothing they could not infer, and telling
 * them nothing would strand a real person at a dead end. What is never
 * disclosed is anything about the family behind an invalid token.
 */

const SECONDS_PER_HOUR = 3_600;

export type InvitationRecord = {
  /** SHA-256 of the token. The raw token is never part of this type. */
  readonly tokenHash: string;
  readonly invitationId: string;
  readonly familyId: FamilyId;
  readonly role: AssignableFamilyRole;
  readonly status: InvitationStatus;
  readonly label: string | null;
  readonly createdByUserId: UserId;
  readonly createdAt: string;
  /** DynamoDB TTL, epoch seconds. Expiry is enforced logically as well. */
  readonly expiresAt: number;
  readonly expiresAtIso: string;
  readonly redemptionCount: number;
  readonly maxRedemptions: number;
  readonly acceptedByUserId: UserId | null;
  readonly acceptedAt: string | null;
  readonly revokedAt: string | null;
};

export type InvitationRejectionCode = Extract<
  ErrorCode,
  'INVITATION_INVALID' | 'INVITATION_EXPIRED' | 'INVITATION_REVOKED' | 'INVITATION_ALREADY_USED'
>;

const REJECTION_MESSAGES: Record<InvitationRejectionCode, string> = {
  INVITATION_INVALID: 'This invitation link is not valid.',
  INVITATION_EXPIRED: 'This invitation has expired. Ask for a new link.',
  INVITATION_REVOKED: 'This invitation was withdrawn.',
  INVITATION_ALREADY_USED: 'This invitation has already been used.',
};

export function invitationError(code: InvitationRejectionCode): AppError {
  return new AppError(code, REJECTION_MESSAGES[code]);
}

export type InvitationEvaluation =
  | { readonly usable: true; readonly record: InvitationRecord }
  | { readonly usable: false; readonly code: InvitationRejectionCode };

/**
 * Decides whether a presented token may still be redeemed.
 *
 * Order matters. The hash is compared first, in constant time, so a token that
 * does not belong to this record cannot learn anything about its state; only
 * then is the record's own lifecycle considered.
 */
export function evaluateInvitation(input: {
  readonly record: InvitationRecord | null;
  readonly presentedTokenHash: string;
  readonly now: Date;
}): InvitationEvaluation {
  if (input.record === null) {
    return { usable: false, code: 'INVITATION_INVALID' };
  }
  if (!timingSafeHashEquals(input.record.tokenHash, input.presentedTokenHash)) {
    return { usable: false, code: 'INVITATION_INVALID' };
  }
  if (input.record.revokedAt !== null) {
    return { usable: false, code: 'INVITATION_REVOKED' };
  }
  // Logical expiry: DynamoDB TTL deletes "within 48 hours", so a token past its
  // expiry can still be physically present. It must not work.
  if (input.record.expiresAt * 1000 <= input.now.getTime()) {
    return { usable: false, code: 'INVITATION_EXPIRED' };
  }
  if (
    input.record.redemptionCount >= input.record.maxRedemptions ||
    input.record.status === 'ACCEPTED'
  ) {
    return { usable: false, code: 'INVITATION_ALREADY_USED' };
  }
  if (input.record.status !== 'PENDING') {
    return { usable: false, code: 'INVITATION_INVALID' };
  }
  return { usable: true, record: input.record };
}

export type ExpiryWindow = {
  readonly expiresAt: number;
  readonly expiresAtIso: string;
};

/** Clamped to the platform TTL ceiling; a caller cannot ask for a longer link. */
export function expiryWindow(now: Date, requestedHours: number): ExpiryWindow {
  const hours = Math.min(Math.max(1, Math.floor(requestedHours)), LIMITS.INVITATION_TTL_HOURS);
  const expiresAtMs = now.getTime() + hours * SECONDS_PER_HOUR * 1000;
  return {
    expiresAt: Math.floor(expiresAtMs / 1000),
    expiresAtIso: new Date(expiresAtMs).toISOString(),
  };
}

/**
 * Per-family cap on outstanding invitations (spec §17). This is the abuse
 * control that stops a compromised admin minting hundreds of links.
 *
 * @throws AppError('RATE_LIMITED')
 */
export function assertInvitationQuota(activeCount: number): void {
  if (activeCount >= LIMITS.MAX_ACTIVE_INVITATIONS_PER_FAMILY) {
    throw new AppError(
      'RATE_LIMITED',
      'This family already has the maximum number of open invitations. Revoke one first.',
      undefined,
      60,
    );
  }
}

export function isActiveInvitation(record: InvitationRecord, now: Date): boolean {
  return (
    record.status === 'PENDING' &&
    record.revokedAt === null &&
    record.redemptionCount < record.maxRedemptions &&
    record.expiresAt * 1000 > now.getTime()
  );
}

/**
 * Record to API resource.
 *
 * `Invitation` is a strict object with no token field at all, so this projection
 * is the structural guarantee that a list or read response cannot carry the
 * credential.
 */
export function toInvitation(record: InvitationRecord, now: Date): Invitation {
  return {
    invitationId: record.invitationId,
    familyId: record.familyId,
    role: record.role,
    // A stored PENDING row that has aged out is reported as EXPIRED rather than
    // as still open, whether or not TTL has removed it.
    status:
      record.status === 'PENDING' && !isActiveInvitation(record, now) ? 'EXPIRED' : record.status,
    label: record.label,
    createdByUserId: record.createdByUserId,
    createdAt: record.createdAt,
    expiresAt: record.expiresAtIso,
    redemptionCount: record.redemptionCount,
    maxRedemptions: record.maxRedemptions,
    acceptedByUserId: record.acceptedByUserId,
    acceptedAt: record.acceptedAt,
    revokedAt: record.revokedAt,
  };
}
