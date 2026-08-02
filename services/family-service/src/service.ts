import {
  resolveEntitlements,
  type AuthContext,
  type AuthorizationChecker,
  type SubscriptionRecord,
  type SubscriptionRepository,
  type UserAccountRepository,
} from '@family/auth';
import {
  AppError,
  FAMILY_ROLE_RANK,
  opaqueAuthorizationError,
  type AuditAction,
  type AuditEvent,
  type Entitlements,
  type FamilyId,
  type PlanTier,
  type UserId,
} from '@family/contracts';
import type { Logger } from '@family/observability';
import type {
  BlockUserRequest,
  BlockUserResponse,
  CreateFamilyRequest,
  CreateFamilyResponse,
  FamilyMember,
  GetFamilyResponse,
  ListFamiliesResponse,
  ListFamilyMembersQuery,
  ListFamilyMembersResponse,
  RemoveFamilyMemberResponse,
  ReportAbuseRequest,
  ReportAbuseResponse,
  TransferFamilyOwnershipResponse,
  UnblockUserResponse,
  UpdateFamilyMemberRequest,
  UpdateFamilyMemberResponse,
  UpdateFamilyRequest,
  UpdateFamilyResponse,
} from '@family/schemas';

import {
  assertCanChangeRole,
  assertCanCreateFamily,
  canManageMembers,
  planOwnershipTransfer,
  planRemoval,
  type MemberSummary,
} from './domain/membership-rules.js';
import { toFamily, toFamilyMember, toMemberSummary } from './domain/projections.js';
import type {
  AuditWriter,
  FamilyEventPublisher,
  FamilyRecord,
  FamilyStore,
  MembershipRow,
  MembershipStore,
} from './ports.js';

/**
 * Family and membership operations.
 *
 * Two behaviours are worth calling out because they are what a safety-critical
 * product is judged on:
 *
 *  - Removing a member REVOKES LOCATION ACCESS IN THE SAME WRITE. The row's
 *    status, its sharing switch and its visibility lists all change together, so
 *    there is no window in which an authorisation check could still pass. An
 *    event is then published so every client purges the cached position rather
 *    than showing a stale pin.
 *  - Blocking is SYMMETRIC. Neither party can see the other afterwards, so a
 *    block cannot be used to work out whether the other person noticed.
 */

/** Family creation needs the *user's* subscription; nothing else does. */
export interface SubscriptionReader extends SubscriptionRepository {
  getSubscriptionForUser(userId: UserId): Promise<SubscriptionRecord | null>;
}

export type FamilyServiceDependencies = {
  readonly checker: AuthorizationChecker;
  readonly accounts: UserAccountRepository;
  readonly families: FamilyStore;
  readonly memberships: MembershipStore;
  readonly subscriptions: SubscriptionReader;
  readonly events: FamilyEventPublisher;
  readonly audit: AuditWriter;
  readonly logger: Logger;
  readonly now: () => Date;
  readonly newId: () => string;
  readonly safetyResourcesUrl: string | null;
};

const FAMILY_SCHEMA_VERSION = 1;

/** Categories that surface safety resources after a report. */
const SAFETY_RESOURCE_CATEGORIES: readonly string[] = ['UNWANTED_TRACKING', 'COERCED_SHARING'];

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function entitlementsForFamily(
  familyId: FamilyId,
  deps: FamilyServiceDependencies,
): Promise<{ tier: PlanTier; entitlements: Entitlements }> {
  return resolveEntitlements(await deps.subscriptions.getSubscriptionForFamily({ familyId }));
}

async function requireActiveAccount(
  auth: AuthContext,
  deps: FamilyServiceDependencies,
): Promise<void> {
  const account = await deps.accounts.getUserAccount({ userId: auth.userId });
  if (account === null) {
    throw opaqueAuthorizationError(auth.requestId);
  }
  if (account.status === 'PENDING_DELETION' || account.status === 'DELETED') {
    throw new AppError('ACCOUNT_PENDING_DELETION', 'This account is scheduled for deletion.');
  }
  if (account.status !== 'ACTIVE') {
    throw opaqueAuthorizationError(auth.requestId);
  }
}

async function loadFamily(
  familyId: FamilyId,
  auth: AuthContext,
  deps: FamilyServiceDependencies,
): Promise<FamilyRecord> {
  const record = await deps.families.get(familyId);
  if (record === null) {
    // The caller already proved membership to get here, but a missing family
    // record is still answered opaquely rather than as a 404.
    throw opaqueAuthorizationError(auth.requestId);
  }
  return record;
}

async function writeAudit(
  deps: FamilyServiceDependencies,
  input: {
    action: AuditAction;
    auth: AuthContext;
    targetUserId: UserId;
    familyId: FamilyId | null;
    occurredAt: string;
    metadata: AuditEvent['metadata'];
  },
): Promise<void> {
  await deps.audit.record({
    auditId: deps.newId(),
    action: input.action,
    actorUserId: input.auth.userId,
    targetUserId: input.targetUserId,
    familyId: input.familyId,
    metadata: input.metadata,
    occurredAt: input.occurredAt,
    requestId: input.auth.requestId,
    sourceIpHash: null,
  });
}

function summaryOf(row: MembershipRow): MemberSummary {
  return toMemberSummary(row);
}

// ---------------------------------------------------------------------------
// POST /v1/families
// ---------------------------------------------------------------------------

export async function createFamily(
  input: { readonly auth: AuthContext; readonly body: CreateFamilyRequest },
  deps: FamilyServiceDependencies,
): Promise<CreateFamilyResponse> {
  await requireActiveAccount(input.auth, deps);

  const existing = await deps.memberships.listByUser(input.auth.userId);
  const activeFamilies = existing.filter((row) => row.status === 'ACTIVE');
  const snapshot = resolveEntitlements(
    await deps.subscriptions.getSubscriptionForUser(input.auth.userId),
  );
  assertCanCreateFamily({
    existingFamilyCount: activeFamilies.length,
    entitlements: snapshot.entitlements,
  });

  const now = deps.now().toISOString();
  const familyId = deps.newId() as FamilyId;

  const family: FamilyRecord = {
    familyId,
    name: input.body.name,
    ownerUserId: input.auth.userId,
    timeZone: input.body.timeZone,
    savedPlaceCount: 0,
    pendingInvitationCount: 0,
    createdAt: now,
    updatedAt: now,
    schemaVersion: FAMILY_SCHEMA_VERSION,
  };

  const membership: MembershipRow = {
    familyId,
    userId: input.auth.userId,
    role: 'OWNER',
    status: 'ACTIVE',
    // Creating a family does not start sharing. The owner opts in explicitly,
    // exactly as an invited member does.
    sharingStatus: 'NEVER_ENABLED',
    visibleToUserIds: null,
    displayName: input.body.name,
    avatarUrl: null,
    deviceCount: 0,
    lastSeenAt: null,
    joinedAt: now,
    invitedByUserId: null,
    sharingChangedAt: null,
    updatedAt: now,
  };

  await deps.families.create(family);
  await deps.memberships.create(membership);
  await deps.events.publish({
    kind: 'FAMILY_CREATED',
    familyId,
    ownerUserId: input.auth.userId,
    occurredAt: now,
  });

  deps.logger.info('family created', { familyId, ownerUserId: input.auth.userId });

  return {
    family: toFamily(family, [membership], snapshot.tier),
    membership: toFamilyMember(membership, input.auth.userId),
  };
}

// ---------------------------------------------------------------------------
// GET /v1/families
// ---------------------------------------------------------------------------

export async function listFamilies(
  input: { readonly auth: AuthContext },
  deps: FamilyServiceDependencies,
): Promise<ListFamiliesResponse> {
  const rows = (await deps.memberships.listByUser(input.auth.userId)).filter(
    (row) => row.status === 'ACTIVE',
  );

  const families = [];
  for (const row of rows) {
    const record = await deps.families.get(row.familyId);
    if (record === null) {
      continue;
    }
    const members = await deps.memberships.listByFamily(row.familyId);
    const snapshot = await entitlementsForFamily(row.familyId, deps);
    families.push(toFamily(record, members, snapshot.tier));
  }

  return { families };
}

// ---------------------------------------------------------------------------
// GET /v1/families/{familyId}
// ---------------------------------------------------------------------------

export async function getFamily(
  input: { readonly auth: AuthContext; readonly familyId: FamilyId },
  deps: FamilyServiceDependencies,
): Promise<GetFamilyResponse> {
  const grant = await deps.checker.assertCanMutateFamily({
    auth: input.auth,
    familyId: input.familyId,
    // A read needs membership, not seniority.
    minimumRole: 'MEMBER',
  });

  const record = await loadFamily(input.familyId, input.auth, deps);
  const members = await deps.memberships.listByFamily(input.familyId);
  const snapshot = await entitlementsForFamily(input.familyId, deps);

  return {
    family: toFamily(record, members, snapshot.tier),
    members: members.map((row) => toFamilyMember(row, input.auth.userId)),
    callerRole: grant.requesterMembership.role,
  };
}

// ---------------------------------------------------------------------------
// PATCH /v1/families/{familyId}
// ---------------------------------------------------------------------------

export async function updateFamily(
  input: {
    readonly auth: AuthContext;
    readonly familyId: FamilyId;
    readonly body: UpdateFamilyRequest;
  },
  deps: FamilyServiceDependencies,
): Promise<UpdateFamilyResponse> {
  await deps.checker.assertCanMutateFamily({ auth: input.auth, familyId: input.familyId });

  const now = deps.now().toISOString();
  const updated = await deps.families.update(
    input.familyId,
    {
      ...(input.body.name === undefined ? {} : { name: input.body.name }),
      ...(input.body.timeZone === undefined ? {} : { timeZone: input.body.timeZone }),
    },
    now,
  );
  const members = await deps.memberships.listByFamily(input.familyId);
  const snapshot = await entitlementsForFamily(input.familyId, deps);

  return { family: toFamily(updated, members, snapshot.tier) };
}

// ---------------------------------------------------------------------------
// GET /v1/families/{familyId}/members
// ---------------------------------------------------------------------------

export async function listFamilyMembers(
  input: {
    readonly auth: AuthContext;
    readonly familyId: FamilyId;
    readonly query: ListFamilyMembersQuery;
  },
  deps: FamilyServiceDependencies,
): Promise<ListFamilyMembersResponse> {
  await deps.checker.assertCanMutateFamily({
    auth: input.auth,
    familyId: input.familyId,
    minimumRole: 'MEMBER',
  });

  const rows = await deps.memberships.listByFamily(input.familyId);
  const members: FamilyMember[] = rows
    .filter((row) => {
      if (input.query.includeRemoved) {
        return true;
      }
      return row.status === input.query.status;
    })
    .map((row) => toFamilyMember(row, input.auth.userId));

  return { familyId: input.familyId, members };
}

// ---------------------------------------------------------------------------
// PATCH /v1/families/{familyId}/members/{userId}
// ---------------------------------------------------------------------------

export async function updateFamilyMember(
  input: {
    readonly auth: AuthContext;
    readonly familyId: FamilyId;
    readonly targetUserId: UserId;
    readonly body: UpdateFamilyMemberRequest;
  },
  deps: FamilyServiceDependencies,
): Promise<UpdateFamilyMemberResponse> {
  await deps.checker.assertCanManageMember({
    auth: input.auth,
    familyId: input.familyId,
    targetUserId: input.targetUserId,
  });

  const actorRow = await deps.memberships.get(input.familyId, input.auth.userId);
  const targetRow = await deps.memberships.get(input.familyId, input.targetUserId);
  if (actorRow === null || targetRow === null) {
    throw opaqueAuthorizationError(input.auth.requestId);
  }

  if (input.body.role !== undefined) {
    assertCanChangeRole({
      actor: summaryOf(actorRow),
      target: summaryOf(targetRow),
      nextRole: input.body.role,
      requestId: input.auth.requestId,
    });
  }
  if (input.body.status !== undefined && targetRow.role === 'OWNER') {
    throw new AppError('CONFLICT', 'The family owner cannot be blocked or suspended.');
  }

  const now = deps.now().toISOString();
  const updated = await deps.memberships.patch(
    input.familyId,
    input.targetUserId,
    {
      ...(input.body.role === undefined ? {} : { role: input.body.role }),
      ...(input.body.status === undefined ? {} : { status: input.body.status }),
      ...(input.body.displayName === undefined ? {} : { displayName: input.body.displayName }),
    },
    now,
  );

  if (input.body.role !== undefined) {
    await writeAudit(deps, {
      action: 'MEMBER_ROLE_CHANGED',
      auth: input.auth,
      targetUserId: input.targetUserId,
      familyId: input.familyId,
      occurredAt: now,
      metadata: { role: input.body.role, previousRole: targetRow.role },
    });
    await deps.events.publish({
      kind: 'MEMBER_ROLE_CHANGED',
      familyId: input.familyId,
      userId: input.targetUserId,
      actorUserId: input.auth.userId,
      role: input.body.role,
      occurredAt: now,
    });
  }

  return { member: toFamilyMember(updated, input.auth.userId) };
}

// ---------------------------------------------------------------------------
// DELETE /v1/families/{familyId}/members/{userId}
// ---------------------------------------------------------------------------

export async function removeFamilyMember(
  input: {
    readonly auth: AuthContext;
    readonly familyId: FamilyId;
    readonly targetUserId: UserId;
    readonly deleteHistory: boolean;
  },
  deps: FamilyServiceDependencies,
): Promise<RemoveFamilyMemberResponse> {
  await deps.checker.assertCanManageMember({
    auth: input.auth,
    familyId: input.familyId,
    targetUserId: input.targetUserId,
  });

  const actorRow = await deps.memberships.get(input.familyId, input.auth.userId);
  const targetRow = await deps.memberships.get(input.familyId, input.targetUserId);
  if (actorRow === null || targetRow === null) {
    throw opaqueAuthorizationError(input.auth.requestId);
  }

  const plan = planRemoval({
    actor: summaryOf(actorRow),
    target: summaryOf(targetRow),
    requestId: input.auth.requestId,
  });

  const now = deps.now().toISOString();
  await deps.memberships.revoke({
    familyId: input.familyId,
    userId: input.targetUserId,
    status: plan.resultingStatus,
    at: now,
  });

  await writeAudit(deps, {
    action: 'MEMBER_REMOVED',
    auth: input.auth,
    targetUserId: input.targetUserId,
    familyId: input.familyId,
    occurredAt: now,
    metadata: { status: plan.resultingStatus, selfInitiated: plan.selfInitiated },
  });

  // Published after the row is durable: clients act on this by dropping cached
  // positions, and announcing a removal that did not happen would be worse than
  // announcing it late.
  await deps.events.publish({
    kind: 'MEMBERSHIP_ENDED',
    familyId: input.familyId,
    userId: input.targetUserId,
    actorUserId: input.auth.userId,
    status: plan.resultingStatus,
    occurredAt: now,
    purgeCachedLocations: true,
    deleteHistory: input.deleteHistory,
  });

  deps.logger.info('membership ended', {
    familyId: input.familyId,
    actorUserId: input.auth.userId,
    targetUserId: input.targetUserId,
    status: plan.resultingStatus,
  });

  return {
    familyId: input.familyId,
    userId: input.targetUserId,
    status: plan.resultingStatus,
    removedAt: now,
    // Erasure is asynchronous; the event above carries the instruction. This
    // reports that deletion was requested and scheduled, not that bytes are gone.
    historyDeleted: input.deleteHistory,
  };
}

// ---------------------------------------------------------------------------
// POST /v1/families/{familyId}/members/{userId}/transfer-ownership
// ---------------------------------------------------------------------------

export async function transferFamilyOwnership(
  input: {
    readonly auth: AuthContext;
    readonly familyId: FamilyId;
    readonly targetUserId: UserId;
  },
  deps: FamilyServiceDependencies,
): Promise<TransferFamilyOwnershipResponse> {
  await deps.checker.assertCanManageMember({
    auth: input.auth,
    familyId: input.familyId,
    targetUserId: input.targetUserId,
    minimumRole: 'OWNER',
  });

  const actorRow = await deps.memberships.get(input.familyId, input.auth.userId);
  const targetRow = await deps.memberships.get(input.familyId, input.targetUserId);
  if (actorRow === null || targetRow === null) {
    throw opaqueAuthorizationError(input.auth.requestId);
  }

  const plan = planOwnershipTransfer({
    actor: summaryOf(actorRow),
    target: summaryOf(targetRow),
    requestId: input.auth.requestId,
  });

  const now = deps.now().toISOString();
  await deps.families.transferOwnership({
    familyId: input.familyId,
    previousOwnerUserId: plan.previousOwnerUserId,
    newOwnerUserId: plan.newOwnerUserId,
    previousOwnerRole: plan.previousOwnerRole,
    at: now,
  });

  await writeAudit(deps, {
    action: 'MEMBER_ROLE_CHANGED',
    auth: input.auth,
    targetUserId: plan.newOwnerUserId,
    familyId: input.familyId,
    occurredAt: now,
    metadata: { role: 'OWNER', previousRole: targetRow.role, ownershipTransferred: true },
  });
  await deps.events.publish({
    kind: 'OWNERSHIP_TRANSFERRED',
    familyId: input.familyId,
    previousOwnerUserId: plan.previousOwnerUserId,
    newOwnerUserId: plan.newOwnerUserId,
    occurredAt: now,
  });

  return {
    familyId: input.familyId,
    previousOwnerUserId: plan.previousOwnerUserId,
    newOwnerUserId: plan.newOwnerUserId,
    transferredAt: now,
  };
}

// ---------------------------------------------------------------------------
// POST /v1/support/blocks
// ---------------------------------------------------------------------------

async function sharedFamilyRows(
  userId: UserId,
  otherUserId: UserId,
  deps: FamilyServiceDependencies,
): Promise<Array<{ mine: MembershipRow; theirs: MembershipRow }>> {
  const mine = (await deps.memberships.listByUser(userId)).filter((row) => row.status === 'ACTIVE');
  const pairs: Array<{ mine: MembershipRow; theirs: MembershipRow }> = [];
  for (const row of mine) {
    const theirs = await deps.memberships.get(row.familyId, otherUserId);
    if (theirs !== null && theirs.status === 'ACTIVE') {
      pairs.push({ mine: row, theirs });
    }
  }
  return pairs;
}

export async function blockUser(
  input: { readonly auth: AuthContext; readonly body: BlockUserRequest },
  deps: FamilyServiceDependencies,
): Promise<BlockUserResponse> {
  await requireActiveAccount(input.auth, deps);

  if (input.body.blockedUserId === input.auth.userId) {
    throw new AppError('VALIDATION_FAILED', 'The request could not be validated.', [
      { path: 'blockedUserId', message: 'This value is not valid.' },
    ]);
  }

  const now = deps.now().toISOString();
  const pairs = await sharedFamilyRows(input.auth.userId, input.body.blockedUserId, deps);
  const familyIds: FamilyId[] = [];
  let removedAnywhere = false;

  for (const pair of pairs) {
    familyIds.push(pair.mine.familyId);

    // Symmetric by construction: one call writes both deny-lists, so a block can
    // never leave one party still able to see the other.
    await deps.memberships.setMutuallyHidden({
      familyId: pair.mine.familyId,
      userId: input.auth.userId,
      otherUserId: input.body.blockedUserId,
      hidden: true,
      at: now,
    });

    if (!input.body.removeFromSharedFamilies) {
      continue;
    }

    const canRemoveOther =
      canManageMembers(pair.mine.role) &&
      pair.theirs.role !== 'OWNER' &&
      FAMILY_ROLE_RANK[pair.mine.role] > FAMILY_ROLE_RANK[pair.theirs.role];

    if (canRemoveOther) {
      await deps.memberships.revoke({
        familyId: pair.mine.familyId,
        userId: input.body.blockedUserId,
        status: 'REMOVED',
        at: now,
      });
      removedAnywhere = true;
      await deps.events.publish({
        kind: 'MEMBERSHIP_ENDED',
        familyId: pair.mine.familyId,
        userId: input.body.blockedUserId,
        actorUserId: input.auth.userId,
        status: 'REMOVED',
        occurredAt: now,
        purgeCachedLocations: true,
        deleteHistory: false,
      });
    } else if (pair.mine.role !== 'OWNER') {
      // Cannot remove them, so leave instead — the fast exit a person needs when
      // the other party is the one with authority.
      await deps.memberships.revoke({
        familyId: pair.mine.familyId,
        userId: input.auth.userId,
        status: 'LEFT',
        at: now,
      });
      removedAnywhere = true;
      await deps.events.publish({
        kind: 'MEMBERSHIP_ENDED',
        familyId: pair.mine.familyId,
        userId: input.auth.userId,
        actorUserId: input.auth.userId,
        status: 'LEFT',
        occurredAt: now,
        purgeCachedLocations: true,
        deleteHistory: false,
      });
    }
    // An owner who cannot remove the other keeps the family; the block stands.
  }

  await writeAudit(deps, {
    action: 'USER_BLOCKED',
    auth: input.auth,
    targetUserId: input.body.blockedUserId,
    familyId: null,
    occurredAt: now,
    metadata: { familyCount: familyIds.length, removedFromSharedFamilies: removedAnywhere },
  });
  await deps.events.publish({
    kind: 'USER_BLOCKED',
    actorUserId: input.auth.userId,
    blockedUserId: input.body.blockedUserId,
    familyIds,
    occurredAt: now,
    purgeCachedLocations: true,
  });

  return {
    block: {
      blockedUserId: input.body.blockedUserId,
      blockedAt: now,
      removedFromSharedFamilies: removedAnywhere,
    },
  };
}

export async function unblockUser(
  input: { readonly auth: AuthContext; readonly blockedUserId: UserId },
  deps: FamilyServiceDependencies,
): Promise<UnblockUserResponse> {
  await requireActiveAccount(input.auth, deps);

  const now = deps.now().toISOString();
  for (const pair of await sharedFamilyRows(input.auth.userId, input.blockedUserId, deps)) {
    await deps.memberships.setMutuallyHidden({
      familyId: pair.mine.familyId,
      userId: input.auth.userId,
      otherUserId: input.blockedUserId,
      hidden: false,
      at: now,
    });
  }

  return { blockedUserId: input.blockedUserId, unblockedAt: now };
}

// ---------------------------------------------------------------------------
// POST /v1/support/reports
// ---------------------------------------------------------------------------

export async function reportAbuse(
  input: { readonly auth: AuthContext; readonly body: ReportAbuseRequest },
  deps: FamilyServiceDependencies,
): Promise<ReportAbuseResponse> {
  await requireActiveAccount(input.auth, deps);

  const now = deps.now().toISOString();
  const reportId = deps.newId();

  // Recorded first: the report must survive even if the follow-on actions fail.
  await writeAudit(deps, {
    action: 'ABUSE_REPORTED',
    auth: input.auth,
    targetUserId: input.body.reportedUserId,
    familyId: input.body.familyId,
    occurredAt: now,
    metadata: {
      reportId,
      category: input.body.category,
      blockRequested: input.body.blockImmediately,
      leaveRequested: input.body.leaveFamily,
    },
  });

  let blocked = false;
  if (input.body.blockImmediately && input.body.reportedUserId !== input.auth.userId) {
    await blockUser(
      {
        auth: input.auth,
        body: { blockedUserId: input.body.reportedUserId, removeFromSharedFamilies: false },
      },
      deps,
    );
    blocked = true;
  }

  let leftFamily = false;
  const familyId = input.body.familyId;
  if (input.body.leaveFamily && familyId !== null) {
    const own = await deps.memberships.get(familyId, input.auth.userId);
    if (own !== null && own.status === 'ACTIVE' && own.role !== 'OWNER') {
      await deps.memberships.revoke({
        familyId,
        userId: input.auth.userId,
        status: 'LEFT',
        at: now,
      });
      await deps.events.publish({
        kind: 'MEMBERSHIP_ENDED',
        familyId,
        userId: input.auth.userId,
        actorUserId: input.auth.userId,
        status: 'LEFT',
        occurredAt: now,
        purgeCachedLocations: true,
        deleteHistory: false,
      });
      leftFamily = true;
    }
  }

  await deps.events.publish({
    kind: 'ABUSE_REPORTED',
    reportId,
    reporterUserId: input.auth.userId,
    familyId,
    category: input.body.category,
    occurredAt: now,
  });

  deps.logger.info('abuse reported', {
    reportId,
    category: input.body.category,
    blocked,
    leftFamily,
  });

  // Deliberately says nothing about any enforcement action taken against the
  // reported account: that would let a reporter probe another user's state.
  return {
    reportId,
    submittedAt: now,
    blocked,
    leftFamily,
    safetyResourcesUrl: SAFETY_RESOURCE_CATEGORIES.includes(input.body.category)
      ? deps.safetyResourcesUrl
      : null,
  };
}
