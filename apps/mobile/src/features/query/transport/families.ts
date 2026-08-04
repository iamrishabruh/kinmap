import * as Crypto from 'expo-crypto';

import type { FamilyId, UserId } from '@family/contracts';
import {
  BlockUserResponseSchema,
  GetAccountResponseSchema,
  GetFamilyMemberResponseSchema,
  GetFamilyResponseSchema,
  ListFamiliesResponseSchema,
  ListFamilyMembersResponseSchema,
  RemoveFamilyMemberResponseSchema,
  ReportAbuseResponseSchema,
  UpdateFamilyMemberResponseSchema,
  type Family,
  type FamilyMember,
  type RemoveFamilyMemberResponse,
} from '@family/schemas';

import type { FamilyApi } from '@/features/query/api';
import type {
  AbuseCategory,
  AssignableFamilyRole,
  FamilyDetail,
  FamilyMemberView,
  FamilySummary,
  RemoveMemberResult,
  ReportAccountResult,
} from '@/features/query/types';
import { request } from '@/lib/api';

/**
 * The families, members and safety slice of {@link FamilyApi}.
 *
 * Every method here is backed by a route that is actually deployed
 * (`infrastructure/stacks/api-stack.ts`) and served by
 * `services/family-service/src/handler.ts`:
 *
 *   `GET    /v1/families`                                -> ListFamiliesResponseSchema
 *   `GET    /v1/families/{familyId}`                     -> GetFamilyResponseSchema
 *   `GET    /v1/families/{familyId}/members`             -> ListFamilyMembersResponseSchema
 *   `GET    /v1/families/{familyId}/members/{userId}`    -> GetFamilyMemberResponseSchema
 *   `PATCH  /v1/families/{familyId}/members/{userId}`    -> UpdateFamilyMemberResponseSchema
 *   `DELETE /v1/families/{familyId}/members/{userId}`    -> RemoveFamilyMemberResponseSchema
 *   `POST   /v1/support/blocks`                          -> BlockUserResponseSchema
 *   `POST   /v1/support/reports`                         -> ReportAbuseResponseSchema
 *   `GET    /v1/account`                                 -> GetAccountResponseSchema
 *
 * The last one is used by `leaveFamily` only, to learn who the caller is; see
 * the note on that method.
 *
 * ---------------------------------------------------------------------------
 * PRIVACY
 * ---------------------------------------------------------------------------
 * None of these endpoints accepts or returns a coordinate — membership
 * responses carry the *status* of sharing and never a position — so nothing in
 * this module can leak one. Nothing here logs, either: not a path, not an id,
 * not a failure. `request()` already refuses to echo a body that failed
 * validation, and there is nothing worth adding to that.
 *
 * ---------------------------------------------------------------------------
 * WHY EVERY RESPONSE IS RE-MAPPED FIELD BY FIELD
 * ---------------------------------------------------------------------------
 * The wire resources carry bookkeeping the view models deliberately omit
 * (`createdAt`, `updatedAt`, `schemaVersion`). Spreading the parsed object into
 * a view type would compile — excess-property checking does not apply to
 * spreads — and would quietly widen what the UI layer holds. Copying named
 * fields keeps the view models exactly as `types.ts` declares them.
 */

/** Exactly the nine methods this module owns. */
export type FamiliesApi = Pick<
  FamilyApi,
  | 'listFamilies'
  | 'getFamily'
  | 'listMembers'
  | 'getMember'
  | 'updateMemberRole'
  | 'removeMember'
  | 'leaveFamily'
  | 'blockUser'
  | 'reportAccount'
>;

/**
 * Opaque, non-guessable, and derived from randomness only — never from a user
 * id, a family id or a timestamp — so it discloses nothing if it is ever seen.
 * Same construction as `features/settings/api/client.ts`.
 */
function newIdempotencyKey(): string {
  return Crypto.randomUUID();
}

/**
 * Ids reach the URL, so they are escaped. `UserIdSchema` is a free-form string
 * (a provider `sub`), not a uuid, so this is a correctness requirement rather
 * than a formality.
 */
function familyPath(familyId: FamilyId): string {
  return `/v1/families/${encodeURIComponent(familyId)}`;
}

function memberPath(familyId: FamilyId, userId: UserId): string {
  return `${familyPath(familyId)}/members/${encodeURIComponent(userId)}`;
}

function toFamilySummary(family: Family): FamilySummary {
  return {
    familyId: family.familyId,
    name: family.name,
    ownerUserId: family.ownerUserId,
    timeZone: family.timeZone,
    memberCount: family.memberCount,
    activeMemberCount: family.activeMemberCount,
    pendingInvitationCount: family.pendingInvitationCount,
    savedPlaceCount: family.savedPlaceCount,
    planTier: family.planTier,
  };
}

function toMemberView(member: FamilyMember): FamilyMemberView {
  return {
    userId: member.userId,
    familyId: member.familyId,
    displayName: member.displayName,
    avatarUrl: member.avatarUrl,
    role: member.role,
    status: member.status,
    sharingStatus: member.sharingStatus,
    sharingWithCaller: member.sharingWithCaller,
    deviceCount: member.deviceCount,
    lastSeenAt: member.lastSeenAt,
    joinedAt: member.joinedAt,
    invitedByUserId: member.invitedByUserId,
  };
}

function toRemoveMemberResult(response: RemoveFamilyMemberResponse): RemoveMemberResult {
  return {
    familyId: response.familyId,
    userId: response.userId,
    status: response.status,
    removedAt: response.removedAt,
    historyDeleted: response.historyDeleted,
  };
}

/**
 * Sent as the abuse report's `description` when the reporter typed nothing.
 *
 * `ReportAbuseRequestSchema.description` is `min(1)`, but `reportAccount` takes
 * `note: string | null` — a report with no note is a valid, common case (the
 * category is often the whole story). This is a fixed, client-authored sentence
 * so that an empty note never becomes an invented account of what happened.
 */
const NO_REPORT_NOTE = 'No additional details were provided by the reporter.';

export type FamiliesApiOptions = {
  /**
   * Resolves the signed-in user's id for `leaveFamily`. Defaults to a
   * `GET /v1/account` read. The orchestrator can pass the session module's
   * cached value instead to save the extra round trip.
   */
  readonly resolveCallerUserId?: () => Promise<UserId>;
};

async function fetchCallerUserId(): Promise<UserId> {
  const response = await request({
    method: 'GET',
    path: '/v1/account',
    schema: GetAccountResponseSchema,
  });
  return response.account.userId;
}

export function createFamiliesApi(options: FamiliesApiOptions = {}): FamiliesApi {
  const resolveCallerUserId = options.resolveCallerUserId ?? fetchCallerUserId;

  return {
    async listFamilies(signal?: AbortSignal): Promise<FamilySummary[]> {
      const response = await request({
        method: 'GET',
        path: '/v1/families',
        schema: ListFamiliesResponseSchema,
        signal,
      });
      return response.families.map(toFamilySummary);
    },

    async getFamily(input: { familyId: FamilyId }, signal?: AbortSignal): Promise<FamilyDetail> {
      const response = await request({
        method: 'GET',
        path: familyPath(input.familyId),
        schema: GetFamilyResponseSchema,
        signal,
      });
      return {
        family: toFamilySummary(response.family),
        members: response.members.map(toMemberView),
        // The server's own answer for the caller's role. Re-deriving it from the
        // member list here would give the client a second opinion about a
        // permission, and the client is never the authority on one.
        callerRole: response.callerRole,
      };
    },

    async listMembers(
      input: { familyId: FamilyId },
      signal?: AbortSignal,
    ): Promise<FamilyMemberView[]> {
      // No query: `ListFamilyMembersQuerySchema` already defaults to
      // `status: 'ACTIVE'` and `includeRemoved: false`, which is exactly the set
      // a client renders. Restating the defaults here would mean two places to
      // change when the contract does.
      const response = await request({
        method: 'GET',
        path: `${familyPath(input.familyId)}/members`,
        schema: ListFamilyMembersResponseSchema,
        signal,
      });
      return response.members.map(toMemberView);
    },

    async getMember(
      input: { familyId: FamilyId; userId: UserId },
      signal?: AbortSignal,
    ): Promise<FamilyMemberView> {
      const response = await request({
        method: 'GET',
        path: memberPath(input.familyId, input.userId),
        schema: GetFamilyMemberResponseSchema,
        signal,
      });
      return toMemberView(response.member);
    },

    async updateMemberRole(input: {
      familyId: FamilyId;
      userId: UserId;
      role: AssignableFamilyRole;
    }): Promise<FamilyMemberView> {
      const response = await request({
        method: 'PATCH',
        path: memberPath(input.familyId, input.userId),
        // Role only. `UpdateFamilyMemberRequestSchema` also accepts `status` and
        // `displayName`; sending either from this method would let a role change
        // silently carry an unrelated write.
        body: { role: input.role },
        schema: UpdateFamilyMemberResponseSchema,
        idempotencyKey: newIdempotencyKey(),
      });
      return toMemberView(response.member);
    },

    /**
     * Resolves only once the server has confirmed the removal.
     *
     * `useRemoveMember` purges the removed member's cached locations, timeline
     * and history from the device in `onSuccess` (spec §35). That purge is
     * irreversible on this device, so this method must never resolve
     * optimistically: the promise settles on the parsed `200`, and a failure
     * propagates as an `AppError` so the cache is left intact.
     */
    async removeMember(input: {
      familyId: FamilyId;
      userId: UserId;
      deleteHistory: boolean;
    }): Promise<RemoveMemberResult> {
      const response = await request({
        method: 'DELETE',
        path: memberPath(input.familyId, input.userId),
        // The flag is a query parameter, not a body: DELETE bodies are dropped
        // by some intermediaries, and `RemoveFamilyMemberQuerySchema` reads it
        // from the query string. `false` is sent explicitly rather than omitted,
        // because the server-side default is `true`.
        query: { deleteHistory: input.deleteHistory },
        schema: RemoveFamilyMemberResponseSchema,
        idempotencyKey: newIdempotencyKey(),
      });
      return toRemoveMemberResult(response);
    },

    /**
     * Leaving is removing yourself.
     *
     * There is no `/v1/families/{familyId}/leave` route. The deployed surface
     * models a departure as `DELETE .../members/{userId}` where the target is
     * the caller — `planRemoval` in the family service sees `selfInitiated` and
     * answers `status: 'LEFT'` rather than `'REMOVED'`. That means the caller's
     * own id is needed, which is why this is the one method here that may issue
     * a second request; pass `resolveCallerUserId` to avoid it.
     *
     * `deleteHistory: true` matches the contract default: someone withdrawing
     * from a family should not leave a trail behind inside it.
     */
    async leaveFamily(input: { familyId: FamilyId }): Promise<RemoveMemberResult> {
      const callerUserId = await resolveCallerUserId();
      const response = await request({
        method: 'DELETE',
        path: memberPath(input.familyId, callerUserId),
        query: { deleteHistory: true },
        schema: RemoveFamilyMemberResponseSchema,
        idempotencyKey: newIdempotencyKey(),
      });
      return toRemoveMemberResult(response);
    },

    /**
     * A personal block: it hides the two people from each other in every family
     * they share, in one server-side write, symmetrically.
     *
     * `removeFromSharedFamilies` is sent as `false` on purpose. With `true` the
     * service removes the other person where the caller has the authority to do
     * so and otherwise makes *the caller* leave the family — a destructive,
     * surprising outcome for someone who tapped "Block". `useBlockUser` agrees:
     * it purges cached locations and invalidates members, but does not touch
     * `families()` or `session()`, so no membership is expected to end. Blocking
     * with `removeFromSharedFamilies: false` also always succeeds, which is what
     * a safety action has to do.
     *
     * The result is a lossy fit for `RemoveMemberResult`; see the module's gap
     * notes. `BlockUserResponse` carries no family scope (the block is
     * account-wide) and no membership status, so `familyId` is echoed from the
     * input for the cache purge, `status` reports `'REMOVED'` in the sense of
     * "no longer visible to you", and `historyDeleted` is `false` because this
     * endpoint deletes no history.
     */
    async blockUser(input: { familyId: FamilyId; userId: UserId }): Promise<RemoveMemberResult> {
      const response = await request({
        method: 'POST',
        path: '/v1/support/blocks',
        body: { blockedUserId: input.userId, removeFromSharedFamilies: false },
        schema: BlockUserResponseSchema,
        idempotencyKey: newIdempotencyKey(),
      });
      return {
        familyId: input.familyId,
        userId: response.block.blockedUserId,
        status: 'REMOVED',
        removedAt: response.block.blockedAt,
        historyDeleted: false,
      };
    },

    /**
     * Files an abuse report and, per the contract's default, stops the reported
     * person from seeing the reporter immediately — the report and the
     * protection are one write, so a user cannot end up having reported someone
     * who can still watch them.
     *
     * `leaveFamily: false` is explicit: reporting must not silently end a
     * membership. `leaveFamily()` above is the deliberate way to do that.
     *
     * The response's `blocked`, `leftFamily` and `safetyResourcesUrl` are
     * dropped because `ReportAccountResult` has nowhere to put them; the
     * safety-resources URL in particular is worth surfacing later.
     */
    async reportAccount(input: {
      familyId: FamilyId;
      userId: UserId;
      category: AbuseCategory;
      note: string | null;
    }): Promise<ReportAccountResult> {
      const response = await request({
        method: 'POST',
        path: '/v1/support/reports',
        body: {
          reportedUserId: input.userId,
          familyId: input.familyId,
          category: input.category,
          description: input.note ?? NO_REPORT_NOTE,
          blockImmediately: true,
          leaveFamily: false,
        },
        schema: ReportAbuseResponseSchema,
        idempotencyKey: newIdempotencyKey(),
      });
      return { reportId: response.reportId, submittedAt: response.submittedAt };
    },
  };
}

/** The composed instance; `createFamiliesApi()` exists for tests and for wiring. */
export const familiesApi: FamiliesApi = createFamiliesApi();
