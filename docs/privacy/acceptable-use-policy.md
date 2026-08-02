# Acceptable Use Policy

> # ⚠️ DRAFT — REQUIRES REVIEW BY QUALIFIED LEGAL COUNSEL BEFORE PUBLICATION.
>
> **This document has not been reviewed by an attorney and must not be relied upon as
> legal advice or published as-is.**

---

**Status:** Draft / not published
**Document version:** `0.1.0-draft`
**Incorporated into:** [Terms of Service](./terms-of-service.md)
**Report a violation:** {{product.supportEmail}}

---

## 1. The line this product draws

{{product.name}} exists so that people who **want** to be findable by their family can be.

It does not exist to find people who do not want to be found. The distinction is the
entire product. Every feature is built so that the person being located is a participant
rather than a subject: sharing is off by default, the indicator cannot be hidden, and the
off switch is always reachable.

Using the product to defeat that — through pressure, deception, or access to someone
else's device — violates this policy regardless of whether the software technically
permitted it.

## 2. Prohibited uses

### 2.1 Non-consensual location tracking

Prohibited:

- Enabling sharing on a device belonging to another person, or on a device you gave them,
  without their knowledge and ongoing agreement.
- Creating or accessing an account on another person's behalf in order to see where they
  are.
- Configuring a device and handing it to someone without telling them sharing is on.
- Pressuring, threatening, bribing, or conditioning access to money, housing, a vehicle,
  a phone, or affection on someone keeping sharing enabled.
- Punishing someone for pausing sharing, leaving a family, or declining a live session.
- Using the product against an intimate partner, ex-partner, roommate, or family member
  who has told you — in any way — that they do not want to be located.

**Coerced consent is not consent.** A tap on "Enable sharing" made under threat does not
make the use acceptable.

### 2.2 Stalking, harassment, and abuse

- Stalking or surveilling any person.
- Using location to intimidate, ambush, follow, or confront someone.
- Repeatedly requesting live sessions after being declined. Declining requires no reason;
  treating a decline as an invitation to ask again is harassment.
- Using arrival and departure alerts to monitor someone's movements against their wishes.
- Using the product to locate someone who has obtained a protective or restraining order,
  or who has left a household to escape harm.

### 2.3 Employment, commercial, and institutional monitoring

Prohibited without exception:

- Tracking employees, contractors, gig workers, drivers, or delivery staff.
- Fleet, asset, or logistics tracking.
- Tracking students by a school, or residents by a landlord, care home, or institution.
- Any use where one party's continued income, housing, education, or care depends on
  keeping sharing on.

This product has no consent model that survives an employment relationship, so it is not
offered for one. Use a purpose-built product with the appropriate legal framework.

### 2.4 Investigative and law-enforcement use

- Private investigation, skip tracing, debt collection, bail enforcement, process serving,
  or journalism-by-surveillance.
- Law-enforcement use of a consumer account to locate a person. Official requests must go
  through the process in [`law-enforcement-requests.md`](./law-enforcement-requests.md).

### 2.5 Technical abuse

- Falsifying, spoofing, replaying, or injecting location data.
- Automating, scraping, or accessing the API outside the app.
- Circumventing rate limits, entitlement checks, encryption, or the audit log.
- Attempting to suppress, hide, or disable another user's sharing indicator or
  notifications.
- Modifying the app to remove privacy controls, or distributing such a build.
- Creating accounts to evade a block, suspension, or removal.
- Using invitations for spam or phishing.

### 2.6 Minors

- An adult must not conceal from a minor that the minor's location is being shared. A
  child is entitled to know they are being located, in language they understand.
- Locating a minor who is not in your care.
- Using the product to facilitate contact with a minor by someone the minor's guardians
  have not approved.
- **The full set of rules regarding minors is unresolved and is a question for counsel —
  see §6.**

### 2.7 Unlawful use

Any use that violates applicable law, including wiretap, electronic-surveillance,
stalking, anti-harassment, and location-privacy statutes.

## 3. What we do about violations

Depending on severity, and weighted heavily toward the safety of the person being
located:

1. In-app warning.
2. Feature restriction — for example, removing the ability to request live sessions.
3. Removal from a family.
4. Account suspension.
5. Account termination.
6. Referral to law enforcement where there is a credible risk to life.

We act on the reported user, not the reporter. **We will not tell a reported user who
reported them** when doing so could place the reporter at risk.

## 4. If this is being used against you

Read the [Safety Policy](./safety-policy.md) first — it is written for exactly this
situation and includes what happens visibly on your device if you take each action.

The short version:

- You can pause or disable sharing at any moment. It takes effect immediately; your
  position becomes unreadable, not frozen at its last value.
- You can leave a family. You do not need the owner's permission.
- You can delete your location history.
- You can see who has looked at your location, in Privacy → Access log.
- You can block a user.
- You can delete your account.
- Nobody can re-enable your sharing remotely. There is no such capability in the product.

Report abuse to {{product.supportEmail}}. If you are in immediate danger, contact your
local emergency services first.

## 5. Reporting

In-app: Settings → Support → Report a problem (`POST /v1/support/reports`).
By email: {{product.supportEmail}}.

Include what happened and who is involved. **Do not include coordinates** — we do not need
them and we do not want them in a support system.

We aim to acknowledge safety reports within one business day and to act on credible
imminent-risk reports the same day. **These targets are operational goals, not
contractual commitments, and the support rota is not yet staffed — see the README's
"what is NOT yet provisioned" section.**

## 6. Open questions for counsel

1. **Minors.** What may an adult lawfully do with a minor's location, and at what age does
   the minor's own refusal become controlling? This policy currently asserts a child must
   always be told. Confirm that is correct in each target market, and whether it can be
   stated as a rule at all.
2. Does prohibiting employer use actually shield the operator from liability if an
   employer does it anyway? Is active detection required rather than a written ban?
3. What is the operator's duty when it becomes aware of credible intimate-partner abuse
   through this product — report, warn the victim, warn the abuser's family, do nothing?
   Warning a victim may escalate risk; not warning may create liability. This needs a
   documented decision.
4. Notification duties before suspending or terminating an account, and how they interact
   with not tipping off an abuser.
5. Retention of evidence relating to a safety report, and how that squares with the
   30-day location retention and with deletion rights.
6. Jurisdictions where "consent" to location sharing between spouses is presumed or
   cannot be withdrawn — do any exist among target markets?
7. Whether refusing to serve law-enforcement requests through consumer accounts is
   sustainable, and the correct posture on emergency disclosure requests.
8. Whether this policy needs a plain-language or child-readable variant.

---

_End of draft. Do not publish._
