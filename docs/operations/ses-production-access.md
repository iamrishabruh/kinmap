# SES production access — what to do

**Status:** DENIED. Support case `178590242200368`, production account.

Until this is resolved, production SES can only send to addresses verified in
that account. Every family invitation to a real person is silently
undeliverable, so this blocks launch and nothing else unblocks it.

---

## Why the API cannot fix it

`sesv2 put-account-details` — the call that submitted the original request —
returns `ConflictException` after a denial, exactly as it did while the request
was pending. There is no API to appeal, resubmit, or read the reason. The
support case is the only route.

`sesv2 get-account` reports `ReviewDetails.Status: DENIED` and the case id, and
nothing else. `support describe-cases` needs a Business or Enterprise plan.

---

## Exactly what to do

### 1. Open the case

<https://console.aws.amazon.com/support/home#/case/?displayId=178590242200368>

Sign in as the **production** account (`kinmap-production`), not development and
not management — the case belongs to the account that made the request. Service
limit cases are viewable and repliable on the Basic support plan; this is the
documented exception to Basic's limitations, so no paid plan is needed.

### 2. Read the denial reason first

Do not paste the reply below blind. AWS states a reason, and it is usually one
of four things:

| Reason they gave                        | What actually answers it                               |
| --------------------------------------- | ------------------------------------------------------ |
| Cannot tell what the product is         | The site is live — point at it                         |
| Unclear how recipients consented        | The invitation flow: a member types a specific address |
| No bounce/complaint handling described  | This now exists and did not when the request was made  |
| Volume or use case looks like marketing | Restate: transactional only, no lists, under 100/day   |

If the reason is something else, answer that instead. The reply below is
material to draw on, not a script.

### 3. Reply with what is now true

Everything in this text was verified against the live production account on the
day it was written. Do not add to it — an unverifiable claim in an appeal is
worse than a short reply.

> This is an appeal for case 178590242200368.
>
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
