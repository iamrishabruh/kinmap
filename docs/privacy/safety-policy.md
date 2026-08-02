# Safety Policy

> # ⚠️ DRAFT — REQUIRES REVIEW BY QUALIFIED LEGAL COUNSEL BEFORE PUBLICATION.
>
> **This document has not been reviewed by an attorney and must not be relied upon as
> legal advice or published as-is.**
>
> **This document has also not been reviewed by a domestic-violence or child-safety
> specialist. It must be before publication — see §9.**

---

**Status:** Draft / not published
**Document version:** `0.1.0-draft`
**Audience:** users, support staff, and engineers
**Contact:** {{product.supportEmail}}

---

> **If you are in immediate danger, contact your local emergency services. This product is
> not a safety service and must not be relied on in an emergency.**

---

## 1. The threat we design against

The dangerous case for a location-sharing product is not a stranger breaking in. It is
someone who already has access — a partner, an ex, a parent, an adult child, a
roommate — using the product to control another person.

That person often has physical access to the victim's phone, may know their passcode,
may have set up the account, and may notice changes. Design decisions here account for
that, and sometimes they trade convenience away to get it.

## 2. Design commitments

These are properties of the shipped software, not aspirations.

### 2.1 Sharing is always visible to the person being shared

- Sharing is `NEVER_ENABLED` by default. It cannot be enabled remotely, by another
  member, by an administrator, by support, or by a subscription.
- While sharing is active the app shows a persistent indicator, and on Android a
  foreground-service notification. **Neither can be hidden, disguised, minimised, or
  relabelled.** A build that disguised the foreground notification would be rejected in
  code review as a safety defect.
- Enabling requires the operating-system permission dialog, which the person taps
  themselves.

### 2.2 The off switch always works, immediately

- Pause or disable takes effect at once. The server re-checks sharing status on every
  read, so a paused position becomes **unreadable** rather than frozen at its last value.
  Nobody sees a stale point and mistakes it for a current one.
- There is no cooldown, no approval, no "the owner must confirm".
- Leaving a family is unilateral.
- Revoking OS permission always works, and the app reports the truth to the family:
  permission was lost. It never fabricates a position or implies sharing is still on.

### 2.3 Nothing is covert

- No hidden mode, no stealth install, no invisible sharing, no disguised notification, no
  silent re-enable.
- Live sessions require the target's explicit acceptance.
- Declining a live session requires no reason. The schema has no reason field for
  rejection **on purpose** — a required justification is a coercion vector.

### 2.4 You can see who looked

Privacy → Access log (`GET /v1/privacy/audit`) shows every read of your location, every
history query, every live session, every sharing change, and every membership change,
with who and when. This survives longer than the location data itself, so "who was
watching me last month" remains answerable after the locations are gone.

### 2.5 Roles carry no power over your body

`OWNER` and `ADMIN` are administrative roles. They cannot enable your sharing, prevent
your pause, block your departure, or see you while you are paused. The domain model
explicitly refuses to encode guardianship.

### 2.6 Coordinates stay on the map

Your position is never written to logs, metrics, traces, crash reports, analytics, push
notification payloads, deep links, or support tickets. Support staff cannot look up where
you are — not "are not permitted to", **cannot**. There is no tool that does it.

## 3. If someone is tracking you against your will

Each step below states what the other person can observe, so you can decide in what order
to act.

| Action                   | Where                      | What the other person sees                                                                                                                                                                |
| ------------------------ | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Pause sharing**        | Privacy → Sharing          | Your position disappears from their map. They are notified that you paused (`SHARING_PAUSED`) — sharing state is always visible to **both** sides, so a pause cannot be hidden from them. |
| **Leave the family**     | Family → Leave             | They see you left (`MEMBER_LEFT`).                                                                                                                                                        |
| **Delete history**       | Privacy → Delete history   | Nothing directly, but past points vanish from their map history.                                                                                                                          |
| **Block them**           | Support → Block            | They can no longer contact you or invite you.                                                                                                                                             |
| **Revoke OS permission** | System Settings → Location | The app reports `PERMISSION_LOST`. This looks the same as a phone with location off.                                                                                                      |
| **Delete your account**  | Settings → Delete account  | You are removed from every family.                                                                                                                                                        |

**We do not offer a silent pause.** That is a deliberate and debated decision: a pause the
other person cannot see would be safer in the moment but would also let an abuser enable
sharing on someone's phone and hide it. We chose the rule that protects the person being
located, and we state it plainly so you can plan around it. **Counsel and a DV specialist
must confirm this trade-off — see §9.**

If turning sharing off could put you at risk, consider contacting a domestic-violence
advocate before you change anything. They can help you plan the timing.

## 4. If you are a young person

- You are allowed to know that your location is being shared. If an adult set this up on
  your phone without telling you, that violates our [Acceptable Use Policy](./acceptable-use-policy.md).
- The app will always show you when sharing is on. If you cannot find the indicator,
  something is wrong — tell someone you trust or contact {{product.supportEmail}}.
- Your controls are the same as everyone else's.
- **The rules about what a parent may require of a minor here are legally unresolved. See
  §9.**

## 5. Warning signs a device may be compromised

The product cannot protect you if someone else controls your phone or your account.

- You do not recognise a device in Settings → Devices. Revoke it.
- Your access log shows reads you did not expect.
- Your sharing turns back on after you disable it. **We have no capability to do that
  remotely** — it means someone has access to your device or your sign-in method.
- You receive sign-in codes you did not request.

Change your sign-in method, revoke unknown devices, and contact {{product.supportEmail}}.

## 6. What support can and cannot do

**Can:** explain features, help you leave a family, help you delete your account and data,
act on abuse reports, revoke devices.

**Cannot:** see your location, see anyone else's location, re-enable sharing for you, tell
you where someone is, or access your account without a time-boxed grant **you** create
(15 minutes to 24 hours, revocable, logged to your audit trail, and never including
coordinates in any scope).

## 7. Reporting a safety concern

In-app: Settings → Support → Report a problem. Email: {{product.supportEmail}}.

- We act on the reported account, not the reporting one.
- We will not disclose who reported when doing so could endanger them.
- **Do not send coordinates.** We do not want them in a support system.
- Target: acknowledge within one business day; act on credible imminent-risk reports the
  same day. **Operational goal only — the rota is not yet staffed. See the README.**

## 8. Escalation path (internal)

1. Report received (in-app or email).
2. Triaged for imminent risk to life within the same business day.
3. If imminent: on-call safety lead paged; account restrictions applied immediately;
   incident opened under [`incident-response-plan.md`](../security/incident-response-plan.md).
4. If not imminent: investigated against the Acceptable Use Policy.
5. Action taken, recorded in the audit log, and reviewed by a second person before
   termination.
6. Every safety action is reviewed monthly for pattern detection.

**The on-call rota, the paging system, and the second-reviewer roster are NOT yet
provisioned.** Until they are, this escalation path is a design, not an operating process.

## 9. Open questions for counsel and for a domestic-violence specialist

1. **The visible-pause trade-off in §3.** Notifying the other party when someone pauses
   protects against covert tracking but removes the option of quietly going dark. Is this
   the right call? A DV specialist must weigh in, and the answer may differ for minors.
2. Does the operator have a duty to warn a user it believes is being tracked coercively?
   Warning may escalate the risk. Not warning may create liability. A documented decision
   is required.
3. Duty to report suspected child abuse or endangerment: is the operator a mandated
   reporter anywhere it operates?
4. When may or must the operator disclose to law enforcement without legal process, in a
   genuine emergency? See [`law-enforcement-requests.md`](./law-enforcement-requests.md).
5. **Minors:** can a parent lawfully require a minor to keep sharing on? Can the operator
   lawfully honour a minor's revocation over a parent's objection? Product currently
   answers "the minor's revocation always wins" — confirm.
6. Evidence preservation: if a user reports stalking, should the operator preserve records
   past the 30-day retention, and does doing so conflict with the other party's deletion
   rights?
7. Liability exposure from the disclaimer that this is not a safety service — is it
   sufficient, and should the app show an in-product warning at onboarding?
8. Whether a dedicated, unlisted "quiet exit" flow for people fleeing abuse should exist,
   and whether that reintroduces covert-tracking risk.
9. Interaction with protective orders: should the product accept and act on a court order
   naming two accounts?

---

_End of draft. Do not publish._
