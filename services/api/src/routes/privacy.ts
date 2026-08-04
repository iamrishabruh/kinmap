import { AppError, opaqueAuthorizationError, type FamilyId, type UserId } from '@family/contracts';
import {
  DataExportPathSchema,
  DeleteHistoryRequestSchema,
  GetAuditLogQuerySchema,
  UpdateSharingRequestSchema,
  type AuditLogEntry,
  type DataExport,
  type DeleteHistoryResponse,
  type EntitlementsResponse,
  type GetAuditLogResponse,
  type GetRetentionResponse,
  type GetSharingSettingsResponse,
  type ListDataExportsResponse,
  type RequestDataExportResponse,
  type RetentionSettings,
  type UpdateSharingResponse,
} from '@family/schemas';

import { planDataExport, planHistoryDeletion } from '../domain/deletion.js';
import { projectEntitlements } from '../domain/entitlements.js';
import {
  applySharingWrites,
  planSharingChange,
  projectSharingSettings,
} from '../domain/sharing.js';
import { validateBody, validateParams, validateQuery } from '../middleware/validation.js';
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
 *
 * Two of these endpoints are about the data itself rather than about who can see
 * it, and both are shaped by the same constraint: this function holds no grant on
 * any location table and none on the coordinate key.
 *
 *  - `/v1/privacy/exports` records a request and reports its state. It does not
 *    stream an archive, because it could not read one, and the response contract
 *    says so rather than carrying a `downloadUrl` that would forever be null.
 *  - `/v1/privacy/retention` records a choice and reports what is applied. The
 *    ceiling comes from ENTITLEMENTS, re-derived from the stored subscription row
 *    on every request; a plan named by a client is not an input anywhere here.
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

/**
 * The caller's own entitlement snapshot.
 *
 * Derived exactly the way `GET /v1/subscriptions/entitlements` derives it, from
 * the subscription row this service can only read, so the ceiling enforced here
 * and the plan the client was told it has can never disagree. A receipt, a
 * product id or a cached tier presented by the caller is not an input.
 */
async function callerEntitlements(context: AnyRouteContext): Promise<EntitlementsResponse> {
  const auth = requireAuth(context);
  const subscription = await context.services.subscriptions.getForUser(auth.userId);
  return projectEntitlements({ userId: auth.userId, subscription, now: context.now });
}

/**
 * Reports the retention the platform actually enforces.
 *
 * Derived entirely from the plan, because that is what the system acts on: the
 * TTL is stamped at ingestion from a per-deployment value, the read path applies
 * the plan's retention, and the nightly sweep uses the same global. There is no
 * stored per-user preference to report, and inventing one here would mean this
 * endpoint answering with a number nothing honours.
 *
 * Derived on READ rather than stored is also what makes a downgrade safe with no
 * migration: the answer follows the plan immediately, everywhere it is read.
 */
function projectRetention(input: {
  userId: UserId;
  entitlements: EntitlementsResponse;
  auditRetentionDays: number;
}): RetentionSettings {
  const ceiling = input.entitlements.entitlements.historyRetentionDays;
  return {
    userId: input.userId,
    planTier: input.entitlements.tier,
    historyRetentionDays: ceiling,
    maxHistoryRetentionDays: ceiling,
    auditRetentionDays: input.auditRetentionDays,
  };
}

/** Waiting or running: a request the user should be shown rather than replaced. */
function isInFlight(request: DataExport): boolean {
  return request.status === 'QUEUED' || request.status === 'IN_PROGRESS';
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

  defineRoute({
    method: 'GET',
    path: '/v1/privacy/exports',
    authRequired: true,
    // Getting a copy of your own data is a right, not a feature. Gating it on a
    // plan would make the paywall the thing standing between somebody and their
    // own records.
    entitlement: null,
    rateLimit: 'PRIVACY_READ',
    idempotencyRequired: false,
    async handler(context) {
      const auth = requireAuth(context);
      const requests = await context.services.privacyExports.listExports(auth.userId);
      // Always the caller's own partition. There is no parameter that could
      // point this at somebody else's requests.
      const response: ListDataExportsResponse = { exports: requests };
      return { statusCode: 200, body: response };
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/v1/privacy/exports',
    authRequired: true,
    entitlement: null,
    rateLimit: 'PRIVACY_READ',
    idempotencyRequired: true,
    async handler(context) {
      const auth = requireAuth(context);

      // An export already in flight is returned as it stands rather than joined
      // by a second one. Building an archive of somebody's whole account is the
      // most expensive thing this product does on their behalf, and a client
      // that retries with a fresh key — or a user tapping twice — must not be
      // able to queue it twice. 200 rather than 202: nothing new was accepted.
      const inFlight = (await context.services.privacyExports.listExports(auth.userId)).find(
        isInFlight,
      );
      if (inFlight !== undefined) {
        return { statusCode: 200, body: inFlight };
      }

      const job = planDataExport({
        userId: auth.userId,
        now: context.now,
        jobId: context.services.newId(),
        requestId: context.requestId,
      });
      await context.services.jobs.enqueue(job);

      // Echoed from what was just written, so the caller has the id to poll with
      // before the index this list reads from has caught up.
      const response: DataExport = {
        exportId: job.jobId,
        status: 'QUEUED',
        requestedAt: job.requestedAt,
        completesBy: job.completesBy,
        // The archive is mailed as a short-lived signed link and is never
        // returned inline: a response body is exactly the wrong place for it.
        deliveryMethod: 'EMAIL_LINK',
      };
      return { statusCode: 202, body: response };
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/v1/privacy/exports/{exportId}',
    authRequired: true,
    entitlement: null,
    rateLimit: 'PRIVACY_READ',
    idempotencyRequired: false,
    async handler(context) {
      const auth = requireAuth(context);
      const path = validateParams(DataExportPathSchema, context.params);

      const request = await context.services.privacyExports.getExport({
        userId: auth.userId,
        exportId: path.exportId,
      });
      if (request === null) {
        // Identical to the answer for a request that never existed, so this
        // endpoint cannot be used to discover that somebody else asked for one.
        throw opaqueAuthorizationError(context.requestId);
      }
      return { statusCode: 200, body: request };
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/v1/privacy/retention',
    authRequired: true,
    // A FREE account's ceiling is zero days, and it still has to be able to read
    // that. An entitlement gate here would hide the answer behind the plan the
    // answer is about.
    entitlement: null,
    rateLimit: 'GENERAL_READ',
    idempotencyRequired: false,
    async handler(context) {
      const auth = requireAuth(context);

      const response: GetRetentionResponse = {
        retention: projectRetention({
          userId: auth.userId,
          entitlements: await callerEntitlements(context),
          auditRetentionDays: context.services.config.auditRetentionDays,
        }),
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
