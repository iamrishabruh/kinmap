import { AppError, type FamilyId, type UserId } from '@family/contracts';
import {
  DeleteHistoryRequestSchema,
  GetAuditLogQuerySchema,
  UpdateSharingRequestSchema,
  type AuditLogEntry,
  type DeleteHistoryResponse,
  type GetAuditLogResponse,
  type GetSharingSettingsResponse,
  type RequestDataExportResponse,
  type UpdateSharingResponse,
} from '@family/schemas';

import { planDataExport, planHistoryDeletion } from '../domain/deletion.js';
import {
  applySharingWrites,
  planSharingChange,
  projectSharingSettings,
} from '../domain/sharing.js';
import { validateBody, validateQuery } from '../middleware/validation.js';
import type { MembershipRecord } from '../repositories/families.js';
import { defineRoute, type RegisteredRoute } from '../router.js';
import type { AnyRouteContext } from '../types.js';

import { requireAuth, writeAudit } from './shared.js';

/**
 * Privacy endpoints: the controls a user has over their own data.
 *
 * `PATCH /v1/privacy/sharing` is the consent switch, and its contract is that it
 * takes effect immediately. It does that by writing the new state onto the
 * membership rows themselves — the rows `@family/auth` reads when it authorises
 * a location read — so the very next read denies. There is no cache to expire
 * and no token to wait out.
 *
 * Nothing here exposes another member's position. The audit log answers "who
 * looked at me", and its only location-derived field is a coarse geohash, which
 * this service never writes at all.
 */

const DEFAULT_AUDIT_WINDOW_DAYS = 30;

async function loadSharingSettings(
  context: AnyRouteContext,
  memberships: readonly MembershipRecord[],
): Promise<GetSharingSettingsResponse> {
  const auth = requireAuth(context);
  const user = await context.services.accounts.getUser(auth.userId);
  if (user === null) {
    throw new AppError('NOT_FOUND', 'No account was found.');
  }
  const familyNames = await context.services.families.getFamilyNames(
    memberships.map((membership) => membership.familyId),
  );
  return {
    sharing: projectSharingSettings({
      userId: auth.userId,
      memberships,
      familyNames,
      globalStatus: user.sharingStatus,
      globalPausedUntil: user.sharingPausedUntil,
      updatedAt: user.updatedAt,
    }),
  };
}

export const privacyRoutes: RegisteredRoute[] = [
  defineRoute({
    method: 'GET',
    path: '/v1/privacy/sharing',
    authRequired: true,
    entitlement: null,
    rateLimit: 'GENERAL_READ',
    idempotencyRequired: false,
    async handler(context) {
      const auth = requireAuth(context);
      const memberships = await context.services.memberships.listForUser(auth.userId);
      return { statusCode: 200, body: await loadSharingSettings(context, memberships) };
    },
  }),

  defineRoute({
    method: 'PATCH',
    path: '/v1/privacy/sharing',
    authRequired: true,
    entitlement: null,
    rateLimit: 'ACCOUNT_MUTATION',
    idempotencyRequired: false,
    async handler(context) {
      const auth = requireAuth(context);
      const request = validateBody(UpdateSharingRequestSchema, context.body);
      const { services } = context;

      const user = await services.accounts.getUser(auth.userId);
      if (user === null) {
        throw new AppError('NOT_FOUND', 'No account was found.');
      }
      const memberships = await services.memberships.listForUser(auth.userId);

      // Rosters are only needed to work out who loses sight of the user, which
      // is only meaningful when sharing is being switched off.
      const rosters = new Map<FamilyId, readonly MembershipRecord[]>();
      if (!request.sharing) {
        const targets =
          request.scope === 'GLOBAL'
            ? memberships.map((membership) => membership.familyId)
            : memberships
                .filter((membership) => membership.familyId === request.familyId)
                .map((membership) => membership.familyId);
        for (const familyId of new Set(targets)) {
          rosters.set(familyId, await services.memberships.listFamilyMembers(familyId));
        }
      }

      const plan = planSharingChange({
        userId: auth.userId,
        request,
        memberships,
        rosters,
        currentGlobalStatus: user.sharingStatus,
        currentGlobalPausedUntil: user.sharingPausedUntil,
      });

      // Membership rows first: they are what actually denies a read, so they are
      // written before anything cosmetic. A failure here fails the request.
      await services.memberships.writeSharing({ writes: plan.writes, now: context.now });
      if (request.scope === 'GLOBAL') {
        await services.accounts.setSharing({
          userId: auth.userId,
          sharingStatus: plan.globalStatus,
          pausedUntil: plan.globalPausedUntil,
          now: context.now,
        });
      }

      for (const write of plan.writes) {
        await writeAudit(context, {
          action: request.sharing ? 'SHARING_RESUMED' : 'SHARING_PAUSED',
          targetUserId: auth.userId,
          familyId: write.familyId,
          metadata: {
            scope: request.scope,
            timed: write.pausedUntil !== null,
          },
        });
      }

      const updatedMemberships = applySharingWrites(memberships, plan.writes, context.now);
      const familyNames = await services.families.getFamilyNames(
        updatedMemberships.map((membership) => membership.familyId),
      );
      const response: UpdateSharingResponse = {
        sharing: projectSharingSettings({
          userId: auth.userId,
          memberships: updatedMemberships,
          familyNames,
          globalStatus: plan.globalStatus,
          globalPausedUntil: plan.globalPausedUntil,
          updatedAt: context.now.toISOString(),
        }),
        affectedViewerUserIds: plan.affectedViewerUserIds,
      };
      return { statusCode: 200, body: response };
    },
  }),

  defineRoute({
    method: 'DELETE',
    path: '/v1/privacy/history',
    authRequired: true,
    entitlement: null,
    rateLimit: 'ACCOUNT_MUTATION',
    idempotencyRequired: true,
    async handler(context) {
      const auth = requireAuth(context);
      const request = validateBody(DeleteHistoryRequestSchema, context.body);

      const job = planHistoryDeletion({
        userId: auth.userId,
        request,
        now: context.now,
        jobId: context.services.newId(),
        requestId: context.requestId,
      });
      await context.services.jobs.enqueue(job);

      await writeAudit(context, {
        action: 'HISTORY_DELETED',
        targetUserId: auth.userId,
        familyId: request.familyId,
        metadata: { scope: request.scope, ranged: request.from !== null },
      });

      const response: DeleteHistoryResponse = {
        userId: auth.userId,
        scope: request.scope,
        requestedAt: job.requestedAt,
        deletionJobId: job.jobId,
        completesBy: job.completesBy,
      };
      return { statusCode: 202, body: response };
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/v1/privacy/export',
    authRequired: true,
    entitlement: null,
    rateLimit: 'PRIVACY_READ',
    idempotencyRequired: true,
    async handler(context) {
      const auth = requireAuth(context);
      const job = planDataExport({
        userId: auth.userId,
        now: context.now,
        jobId: context.services.newId(),
        requestId: context.requestId,
      });
      await context.services.jobs.enqueue(job);

      const response: RequestDataExportResponse = {
        exportJobId: job.jobId,
        requestedAt: job.requestedAt,
        // The archive is emailed as a short-lived signed link and is never
        // returned inline: a response body is exactly the wrong place for it.
        deliveryMethod: 'EMAIL_LINK',
        completesBy: job.completesBy,
      };
      return { statusCode: 202, body: response };
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/v1/privacy/audit',
    authRequired: true,
    entitlement: null,
    rateLimit: 'PRIVACY_READ',
    idempotencyRequired: false,
    async handler(context) {
      const auth = requireAuth(context);
      const query = validateQuery(GetAuditLogQuerySchema, context.request.query);

      const to = query.to ?? context.now.toISOString();
      const from =
        query.from ??
        new Date(
          context.now.getTime() - DEFAULT_AUDIT_WINDOW_DAYS * 24 * 3600 * 1000,
        ).toISOString();

      const page = await context.services.audit.listForTarget({
        // Always the caller's own partition. There is no parameter that could
        // point this at somebody else's audit trail.
        targetUserId: auth.userId,
        from,
        to,
        action: query.action,
        limit: query.limit,
        cursor: query.cursor,
      });

      const displayNames = await resolveDisplayNames(
        context,
        page.entries.map((entry) => entry.actorUserId),
      );

      const entries: AuditLogEntry[] = page.entries.map((entry) => ({
        auditId: entry.auditId,
        action: entry.action,
        actorUserId: entry.actorUserId,
        actorDisplayName: displayNames.get(entry.actorUserId) ?? null,
        targetUserId: entry.targetUserId,
        familyId: entry.familyId,
        occurredAt: entry.occurredAt,
        // This service never records a location context, so there is never a
        // cell to report. The field exists for readers that do.
        coarseArea: null,
      }));

      const response: GetAuditLogResponse = {
        entries,
        page: { nextCursor: page.nextCursor, hasMore: page.hasMore },
      };
      return { statusCode: 200, body: response };
    },
  }),
];

/**
 * Resolves actor names for one page. The page size is capped at 200 by the query
 * schema and actors repeat heavily, so the deduplicated lookup is small and
 * bounded — no unbounded fan-out hides here.
 */
async function resolveDisplayNames(
  context: AnyRouteContext,
  actorUserIds: readonly UserId[],
): Promise<Map<UserId, string>> {
  const names = new Map<UserId, string>();
  for (const actorUserId of new Set(actorUserIds)) {
    const user = await context.services.accounts.getUser(actorUserId);
    if (user !== null) {
      names.set(actorUserId, user.displayName);
    }
  }
  return names;
}
