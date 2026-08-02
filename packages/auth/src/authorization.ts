import {
  type AppError,
  FAMILY_ROLE_RANK,
  FamilyIdSchema,
  LIMITS,
  RATE_LIMITS,
  UserIdSchema,
  opaqueAuthorizationError,
  type DeviceId,
  type Entitlements,
  type FamilyId,
  type FamilyRole,
  type MembershipStatus,
  type PlanTier,
  type UserId,
} from '@family/contracts';

import { resolveEntitlements } from './entitlements.js';
import { evaluateHistoryRange, type HistoryRange } from './history-range.js';
import type {
  AuthorizationAuditEntry,
  AuthorizationAuditSink,
  DeviceRepository,
  FamilyMembershipRepository,
  RateLimiter,
  SubscriptionRepository,
  UserAccountRepository,
} from './repositories.js';
import type { AuthContext, EntitlementSnapshot, FamilyMembershipRecord } from './types.js';

/**
 * The §18 authorization checklist, in order, for every sensitive operation.
 *
 * Ordering is load-bearing. Cheap identity checks run before repository reads,
 * the requester's own membership is established before anything about the
 * *target* is fetched, and the rate limiter is consumed last so a request that
 * was going to be denied anyway does not burn a legitimate user's quota.
 *
 * Every failure — including "no such family", "target paused sharing" and "rate
 * limited" — leaves through {@link opaqueAuthorizationError}. The specific cause
 * is written to the audit sink for operators and is never returned, so a stalker
 * cannot use response differences to learn whether a person exists, is in a
 * family, or has merely paused sharing (spec §34).
 */

export type AuthorizationOperation =
  | 'READ_CURRENT_LOCATION'
  | 'READ_HISTORY'
  | 'START_LIVE_SESSION'
  | 'MUTATE_FAMILY'
  | 'MANAGE_MEMBER';

/** Server-side only. Recorded in the audit trail; never serialised to a caller. */
export type DenialReason =
  | 'MALFORMED_PRINCIPAL'
  | 'MALFORMED_REQUEST'
  | 'REQUESTER_ACCOUNT_MISSING'
  | 'REQUESTER_ACCOUNT_INACTIVE'
  | 'REQUESTER_DEVICE_MISSING'
  | 'REQUESTER_DEVICE_NOT_REGISTERED'
  | 'REQUESTER_DEVICE_NOT_ACTIVE'
  | 'REQUESTER_NOT_A_MEMBER'
  | 'REQUESTER_MEMBERSHIP_INACTIVE'
  | 'REQUESTER_ROLE_INSUFFICIENT'
  | 'TARGET_NOT_A_MEMBER'
  | 'TARGET_MEMBERSHIP_INACTIVE'
  | 'TARGET_SHARING_DISABLED'
  | 'TARGET_VISIBILITY_EXCLUDES_REQUESTER'
  | 'TARGET_OUTRANKS_REQUESTER'
  | 'ENTITLEMENT_REQUIRED'
  | 'DATE_RANGE_INVALID'
  | 'RATE_LIMITED';

export type AuthorizationGrant = {
  operation: AuthorizationOperation;
  requestId: string;
  familyId: FamilyId;
  requesterUserId: UserId;
  requesterDeviceId: DeviceId | null;
  requesterMembership: FamilyMembershipRecord;
  targetUserId: UserId | null;
  targetMembership: FamilyMembershipRecord | null;
  tier: PlanTier;
  entitlements: Entitlements;
};

export type HistoryAuthorizationGrant = AuthorizationGrant & {
  /** Clamped to what the plan actually retains. Query with this, not the request. */
  effectiveRange: HistoryRange;
  retentionDays: number;
};

export type LiveSessionAuthorizationGrant = AuthorizationGrant & {
  /** Clamped to the platform ceiling; the session service still enforces expiry. */
  maxDurationSeconds: number;
};

export type ReadCurrentLocationRequest = {
  auth: AuthContext;
  familyId: FamilyId;
  targetUserId: UserId;
};

export type ReadHistoryRequest = ReadCurrentLocationRequest & {
  range: HistoryRange;
};

export type StartLiveSessionRequest = ReadCurrentLocationRequest & {
  requestedDurationSeconds?: number;
};

export type MutateFamilyRequest = {
  auth: AuthContext;
  familyId: FamilyId;
  /** Raise to OWNER for destructive operations such as deleting the family. */
  minimumRole?: FamilyRole;
};

export type ManageMemberRequest = {
  auth: AuthContext;
  familyId: FamilyId;
  targetUserId: UserId;
  minimumRole?: FamilyRole;
};

export interface AuthorizationChecker {
  assertCanReadCurrentLocation(request: ReadCurrentLocationRequest): Promise<AuthorizationGrant>;
  assertCanReadHistory(request: ReadHistoryRequest): Promise<HistoryAuthorizationGrant>;
  assertCanStartLiveSession(
    request: StartLiveSessionRequest,
  ): Promise<LiveSessionAuthorizationGrant>;
  assertCanMutateFamily(request: MutateFamilyRequest): Promise<AuthorizationGrant>;
  assertCanManageMember(request: ManageMemberRequest): Promise<AuthorizationGrant>;
}

export type AuthorizationDeps = {
  accounts: UserAccountRepository;
  devices: DeviceRepository;
  memberships: FamilyMembershipRepository;
  subscriptions: SubscriptionRepository;
  rateLimiter: RateLimiter;
  /**
   * Optional. An audit write that fails on an *allowed* decision fails the
   * request: a sensitive read that cannot be recorded must not happen (spec
   * §18). A failed write on a denial is swallowed — the denial already stands.
   */
  auditSink?: AuthorizationAuditSink;
  now?: () => Date;
  /**
   * Per-operation override of the registered-device requirement. Defaults to
   * requiring one everywhere, so a stolen token alone is not enough to read a
   * family member's location.
   */
  deviceRequirements?: Partial<Record<AuthorizationOperation, boolean>>;
};

const DEFAULT_DEVICE_REQUIREMENTS: Record<AuthorizationOperation, boolean> = {
  READ_CURRENT_LOCATION: true,
  READ_HISTORY: true,
  START_LIVE_SESSION: true,
  MUTATE_FAMILY: true,
  MANAGE_MEMBER: true,
};

/** Only an ACTIVE membership grants any access at all. */
const ACTIVE_ONLY: readonly MembershipStatus[] = ['ACTIVE'];
/** An admin may still act on someone whose invitation is still outstanding. */
const ACTIVE_OR_PENDING: readonly MembershipStatus[] = ['ACTIVE', 'PENDING'];

type OperationPolicy = {
  operation: AuthorizationOperation;
  requiresTarget: boolean;
  allowedTargetStatuses: readonly MembershipStatus[];
  /** Reads require the target's consent switch to be on; management does not. */
  requireTargetSharing: boolean;
  requireTargetVisibility: boolean;
  /** Reading your own record is always permitted to you. */
  allowSelfTarget: boolean;
  /** Management operations additionally require the requester to outrank the target. */
  requireRankOverTarget: boolean;
  defaultMinimumRole: FamilyRole | null;
  entitlement: ((entitlements: Entitlements) => boolean) | null;
  rateLimitPerMinute: number;
};

const POLICIES: Record<AuthorizationOperation, OperationPolicy> = {
  READ_CURRENT_LOCATION: {
    operation: 'READ_CURRENT_LOCATION',
    requiresTarget: true,
    allowedTargetStatuses: ACTIVE_ONLY,
    requireTargetSharing: true,
    requireTargetVisibility: true,
    allowSelfTarget: true,
    requireRankOverTarget: false,
    defaultMinimumRole: null,
    entitlement: null,
    rateLimitPerMinute: RATE_LIMITS.CURRENT_LOCATION_PER_USER,
  },
  READ_HISTORY: {
    operation: 'READ_HISTORY',
    requiresTarget: true,
    allowedTargetStatuses: ACTIVE_ONLY,
    requireTargetSharing: true,
    requireTargetVisibility: true,
    allowSelfTarget: true,
    requireRankOverTarget: false,
    defaultMinimumRole: null,
    entitlement: (entitlements) => entitlements.historyRetentionDays > 0,
    rateLimitPerMinute: RATE_LIMITS.HISTORY_READ_PER_USER,
  },
  START_LIVE_SESSION: {
    operation: 'START_LIVE_SESSION',
    requiresTarget: true,
    allowedTargetStatuses: ACTIVE_ONLY,
    requireTargetSharing: true,
    requireTargetVisibility: true,
    // A live session on yourself would burn the single per-target slot.
    allowSelfTarget: false,
    requireRankOverTarget: false,
    defaultMinimumRole: null,
    entitlement: (entitlements) => entitlements.liveSessionsEnabled,
    rateLimitPerMinute: RATE_LIMITS.LIVE_SESSION_CREATE_PER_USER,
  },
  MUTATE_FAMILY: {
    operation: 'MUTATE_FAMILY',
    requiresTarget: false,
    allowedTargetStatuses: ACTIVE_ONLY,
    requireTargetSharing: false,
    requireTargetVisibility: false,
    allowSelfTarget: false,
    requireRankOverTarget: false,
    defaultMinimumRole: 'ADMIN',
    entitlement: null,
    rateLimitPerMinute: RATE_LIMITS.ACCOUNT_MUTATION_PER_USER,
  },
  MANAGE_MEMBER: {
    operation: 'MANAGE_MEMBER',
    requiresTarget: true,
    allowedTargetStatuses: ACTIVE_OR_PENDING,
    requireTargetSharing: false,
    requireTargetVisibility: false,
    // Self-target is how a member leaves a family without holding a role.
    allowSelfTarget: true,
    requireRankOverTarget: true,
    defaultMinimumRole: 'ADMIN',
    entitlement: null,
    rateLimitPerMinute: RATE_LIMITS.ACCOUNT_MUTATION_PER_USER,
  },
};

/** Normalised shape the pipeline works on; public request types widen into it. */
type PipelineRequest = {
  auth: AuthContext;
  familyId: FamilyId;
  targetUserId?: UserId;
  minimumRole?: FamilyRole;
  range?: HistoryRange;
};

type AuthorizationOutcome = AuthorizationGrant & {
  retentionDays: number;
  effectiveRange: HistoryRange | null;
};

export function buildAuthorizationChecker(deps: AuthorizationDeps): AuthorizationChecker {
  const now = deps.now ?? ((): Date => new Date());

  async function audit(
    policy: OperationPolicy,
    request: PipelineRequest,
    decision: 'ALLOWED' | 'DENIED',
    reason: DenialReason | null,
  ): Promise<void> {
    const sink: AuthorizationAuditSink | undefined = deps.auditSink;
    if (sink === undefined) {
      return;
    }
    const entry: AuthorizationAuditEntry = {
      operation: policy.operation,
      decision,
      reason,
      actorUserId: request.auth.userId,
      targetUserId: request.targetUserId ?? null,
      familyId: request.familyId,
      deviceId: request.auth.deviceId,
      requestId: request.auth.requestId,
      occurredAt: now().toISOString(),
    };
    if (decision === 'DENIED') {
      try {
        await sink.record(entry);
      } catch {
        // The denial is the safe outcome; a failed write must never reverse it.
      }
      return;
    }
    // An allowed sensitive read that cannot be recorded must not proceed.
    await sink.record(entry);
  }

  /**
   * Produces the single denial every caller sees. The reason is recorded, then
   * discarded: the returned error is byte-for-byte identical in all cases.
   */
  async function deny(
    policy: OperationPolicy,
    request: PipelineRequest,
    reason: DenialReason,
  ): Promise<AppError> {
    await audit(policy, request, 'DENIED', reason);
    return opaqueAuthorizationError(request.auth.requestId);
  }

  async function authorize(
    policy: OperationPolicy,
    request: PipelineRequest,
  ): Promise<AuthorizationOutcome> {
    // --- 1. Authenticated requester -------------------------------------
    if (!isWellFormedPrincipal(request.auth)) {
      // No verified actor id exists, so there is nothing trustworthy to audit.
      throw opaqueAuthorizationError(safeRequestId(request.auth));
    }
    if (!FamilyIdSchema.safeParse(request.familyId).success) {
      throw await deny(policy, request, 'MALFORMED_REQUEST');
    }
    if (policy.requiresTarget && !UserIdSchema.safeParse(request.targetUserId).success) {
      throw await deny(policy, request, 'MALFORMED_REQUEST');
    }

    const requesterUserId = request.auth.userId;
    const targetUserId: UserId | null = policy.requiresTarget
      ? (request.targetUserId as UserId)
      : null;
    const isSelfTarget = targetUserId !== null && targetUserId === requesterUserId;
    if (isSelfTarget && !policy.allowSelfTarget) {
      throw await deny(policy, request, 'MALFORMED_REQUEST');
    }

    // --- 2. Active requester account ------------------------------------
    const account = await deps.accounts.getUserAccount({ userId: requesterUserId });
    if (account === null) {
      throw await deny(policy, request, 'REQUESTER_ACCOUNT_MISSING');
    }
    if (account.status !== 'ACTIVE') {
      // SUSPENDED, PENDING_DELETION and DELETED all stop here.
      throw await deny(policy, request, 'REQUESTER_ACCOUNT_INACTIVE');
    }

    // --- 3. Registered, active requester device (where required) ---------
    const deviceRequired =
      deps.deviceRequirements?.[policy.operation] ?? DEFAULT_DEVICE_REQUIREMENTS[policy.operation];
    if (deviceRequired) {
      const deviceId = request.auth.deviceId;
      if (deviceId === null) {
        throw await deny(policy, request, 'REQUESTER_DEVICE_MISSING');
      }
      const device = await deps.devices.getDevice({ userId: requesterUserId, deviceId });
      if (device === null || device.userId !== requesterUserId) {
        throw await deny(policy, request, 'REQUESTER_DEVICE_NOT_REGISTERED');
      }
      if (device.status !== 'ACTIVE') {
        throw await deny(policy, request, 'REQUESTER_DEVICE_NOT_ACTIVE');
      }
    }

    // --- 4. Shared ACTIVE family membership for the requester ------------
    const requesterMembership = await deps.memberships.getMembership({
      familyId: request.familyId,
      userId: requesterUserId,
    });
    if (requesterMembership === null) {
      throw await deny(policy, request, 'REQUESTER_NOT_A_MEMBER');
    }
    if (requesterMembership.status !== 'ACTIVE') {
      // REMOVED, LEFT, BLOCKED and still-PENDING all land here: access ends the
      // moment the row stops being ACTIVE, with no cache to wait out.
      throw await deny(policy, request, 'REQUESTER_MEMBERSHIP_INACTIVE');
    }

    const minimumRole = request.minimumRole ?? policy.defaultMinimumRole;
    const requesterRank = FAMILY_ROLE_RANK[requesterMembership.role];
    if (minimumRole !== null && !isSelfTarget && requesterRank < FAMILY_ROLE_RANK[minimumRole]) {
      throw await deny(policy, request, 'REQUESTER_ROLE_INSUFFICIENT');
    }

    // --- 5. Target is a member of the same family, in an allowed state ---
    let targetMembership: FamilyMembershipRecord | null = null;
    if (targetUserId !== null) {
      targetMembership = isSelfTarget
        ? requesterMembership
        : await deps.memberships.getMembership({
            familyId: request.familyId,
            userId: targetUserId,
          });
      if (targetMembership === null || targetMembership.userId !== targetUserId) {
        throw await deny(policy, request, 'TARGET_NOT_A_MEMBER');
      }
      if (!policy.allowedTargetStatuses.includes(targetMembership.status)) {
        throw await deny(policy, request, 'TARGET_MEMBERSHIP_INACTIVE');
      }
      if (
        policy.requireRankOverTarget &&
        !isSelfTarget &&
        // Strictly greater: an ADMIN may not act on another ADMIN or the OWNER.
        requesterRank <= FAMILY_ROLE_RANK[targetMembership.role]
      ) {
        throw await deny(policy, request, 'TARGET_OUTRANKS_REQUESTER');
      }
    }

    // --- 6. Target is currently sharing ----------------------------------
    if (targetMembership !== null && policy.requireTargetSharing && !isSelfTarget) {
      if (targetMembership.sharingStatus !== 'SHARING') {
        // PAUSED, DISABLED, PERMISSION_BLOCKED and NEVER_ENABLED are one answer.
        throw await deny(policy, request, 'TARGET_SHARING_DISABLED');
      }
    }

    // --- 7. Requester allowed by the target's per-member visibility -------
    if (targetMembership !== null && policy.requireTargetVisibility && !isSelfTarget) {
      if (!isVisibleTo(targetMembership, requesterUserId)) {
        throw await deny(policy, request, 'TARGET_VISIBILITY_EXCLUDES_REQUESTER');
      }
    }

    // --- 8. Feature allowed by the family's subscription ------------------
    const subscription = await deps.subscriptions.getSubscriptionForFamily({
      familyId: request.familyId,
    });
    const snapshot: EntitlementSnapshot = resolveEntitlements(subscription);
    if (policy.entitlement !== null && !policy.entitlement(snapshot.entitlements)) {
      throw await deny(policy, request, 'ENTITLEMENT_REQUIRED');
    }

    // --- 9. Date range within platform limits and plan retention ----------
    let effectiveRange: HistoryRange | null = null;
    if (request.range !== undefined) {
      const evaluation = evaluateHistoryRange(request.range, {
        retentionDays: snapshot.entitlements.historyRetentionDays,
        now: now(),
      });
      if (!evaluation.valid) {
        throw await deny(policy, request, 'DATE_RANGE_INVALID');
      }
      effectiveRange = evaluation.effective;
    }

    // --- 10. Rate limit ---------------------------------------------------
    const decision = await deps.rateLimiter.consume({
      key: `${policy.operation}:user:${requesterUserId}`,
      limitPerMinute: policy.rateLimitPerMinute,
      requestId: request.auth.requestId,
    });
    if (!decision.allowed) {
      throw await deny(policy, request, 'RATE_LIMITED');
    }

    await audit(policy, request, 'ALLOWED', null);

    return {
      operation: policy.operation,
      requestId: request.auth.requestId,
      familyId: request.familyId,
      requesterUserId,
      requesterDeviceId: request.auth.deviceId,
      requesterMembership,
      targetUserId,
      targetMembership,
      tier: snapshot.tier,
      entitlements: snapshot.entitlements,
      retentionDays: snapshot.entitlements.historyRetentionDays,
      effectiveRange,
    };
  }

  return {
    async assertCanReadCurrentLocation(
      request: ReadCurrentLocationRequest,
    ): Promise<AuthorizationGrant> {
      return toGrant(await authorize(POLICIES.READ_CURRENT_LOCATION, request));
    },

    async assertCanReadHistory(request: ReadHistoryRequest): Promise<HistoryAuthorizationGrant> {
      const outcome = await authorize(POLICIES.READ_HISTORY, request);
      if (outcome.effectiveRange === null) {
        // Unreachable while READ_HISTORY always carries a range; fail closed.
        throw opaqueAuthorizationError(request.auth.requestId);
      }
      return {
        ...toGrant(outcome),
        effectiveRange: outcome.effectiveRange,
        retentionDays: outcome.retentionDays,
      };
    },

    async assertCanStartLiveSession(
      request: StartLiveSessionRequest,
    ): Promise<LiveSessionAuthorizationGrant> {
      const outcome = await authorize(POLICIES.START_LIVE_SESSION, request);
      return {
        ...toGrant(outcome),
        maxDurationSeconds: clampDuration(request.requestedDurationSeconds),
      };
    },

    async assertCanMutateFamily(request: MutateFamilyRequest): Promise<AuthorizationGrant> {
      return toGrant(await authorize(POLICIES.MUTATE_FAMILY, request));
    },

    async assertCanManageMember(request: ManageMemberRequest): Promise<AuthorizationGrant> {
      return toGrant(await authorize(POLICIES.MANAGE_MEMBER, request));
    },
  };
}

function toGrant(outcome: AuthorizationOutcome): AuthorizationGrant {
  return {
    operation: outcome.operation,
    requestId: outcome.requestId,
    familyId: outcome.familyId,
    requesterUserId: outcome.requesterUserId,
    requesterDeviceId: outcome.requesterDeviceId,
    requesterMembership: outcome.requesterMembership,
    targetUserId: outcome.targetUserId,
    targetMembership: outcome.targetMembership,
    tier: outcome.tier,
    entitlements: outcome.entitlements,
  };
}

/**
 * Visibility is the target's choice and is evaluated against the *requester's*
 * id only — never against a role — so an OWNER cannot override a member's
 * decision to hide from them.
 */
export function isVisibleTo(
  targetMembership: FamilyMembershipRecord,
  requesterUserId: UserId,
): boolean {
  if (targetMembership.hiddenFromUserIds?.includes(requesterUserId) === true) {
    return false;
  }
  if (targetMembership.visibleToUserIds === null) {
    return true;
  }
  return targetMembership.visibleToUserIds.includes(requesterUserId);
}

function clampDuration(requestedSeconds: number | undefined): number {
  if (
    requestedSeconds === undefined ||
    !Number.isFinite(requestedSeconds) ||
    requestedSeconds <= 0
  ) {
    return LIMITS.MAX_LIVE_SESSION_SECONDS;
  }
  return Math.min(Math.floor(requestedSeconds), LIMITS.MAX_LIVE_SESSION_SECONDS);
}

function isWellFormedPrincipal(auth: unknown): auth is AuthContext {
  if (auth === null || typeof auth !== 'object') {
    return false;
  }
  const candidate = auth as Partial<AuthContext>;
  if (candidate.tokenUse !== 'access') {
    return false;
  }
  if (typeof candidate.requestId !== 'string') {
    return false;
  }
  if (candidate.deviceId !== null && typeof candidate.deviceId !== 'string') {
    return false;
  }
  return UserIdSchema.safeParse(candidate.userId).success;
}

function safeRequestId(auth: unknown): string {
  if (auth !== null && typeof auth === 'object') {
    const candidate = (auth as { requestId?: unknown }).requestId;
    if (typeof candidate === 'string') {
      return candidate;
    }
  }
  return '';
}
