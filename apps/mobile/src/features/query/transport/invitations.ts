import * as Crypto from 'expo-crypto';
import type { z } from 'zod';

import { AppError } from '@family/contracts';
import {
  AcceptInvitationResponseSchema,
  CreateInvitationResponseSchema,
  InvitationTokenSchema,
  ListInvitationsResponseSchema,
  PreviewInvitationResponseSchema,
  RevokeInvitationResponseSchema,
  // Referenced only through `typeof` below, so they are erased at build time.
  type AcceptInvitationRequestSchema,
  type CreateInvitationRequestSchema,
  type Invitation as WireInvitation,
} from '@family/schemas';

import { CURRENT_TERMS_VERSION } from '@/features/consent/versions';
import type { FamilyApi } from '@/features/query/api';
import type { AcceptInvitationResult, Invitation, InvitationPreview } from '@/features/query/types';
import { request } from '@/lib/api';

/**
 * The invitation slice of {@link FamilyApi}.
 *
 * ---------------------------------------------------------------------------
 * THE TOKEN IS A CREDENTIAL
 * ---------------------------------------------------------------------------
 * A raw invitation token grants membership of a family, which is to say it
 * grants the ability to be shown other people's locations. `@family/schemas`
 * says it must never be logged, echoed in an error, or included in any
 * list/read response, and this module holds to that:
 *
 *   - Nothing here logs. There is no `console` call, no telemetry hook, and no
 *     debug branch — not even on the failure paths, where a token would be
 *     most tempting to include and most damaging to keep.
 *   - No token is interpolated into an error message. The one error this module
 *     raises itself ({@link invalidTokenError}) is a fixed string; everything
 *     else is the server's own `AppError`, which is user-safe by contract.
 *   - The token travels in the path, which is where the route puts it, and the
 *     API access log records `routeKey` — the uninstantiated template — rather
 *     than the instantiated path, so it does not reach CloudWatch either
 *     (see `infrastructure/stacks/api-stack.ts`).
 *   - `createInvitation` never touches the `token` field of the response. The
 *     share sheet needs a link, and `inviteUrl` already is one; reading the raw
 *     token as well would only create a second copy to leak.
 *
 * ---------------------------------------------------------------------------
 * PREVIEW IS NOT JOINING
 * ---------------------------------------------------------------------------
 * `GET /v1/invitations/{token}` is read-only and creates nothing. The only call
 * here that creates a membership is `acceptInvitation`, which the hook layer
 * fires from an explicit tap. Opening a link must never be the act of consent.
 */

// ---------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------

/**
 * `z.input`, not `z.infer`: every field with a server-side default is optional
 * on the way in. Restating those defaults on the client is how they drift.
 */
type CreateInvitationBody = z.input<typeof CreateInvitationRequestSchema>;
type AcceptInvitationBody = z.input<typeof AcceptInvitationRequestSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Mirrors `newIdempotencyKey()` in the settings feature: a fresh v4 per attempt. */
function newIdempotencyKey(): string {
  return Crypto.randomUUID();
}

/**
 * A token that cannot possibly be valid never becomes a request.
 *
 * The preview and the redemption share the tightest ceiling in the contract
 * (`RATE_LIMITS.INVITATION_ACCEPT_PER_IP`) precisely because token guessing is
 * the cheapest way into a family. Spending that budget on a string the shared
 * schema already rejects would buy nothing and would push a real recipient on
 * the same address closer to a 429.
 *
 * Validation is delegated to `InvitationTokenSchema` rather than re-expressed
 * here, so the client and the server agree on what a token is by construction.
 * The rejected value is NOT included in the error: it is a credential even when
 * it is malformed, because "malformed" may only mean truncated in transit.
 */
function assertTokenShape(token: string): string {
  const parsed = InvitationTokenSchema.safeParse(token);
  if (!parsed.success) throw invalidTokenError();
  return parsed.data;
}

function invalidTokenError(): AppError {
  return new AppError(
    'INVITATION_INVALID',
    'That invitation link is not valid. Ask whoever invited you for a new one.',
  );
}

/**
 * A listed invitation has no share link, and cannot have one.
 *
 * `InvitationSchema` carries no token by design — the raw value is returned
 * exactly once, at creation, and only its hashed handle is stored. So every
 * invitation that arrives through `listInvitations` has an empty `shareUrl`,
 * and a screen that wants a link to re-share must create a new invitation
 * rather than expect this field to be populated. The alternative — deriving a
 * plausible-looking `/invite/<invitationId>` URL — would hand the user a link
 * that silently does not work, which is worse than an obviously absent one.
 */
const NO_SHARE_URL = '';

/**
 * The preview response deliberately identifies no family.
 *
 * `PreviewInvitationResponseSchema` reveals only what a person holding the link
 * already knows: the family's name, who invited them, the role, the expiry and
 * a member count. It carries no `familyId`, and inventing one here would put a
 * fabricated identifier into the query cache, where a later mutation could key
 * off it. Callers must treat an empty `familyId` on a preview as "not known
 * until accepted" — `acceptInvitation` returns the real one.
 */
const UNKNOWN_FAMILY_ID = '';

/**
 * The wire invitation carries an `acceptedAt`; the view model calls the same
 * instant `redeemedAt`. `status`, `label`, `redemptionCount` and
 * `maxRedemptions` have no home in the view type and are dropped here rather
 * than smuggled through an untyped field.
 */
function toInvitation(wire: WireInvitation, shareUrl: string): Invitation {
  return {
    invitationId: wire.invitationId,
    familyId: wire.familyId,
    role: wire.role,
    createdByUserId: wire.createdByUserId,
    createdAt: wire.createdAt,
    expiresAt: wire.expiresAt,
    redeemedAt: wire.acceptedAt,
    revokedAt: wire.revokedAt,
    shareUrl,
  };
}

// ---------------------------------------------------------------------------
// The module
// ---------------------------------------------------------------------------

export type InvitationsApi = Pick<
  FamilyApi,
  | 'listInvitations'
  | 'createInvitation'
  | 'revokeInvitation'
  | 'previewInvitation'
  | 'acceptInvitation'
>;

export type InvitationsApiDeps = {
  /**
   * The display name to give the family on first join. Read at call time, not
   * captured, so an account that loads after composition is still reflected.
   * `null` lets the server apply its own fallback.
   */
  getDisplayName?: () => string | null;
  /**
   * The terms version already recorded on this account. See the note on
   * `acceptInvitation` for why this is a restatement rather than a consent.
   */
  getAcceptedTermsVersion?: () => string | null;
};

export function createInvitationsApi(deps: InvitationsApiDeps = {}): InvitationsApi {
  return {
    /**
     * `GET /v1/families/{familyId}/invitations`
     *
     * The `status` query parameter is omitted so the server's own default
     * (`PENDING`) applies — the outstanding invitations are what a family
     * screen renders, and hard-coding the value here would fork it from the
     * schema the moment that default changes.
     */
    async listInvitations({ familyId }, signal): Promise<Invitation[]> {
      const response = await request({
        method: 'GET',
        path: `/v1/families/${encodeURIComponent(familyId)}/invitations`,
        schema: ListInvitationsResponseSchema,
        signal,
      });
      // `activeCount` / `maxActive` are dropped: the view type has nowhere to
      // put them, and the create call surfaces the ceiling as PLAN_LIMIT_EXCEEDED.
      return response.invitations.map((invitation) => toInvitation(invitation, NO_SHARE_URL));
    },

    /**
     * `POST /v1/families/{familyId}/invitations`
     *
     * The only response in the API that carries a share link. `label`,
     * `expiresInHours` and `maxRedemptions` are left to the server's defaults
     * (72 hours, single redemption) because the interface gives the caller no
     * way to express them and a client-side copy would be the thing that rots.
     */
    async createInvitation({ familyId, role }): Promise<Invitation> {
      const response = await request({
        method: 'POST',
        path: `/v1/families/${encodeURIComponent(familyId)}/invitations`,
        body: { role } satisfies CreateInvitationBody,
        schema: CreateInvitationResponseSchema,
        idempotencyKey: newIdempotencyKey(),
      });
      // `response.token` is intentionally never read. `inviteUrl` embeds it and
      // is what the share sheet needs; a second reference would be a second
      // chance to log it.
      return toInvitation(response.invitation, response.inviteUrl);
    },

    /**
     * `DELETE /v1/families/{familyId}/invitations/{invitationId}`
     *
     * Keyed, because revocation is a state change a retry must not double-apply
     * into a `CONFLICT` on an invitation that is already gone. The response is
     * still parsed before being discarded: a body that does not match the
     * contract means the write did not do what its shape claims.
     */
    async revokeInvitation({ familyId, invitationId }): Promise<void> {
      await request({
        method: 'DELETE',
        path: `/v1/families/${encodeURIComponent(familyId)}/invitations/${encodeURIComponent(invitationId)}`,
        schema: RevokeInvitationResponseSchema,
        idempotencyKey: newIdempotencyKey(),
      });
    },

    /**
     * `GET /v1/invitations/{token}` — read-only. Creates nothing.
     *
     * -----------------------------------------------------------------------
     * WHY THIS IS NOT `anonymous: true`
     * -----------------------------------------------------------------------
     * It is reached from a universal link, so an unauthenticated caller is
     * plausible — but the deployed route is bound to the JWT authorizer.
     * `API_ROUTES` in `infrastructure/stacks/api-stack.ts` marks exactly three
     * routes `unauthenticated` (the two provider webhooks and the liveness
     * probe); `/v1/invitations/{token}` is not one of them. Sending
     * `anonymous: true` would strip the bearer token from a request the gateway
     * requires one on, turning every preview into a 401 that the transport
     * cannot even retry, since anonymous requests skip the refresh cycle.
     *
     * So the link flow is: sign in first, holding the token, then preview. That
     * is what `app/(onboarding)/join-family.tsx` already does — it reaches this
     * route through an authenticated `request()` too. It is also the safer
     * shape: an anonymous preview endpoint would let anyone holding a guessed
     * token learn a family's name and size without ever identifying themselves.
     *
     * -----------------------------------------------------------------------
     * WHAT `status` CAN BE
     * -----------------------------------------------------------------------
     * Always `'VALID'` here, and that is not a stub: the server returns a
     * preview body only for an invitation that can still be accepted. The other
     * four states arrive as errors, not as payloads — `INVITATION_EXPIRED`,
     * `INVITATION_ALREADY_USED`, `INVITATION_REVOKED` and `INVITATION_INVALID`
     * are `AppError` codes, one per remaining member of the union. They are
     * left to propagate so the caller sees a failed query with the server's own
     * wording, rather than a resolved one that renders an expired invitation as
     * a joinable family.
     */
    async previewInvitation({ token }, signal): Promise<InvitationPreview> {
      const safeToken = assertTokenShape(token);
      const response = await request({
        method: 'GET',
        path: `/v1/invitations/${encodeURIComponent(safeToken)}`,
        schema: PreviewInvitationResponseSchema,
        signal,
      });

      return {
        familyId: UNKNOWN_FAMILY_ID,
        familyName: response.familyName,
        invitedByDisplayName: response.invitedByDisplayName,
        role: response.role,
        memberCount: response.memberCount,
        expiresAt: response.expiresAt,
        // Empty by contract, not by omission: the preview "never reveals member
        // lists, emails, or any location data". A count is what a recipient
        // gets before they have joined, and naming the members to someone who
        // merely holds a link would be the leak the endpoint exists to avoid.
        memberDisplayNames: [],
        // The server authors no disclosure copy for this route. The join screen
        // owns that wording, in the binary the user consented to; synthesising
        // it here would put words in the server's mouth.
        disclosures: [],
        status: 'VALID',
      };
    },

    /**
     * `POST /v1/invitations/{token}/accept` — the only call that creates a
     * membership.
     *
     * `startSharingImmediately` is hard-wired to `false`. Joining a family and
     * beginning to transmit a location are separate consents, and the second
     * one is asked for on the location primer where the permission it needs is
     * explained.
     *
     * `acceptedTermsVersion` is required by the request schema but absent from
     * the interface signature. It is a restatement of the acceptance already
     * recorded on the account — the routing guard does not let anyone reach an
     * invitation flow with an out-of-date agreement — so the injected value is
     * preferred and the version compiled into this build is only the floor for
     * the case where the account snapshot has not been read yet. Same reasoning
     * as `app/(onboarding)/join-family.tsx`.
     */
    async acceptInvitation({ token }): Promise<AcceptInvitationResult> {
      const safeToken = assertTokenShape(token);
      const response = await request({
        method: 'POST',
        path: `/v1/invitations/${encodeURIComponent(safeToken)}/accept`,
        body: {
          displayName: deps.getDisplayName?.() ?? null,
          acceptedTermsVersion: deps.getAcceptedTermsVersion?.() ?? CURRENT_TERMS_VERSION,
          startSharingImmediately: false,
        } satisfies AcceptInvitationBody,
        schema: AcceptInvitationResponseSchema,
        idempotencyKey: newIdempotencyKey(),
      });

      return {
        familyId: response.familyId,
        userId: response.membership.userId,
        role: response.membership.role,
        // `joinedAt` is nullable on a membership that the server has not
        // stamped yet; the acceptance instant is the same event by definition.
        joinedAt: response.membership.joinedAt ?? response.acceptedAt,
      };
    },
  };
}

/** The default composition: no session injected, so the shipped constants apply. */
export const invitationsApi: InvitationsApi = createInvitationsApi();
