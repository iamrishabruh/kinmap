# Setup status

What is provisioned, what is written but not yet run, and what still needs a
human. Kept honest: nothing is listed as done unless a command was run and its
output checked. Where something is unproven, it says so.

---

## Done and verified

### Repository

|                |                                                                       |
| -------------- | --------------------------------------------------------------------- |
| Monorepo       | pnpm + Turborepo, 38 workspace projects                               |
| Mobile         | Expo SDK 57.0.9, React Native 0.86.2, committed `ios/` and `android/` |
| Native engines | iOS Swift + Android Kotlin location engine; **both compile**          |
| Backend        | 12 Lambda services                                                    |
| Infrastructure | AWS CDK v2, 12 stacks, synthesises for all three environments         |
| Public site    | `apps/web`, including the universal-link association files            |
| CI             | 15 workflows, all 12 required status checks map to real jobs          |

Quality gates, all green: `typecheck` 38/38, `lint` 38/38 zero errors, `test`
38/38 with **1,584 tests**, `format:check` clean, secret scan clean.

> TypeScript is pinned to **6.0.3, not the "latest" 7.0.2** — `typescript-eslint`
> caps at `<6.1.0`, so TS 7 breaks linting across the repo. The Expo 57 template
> independently pins the same version.

### Toolchain

Node 24.18.1 (LTS), pnpm 11.12.0, TypeScript 6.0.3, OpenJDK 21, Android SDK 36,
Xcode 26.5 with the iOS 26.5 simulator runtime, CocoaPods 1.17.0, AWS CLI 2.36,
CDK 2.1134.0, EAS CLI 21.4.0, Sentry CLI 0.40.0.

### AWS accounts

Four accounts in organization `o-xxxxxxxxxx`, split across NonProduction and
Production OUs. Four permission sets, scoped so that routine production access
**cannot read location data**. Full detail in [aws-accounts.md](./aws-accounts.md).

Root user has MFA enabled and is no longer in routine use.

**The location-data guardrail is proven, not merely configured.** Scanning a
location table with the production deploy role returns:

> `AccessDeniedException ... is not authorized to perform: dynamodb:Scan on
resource: .../kinmap-production-CurrentLocations with an explicit deny in an
identity-based policy`

while the same role scanning a non-location table returns `ResourceNotFound` —
i.e. that call was permitted. The deny is scoped exactly to location data.

### Development environment — deployed and answering

AWS account `000000000000`, region `us-east-1`. **Twelve of twelve stacks
`CREATE_COMPLETE`**: foundation, security, data, identity, notification,
location, billing, mail, migration, web, api, observability.

The API is live on its real hostname, verified end to end from outside AWS:

```
GET https://api.dev.kinmap.app/v1/health   -> 200  {"status":"ok"}
GET https://api.dev.kinmap.app/v1/account  -> 401  (no token presented)
GET https://api.dev.kinmap.app/v1/nope     -> 404  (route table is not enumerable)
```

TLS verifies against the ACM certificate, DNS resolves through the delegated
`dev.kinmap.app` zone, and the CloudWatch Synthetics canary — which runs outside
the account and holds no credentials — is **passing**. **Zero alarms are
firing**, metric or composite.

Verified on the real DynamoDB tables (all 17): `PAY_PER_REQUEST` billing,
customer-managed KMS encryption, point-in-time recovery enabled, and TTL on
`expiresAt` for `LocationHistory` (the 30-day retention promise) and
`Invitations`.

SES inbound receipt rules are active for `support@`, `privacy@` and
`security@dev.kinmap.app`. The rule set had to be activated by hand —
CloudFormation cannot do it, and without that step SES accepts mail and silently
discards it.

The public site is deployed and serving. Verified from outside AWS:

```
https://app.dev.kinmap.app/                                    -> 200
https://dev.kinmap.app/                                        -> 200
https://app.dev.kinmap.app/.well-known/apple-app-site-association
    -> 200, content-type: application/json, no redirect
    -> HH7Q2DUJ9U.app.kinmap, .dev and .staging
```

That file is the prerequisite for an invitation link opening the app rather than
Safari. It is necessary but still not sufficient — nothing is proven until a
signed build is installed on a device and a link is tapped.

### Mobile app wiring

`apps/mobile/.env.local` (git-ignored) is populated from the deployed
CloudFormation outputs, not typed by hand: API URL `https://api.dev.kinmap.app`,
Cognito pool `us-east-1_XXXXXXXXX`, client `xxxxxxxxxxxxxxxxxxxxxxxxxx`.

The EAS project is created and linked: **`@rishabruh/kinmap`**, id
`7cfe193d-e29a-404d-a2f2-20f858aa9c32`. `eas config --platform ios --profile
development` resolves cleanly and reports bundle identifier `app.kinmap.dev`,
which matches the identifier provisioned in the Apple portal.

> `APP_BUNDLE_ID` in that file is the **base** id, `app.kinmap`. `app.config.ts`
> appends the variant suffix itself, so putting the suffixed id there yields
> `app.kinmap.dev.dev` — an identifier that exists nowhere in the Apple portal,
> failing the build with a signing error that names the wrong cause.

### Apple Developer portal

Provisioned through the App Store Connect API by `scripts/apple/bundle-ids.ts` —
no console clicking. Verified idempotent: a third consecutive run changes
nothing.

| Bundle ID            | Resource     | Capabilities                                               |
| -------------------- | ------------ | ---------------------------------------------------------- |
| `app.kinmap`         | `AXDG4JXHJW` | Sign in with Apple, Push Notifications, Associated Domains |
| `app.kinmap.dev`     | `F97PVDB3KH` | same                                                       |
| `app.kinmap.staging` | `M6Z9F2YLW2` | same                                                       |

> Associated Domains being enabled is necessary but **not sufficient** for
> universal links. `https://kinmap.app/.well-known/apple-app-site-association`
> must also be served over HTTPS with `content-type: application/json` and no
> redirect.

### Identifiers on file

Everything below is recorded in `bootstrap.config.local.json` (git-ignored).

|               |                                                             |
| ------------- | ----------------------------------------------------------- |
| Domain        | `kinmap.app`, hosted zone `Z00000000000000000`           |
| Dev subdomain | `dev.kinmap.app`, delegated zone `Z00000000000000000`    |
| Apple Team ID | `HH7Q2DUJ9U` (Individual enrollment)                        |
| ASC API key   | `XXXXXXXXXX`, issuer `00000000-0000-0000-0000-000000000000` |
| Bundle IDs    | `app.kinmap`, `.dev`, `.staging`                            |
| Expo          | `rishabruh`                                                 |
| Sentry        | org `reachmind`                                             |
| GitHub        | `iamrishabruh`, scopes include `workflow`                   |
| Seller name   | Rishabh Chouhan                                             |

The App Store Connect `.p8` is at `~/.private/AuthKey_XXXXXXXXXX.p8`, owner-only.
It is never committed, never logged, and never passed as a command-line argument.

---

## Blocked on you

### 1. Click two SES verification emails — blocks all mail forwarding

Both non-production accounts are in the **SES sandbox**, which means mail can
only be delivered to a verified address. `rchouhan.network@gmail.com` is
registered as an identity in each account but is **not yet verified**, so
forwarding to it silently fails.

Fresh verification emails were sent from both accounts. Two separate emails, two
separate clicks — one is not enough:

| From account | ID             | Subject                                                  |
| ------------ | -------------- | -------------------------------------------------------- |
| development  | `000000000000` | Amazon Web Services – Email Address Verification Request |
| staging      | `000000000000` | same, sent separately                                    |

Confirm with:

```bash
aws sesv2 list-email-identities --profile kinmap-development --region us-east-1 \
  --query 'EmailIdentities[].[IdentityName,VerifiedForSendingStatus]' --output text
```

Both should read `true`. If a link has expired, resend with
`aws ses verify-email-identity --email-address rchouhan.network@gmail.com --profile <profile> --region us-east-1`.

The `dev.kinmap.app` **domain** identity needs nothing from you — its three DKIM
CNAMEs are published and resolving publicly, and SES verifies it on its own
schedule.

### 2. Delete one stray Expo project — 30 seconds, needs your password

The first `eas init` ran before `.env.local` existed, so it fell back to the
default slug and created `@rishabruh/family-location`. The correct project,
`@rishabruh/kinmap`, was created afterwards and is the one everything points at.
The stray one is empty and harmless, but deleting it needs an interactive
password confirmation that cannot be automated:

```bash
cd apps/mobile
eas project:delete @rishabruh/family-location
```

### 3. Google / Firebase — only when you add Android or Google Sign-In

Deliberately deferred while the project is iOS-first. Note that Google Sign-In
**on iOS** also needs a Google Cloud OAuth client — if you ship Apple and email
sign-in only, Google can be skipped entirely for now.

### 4. Decisions, not tasks

- **COPPA.** A family location product will have children on it. This materially
  changes what may be collected and what must be disclosed. It is the first open
  question in `apps/web/public/privacy.html` and needs a lawyer before launch,
  not after.
- **WAF architecture.** See the gap below — two options, both a deliberate
  trade-off rather than a fix.
- **Seller name.** Individual enrollment means the App Store lists **Rishabh
  Chouhan**. Switching to Organization enrollment needs a D-U-N-S number and is
  far easier before the first publish than after. You have said this is fine.

---

## Written but not yet run

| What                           | Where                                           | Needs                  |
| ------------------------------ | ----------------------------------------------- | ---------------------- |
| Staging stack deploy           | `CDK_ENVIRONMENT=staging pnpm cdk:deploy`       | a decision             |
| Production stack deploy        | `CDK_ENVIRONMENT=production pnpm cdk:deploy`    | **explicit approval**  |
| Service Control Policies       | `scripts/aws/service-control-policies.sh`       | a decision — see below |
| GitHub repository and rulesets | `scripts/bootstrap/bootstrap.sh --phase github` | a decision — see below |

Staging and production accounts are CDK-bootstrapped (`CDKToolkit` is their only
stack) but carry no application infrastructure.

SCPs are not attached yet because they restrict what the accounts can do, and
development is still the only account holding anything.

The GitHub repository has **not** been created. The work is committed locally on
`main` and `development`, with no remote configured. Creating and pushing a
repository is outward-facing, so it waits for you to say go.

---

## Known gap: WAF is not protecting the API

WAFv2 attaches only to an ALB, an API Gateway **REST** API, AppSync, a Cognito
user pool, App Runner, or CloudFront. This platform uses an API Gateway **HTTP**
API, which is not on that list — the association fails at deploy time with a
misleading `The ARN isn't valid`. The ARN is correct; the resource type is
unsupported.

The WebACL and its rules are still defined, deployed and versioned, so they are
ready to attach. Two ways to close it:

1. **CloudFront in front of the API**, with the ACL moved to CLOUDFRONT scope.
   The usual answer, and it buys edge caching. Adds a hop and a cache
   invalidation story.
2. **Migrate to a REST API.** Roughly 3.5× the per-request cost, and it loses the
   JWT authorizer this design relies on.

Active in the meantime: API Gateway per-route throttling, and the per-principal
token bucket in `services/api` — the control the rate limits in
`@family/contracts` actually describe. Missing are the managed rule groups
(common exploits, bad inputs) and the IP-based rate rule.

---

## Not built

Stated plainly so nothing here is mistaken for working software.

- **Most mobile screens.** The feature layer beneath them — auth, billing, live
  sessions, location engine integration, privacy caches, map models — is
  implemented and tested. The Expo Router screens on top mostly are not.
- **Background tracking has never run on a real device.** Both native engines
  compile. No claim is made about reliability, battery cost, geofence latency or
  update freshness until the real-device matrix in
  `docs/architecture/mobile-location-engine.md` has actually been executed.
- **No app has been built through EAS**, submitted to TestFlight, or run on a
  physical device.
- **No end-to-end user journey has been exercised.** The API answers and rejects
  correctly at the edge, but no account has been created, no family formed and no
  location ingested.
- **Branding is inconsistent below the surface.** The deep-link scheme is still
  `familylocation-dev` and the iOS background task identifiers are still
  `com.familylocation.engine.*`. Both are baked into the committed native
  projects and the Swift engine's `BGTaskScheduler` registration, so renaming
  them means regenerating and re-verifying the native build. Worth doing before
  the first TestFlight submission, not after.
- **`migrations/`** contains no migrations yet.

---

## Order of operations from here

1. Click both SES verification emails, then send a test message to
   `support@dev.kinmap.app` and confirm it arrives
2. First EAS development build, install on a real iPhone —
   `cd apps/mobile && eas build --profile development --platform ios`
3. Create an account against the live development API: the first end-to-end
   journey, and the first thing that exercises Cognito, the API and DynamoDB
   together
4. Tap an invitation link on the device and confirm it opens the app rather than
   Safari — the only proof that universal links work
5. Begin the real-device location matrix — the only thing that can substantiate
   any claim about background tracking
6. Create the GitHub repository and push
7. Decide the WAF architecture, then deploy staging
8. Production, only with explicit approval
