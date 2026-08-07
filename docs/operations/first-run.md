# First run — what only you can do

Four things need a human with account access. They are independent: none blocks
another, and the first two take about ten minutes together.

Every command here has been written against the **development** account unless it
says otherwise. Nothing in this file touches production except §3, which is the
one thing that must.

---

## 1. Confirm the alarm subscriptions, so alarms reach a person

**Right now no alarm in development reaches anybody.** Both SNS topics subscribed
`alerts@dev.kinmap.app`, and until the subscription is confirmed the topic has a
subscriber that will never receive anything. A confirmation email cannot be
resent by anyone but SNS, and it expires after three days.

First, see what state they are actually in:

```bash
aws sns list-topics --profile kinmap-development --region us-east-1 \
  --query "Topics[?contains(TopicArn, 'kinmap-development')].TopicArn" --output text
```

Then, for each topic ARN that comes back:

```bash
aws sns list-subscriptions-by-topic --topic-arn <arn> \
  --profile kinmap-development --region us-east-1 \
  --query "Subscriptions[].{Endpoint:Endpoint,Arn:SubscriptionArn}" --output table
```

A `SubscriptionArn` of literally `PendingConfirmation` is the unconfirmed case.

### The confirmation email has to be able to arrive

`alerts@dev.kinmap.app` is served by the mail-forwarding stack — SES receives it,
Lambda forwards it on. That path is verified working, so the confirmation should
land in whichever mailbox `mail-stack.ts` forwards to. If it does not, the cause
is almost always that the forward destination is not what you think it is:

```bash
aws lambda get-function-configuration \
  --function-name kinmap-development-mail-forwarder \
  --profile kinmap-development --region us-east-1 \
  --query 'Environment.Variables' --output json
```

Re-send by deleting and re-creating the subscription — there is no "resend"
API:

```bash
aws sns unsubscribe --subscription-arn <arn> --profile kinmap-development --region us-east-1
aws sns subscribe --topic-arn <arn> --protocol email \
  --notification-endpoint alerts@dev.kinmap.app \
  --profile kinmap-development --region us-east-1
```

Then click the link in the mail. Verify it took:

```bash
aws sns list-subscriptions-by-topic --topic-arn <arn> \
  --profile kinmap-development --region us-east-1 \
  --query "Subscriptions[].SubscriptionArn" --output text
```

A real ARN rather than `PendingConfirmation` is the whole test.

> Staging and production have their own topics in their own accounts, with the
> same problem and the same fix. Do development first — it is the one you will
> actually be watching this week.

---

## 2. Testing email in development, without SES production access

**You do not need production access to exercise the invitation flow.** Both
accounts are in the SES sandbox, which means SES will only deliver to addresses
that have been verified in that same account. Verifying a handful of your own
addresses is enough to run every email path end to end.

```bash
aws sesv2 create-email-identity --email-identity you@example.com \
  --profile kinmap-development --region us-east-1
```

SES emails that address a verification link. Click it, then confirm:

```bash
aws sesv2 get-email-identity --email-identity you@example.com \
  --profile kinmap-development --region us-east-1 \
  --query '{Verified:VerifiedForSendingStatus}' --output json
```

Verify **two** addresses, not one: an invitation needs a sender and a recipient
who are different people, and a plus-address (`you+kin@example.com`) counts as a
separate identity to SES and works for this.

What this covers: Cognito verification codes, password resets, family
invitations, and the security notices. That is every email the product sends.

What it does not cover: sending to somebody who has not verified. That is §3, and
it only matters at launch.

---

## 3. SES production access — the appeal

**Status: DENIED in the production account.** Until this is resolved, every
family invitation to a real person is silently undeliverable, which blocks launch
and nothing else unblocks it.

The full text to submit is in
[`ses-production-access.md`](./ses-production-access.md) — it is written out
there rather than repeated here because it must be sent verbatim, and every claim
in it was verified against the live production account. The essential facts:

- The id SES reports (`178590242200368`) is an **internal review reference, not a
  Support Center case**. There is no case at that number. Looking for one wastes
  an afternoon.
- `sesv2 put-account-details` cannot appeal a denial — it returns
  `ConflictException` exactly as it does while a request is pending.
- So the route is a **new support case of the one type Basic support allows**: a
  service limit increase. Support Center → Create case → "Looking for service
  limit increases?" → SES Sending Limits.
- It must be opened from the **production** account, signed in through the IAM
  Identity Center portal with the `KinmapProdDeploy` role. The denial and the
  limits belong to that account; development's SES state is irrelevant to it.

Since the original request, bounce and complaint handling has been added — a
default configuration set, an SNS event destination covering BOUNCE, COMPLAINT,
REJECT, RENDERING_FAILURE and DELIVERY_DELAY, account-level suppression, and
verified DKIM. That is the substantive thing that changed, and it is what the
appeal leads with.

A reply usually lands within one business day.

---

## 4. The first build on a real iPhone

This is the step that produces the first genuine evidence about background
location, and nothing before it substantiates any claim about it.

### Before you start

- The device must be registered with the Apple Developer account. It already is,
  and a development certificate exists.
- Use the wrapper, never a bare `eas build` — see
  [`setup-status.md`](./setup-status.md#building-the-app) for the three ways a
  bare invocation goes wrong invisibly.

### The build

```bash
pnpm build:ios development
```

**Run it interactively the first time.** EAS needs to create the distribution
certificate, and that is a prompt. Once it exists, later builds are
non-interactive.

The wrapper points EAS at the App Store Connect API key already on file, so there
is no Apple ID password and no two-factor prompt. Only the key's path is
exported; the key itself is never echoed, logged, or passed as an argument.

### Then, in order

1. **Install it and create an account.** This is the first end-to-end journey and
   the first thing that exercises Cognito, the API and DynamoDB together. Use one
   of the addresses you verified in §2, or the code will never arrive.
2. **Tap an invitation link on the device.** It must open the app rather than
   Safari. That is the only proof universal links work — the association file
   serving a 200 is necessary and not sufficient.
3. **Begin the real-device location matrix** in
   `docs/architecture/mobile-location-engine.md`. Until this runs, no claim about
   reliability, battery cost, geofence latency or update freshness is supported
   by anything.

### What a simulator already told us, and what it did not

The screens have been run in the iOS simulator against the live development API:
they render, they navigate, and the routing guard moves between them. That covers
layout and flow. It says nothing about location, because a simulator's location
is a menu item — and nothing about battery, permissions as a real user grants
them, or what the OS does to a suspended app.
