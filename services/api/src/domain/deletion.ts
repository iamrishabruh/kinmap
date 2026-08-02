import type { FamilyId, UserId } from '@family/contracts';
import type { DeleteAccountRequest, DeleteHistoryRequest } from '@family/schemas';

import type { MembershipRecord, SharingWrite } from '../repositories/families.js';
import type { JobRecord } from '../repositories/jobs.js';

/**
 * Erasure and export planning.
 *
 * Deletion is asynchronous — a worker with the necessary grants does the actual
 * work — but the *consequences the user asked for* are not deferred. The plan
 * therefore has two halves:
 *
 *  - a durable job, so the request cannot be lost;
 *  - immediate revocations, so that between pressing "delete my account" and the
 *    worker running, nobody can see the user and no device can upload for them.
 *
 * The route applies them in that order: job first (nothing is lost), then the
 * revocations (nothing is visible). A crash in between leaves a scheduled
 * deletion and a still-visible user, which the client's retry fixes; the reverse
 * order would risk an invisible user whose deletion was never recorded.
 */

/** A history deletion is a bounded job; the client is told when to expect it. */
const HISTORY_DELETION_HOURS = 24;
const DATA_EXPORT_HOURS = 72;

export type AccountDeletionPlan = {
  readonly job: JobRecord;
  readonly scheduledPurgeAt: string;
  /** Families the user owns: they must be handed over or dissolved. */
  readonly affectedFamilyIds: FamilyId[];
  /** Applied immediately, before the job runs. */
  readonly sharingWrites: SharingWrite[];
};

export function planAccountDeletion(input: {
  userId: UserId;
  memberships: readonly MembershipRecord[];
  request: DeleteAccountRequest;
  now: Date;
  gracePeriodDays: number;
  jobId: string;
  requestId: string;
}): AccountDeletionPlan {
  const requestedAt = input.now.toISOString();
  const scheduledPurgeAt = addDays(input.now, input.gracePeriodDays).toISOString();

  return {
    scheduledPurgeAt,
    affectedFamilyIds: input.memberships
      .filter((membership) => membership.role === 'OWNER' && membership.status === 'ACTIVE')
      .map((membership) => membership.familyId)
      .sort(),
    // DISABLED rather than PAUSED: this is not a temporary withdrawal, and the
    // distinction is what the UI uses to explain the state to other members.
    sharingWrites: input.memberships.map((membership) => ({
      familyId: membership.familyId,
      userId: input.userId,
      sharingStatus: 'DISABLED',
      pausedUntil: null,
      pausedScope: null,
    })),
    job: {
      jobId: input.jobId,
      userId: input.userId,
      jobType: 'ACCOUNT_DELETION',
      status: 'PENDING',
      requestedAt,
      // The grace period is the point of no return: signing in before it
      // cancels the deletion, so the worker must not start any earlier.
      scheduledFor: scheduledPurgeAt,
      completesBy: addDays(input.now, input.gracePeriodDays + 1).toISOString(),
      requestId: input.requestId,
      scope: 'ACCOUNT',
      from: null,
      to: null,
      familyId: null,
      reason: input.request.reason,
      feedback: input.request.feedback,
    },
  };
}

export function planHistoryDeletion(input: {
  userId: UserId;
  request: DeleteHistoryRequest;
  now: Date;
  jobId: string;
  requestId: string;
}): JobRecord {
  const requestedAt = input.now.toISOString();
  return {
    jobId: input.jobId,
    userId: input.userId,
    jobType: 'HISTORY_DELETION',
    status: 'PENDING',
    requestedAt,
    // Erasure of one's own history is not delayed; there is nothing to undo.
    scheduledFor: requestedAt,
    completesBy: addHours(input.now, HISTORY_DELETION_HOURS).toISOString(),
    requestId: input.requestId,
    scope: input.request.scope,
    from: input.request.from,
    to: input.request.to,
    familyId: input.request.familyId,
    reason: null,
    feedback: null,
  };
}

export function planDataExport(input: {
  userId: UserId;
  now: Date;
  jobId: string;
  requestId: string;
}): JobRecord {
  const requestedAt = input.now.toISOString();
  return {
    jobId: input.jobId,
    userId: input.userId,
    jobType: 'DATA_EXPORT',
    status: 'PENDING',
    requestedAt,
    scheduledFor: requestedAt,
    completesBy: addHours(input.now, DATA_EXPORT_HOURS).toISOString(),
    requestId: input.requestId,
    scope: 'ALL',
    from: null,
    to: null,
    familyId: null,
    reason: null,
    feedback: null,
  };
}

function addDays(from: Date, days: number): Date {
  return addHours(from, days * 24);
}

function addHours(from: Date, hours: number): Date {
  return new Date(from.getTime() + hours * 60 * 60 * 1000);
}
