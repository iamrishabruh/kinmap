# Terms of Service

> # ⚠️ DRAFT — REQUIRES REVIEW BY QUALIFIED LEGAL COUNSEL BEFORE PUBLICATION.
>
> **This document has not been reviewed by an attorney and must not be relied upon as
> legal advice or published as-is.**

---

**Status:** Draft / not published
**Document version:** `0.1.0-draft`
**Operator:** {{product.legalCompanyName}}
**Product:** {{product.name}}
**Contact:** {{product.supportEmail}}

This draft is written to describe accurately what the software does. It is **not** a
complete contract: the clauses an attorney would ordinarily insist on (governing law,
arbitration, class-action waiver, limitation of liability, warranty disclaimer,
indemnity, force majeure) are marked `TO BE DRAFTED BY COUNSEL` rather than guessed at.
Placeholder legal text is more dangerous than absent legal text.

---

## 1. What the service is

{{product.name}} lets people who have each individually agreed to it see one another's
location on a shared map. It is a convenience and coordination tool.

**It is not a safety or emergency service.** It is not a monitoring product, a
surveillance product, an employee-tracking product, or a substitute for calling emergency
services. Do not rely on it in an emergency.

## 2. The consent rule, which overrides everything else in these Terms

No person's location is collected or shown unless that person authenticated, joined a
family, turned sharing on themselves, granted the operating-system permission themselves,
can see that sharing is active, and can turn it off at any moment.

Nothing in these Terms, no subscription, no family role, and no agreement between users
can waive this. A user's ability to pause, revoke, leave, or delete is **not** a
contractual term that can be bargained away.

## 3. Eligibility and accounts

- You must be old enough to form a binding contract where you live. **The minimum age and
  the treatment of minors are unresolved — see §14.**
- One account per person. Accounts are personal and not transferable.
- You are responsible for keeping access to your sign-in method secure.
- Authentication is by email one-time code, Sign in with Apple, or Google Sign-In.

## 4. Families, roles, and what a role does _not_ mean

A family is a group of accounts. Roles are `OWNER`, `ADMIN`, `ADULT`, and `MEMBER`.

Roles govern **administrative** privileges only: who can invite, who can remove, who can
edit saved places, who can transfer ownership.

**A role never grants authority over another member's body, movements, or privacy
controls.** An `OWNER` cannot turn on another member's sharing, cannot prevent them from
pausing, cannot stop them leaving, and cannot see their location while they are paused.
Roles deliberately do **not** encode legal guardianship, and the platform does not infer
parent/child status from them.

## 5. Invitations

Invitations expire after 72 hours, may be redeemed once, and are capped at 10 active per
family. Joining is always an affirmative act by the invitee. Accepting an invitation does
**not** turn sharing on — that is a separate, explicit step.

## 6. Live sessions

A live session is a request for a temporary increase in update frequency. The target must
accept. The target may grant less time than requested, never more. The maximum is 10
minutes, after which it expires automatically. At most one live session may observe a
given person at a time. Declining requires no reason and carries no penalty.

Repeatedly requesting live sessions from someone who declines is harassment under the
[Acceptable Use Policy](./acceptable-use-policy.md).

## 7. Subscriptions and billing

- Plans: Free, Family (monthly/annual), Family Plus (monthly/annual).
- Entitlements are **server-authoritative**. The client may cache them, but the API
  re-derives them from the subscription record on every request.

|                          | Free | Family  | Family Plus |
| ------------------------ | ---- | ------- | ----------- |
| Members per family       | 2    | 6       | 12          |
| Families                 | 1    | 1       | 3           |
| Saved places             | 1    | 50      | 200         |
| Location history         | none | 30 days | 30 days     |
| Live sessions            | no   | yes     | yes         |
| Arrival/departure alerts | yes  | yes     | yes         |
| Priority support         | no   | no      | yes         |

- Purchases are made **through Apple's App Store or Google Play**, not through us.
  Subscriptions auto-renew until cancelled in the platform's own settings.
- **Refunds are handled by Apple and Google under their policies. We cannot issue a
  refund for a platform purchase.**
- Cancelling does not delete your account or your data. Deleting your account does not
  cancel a subscription — you must cancel it in the App Store or Google Play. We will say
  this in the deletion flow itself.
- A lapsed subscription downgrades entitlements. History beyond the Free plan's retention
  becomes inaccessible and is deleted on its existing 30-day TTL schedule. **Counsel: is
  advance notice of history loss legally required? See §14.**
- Price changes: **TO BE DRAFTED BY COUNSEL** (notice period, consent, platform rules).

## 8. Acceptable use

Governed by the [Acceptable Use Policy](./acceptable-use-policy.md), which is
incorporated into these Terms. In short: do not use this to stalk, coerce, monitor, or
surveil anyone, do not use it on an account that is not yours, and do not use it for
employee or contractor tracking.

## 9. Safety

Governed by the [Safety Policy](./safety-policy.md). If you are being coerced into
sharing your location, see that document — it is written for that situation specifically.

## 10. Your data

Governed by the [Privacy Policy](./privacy-policy.md), the
[Data Retention Policy](./data-retention-policy.md), and the
[Account Deletion Policy](./account-deletion-policy.md).

Notably: coordinates are encrypted at the application layer before storage, are never
written to logs, analytics, crash reports, push payloads, or URLs, and support staff have
no standing access to your data.

## 11. Availability, changes, and accuracy

- The service is provided on a best-effort basis. Location accuracy depends on your
  device, your operating system, your battery state, network coverage, and platform
  background-execution limits that we do not control.
- Points that fail plausibility checks (accuracy worse than 500 m, implied speed above
  350 m/s, clock skew, staleness beyond 72 hours) are rejected rather than shown.
- The app tells you when a position is `STALE` or when someone's permission was lost. **It
  will never display a stale position as though it were current.**
- We may change or discontinue features. Material changes to safety-critical location
  behaviour, permissions, or billing require a full store release — they are never
  delivered as a silent over-the-air update.

## 12. Suspension and termination

We may suspend or terminate an account for violations of the Acceptable Use Policy,
particularly those involving the safety of another person. Where safety permits, we will
say why. Grounds, notice, and appeal process: **TO BE DRAFTED BY COUNSEL.**

You may stop using the service at any time and delete your account from within the app.

## 13. Clauses not drafted here

The following are intentionally absent. Publishing without them, or with invented
versions of them, would be worse than publishing nothing:

- Governing law and venue — `TO BE DRAFTED BY COUNSEL`
- Dispute resolution / arbitration / class-action waiver — `TO BE DRAFTED BY COUNSEL`
- Disclaimer of warranties — `TO BE DRAFTED BY COUNSEL`
- Limitation of liability and its cap — `TO BE DRAFTED BY COUNSEL`
- Indemnification — `TO BE DRAFTED BY COUNSEL`
- Force majeure, assignment, severability, entire agreement — `TO BE DRAFTED BY COUNSEL`
- Apple's required "Licensed Application End User License Agreement" terms, including
  Apple as a third-party beneficiary — `TO BE DRAFTED BY COUNSEL`
- Consumer-protection carve-outs that cannot be disclaimed in certain jurisdictions —
  `TO BE DRAFTED BY COUNSEL`

## 14. Open questions for counsel

1. **Minimum age**, and whether a parent or guardian may accept these Terms for a minor.
   See the minors section of the [Privacy Policy](./privacy-policy.md#12-open-questions-for-counsel),
   which is the fuller list.
2. If a minor can hold an account, can they be bound by an arbitration clause? Most
   jurisdictions say no or it is contested.
3. Product asserts that a minor may pause or revoke sharing against a parent's wishes.
   Is that defensible, and does it create liability if a parent claims harm resulted?
4. Two-sided consent: when adult A shares with adult B, are there two separate contracts,
   or one contract with third-party effects? What happens when A withdraws consent but B
   claims a retained interest in historical data?
5. Is the product's refusal to offer covert tracking sufficient to avoid liability for
   users who misuse it consensually-in-form but coercively-in-fact?
6. Employer use: an outright ban is stated in the AUP. Is a ban enforceable, and is it
   sufficient to avoid the wiretap/employee-monitoring statutes that would otherwise
   apply?
7. Is location data at this granularity subject to any sector-specific statute in the
   target markets (state location-privacy acts, e.g. Illinois-style proposals)?
8. Do we need distinct regional terms, and can one document serve all target markets?
9. Subscription auto-renewal disclosure requirements vary by jurisdiction and by
   platform. Confirm the in-app paywall copy satisfies each.
10. Whether stating "this is not a safety service" is sufficient to disclaim reliance, or
    whether stronger in-product warnings are required.

---

_End of draft. Do not publish._
