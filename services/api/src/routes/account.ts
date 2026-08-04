import { AppError, ENTITLED_SUBSCRIPTION_STATUSES, type FamilyId } from '@family/contracts';
import {
  DeleteAccountRequestSchema,
  UpdateAccountRequestSchema,
  type AccountDeletionPreviewResponse,
  type CancelAccountDeletionResponse,
  type DeleteAccountRequest,
  type DeleteAccountResponse,
  type DeletionPreviewFamily,
  type GetAccountResponse,
  type UpdateAccountResponse,
} from '@family/schemas';

import { projectAccount, toProfilePatch, visibleAccountStatus } from '../domain/account.js';
import { planAccountDeletion } from '../domain/deletion.js';
import { validateBody } from '../middleware/validation.js';
import type { MembershipRecord } from '../repositories/families.js';
import type { SubscriptionRecord } from '../repositories/subscriptions.js';
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
 *
 * `GET /v1/account/deletion/preview` is the screen in front of it. It answers
 * from the same planner the deletion runs, because a preview that disagreed
 * with what actually happens would cause exactly the surprise it exists to
 * prevent. It counts and never reads: this function holds no coordinate key,
 * and no count it produces — nor any log line it writes — carries a position.
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

/**
 * The request the preview plans against.
 *
 * A preview has nothing to confirm and no reason to give, but it must plan with
 * the *same* function the deletion uses or the two can drift apart. `reason` and
 * `feedback` reach only the job record, which the preview throws away, so this
 * placeholder cannot show up in a response, a job or an audit row.
 */
const PREVIEW_REQUEST: DeleteAccountRequest = {
  confirmation: 'DELETE',
  reason: 'OTHER',
  feedback: null,
};

async function previewAccountDeletion(
  context: AnyRouteContext,
): Promise<AccountDeletionPreviewResponse> {
  const auth = requireAuth(context);
  const { services } = context;

  const user = await services.accounts.getUser(auth.userId);
  if (user === null || visibleAccountStatus(user.status) === null) {
    throw new AppError('NOT_FOUND', 'No account was found.');
  }

  const memberships = await services.memberships.listForUser(auth.userId);
  // The real planner, on the real memberships, with the real grace period.
  // Nothing is enqueued and nothing is written: the plan's job is discarded and
  // only its conclusions are reported.
  const plan = planAccountDeletion({
    userId: auth.userId,
    memberships,
    request: PREVIEW_REQUEST,
    now: context.now,
    gracePeriodDays: services.config.accountDeletionGraceDays,
    jobId: services.newId(),
    requestId: context.requestId,
  });

  const ownedFamilies = await describeOwnedFamilies(context, plan.affectedFamilyIds);
  const owned = new Set(plan.affectedFamilyIds);

  const devices = await services.devices.list(auth.userId);
  const subscription = await services.subscriptions.getForUser(auth.userId);
  // Server-side, from the stored subscription row. What the client believes it
  // is paying for is not an input here any more than it is anywhere else.
  const hasActiveSubscription =
    subscription !== null && ENTITLED_SUBSCRIPTION_STATUSES.includes(subscription.status);

  return {
    ownedFamilies,
    memberFamilyCount: memberships.filter(
      (membership) => membership.status === 'ACTIVE' && !owned.has(membership.familyId),
    ).length,
    storedLocationPointCount: await services.locationCounts.countStoredPoints({
      userId: auth.userId,
      now: context.now,
    }),
    savedPlaceCount: await countForfeitedPlaces(context, ownedFamilies),
    // A device that is already revoked is not something the deletion takes away.
    registeredDeviceCount: devices.filter((device) => device.status !== 'REVOKED').length,
    hasActiveSubscription,
    subscriptionStore: hasActiveSubscription ? billingStore(subscription) : 'NONE',
    gracePeriodDays: services.config.accountDeletionGraceDays,
  };
}

/**
 * The families the caller owns, and whether each one survives them.
 *
 * The rule is the deletion worker's: a family with another active member is
 * handed to the longest-standing of them, and a family of one is dissolved. It
 * is answered from the roster here for the same reason the worker recomputes it
 * on every run — the roster is what decides it, and it can change between the
 * preview and the purge.
 */
async function describeOwnedFamilies(
  context: AnyRouteContext,
  ownedFamilyIds: readonly FamilyId[],
): Promise<DeletionPreviewFamily[]> {
  const auth = requireAuth(context);
  const names = await context.services.families.getFamilyNames(ownedFamilyIds);

  const families: DeletionPreviewFamily[] = [];
  for (const familyId of ownedFamilyIds) {
    const name = names.get(familyId);
    if (name === undefined) {
      // A membership row pointing at a family that is already gone: there is
      // nothing left to hand over, and no name worth inventing for it.
      continue;
    }
    const members = await context.services.memberships.listFamilyMembers(familyId);
    const active = members.filter((member) => member.status === 'ACTIVE');
    families.push({
      familyId,
      name,
      memberCount: active.length,
      willBeDissolved: !active.some((member) => member.userId !== auth.userId),
    });
  }
  return families;
}

/**
 * Saved places that are actually lost.
 *
 * A saved place is family data rather than personal data, so when the family
 * survives, authorship moves to whoever inherits it and the place stays where
 * it is; only the places the caller authored in a family that dissolves are
 * destroyed. Counting every place they ever created would be the alarming
 * number rather than the true one.
 *
 * A place carries a centre. Nothing but its author is looked at here, and no
 * part of one reaches the response.
 */
async function countForfeitedPlaces(
  context: AnyRouteContext,
  ownedFamilies: readonly DeletionPreviewFamily[],
): Promise<number> {
  const auth = requireAuth(context);
  let total = 0;
  for (const family of ownedFamilies) {
    if (!family.willBeDissolved) {
      continue;
    }
    const places = await context.services.places.listForFamily(family.familyId);
    total += places.filter((place) => place.createdBy === auth.userId).length;
  }
  return total;
}

/**
 * Which store keeps charging once the account is gone.
 *
 * Deleting an account cancels nothing at a store — only the store can do that —
 * so this names the one place the caller has to go. A promotional grant is not
 * a store subscription and bills nobody, so it answers `NONE`.
 */
function billingStore(
  subscription: SubscriptionRecord | null,
): AccountDeletionPreviewResponse['subscriptionStore'] {
  switch (subscription?.source) {
    case 'APP_STORE':
      return 'APP_STORE';
    case 'PLAY_STORE':
      return 'PLAY_STORE';
    default:
      return 'NONE';
  }
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
    method: 'GET',
    path: '/v1/account/deletion/preview',
    authRequired: true,
    entitlement: null,
    // A privacy read rather than a general one: it sweeps a month of history
    // partitions to count them, so it is priced like the history read it is
    // counting rather than like a profile fetch.
    rateLimit: 'PRIVACY_READ',
    idempotencyRequired: false,
    async handler(context) {
      return { statusCode: 200, body: await previewAccountDeletion(context) };
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
