# SES production access — what to do

**Status:** DENIED, in the production account. SES reports an internal review
id of `178590242200368` — see below, it is not a support case number.

Until this is resolved, production SES can only send to addresses verified in
that account. Every family invitation to a real person is silently
undeliverable, so this blocks launch and nothing else unblocks it.

---

## The case id is not a Support Center case

`sesv2 get-account` reports `ReviewDetails: { Status: DENIED, CaseId: ... }`,
and that id is an INTERNAL SES review reference. It is not a Support Center
case number, there is no case at
`console.aws.amazon.com/support/home#/case/?displayId=<that id>`, and looking
for one wastes an afternoon. Nothing is wrong with the account and nothing is
wrong with your permissions.

`sesv2 put-account-details` also cannot be used to appeal: it returns
`ConflictException` after a denial exactly as it does while a request is
pending. And `support describe-cases` needs a Business or Enterprise plan.

So the route is a NEW support case, of the one type Basic support does allow:
a service limit increase.

---

## Exactly what to do

### 1. Sign in to the production account

Use the IAM Identity Center portal — the `sso_start_url` in `~/.aws/config` —
and pick the **production** account with the `KinmapProdDeploy` role. That role
carries `PowerUserAccess` and the inline denies on it cover location data, the
coordinate key and the audit trail only, so it can open and reply to support
cases.

It must be the production account. The request, the denial and the sending
limits all belong to that account; the development account's SES state is
separate and irrelevant here.

### 2. Create a service limit increase case

Support Center -> **Create case** -> **Looking for service limit increases?**

| Field           | Value                       |
| --------------- | --------------------------- |
| Limit type      | SES Sending Limits          |
| Mail type       | Transactional               |
| Website URL     | `https://www.kinmap.app`    |
| Region          | US East (N. Virginia)       |
| Limit           | Desired Daily Sending Quota |
| New limit value | 50000                       |

The use-case description is the body below. If the denial email named a
specific reason, answer that reason first, in its own paragraph, before the
rest.

### 3. Reply with what is now true

Everything in this text was verified against the live production account on the
day it was written. Do not add to it — an unverifiable claim in an appeal is
worse than a short reply.

> Kinmap is a consent-based family location sharing app for iOS. The product is
> deployed and serving: https://www.kinmap.app is live, and the API answers at
> https://api.kinmap.app. The privacy policy and terms are published at
> https://www.kinmap.app/privacy.html and /terms.html.
>
> SES is used only for transactional mail that a user's own action triggers:
>
> - account verification codes and password resets issued by Amazon Cognito
> - family invitations, where an existing member types the specific address of
>   one person they want to invite
> - security notices, such as a new device signing in to an account
>
> There is no marketing, no newsletter and no bulk sending. We do not buy, rent,
> scrape or import lists. Every recipient is either the account holder's own
> address or an address a user entered to invite one named person.
>
> Since the original request we have added the bounce and complaint handling
> that was not in place at the time:
>
> - configuration set `kinmap-production`, set as the DEFAULT for the sending
>   identity, so no message can be sent without it
> - an SNS event destination on that configuration set receiving BOUNCE,
>   COMPLAINT, REJECT, RENDERING_FAILURE and DELIVERY_DELAY
> - account-level suppression enabled for both BOUNCE and COMPLAINT
> - the sending domain kinmap.app verified with DKIM (status SUCCESS)
>
> Recipients can stop mail at any time: an invitation expires and can be revoked
> by the sender, each notification category is individually switchable in the
> app, and deleting an account removes the address entirely.
>
> Expected volume at launch is well under 100 messages a day.

### 4. What to expect

A reply usually lands within one business day. If it is denied a second time,
the reason will be more specific — send it to me and I will tell you whether it
is something the platform can change or something that needs a different
approach.

---

## Meanwhile

Development SES is in the sandbox too, and that is fine: verify the handful of
test addresses you need with

```
aws sesv2 create-email-identity --email-identity <address> \
  --profile kinmap-development --region us-east-1
```

and click the link. That is enough to exercise the invitation flow end to end
without production access.
