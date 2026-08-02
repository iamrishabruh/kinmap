import { AppError, type FamilyId } from '@family/contracts';
import {
  DeleteAccountRequestSchema,
  UpdateAccountRequestSchema,
  type CancelAccountDeletionResponse,
  type DeleteAccountResponse,
  type GetAccountResponse,
  type UpdateAccountResponse,
} from '@family/schemas';

import { projectAccount, toProfilePatch, visibleAccountStatus } from '../domain/account.js';
import { planAccountDeletion } from '../domain/deletion.js';
import { validateBody } from '../middleware/validation.js';
import type { MembershipRecord } from '../repositories/families.js';
import { defineRoute, type RegisteredRoute } from '../router.js';
import type { AnyRouteContext } from '../types.js';

import { requireAuth, writeAudit } from './shared.js';

/**
 * Account endpoints.
 *
 * `DELETE /v1/account` is the one that matters. Erasure itself is asynchronous —
 * this function holds no grant on any location table — but the two consequences
 * the user is asking for are applied before the response is written:
 *
 *  1. sharing is switched off in every family, on the membership rows the
 *     authorization checker reads, so nobody can see them from the next request
 *     onward;
 *  2. every device is revoked and its push token destroyed, so nothing keeps
 *     uploading on their behalf while the grace period runs.
 *
 * The scheduled job is what makes the request durable; the revocations are what
 * make it immediate. Both are idempotent, so a client retry cannot create a
 * second job or move the purge deadline.
 */

async function readAccount(context: AnyRouteContext): Promise<GetAccountResponse> {
  const auth = requireAuth(context);
  const user = await context.services.accounts.getUser(auth.userId);
  if (user === null) {
    throw new AppError('NOT_FOUND', 'No account was found.');
  }
  const status = visibleAccountStatus(user.status);
  if (status === null) {
    throw new AppError('NOT_FOUND', 'No account was found.');
  }

  const memberships = await context.services.memberships.listForUser(auth.userId);
  return {
    account: projectAccount({ user, familyIds: activeFamilyIds(memberships), status }),
  };
}

function activeFamilyIds(memberships: readonly MembershipRecord[]): FamilyId[] {
  return memberships
    .filter((membership) => membership.status === 'ACTIVE')
    .map((membership) => membership.familyId)
    .sort();
}

export const accountRoutes: RegisteredRoute[] = [
  defineRoute({
    method: 'GET',
    path: '/v1/account',
    authRequired: true,
    entitlement: null,
    rateLimit: 'GENERAL_READ',
    idempotencyRequired: false,
    async handler(context) {
      return { statusCode: 200, body: await readAccount(context) };
    },
  }),

  defineRoute({
    method: 'PATCH',
    path: '/v1/account',
    authRequired: true,
    entitlement: null,
    rateLimit: 'ACCOUNT_MUTATION',
    idempotencyRequired: false,
    async handler(context) {
      const auth = requireAuth(context);
      const request = validateBody(UpdateAccountRequestSchema, context.body);

      const updated = await context.services.accounts.updateProfile({
        userId: auth.userId,
        patch: toProfilePatch(request),
        now: context.now,
      });
      if (updated === null) {
        throw new AppError('NOT_FOUND', 'No account was found.');
      }
      const status = visibleAccountStatus(updated.status);
      if (status === null) {
        throw new AppError('NOT_FOUND', 'No account was found.');
      }

      const memberships = await context.services.memberships.listForUser(auth.userId);
      const response: UpdateAccountResponse = {
        account: projectAccount({
          user: updated,
          familyIds: activeFamilyIds(memberships),
          status,
        }),
      };
      return { statusCode: 200, body: response };
    },
  }),

  defineRoute({
    method: 'DELETE',
    path: '/v1/account',
    authRequired: true,
    entitlement: null,
    rateLimit: 'ACCOUNT_MUTATION',
    // Destroying an account is the least replayable operation in the product.
    idempotencyRequired: true,
    async handler(context) {
      const auth = requireAuth(context);
      const request = validateBody(DeleteAccountRequestSchema, context.body);
      const { services } = context;

      const user = await services.accounts.getUser(auth.userId);
      if (user === null || visibleAccountStatus(user.status) === null) {
        throw new AppError('NOT_FOUND', 'No account was found.');
      }

      const memberships = await services.memberships.listForUser(auth.userId);
      const plan = planAccountDeletion({
        userId: auth.userId,
        memberships,
        request,
        now: context.now,
        gracePeriodDays: services.config.accountDeletionGraceDays,
        jobId: services.newId(),
        requestId: context.requestId,
      });

      // The conditional update is the guard against two concurrent deletions:
      // only an ACTIVE account can be scheduled, so the purge deadline is set
      // exactly once and a retry never pushes it further out.
      await services.accounts.markPendingDeletion({
        userId: auth.userId,
        scheduledPurgeAt: plan.scheduledPurgeAt,
        now: context.now,
      });

      // Self-healing: if an earlier attempt flipped the status but failed before
      // recording the job, this recreates it rather than leaving an account that
      // is pending deletion forever and purged never.
      const jobs = await services.jobs.listForUser(auth.userId);
      const existing = jobs.find(
        (job) => job.jobType === 'ACCOUNT_DELETION' && job.status === 'PENDING',
      );
      if (existing === undefined) {
        await services.jobs.enqueue(plan.job);
      }
      const scheduledPurgeAt = existing?.scheduledFor ?? plan.scheduledPurgeAt;

      // Immediate, before anything asynchronous runs.
      await services.memberships.writeSharing({ writes: plan.sharingWrites, now: context.now });
      await services.accounts.setSharing({
        userId: auth.userId,
        sharingStatus: 'DISABLED',
        pausedUntil: null,
        now: context.now,
      });
      const revokedDevices = await services.devices.revokeAll({
        userId: auth.userId,
        now: context.now,
      });

      await writeAudit(context, {
        action: 'ACCOUNT_DELETION_REQUESTED',
        targetUserId: auth.userId,
        metadata: {
          reason: request.reason,
          revokedDeviceCount: revokedDevices,
          familiesAffected: plan.affectedFamilyIds.length,
        },
      });

      const response: DeleteAccountResponse = {
        userId: auth.userId,
        status: 'PENDING_DELETION',
        requestedAt: context.now.toISOString(),
        scheduledPurgeAt,
        gracePeriodDays: services.config.accountDeletionGraceDays,
        affectedFamilyIds: plan.affectedFamilyIds,
      };
      return { statusCode: 202, body: response };
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/v1/account/deletion/cancel',
    authRequired: true,
    entitlement: null,
    rateLimit: 'ACCOUNT_MUTATION',
    idempotencyRequired: false,
    async handler(context) {
      const auth = requireAuth(context);
      const { services } = context;

      const outcome = await services.accounts.cancelDeletion({
        userId: auth.userId,
        now: context.now,
      });
      if (outcome === 'NOT_PENDING') {
        throw new AppError('CONFLICT', 'This account is not scheduled for deletion.');
      }
      await services.jobs.cancelPending({
        userId: auth.userId,
        jobType: 'ACCOUNT_DELETION',
        now: context.now,
      });

      // Sharing and devices stay revoked. Re-enabling them is an explicit act by
      // the user, not a side effect of changing their mind about deleting.
      const response: CancelAccountDeletionResponse = {
        userId: auth.userId,
        status: 'ACTIVE',
        cancelledAt: context.now.toISOString(),
      };
      return { statusCode: 200, body: response };
    },
  }),
];
