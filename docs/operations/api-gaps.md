# API gaps

Methods on `FamilyApi` that the deployed API cannot fully serve.

Every one of these was found while writing the transport, and every one is
recorded here rather than stubbed. That distinction is the point of this file: a
method that quietly returns `[]` or a fabricated id looks like a working feature
and fails silently in front of a user, while a method that refuses tells you
exactly what is missing. Where a workaround exists it is described, including
what it costs.

Three of these are worth reading even if you skim the rest:

- **`getMemberTimeline` throws instead of returning an empty list.** An empty
  timeline would tell somebody their family member did nothing all day, which is
  a statement about another person's movements that this client is in no
  position to make. It also refuses to synthesise arrivals by watching `placeId`
  change across history points — that is a server-owned derivation, and invented
  on-device from somebody else's positions it would be believed.
- **`blockUser` sends `removeFromSharedFamilies: false`.** With `true` the
  service removes the other person only where the caller outranks them, and
  otherwise makes _the caller_ leave the family. A destructive surprise behind a
  "Block" tap is not acceptable, so the safe half is sent and the gap is
  recorded.
- **`previewInvitation` returns an empty `familyId` rather than a plausible
  UUID.** A fabricated id in the query cache is something a later mutation could
  key off.

---

## `[session] getSession`

AuthenticatedSession.activeFamilyId has no wire source. GET /v1/account is deployed (api-stack.ts:128) but its contract, AccountSchema in packages/schemas/src/account.ts, carries only familyIds — there is no activeFamilyId field, and no route in API_ROUTES stores or returns a per-device/per-session 'current family'. I did NOT invent a route: the value is derived locally as familyIds[0] ?? null, which is stable because services/api/src/routes/account.ts returns ACTIVE memberships already sorted ascending. Consequence: a user in two or more families always lands on whichever family id sorts first, and cannot switch — useActiveFamilyId() (hooks.ts:46) reads straight off this field, so the whole signed-in surface inherits that choice. Real fix is one of: add activeFamilyId to the account response, or persist an explicit local selection and have the orchestrator override this field. Flagged rather than stubbed.

## `[families] leaveFamily`

No self-scoped route exists. API_ROUTES has no /v1/families/{familyId}/leave and no 'me' alias for {userId}; the family service models a departure as DELETE .../members/{userId} where the target is the caller (planRemoval sets selfInitiated -> status 'LEFT'). The interface signature takes only { familyId }, so the caller's own id has to come from somewhere: implemented as a GET /v1/account read (GetAccountResponseSchema) before the DELETE. createFamiliesApi({ resolveCallerUserId }) lets the orchestrator inject the session module's value and skip the extra round trip. Nothing is stubbed or invented, but leaveFamily is two requests unless it is wired.

## `[families] blockUser`

POST /v1/support/blocks is the only block route and it is account-wide: BlockUserRequest is { blockedUserId, removeFromSharedFamilies } with no familyId, and BlockUserResponse is { block: { blockedUserId, blockedAt, removedFromSharedFamilies } } with no membership status and no history flag. The interface declares Promise<RemoveMemberResult>, so three of the five fields cannot come from the server: familyId is echoed from the input (needed by useBlockUser's cache purge), status is the constant 'REMOVED' meaning 'no longer visible to you' (RemoveMemberResult has no 'BLOCKED' arm, and the server could not distinguish REMOVED from LEFT anyway - removedFromSharedFamilies is one boolean covering both paths), historyDeleted is the constant false because this endpoint deletes no history. Sent with removeFromSharedFamilies: false: with true, the service removes the other person only where the caller outranks them and otherwise makes the CALLER leave the family, which is a destructive surprise for a 'Block' tap; useBlockUser also does not invalidate families()/session(), so it does not expect a membership to end. Either the interface should return a block-shaped result, or a family-scoped block route is missing.

## `[families] reportAccount`

Two contract mismatches, both worked around in-module rather than by inventing a route. (1) ReportAbuseRequestSchema.description is z.string().min(1) but the interface passes note: string | null, so a note-less report would be rejected server-side; a fixed client-authored sentence ('No additional details were provided by the reporter.') is sent instead of fabricating a description from user data. (2) ReportAccountResult is only { reportId, submittedAt }, so the response's blocked, leftFamily and especially safetyResourcesUrl (the locale-aware safety resources shown after an unwanted-tracking report, spec-relevant) are parsed and then dropped - there is nowhere in the view type to put them. Separately, types.ts AbuseCategory omits 'COERCED_SHARING', which AbuseCategorySchema accepts, so that category is unreportable from this client.

## `[locations] getMemberTimeline`

No timeline route exists in API_ROUTES. TimelineEntry is a coordinate-free row (ARRIVED/DEPARTED by saved-place name, sharing and live-session transitions, permission loss) and nothing in the deployed table returns that shape: the history route returns raw points, and /v1/privacy/audit is scoped to 'who looked at ME' for the caller alone, so it is not another member's timeline. Implemented as a throw of AppError('NOT_FOUND', 'A member timeline is not available in this version of Family Location.') - the same answer the missing route would give. It deliberately does NOT return [] (which would tell a user their family member did nothing all day) and does NOT synthesise arrivals by watching placeId change across history points (a server-owned derivation, invented on-device from someone else's positions, and it would be believed). Needs a real GET /v1/families/{familyId}/members/{userId}/timeline or equivalent.

## `[places] getPlace`

There is no GET /v1/places/{placeId} in API_ROUTES (infrastructure/stacks/api-stack.ts lines 348-363 deploy only GET+POST /v1/places and PATCH+DELETE /v1/places/{placeId}), and services/api/src/routes/places.ts registers no single-place read. No route was invented: getPlace issues GET /v1/places?familyId=..., parses ListPlacesResponseSchema and selects the id, throwing AppError('NOT_FOUND') when absent — the same answer the API gives for a place outside the caller's families, so the two stay indistinguishable. The list is capped by maxSavedPlaces, so the read is small, but it is a full-collection fetch rather than a point read: if a real single-place route lands, this method should switch to it.

## `[invitations] previewInvitation`

Route EXISTS and is called; the RESPONSE CONTRACT is short of the view type. PreviewInvitationResponseSchema returns only familyName, invitedByDisplayName, role, expiresAt, memberCount. InvitationPreview additionally demands familyId, memberDisplayNames, disclosures and status. familyId is returned as '' (UNKNOWN_FAMILY_ID) rather than a fabricated UUID — a made-up id in the query cache is something a later mutation could key off. memberDisplayNames and disclosures are [] : the schema states the preview must never reveal member lists, and no server-authored disclosure copy exists for this route (the join screen owns that wording). status is always 'VALID', which is accurate rather than a stub — the server returns a preview body only for a usable invitation, and the other four union members map 1:1 onto the AppError codes INVITATION_EXPIRED / INVITATION_ALREADY_USED / INVITATION_REVOKED / INVITATION_INVALID, which are left to propagate so an expired invite renders as a failed query and not as a joinable family. If the product wants those four states as data, the server has to return them; either the route grows a familyId + status body or InvitationPreview should shed the four fields.

## `[invitations] listInvitations`

Route EXISTS and is called; the RESPONSE CONTRACT cannot supply Invitation.shareUrl. InvitationSchema is deliberately token-free — the raw token is returned exactly once, at creation, and only its hashed handle is stored — so listed invitations get shareUrl: '' (NO_SHARE_URL). Deriving a plausible /invite/<invitationId> link would hand the user a URL that silently does not work. A screen wanting a re-share link must create a new invitation. Suggest making shareUrl optional/null on the view type. Also dropped: the wire status, label, redemptionCount, maxRedemptions fields and the response's activeCount/maxActive, which have no home in the view type.

## `[invitations] acceptInvitation`

Route EXISTS and is called; the INTERFACE SIGNATURE is short of the request contract. AcceptInvitationRequestSchema requires acceptedTermsVersion (no default), but FamilyApi.acceptInvitation takes only { token }. The module therefore uses an optional injected getter and falls back to CURRENT_TERMS_VERSION from @/features/consent/versions — a restatement of the acceptance already on the account (the routing guard blocks an out-of-date agreement from reaching this flow), exactly as app/(onboarding)/join-family.tsx does. displayName defaults to null unless injected, so the server applies its own fallback. Wire this properly by passing session getters into createInvitationsApi() at composition.

## `[live-sessions] getLiveSession`

There is no GET /v1/live-sessions/{sessionId} in API_ROUTES (infrastructure/stacks/api-stack.ts) and no handler in services/api/src/routes/live-sessions.ts. I did not invent one. It is served instead by GET /v1/live-sessions?familyId=… — which returns only sessions the caller is a party to, i.e. exactly the authorization the by-id route would have applied — and the row is picked out by id. The owning familyId is not in the method's input, so it is remembered from whichever earlier response first carried that session (list / request / respond / stop). A sessionId this process has never seen cannot be addressed and is refused with AppError('NOT_FOUND') rather than guessed at. Practical effect: a cold-start deep link straight to a session detail screen (e.g. from a push notification) fails until the family's session list has been read once. A real by-id route would remove both the failure mode and the extra list traffic — getLiveSession polls at the 10s liveSession cadence, and each poll currently costs a full family list read.

## `[live-sessions] requestLiveSession`

Route exists and is fully implemented (POST /v1/live-sessions). Listed here only because its response cannot express part of the view contract: LiveSessionSchema carries no duration at all — projectLiveSession() in services/api/src/repositories/live-sessions.ts deliberately drops both requestedDurationSeconds and grantedDurationSeconds — and expiresAt is null until the session is ACTIVE. So a PENDING request has no wire-representable duration, and the target's consent prompt (live-session-indicator.tsx renders 'X asked to follow your location for {duration}') cannot be driven from the server's answer. I derive durationSeconds as expiresAt - startedAt where both exist, and otherwise fall back to LIMITS.MAX_LIVE_SESSION_SECONDS, an upper bound — overstating to the person being asked to consent is the safe direction. Fixing this properly means adding requestedDurationSeconds/grantedDurationSeconds to the projection.

---

## What to do about them

They divide into three kinds:

**Routes that do not exist.** `GET /v1/places/{placeId}`,
`GET /v1/live-sessions/{sessionId}`, a member timeline route, and a self-scoped
`leaveFamily`. Each currently costs an extra list read or a second request; the
timeline has no workaround at all.

**Contracts that are short of the view type.** `activeFamilyId`, `shareUrl`,
the invitation preview's `familyId` and `status`, the block result's shape. In
most of these the view type is asking for something the server has decided not
to return — sometimes deliberately, as with the invitation token, which is
returned once at creation and never again. The fix is usually to change the view
type rather than the server.

**Signature mismatches.** `acceptInvitation` takes only a token while the
request contract requires an accepted terms version, and `AbuseCategory` in the
client omits `COERCED_SHARING`, which the server accepts — so that category is
currently unreportable from the app. That last one matters more than its size
suggests: coerced sharing is precisely the abuse this product needs a report
path for.
