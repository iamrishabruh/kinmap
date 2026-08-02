import {
  resolveEntitlements,
  type AuthContext,
  type AuthorizationChecker,
  type RateLimiter,
  type SubscriptionRepository,
  type UserAccountRepository,
} from '@family/auth';
import {
  AppError,
  ENTITLEMENTS,
  LIMITS,
  RATE_LIMITS,
  opaqueAuthorizationError,
  type AuditAction,
  type AuditEvent,
  type FamilyId,
  type UserId,
} from '@family/contracts';
import type { Logger } from '@family/observability';
import type {
  AcceptInvitationRequest,
  AcceptInvitationResponse,
  CreateInvitationRequest,
  CreateInvitationResponse,
  FamilyMember,
  ListInvitationsQuery,
  ListInvitationsResponse,
  PreviewInvitationResponse,
  RevokeInvitationResponse,
} from '@family/schemas';

import {
  assertInvitationQuota,
  evaluateInvitation,
  expiryWindow,
  invitationError,
  isActiveInvitation,
  toInvitation,
  type InvitationRecord,
} from './domain/invitation-rules.js';
import { buildInviteUrl, generateInvitationToken, hashInvitationToken } from './domain/token.js';
import type {
  AuditWriter,
  FamilyReader,
  InvitationStore,
  MembershipReader,
  MembershipSummary,
  NewMembership,
} from './ports.js';

/**
 * Invitation issue, preview, revocation and redemption.
 *
 * The credential is handled once, in `createInvitation`, and never again: from
 * that point on every code path deals only in hashes. Redemption is a two-step
 * flow on purpose — a preview that discloses the family and the permissions
 * being granted, then an explicit acceptance — so that following a link is never
 * the same act as joining a family and starting to be locatable.
 */

export type InvitationDependencies = {
  readonly checker: AuthorizationChecker;
  readonly accounts: UserAccountRepository;
  readonly subscriptions: SubscriptionRepository;
  readonly families: FamilyReader;
  readonly memberships: MembershipReader;
  readonly invitations: InvitationStore;
  readonly rateLimiter: RateLimiter;
  readonly audit: AuditWriter;
  readonly logger: Logger;
  readonly now: () => Date;
  readonly newId: () => string;
  readonly inviteLinkBaseUrl: string;
};

const OCCUPIES_SEAT = new Set(['ACTIVE', 'PENDING']);

async function writeAudit(
  deps: InvitationDependencies,
  input: {
    action: AuditAction;
    auth: AuthContext;
    targetUserId: UserId;
    familyId: FamilyId;
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

async function requireActiveAccount(
  auth: AuthContext,
  deps: InvitationDependencies,
): Promise<void> {
  const account = await deps.accounts.getUserAccount({ userId: auth.userId });
  if (account === null || account.status !== 'ACTIVE') {
    throw opaqueAuthorizationError(auth.requestId);
  }
}

function toFamilyMember(row: MembershipSummary, callerUserId: UserId): FamilyMember {
  return {
    userId: row.userId,
    familyId: row.familyId,
    displayName: row.displayName,
    avatarUrl: row.avatarUrl,
    role: row.role,
    status: row.status,
    sharingStatus: row.sharingStatus,
    sharingWithCaller: row.userId === callerUserId,
    deviceCount: row.deviceCount,
    lastSeenAt: row.lastSeenAt,
    joinedAt: row.joinedAt,
    invitedByUserId: row.invitedByUserId,
    updatedAt: row.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// POST /v1/families/{familyId}/invitations
// ---------------------------------------------------------------------------

export async function createInvitation(
  input: {
    readonly auth: AuthContext;
    readonly familyId: FamilyId;
    readonly body: CreateInvitationRequest;
  },
  deps: InvitationDependencies,
): Promise<CreateInvitationResponse> {
  // Only OWNER and ADMIN may invite: MUTATE_FAMILY defaults to a minimum of
  // ADMIN, and OWNER outranks it.
  await deps.checker.assertCanMutateFamily({ auth: input.auth, familyId: input.familyId });

  const now = deps.now();
  const nowIso = now.toISOString();

  // Per-family creation rate, independent of which admin is asking, so two
  // admins cannot together exceed the family's budget.
  const decision = await deps.rateLimiter.consume({
    key: `INVITATION_CREATE:family:${input.familyId}`,
    limitPerMinute: RATE_LIMITS.INVITATION_CREATE_PER_FAMILY,
    requestId: input.auth.requestId,
  });
  if (!decision.allowed) {
    throw new AppError(
      'RATE_LIMITED',
      'Too many invitations created for this family. Please try again shortly.',
      undefined,
      decision.retryAfterSeconds ?? 60,
    );
  }

  const existing = await deps.invitations.listByFamily(input.familyId, null);
  const active = existing.filter((record) => isActiveInvitation(record, now));
  assertInvitationQuota(active.length);

  // An outstanding invitation holds a seat, so a family cannot invite its way
  // past the plan limit and only discover it at acceptance time.
  const members = await deps.memberships.listByFamily(input.familyId);
  const snapshot = resolveEntitlements(
    await deps.subscriptions.getSubscriptionForFamily({ familyId: input.familyId }),
  );
  const capacity = Math.min(snapshot.entitlements.maxMembersPerFamily, LIMITS.MAX_FAMILY_MEMBERS);
  const seatsUsed =
    members.filter((member) => OCCUPIES_SEAT.has(member.status)).length + active.length;
  if (seatsUsed >= capacity) {
    throw new AppError(
      'PLAN_LIMIT_EXCEEDED',
      'This family has reached the maximum number of members for its plan.',
    );
  }

  const issued = generateInvitationToken();
  const expiry = expiryWindow(now, input.body.expiresInHours);

  const record: InvitationRecord = {
    // Only the hash is persisted. `issued.token` is used exactly twice below:
    // to build the link, and to return it. It is never stored or logged.
    tokenHash: issued.tokenHash,
    invitationId: deps.newId(),
    familyId: input.familyId,
    role: input.body.role,
    status: 'PENDING',
    label: input.body.label,
    createdByUserId: input.auth.userId,
    createdAt: nowIso,
    expiresAt: expiry.expiresAt,
    expiresAtIso: expiry.expiresAtIso,
    redemptionCount: 0,
    maxRedemptions: Math.min(input.body.maxRedemptions, LIMITS.MAX_INVITATION_REDEMPTIONS),
    acceptedByUserId: null,
    acceptedAt: null,
    revokedAt: null,
  };

  await deps.invitations.create(record);
  await writeAudit(deps, {
    action: 'INVITATION_CREATED',
    auth: input.auth,
    targetUserId: input.auth.userId,
    familyId: input.familyId,
    occurredAt: nowIso,
    metadata: {
      invitationId: record.invitationId,
      role: record.role,
      activeCount: active.length + 1,
    },
  });

  deps.logger.info('invitation created', {
    familyId: input.familyId,
    invitationId: record.invitationId,
    role: record.role,
  });

  return {
    invitation: toInvitation(record, now),
    token: issued.token,
    inviteUrl: buildInviteUrl(deps.inviteLinkBaseUrl, issued.token),
  };
}

// ---------------------------------------------------------------------------
// GET /v1/families/{familyId}/invitations
// ---------------------------------------------------------------------------

export async function listInvitations(
  input: {
    readonly auth: AuthContext;
    readonly familyId: FamilyId;
    readonly query: ListInvitationsQuery;
  },
  deps: InvitationDependencies,
): Promise<ListInvitationsResponse> {
  await deps.checker.assertCanMutateFamily({ auth: input.auth, familyId: input.familyId });

  const now = deps.now();
  const records = await deps.invitations.listByFamily(input.familyId, null);
  const projected = records.map((record) => toInvitation(record, now));

  return {
    familyId: input.familyId,
    invitations: projected.filter((invitation) => invitation.status === input.query.status),
    activeCount: records.filter((record) => isActiveInvitation(record, now)).length,
    maxActive: LIMITS.MAX_ACTIVE_INVITATIONS_PER_FAMILY,
  };
}

// ---------------------------------------------------------------------------
// DELETE /v1/families/{familyId}/invitations/{invitationId}
// ---------------------------------------------------------------------------

export async function revokeInvitation(
  input: {
    readonly auth: AuthContext;
    readonly familyId: FamilyId;
    readonly invitationId: string;
  },
  deps: InvitationDependencies,
): Promise<RevokeInvitationResponse> {
  await deps.checker.assertCanMutateFamily({ auth: input.auth, familyId: input.familyId });

  const at = deps.now().toISOString();
  const revoked = await deps.invitations.revoke({
    familyId: input.familyId,
    invitationId: input.invitationId,
    at,
  });
  if (revoked === null) {
    throw new AppError('NOT_FOUND', 'The requested resource does not exist.');
  }

  await writeAudit(deps, {
    action: 'INVITATION_REVOKED',
    auth: input.auth,
    targetUserId: input.auth.userId,
    familyId: input.familyId,
    occurredAt: at,
    metadata: { invitationId: input.invitationId },
  });

  return {
    invitationId: input.invitationId,
    familyId: input.familyId,
    status: 'REVOKED',
    revokedAt: at,
  };
}

// ---------------------------------------------------------------------------
// GET /v1/invitations/{token}
// ---------------------------------------------------------------------------

/**
 * Resolves a presented token to a usable invitation.
 *
 * The raw token exists only as this function's parameter. Everything downstream
 * receives the record.
 */
async function resolvePresentedToken(
  token: string,
  deps: InvitationDependencies,
): Promise<InvitationRecord> {
  const presentedTokenHash = hashInvitationToken(token);
  const record = await deps.invitations.findByTokenHash(presentedTokenHash);
  const evaluation = evaluateInvitation({ record, presentedTokenHash, now: deps.now() });
  if (!evaluation.usable) {
    throw invitationError(evaluation.code);
  }
  return evaluation.record;
}

export async function previewInvitation(
  input: { readonly auth: AuthContext; readonly token: string },
  deps: InvitationDependencies,
): Promise<PreviewInvitationResponse> {
  // An authenticated recipient is required even to look: an anonymous preview
  // endpoint would let anyone who scraped a link enumerate family names.
  await requireActiveAccount(input.auth, deps);

  const record = await resolvePresentedToken(input.token, deps);
  const family = await deps.families.get(record.familyId);
  if (family === null) {
    throw invitationError('INVITATION_INVALID');
  }

  const members = await deps.memberships.listByFamily(record.familyId);
  const inviter = members.find((member) => member.userId === record.createdByUserId);

  // Deliberately minimal: the family's name, who invited you, the role you would
  // be granted and when the link dies. No member list, no emails, no locations.
  return {
    familyName: family.name,
    invitedByDisplayName: inviter?.displayName ?? 'A family member',
    role: record.role,
    expiresAt: record.expiresAtIso,
    memberCount: members.filter((member) => member.status === 'ACTIVE').length,
  };
}

// ---------------------------------------------------------------------------
// POST /v1/invitations/{token}/accept
// ---------------------------------------------------------------------------

export async function acceptInvitation(
  input: {
    readonly auth: AuthContext;
    readonly token: string;
    readonly body: AcceptInvitationRequest;
  },
  deps: InvitationDependencies,
): Promise<AcceptInvitationResponse> {
  await requireActiveAccount(input.auth, deps);

  const now = deps.now();
  const acceptedAt = now.toISOString();
  const record = await resolvePresentedToken(input.token, deps);

  const family = await deps.families.get(record.familyId);
  if (family === null) {
    throw invitationError('INVITATION_INVALID');
  }

  const existing = await deps.memberships.get(record.familyId, input.auth.userId);
  if (existing !== null && existing.status === 'ACTIVE') {
    throw new AppError('CONFLICT', 'You are already a member of this family.');
  }

  const members = await deps.memberships.listByFamily(record.familyId);
  const snapshot = resolveEntitlements(
    await deps.subscriptions.getSubscriptionForFamily({ familyId: record.familyId }),
  );
  const capacity = Math.min(
    snapshot.entitlements.maxMembersPerFamily || ENTITLEMENTS.FREE.maxMembersPerFamily,
    LIMITS.MAX_FAMILY_MEMBERS,
  );
  if (members.filter((member) => OCCUPIES_SEAT.has(member.status)).length >= capacity) {
    throw new AppError(
      'PLAN_LIMIT_EXCEEDED',
      'This family has reached the maximum number of members for its plan.',
    );
  }

  const membership: NewMembership = {
    familyId: record.familyId,
    userId: input.auth.userId,
    role: record.role,
    status: 'ACTIVE',
    // Joining a family does not start sharing. The member opts in explicitly.
    sharingStatus: input.body.startSharingImmediately ? 'SHARING' : 'NEVER_ENABLED',
    displayName: input.body.displayName ?? 'Member',
    invitedByUserId: record.createdByUserId,
    joinedAt: acceptedAt,
    acceptedTermsVersion: input.body.acceptedTermsVersion,
  };

  // The membership and the consumption of the token happen in ONE transaction,
  // conditional on the token still being unconsumed. Two devices tapping the
  // same link at the same moment therefore yield exactly one membership.
  const outcome = await deps.invitations.redeem({
    tokenHash: record.tokenHash,
    membership,
    acceptedByUserId: input.auth.userId,
    acceptedAt,
    nowEpochSeconds: Math.floor(now.getTime() / 1000),
  });

  if (outcome.kind === 'ALREADY_CONSUMED') {
    throw invitationError('INVITATION_ALREADY_USED');
  }
  if (outcome.kind === 'ALREADY_MEMBER') {
    throw new AppError('CONFLICT', 'You are already a member of this family.');
  }

  await writeAudit(deps, {
    action: 'INVITATION_ACCEPTED',
    auth: input.auth,
    targetUserId: input.auth.userId,
    familyId: record.familyId,
    occurredAt: acceptedAt,
    metadata: {
      invitationId: record.invitationId,
      role: record.role,
      startedSharing: input.body.startSharingImmediately,
    },
  });

  deps.logger.info('invitation accepted', {
    familyId: record.familyId,
    invitationId: record.invitationId,
    role: record.role,
  });

  return {
    familyId: record.familyId,
    familyName: family.name,
    membership: toFamilyMember(outcome.membership, input.auth.userId),
    acceptedAt,
  };
}
