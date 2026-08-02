import { AppError, type UserId } from '@family/contracts';
import {
  BlockPathSchema,
  BlockUserRequestSchema,
  CreateSupportAccessGrantRequestSchema,
  CreateSupportTicketRequestSchema,
  ReportAbuseRequestSchema,
  SupportAccessGrantPathSchema,
  type BlockUserResponse,
  type CreateSupportAccessGrantResponse,
  type CreateSupportTicketResponse,
  type ListSupportTicketsResponse,
  type ReportAbuseResponse,
  type RevokeSupportAccessGrantResponse,
  type UnblockUserResponse,
} from '@family/schemas';

import { projectEntitlements } from '../domain/entitlements.js';
import { planBlock, planUnblock, type VisibilityWrite } from '../domain/support.js';
import { validateBody, validateParams } from '../middleware/validation.js';
import { defineRoute, type RegisteredRoute } from '../router.js';
import type { AnyRouteContext } from '../types.js';

import { requireAuth, writeAudit } from './shared.js';

/**
 * Support and safety.
 *
 * Two rules run through this module:
 *
 *  - **No support scope can reveal a coordinate.** The grant scopes are account
 *    metadata, device health, subscription and membership; there is no location
 *    scope to ask for, and a grant is hard-capped in duration so it cannot
 *    quietly become standing access.
 *  - **A block is applied, not announced.** Blocking writes mutual invisibility
 *    onto both members' rows in every shared family, and the response never
 *    reports what happened to the other account — that would make the endpoint a
 *    way to probe somebody else's state.
 *
 * Tickets, grants and reports are stored as append-only, user-partitioned
 * records; see `repositories/support.ts` for why they share the audit table.
 */

const SAFETY_RESOURCE_CATEGORIES = new Set(['UNWANTED_TRACKING', 'COERCED_SHARING']);

async function applyVisibilityWrites(
  context: AnyRouteContext,
  writes: readonly VisibilityWrite[],
): Promise<void> {
  for (const write of writes) {
    await context.services.memberships.setHiddenFromUserIds({
      familyId: write.familyId,
      userId: write.userId,
      hiddenFromUserIds: write.hiddenFromUserIds,
      now: context.now,
    });
  }
}

async function blockUser(
  context: AnyRouteContext,
  input: { blockedUserId: UserId; removeFromSharedFamilies: boolean },
): Promise<{ sharedFamilyIds: string[]; leftFamilyIds: string[] }> {
  const auth = requireAuth(context);
  if (input.blockedUserId === auth.userId) {
    throw new AppError('VALIDATION_FAILED', 'You cannot block yourself.', [
      { path: 'blockedUserId', message: 'This value is not one of the allowed values.' },
    ]);
  }

  const [actorMemberships, blockedMemberships] = await Promise.all([
    context.services.memberships.listForUser(auth.userId),
    context.services.memberships.listForUser(input.blockedUserId),
  ]);

  const plan = planBlock({
    actorUserId: auth.userId,
    blockedUserId: input.blockedUserId,
    actorMemberships,
    blockedMemberships,
    removeFromSharedFamilies: input.removeFromSharedFamilies,
  });

  await applyVisibilityWrites(context, plan.visibilityWrites);
  for (const familyId of plan.leftFamilyIds) {
    // The requester leaves; the blocked member is never evicted by this call.
    await context.services.memberships.setStatus({
      familyId,
      userId: auth.userId,
      status: 'LEFT',
      now: context.now,
    });
  }

  for (const familyId of plan.sharedFamilyIds) {
    await writeAudit(context, {
      action: 'USER_BLOCKED',
      targetUserId: input.blockedUserId,
      familyId,
      metadata: { removedFromSharedFamilies: plan.leftFamilyIds.length > 0 },
    });
  }

  return { sharedFamilyIds: plan.sharedFamilyIds, leftFamilyIds: plan.leftFamilyIds };
}

export const supportRoutes: RegisteredRoute[] = [
  defineRoute({
    method: 'GET',
    path: '/v1/support/tickets',
    authRequired: true,
    entitlement: null,
    rateLimit: 'GENERAL_READ',
    idempotencyRequired: false,
    async handler(context) {
      const auth = requireAuth(context);
      const tickets = await context.services.support.listTickets(auth.userId);
      const response: ListSupportTicketsResponse = {
        tickets: tickets.map((ticket) => ({
          ticketId: ticket.ticketId,
          topic: ticket.topic,
          subject: ticket.subject,
          status: ticket.status,
          priority: ticket.priority,
          createdAt: ticket.createdAt,
          updatedAt: ticket.updatedAt,
        })),
      };
      return { statusCode: 200, body: response };
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/v1/support/tickets',
    authRequired: true,
    entitlement: null,
    rateLimit: 'ACCOUNT_MUTATION',
    idempotencyRequired: true,
    async handler(context) {
      const auth = requireAuth(context);
      const request = validateBody(CreateSupportTicketRequestSchema, context.body);

      const subscription = await context.services.subscriptions.getForUser(auth.userId);
      const entitlements = projectEntitlements({
        userId: auth.userId,
        subscription,
        now: context.now,
      }).entitlements;

      const timestamp = context.now.toISOString();
      const ticket = {
        ticketId: context.services.newId(),
        userId: auth.userId,
        topic: request.topic,
        subject: request.subject,
        body: request.body,
        familyId: request.familyId,
        // Device health carries permissions, battery and queue depth — never a
        // coordinate — so it is safe to hand to an agent.
        diagnostics: request.diagnostics ?? null,
        status: 'OPEN' as const,
        priority: entitlements.prioritySupport ? ('PRIORITY' as const) : ('STANDARD' as const),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await context.services.support.createTicket(ticket);

      const response: CreateSupportTicketResponse = {
        ticket: {
          ticketId: ticket.ticketId,
          topic: ticket.topic,
          subject: ticket.subject,
          status: ticket.status,
          priority: ticket.priority,
          createdAt: ticket.createdAt,
          updatedAt: ticket.updatedAt,
        },
      };
      return { statusCode: 201, body: response };
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/v1/support/access-grants',
    authRequired: true,
    entitlement: null,
    rateLimit: 'ACCOUNT_MUTATION',
    idempotencyRequired: true,
    async handler(context) {
      const auth = requireAuth(context);
      const request = validateBody(CreateSupportAccessGrantRequestSchema, context.body);

      const grantedAt = context.now.toISOString();
      const expiresAt = new Date(
        context.now.getTime() + request.durationMinutes * 60 * 1000,
      ).toISOString();

      const grant = {
        grantId: context.services.newId(),
        ticketId: request.ticketId,
        userId: auth.userId,
        scopes: request.scopes,
        grantedAt,
        expiresAt,
      };
      await context.services.support.createGrant(grant);

      await writeAudit(context, {
        action: 'SUPPORT_ACCESS_GRANTED',
        targetUserId: auth.userId,
        metadata: { scopes: grant.scopes.join(','), durationMinutes: request.durationMinutes },
      });

      const response: CreateSupportAccessGrantResponse = {
        grant: { ...grant, revokedAt: null },
      };
      return { statusCode: 201, body: response };
    },
  }),

  defineRoute({
    method: 'DELETE',
    path: '/v1/support/access-grants/{grantId}',
    authRequired: true,
    entitlement: null,
    rateLimit: 'ACCOUNT_MUTATION',
    idempotencyRequired: false,
    async handler(context) {
      const auth = requireAuth(context);
      const path = validateParams(SupportAccessGrantPathSchema, context.params);

      const grant = await context.services.support.getGrant({
        userId: auth.userId,
        grantId: path.grantId,
      });
      if (grant === null) {
        throw new AppError('NOT_FOUND', 'No such access grant.');
      }

      await context.services.support.revokeGrant({
        userId: auth.userId,
        grantId: path.grantId,
        revokedAt: context.now,
      });

      const response: RevokeSupportAccessGrantResponse = {
        grantId: path.grantId,
        revokedAt: context.now.toISOString(),
      };
      return { statusCode: 200, body: response };
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/v1/support/reports',
    authRequired: true,
    entitlement: null,
    rateLimit: 'ACCOUNT_MUTATION',
    idempotencyRequired: true,
    async handler(context) {
      const auth = requireAuth(context);
      const request = validateBody(ReportAbuseRequestSchema, context.body);

      let blocked = false;
      let leftFamily = false;
      if (request.blockImmediately) {
        const outcome = await blockUser(context, {
          blockedUserId: request.reportedUserId,
          removeFromSharedFamilies: request.leaveFamily,
        });
        blocked = true;
        leftFamily = outcome.leftFamilyIds.length > 0;
      } else if (request.leaveFamily && request.familyId !== null) {
        await context.services.memberships.setStatus({
          familyId: request.familyId,
          userId: auth.userId,
          status: 'LEFT',
          now: context.now,
        });
        leftFamily = true;
      }

      const submittedAt = context.now.toISOString();
      const reportId = context.services.newId();
      await context.services.support.createReport({
        reportId,
        reporterUserId: auth.userId,
        reportedUserId: request.reportedUserId,
        familyId: request.familyId,
        category: request.category,
        description: request.description,
        blocked,
        leftFamily,
        submittedAt,
      });

      await writeAudit(context, {
        action: 'ABUSE_REPORTED',
        targetUserId: request.reportedUserId,
        familyId: request.familyId,
        metadata: { category: request.category, blocked, leftFamily },
      });

      const response: ReportAbuseResponse = {
        reportId,
        submittedAt,
        blocked,
        leftFamily,
        // Never says whether anything was done to the reported account.
        safetyResourcesUrl: SAFETY_RESOURCE_CATEGORIES.has(request.category)
          ? `https://${context.services.config.webDomain}/safety`
          : null,
      };
      return { statusCode: 201, body: response };
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/v1/support/blocks',
    authRequired: true,
    entitlement: null,
    rateLimit: 'ACCOUNT_MUTATION',
    idempotencyRequired: true,
    async handler(context) {
      const request = validateBody(BlockUserRequestSchema, context.body);
      const outcome = await blockUser(context, {
        blockedUserId: request.blockedUserId,
        removeFromSharedFamilies: request.removeFromSharedFamilies,
      });

      const response: BlockUserResponse = {
        block: {
          blockedUserId: request.blockedUserId,
          blockedAt: context.now.toISOString(),
          removedFromSharedFamilies: outcome.leftFamilyIds.length > 0,
        },
      };
      return { statusCode: 201, body: response };
    },
  }),

  defineRoute({
    method: 'DELETE',
    path: '/v1/support/blocks/{userId}',
    authRequired: true,
    entitlement: null,
    rateLimit: 'ACCOUNT_MUTATION',
    idempotencyRequired: false,
    async handler(context) {
      const auth = requireAuth(context);
      const path = validateParams(BlockPathSchema, context.params);

      const [actorMemberships, blockedMemberships] = await Promise.all([
        context.services.memberships.listForUser(auth.userId),
        context.services.memberships.listForUser(path.userId),
      ]);

      await applyVisibilityWrites(
        context,
        planUnblock({
          actorUserId: auth.userId,
          blockedUserId: path.userId,
          actorMemberships,
          blockedMemberships,
        }),
      );

      const response: UnblockUserResponse = {
        blockedUserId: path.userId,
        unblockedAt: context.now.toISOString(),
      };
      return { statusCode: 200, body: response };
    },
  }),
];
