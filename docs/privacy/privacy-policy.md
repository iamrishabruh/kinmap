# Privacy Policy

> # ⚠️ DRAFT — REQUIRES REVIEW BY QUALIFIED LEGAL COUNSEL BEFORE PUBLICATION.
>
> **This document has not been reviewed by an attorney and must not be relied upon as
> legal advice or published as-is.**

---

**Status:** Draft / not published
**Document version:** `0.1.0-draft`
**Last technical review:** 2026-08-02 (engineering accuracy only — no legal review)
**Applies to:** {{product.name}} mobile application and `{{domains.api}}` API

Placeholders written as `{{...}}` map to keys in `bootstrap.config.example.json` and are
resolved during bootstrap. A placeholder that is still unresolved means the corresponding
account, domain, or legal entity has **not** been provisioned.

---

## 0. What counsel must decide before this is published

This section is deliberately first. It must be deleted only after every item is answered
in writing by a qualified attorney. See also
[`open-legal-questions`](#12-open-questions-for-counsel) at the end of this document.

- **We do not claim compliance with GDPR, UK GDPR, CCPA/CPRA, COPPA, PIPEDA, LGPD, or any
  other regime.** No compliance statement appears anywhere in this repository. Whether
  this product can lawfully operate in any given jurisdiction is an open question.
- The controller/processor characterisation of the operator relative to a family
  "OWNER" has not been determined.
- The lawful basis (if any) for processing each category below has not been determined.
- The treatment of minors is the single largest unresolved risk. See §12.

---

## 1. The consent model, stated first

{{product.name}} is a **consent-based** location-sharing product. A person's location is
never collected, stored, or shown to anyone unless **all** of the following are
simultaneously true:

1. They created an account and authenticated (`POST /v1/auth/...`).
2. They joined a family, either by creating it or by redeeming an invitation they chose
   to accept.
3. They explicitly enabled sharing in the app. Sharing is **off** by default; the account
   default `SharingStatus` is `NEVER_ENABLED`.
4. They granted the operating-system location permission themselves, in the OS dialog.
5. The app is displaying an active, non-dismissible sharing indicator to them.
6. They retain the ability to pause, disable, revoke, leave, or delete at any moment.

If any one of these becomes false, location collection stops. There is no configuration,
subscription tier, family role, or support tool that can override this. `TrackingState`
values `DISABLED` and `PERMISSION_REQUIRED` are excluded from
`LOCATION_PRODUCING_STATES` in `packages/contracts/src/domain.ts`, which is the
enforcement point.

**There is no hidden or "stealth" mode.** The app does not implement one, and any build
that did would be a defect, not a feature.

## 2. Who we are

|                         |                                                       |
| ----------------------- | ----------------------------------------------------- |
| Operator                | {{product.legalCompanyName}}                          |
| Product                 | {{product.name}}                                      |
| Privacy contact         | {{product.privacyEmail}}                              |
| Security contact        | {{product.securityEmail}}                             |
| Support                 | {{product.supportEmail}}                              |
| Postal address          | **NOT YET PROVISIONED — required before publication** |
| EU/UK representative    | **NOT APPOINTED — see §12**                           |
| Data Protection Officer | **NOT APPOINTED — see §12**                           |

## 3. What we collect

Each row below corresponds to a schema in `packages/schemas/src/` or
`packages/contracts/src/domain.ts`. This table is the source of truth for the App Store
privacy labels and the Google Play Data safety form; if the code changes, this table and
both store forms change in the same pull request.

### 3.1 Account information

| Field                                                  | Source              | Required | Notes                                                                                                  |
| ------------------------------------------------------ | ------------------- | -------- | ------------------------------------------------------------------------------------------------------ |
| `userId`                                               | Generated           | Yes      | UUID. Not derived from any personal identifier.                                                        |
| `displayName`                                          | You                 | Yes      | Shown to your family members.                                                                          |
| `email`                                                | You or Apple/Google | Yes      | Used for sign-in and service email. Returned only on your own profile read; never on another member's. |
| `phoneNumber`                                          | You                 | No       | Nullable. Optional throughout.                                                                         |
| `avatarUrl`                                            | You                 | No       | Nullable.                                                                                              |
| `locale`, `timeZone`                                   | Device              | Yes      | Used to render times and localise notifications.                                                       |
| `acceptedTermsVersion`, `acceptedPrivacyPolicyVersion` | You                 | Yes      | Records which version you agreed to.                                                                   |
| `status`                                               | System              | Yes      | `ACTIVE`, `PENDING_DELETION`, or `SUSPENDED`.                                                          |

Authentication is handled by Amazon Cognito. Supported methods: email with a six-digit
one-time code, Sign in with Apple (`APPLE`), and Google Sign-In (`GOOGLE`). One-time
codes and provider identity tokens are treated as credentials: they are verified
server-side, never logged, and never included in an error message.

### 3.2 Location data

Collected only under the six conditions in §1.

Per `LocationEventSchema`: `latitude`, `longitude`, `horizontalAccuracy`, and optionally
`altitude`, `verticalAccuracy`, `heading`, `speed`, `batteryLevel`, `isLowPowerMode`,
`motionState`, plus `trackingMode`, `capturedAt`, `deviceId`, and a monotonic
`sequenceNumber`.

Points are rejected at ingestion — not silently dropped — when they fail the acceptance
rules in `packages/contracts/src/limits.ts`:

- horizontal accuracy worse than 500 m, or negative (an invalid fix);
- a `capturedAt` more than 120 seconds in the future (clock skew);
- an event older than 72 hours (the on-device queue's maximum age);
- a duplicate: within 20 m and 60 s of an already-stored point;
- an implied ground speed above 350 m/s (a spoofed or corrupt fix).

### 3.3 Device information

Per `RegisterDeviceRequestSchema`: `deviceId` (a UUID the app generates — **not** an
advertising identifier, IDFA, IDFV, ANDROID_ID, or hardware serial), `platform`,
`osVersion`, `appVersion`, `appBuild`, `modelIdentifier` (e.g. `iPhone16,2`), an optional
user-set `deviceName`, `locale`, `timeZone`, and a push token.

Push tokens are stored so notifications can be delivered, but they are never returned by
the API. The device read model exposes only a `pushTokenRegistered` boolean.

Device health (`DeviceLocationHealthSchema`) — permission state, battery level, low-power
mode, charging state, pending-event queue depth, last upload error — is collected to
explain to you and to support why sharing may not be working. **It contains no
coordinates.**

### 3.4 Family, membership, and invitation data

Family name, membership `FamilyRole` (`OWNER`, `ADMIN`, `ADULT`, `MEMBER`) and
`MembershipStatus` (`ACTIVE`, `PENDING`, `REMOVED`, `LEFT`, `BLOCKED`), and invitation
records. Invitation tokens expire after 72 hours, are redeemable once, and are capped at
10 active per family.

**Roles do not encode legal guardianship.** `packages/contracts/src/domain.ts` states this
explicitly. The platform does not infer parent/child status, and an `OWNER` has no
authority over another member's sharing switch.

### 3.5 Saved places

`name`, `category` (`HOME`, `WORK`, `SCHOOL`, `GYM`, `FAMILY`, `OTHER`), centre
coordinates, and `radiusMeters` (50–10,000). Saved places are authored by a family and
visible to that family. Their coordinates are protected the same way location events are
(§5).

### 3.6 Live sessions

A live session is a **consent grant**, not a data channel. A requester asks; the target
must explicitly accept before anything changes; the target may grant less time than was
requested but never more; and the ceiling is 600 seconds
(`LIMITS.MAX_LIVE_SESSION_SECONDS`), enforced in native code, on the server, and by
automatic expiry. At most one live session may observe a given target at a time.

Rejection carries no reason field, by design: a person must be able to say no without
justifying it. A free-text reason would be a coercion vector.

### 3.7 Audit records

Every sensitive read and every consent change is recorded (`AuditEventSchema`): the
action, who acted, who was affected, the family, a request id, a **hash** of the source
IP address, and coarse metadata. Audit metadata is contractually restricted to strings,
numbers, and booleans and **must never contain a coordinate**.

You can read your own audit trail: `GET /v1/privacy/audit`. This is how you find out who
looked at your location and when.

### 3.8 Subscription data

Purchases are processed by Apple and Google. Entitlements are reconciled through
RevenueCat. We receive a plan, a subscription status, and renewal metadata. **We never
receive or store your payment card, bank details, or billing address.**

### 3.9 Support data

Support tickets, an optional diagnostics bundle (device health only — no coordinates),
abuse reports, and blocks.

Support staff have **no standing access** to your data. The only path is a
`SupportAccessGrant` that **you** create, scoped to specific data, lasting between 15
minutes and 24 hours, revocable by you at any time, and written to your audit log as
`SUPPORT_ACCESS_GRANTED`. **No support scope includes coordinates.**

### 3.10 Diagnostics and crash reports

Crash and performance data via Sentry, and operational logs and metrics. These pass
through the redaction layer in §6.

## 4. What we do NOT collect

- **No advertising identifiers.** No IDFA, no Google Advertising ID. The app declares
  `NSUserTrackingUsageDescription` only to state plainly that it does not track you across
  other apps or websites.
- **No cross-app or cross-site tracking, and no data brokers.**
- **No contacts, photos, microphone, camera, calendar, health, or SMS access.**
- **No advertising, and no sale or sharing of personal information for advertising.**
- **No coordinates outside the map.** See §6.

## 5. How location is protected

Coordinates are encrypted at the **application** layer before they reach the database —
not merely by disk encryption.

- Envelope encryption (`packages/crypto/`). AWS KMS mints a data key bound to an
  **encryption context** of `purpose`, `familyId`, `schemaVersion`, and where applicable
  `userId`.
- The coordinate payload is sealed with **AES-256-GCM**, using the canonicalised
  encryption context as additional authenticated data.
- Only the **wrapped** key is persisted alongside the ciphertext.
- Decryption requires the caller to supply the same context. A ciphertext row copied into
  another family's partition is **undecryptable**, not merely misattributed — two
  independent layers (KMS and the GCM tag) must both agree.
- The crypto module does not log, and no error it raises embeds a coordinate, a payload,
  or key material.

In transit: TLS. Reads are authorised per request — `GET /v1/families/{familyId}/locations/current`
re-checks membership **and** sharing status on every call, so pausing takes effect
immediately rather than freezing your last known position.

## 6. Coordinates never leave the map

This is an engineering rule enforced by shared code, not a promise:

- A single deny-list (`packages/observability/src/deny-list.ts`) is applied by the
  logger, the metrics helper, the tracing helpers, and the Sentry scrubber.
- Matching keys are **dropped, not masked**, so neither the key nor a placeholder hints at
  what was there. `latitude`, `longitude`, `lat`, `lng`, `coords`, `coordinates`,
  `address`, `placeName`, `familyName`, `email`, and every token-shaped key are on it.
- Push payloads (`PushPayloadSchema`) carry identifiers and a saved-place **name** — never
  a point. Deep links carry no coordinates in the query string.
- Audit metadata is coarse only.
- Repository-wide tests assert these properties.

Consequence: **our own operators cannot look up where you are from logs, dashboards,
crash reports, or notifications.**

## 7. How long we keep it

Summarised here; the authoritative document is
[`data-retention-policy.md`](./data-retention-policy.md).

| Data                           | Retention                                                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Location history — paid plans  | **30 days**, enforced by DynamoDB TTL (`LIMITS.HISTORY_RETENTION_DAYS`)                                            |
| Location history — Free plan   | **0 days** — current position only, no history is retained                                                         |
| On-device upload queue         | 72 hours maximum (`LIMITS.MAX_QUEUE_AGE_HOURS`)                                                                    |
| Live sessions                  | Expire automatically, ≤ 10 minutes                                                                                 |
| Invitations                    | 72 hours                                                                                                           |
| Account after deletion request | Purged at `scheduledPurgeAt`; see [`account-deletion-policy.md`](./account-deletion-policy.md)                     |
| Audit records                  | Retained beyond location history so that "who saw me" survives the location itself — exact period **TBD, see §12** |

The maximum history window a single query may request is 31 days
(`LIMITS.MAX_HISTORY_RANGE_DAYS`), which is one day wider than the retention period so a
whole-month query cannot silently truncate.

## 8. Your controls

Every one of these exists in the shipping app today:

| Control                        | Where            | Effect                                                                                                                           |
| ------------------------------ | ---------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Pause sharing (all families)   | Privacy settings | Immediate. Your position becomes unreadable, not frozen.                                                                         |
| Pause sharing (one family)     | Family settings  | Immediate, scoped.                                                                                                               |
| Disable sharing entirely       | Privacy settings | Location collection stops.                                                                                                       |
| Timed pause                    | Privacy settings | Auto-resumes at `pausedUntil`, and tells you it will.                                                                            |
| Delete location history        | Privacy settings | `DELETE /v1/privacy/history`.                                                                                                    |
| See who accessed your location | Privacy settings | `GET /v1/privacy/audit`.                                                                                                         |
| Leave a family                 | Family settings  | Ends sharing with that family immediately.                                                                                       |
| Revoke a device                | Device settings  | That device stops being able to upload.                                                                                          |
| Delete your account            | Account settings | See [`account-deletion-policy.md`](./account-deletion-policy.md).                                                                |
| Revoke OS permission           | System Settings  | Always available. The app degrades honestly and tells your family your permission was lost — it never pretends to still have it. |
| Block another user             | Support settings | Prevents contact and future invitations.                                                                                         |

Revocation is **immediate**, not queued to a nightly job.

## 9. Who else processes your data

See [`subprocessor-list.md`](./subprocessor-list.md) for the full list, the data category
each receives, and its region. No subprocessor receives plaintext coordinates except the
map tile provider, which receives a viewport in order to render tiles for you, and the
cloud database, which receives ciphertext it cannot decrypt without KMS.

## 10. Where data is processed

Primary region `{{aws.primaryRegion}}`; disaster-recovery region
`{{aws.disasterRecoveryRegion}}`. International transfer mechanisms have **not** been
established. See §12.

## 11. Changes to this policy

The version you accepted is recorded on your account
(`acceptedPrivacyPolicyVersion`). A material change requires re-acceptance in the app. We
will not silently expand what we collect.

## 12. Open questions for counsel

These are unresolved. They are listed here rather than papered over.

### Minors — the highest-risk area

This product locates family members, some of whom will be children. Counsel must answer:

1. Is there a minimum age to hold an account, and how is it verified beyond self-attestation?
2. Does COPPA apply? If a child under 13 can be located, what constitutes verifiable
   parental consent, and does the current invitation flow satisfy it?
3. GDPR Art. 8: what is the digital-consent age in each target market (13–16 varies), and
   who provides consent?
4. The domain model deliberately **refuses** to encode guardianship. Is a
   "guardian" concept legally required — and if so, how is it verified without creating a
   new abuse vector where an adult falsely claims guardianship over another adult?
5. Can a minor lawfully exercise the pause/revoke/delete controls in §8 against a parent's
   wishes? Product currently says **yes, always**. Confirm this is defensible.
6. Is a separate child-facing privacy notice required, and at what reading level?
7. Are Apple's Kids Category rules or Google Play's Families policy triggered? Both impose
   requirements this app has **not** been assessed against.
8. What happens to a minor's data at the age of majority?
9. School/education context: `PlaceCategory.SCHOOL` exists. Does storing a school geofence
   for a minor trigger FERPA or state student-privacy laws?

### Everything else

10. Controller vs. processor: is the operator a controller for all processing, or a
    processor for a family OWNER for some of it? Is a DPA or joint-controller arrangement
    needed?
11. Lawful basis for each category in §3, and whether consent must be separately
    withdrawable per category.
12. Is a DPIA/PIA mandatory? Location data at this granularity likely triggers one.
13. International transfers: SCCs, UK IDTA, adequacy, transfer impact assessment.
14. Do we need an EU/UK representative (Art. 27) and a DPO (Art. 37)?
15. CCPA/CPRA: is location "sensitive personal information" here, and are "Do Not Sell or
    Share" and "Limit the Use of Sensitive Personal Information" links required even
    though we do neither?
16. Data-subject-request mechanics: identity verification without collecting **more**
    identity data; how to handle a request from one family member about data that
    describes another.
17. Breach-notification thresholds and deadlines per jurisdiction (see
    [`incident-response-plan.md`](../security/incident-response-plan.md)).
18. Retention period for audit records — privacy argues short, safety and abuse
    investigation argue long.
19. Biometric/inference risk: does storing `motionState` and 30 days of history create
    derived inferences (a religious site, a clinic, a union hall) that attract special
    category protection?
20. Whether the "no compliance claim" posture in this repository is itself acceptable to
    the app stores at review time.

---

_End of draft. Do not publish._
