# Setup status

What is provisioned, what is written but not yet run, and what still needs a
human. Kept honest: nothing is listed as done unless it was verified by running
the command.

Last verified: the commit that introduced this file.

---

## Done and verified

### Repository

|                |                                                                       |
| -------------- | --------------------------------------------------------------------- |
| Monorepo       | pnpm + Turborepo, 27 workspace projects                               |
| Mobile         | Expo SDK 57.0.9, React Native 0.86.2, committed `ios/` and `android/` |
| Native engines | iOS Swift + Android Kotlin location engine; **both compile**          |
| Backend        | 12 Lambda services                                                    |
| Infrastructure | AWS CDK v2, 12 stacks, synthesises for all three environments         |
| Public site    | `apps/web`, including the universal-link association files            |
| CI             | 15 workflows, all 12 required status checks map to real jobs          |

Quality gates, all green: `typecheck` 37/37, `lint` 37/37 zero errors,
`test` 37/37 with **1,553 tests**, `format:check` clean, secret scan clean.

### Toolchain

Node 24.18.1 (LTS), pnpm 11.12.0, TypeScript 6.0.3, OpenJDK 21, Android SDK 36,
Xcode 26.5 with the iOS 26.5 simulator runtime, CocoaPods 1.17.0, AWS CLI 2.36,
CDK 2.1134.0, EAS CLI 21.4.0, Sentry CLI 0.40.0.

> TypeScript is pinned to **6.0.3, not the "latest" 7.0.2** — `typescript-eslint`
> caps at `<6.1.0`, so TS 7 breaks linting across the repo. The Expo 57 template
> independently pins the same version.

### AWS

Four accounts in organization `o-xxxxxxxxxx`, split across NonProduction and
Production OUs. Four permission sets, scoped so that routine production access
**cannot read location data**. Full detail in [aws-accounts.md](./aws-accounts.md).

Root user has MFA enabled and is no longer in routine use.

### Development environment — DEPLOYED

AWS account `000000000000`. Ten stacks live, including all 17 DynamoDB tables.
Verified on the real tables: PAY_PER_REQUEST billing, customer-managed KMS
encryption, point-in-time recovery enabled, and TTL on `expiresAt` for
`LocationHistory` (the 30-day retention promise) and `Invitations`.

SES inbound is active for `support@`, `privacy@`, `security@dev.kinmap.app`.
The receipt rule set had to be activated by hand — CloudFormation cannot do it,
and without that step SES accepts mail and silently discards it.

**The location-data guardrail is proven, not just configured.** Scanning a
location table with the production deploy role returns:

> `AccessDeniedException ... is not authorized to perform: dynamodb:Scan on
resource: .../kinmap-production-CurrentLocations with an explicit deny in an
identity-based policy`

while the same role scanning a non-location table returns `ResourceNotFound` —
i.e. the call was permitted. The deny is scoped exactly to location data.

### Apple Developer portal

Provisioned through the App Store Connect API by `scripts/apple/bundle-ids.ts`
— no console clicking. Verified idempotent: a third consecutive run changes
nothing.

| Bundle ID            | Resource     | Capabilities                                               |
| -------------------- | ------------ | ---------------------------------------------------------- |
| `app.kinmap`         | `AXDG4JXHJW` | Sign in with Apple, Push Notifications, Associated Domains |
| `app.kinmap.dev`     | `F97PVDB3KH` | same                                                       |
| `app.kinmap.staging` | `M6Z9F2YLW2` | same                                                       |

> Associated Domains being enabled is necessary but **not sufficient** for
> universal links. `https://kinmap.app/.well-known/apple-app-site-association`
> must also be served over HTTPS with `content-type: application/json` and no
> redirect. That file exists in `apps/web` and is asserted by tests, but it is
> not deployed until `WebStack` is.

### Identifiers on file

Everything below is recorded in `bootstrap.config.local.json` (git-ignored).

|               |                                                             |
| ------------- | ----------------------------------------------------------- |
| Domain        | `kinmap.app`, hosted zone `Z00000000000000000`           |
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

### 1. Sign in to AWS — blocks every deployment

```bash
aws sso login --profile kinmap-development
aws sts get-caller-identity --profile kinmap-development
```

The ARN should contain `KinmapAdmin` and account `000000000000`. One login covers
every profile. Until this runs, nothing can be bootstrapped or deployed.

### 2. Google / Firebase — only when you add Android or Google Sign-In

Deliberately deferred while the project is iOS-first. Note that **Google Sign-In
on iOS also needs a Google Cloud OAuth client** — if you ship Apple + email
sign-in only, you can skip Google entirely for now.

### 3. Decisions, not tasks

- **Seller name.** Individual enrollment means the App Store lists
  **Rishabh Chouhan**. Switching to an Organization enrollment needs a D-U-N-S
  number and is far easier before the first publish than after. You have said
  this is fine — recorded.
- **COPPA.** A family location product will have children on it. This materially
  changes what you may collect and must disclose. It is the first open question
  in `apps/web/public/privacy.html` and needs a lawyer before launch, not after.

---

## Written but not yet run

These exist in the repository and are ready; they need the AWS login above, or a
deliberate decision to run them.

| What                           | Where                                           | Needs                  |
| ------------------------------ | ----------------------------------------------- | ---------------------- |
| CDK bootstrap of all accounts  | `scripts/aws/bootstrap-accounts.sh`             | AWS login              |
| Development stack deploy       | `pnpm cdk:deploy`                               | AWS login              |
| SES mail forwarding            | `infrastructure/stacks/mail-stack.ts`           | AWS login              |
| Service Control Policies       | `scripts/aws/service-control-policies.sh`       | a decision — see below |
| GitHub repository and rulesets | `scripts/bootstrap/bootstrap.sh --phase github` | a decision — see below |

SCPs are not attached yet because they restrict what the accounts can do, and
there is nothing in them worth protecting until the first deploy lands.

The GitHub repository has **not** been created. The work is committed locally on
`main` and `development`, with no remote configured. Creating and pushing to a
repository is outward-facing, so it waits for you to say go.

---

## Known architectural gap: WAF is not protecting the API

WAFv2 attaches only to an ALB, an API Gateway **REST** API, AppSync, a Cognito
user pool, App Runner, or CloudFront. This platform uses an API Gateway **HTTP**
API, which is not on that list — the association fails at deploy time with a
misleading "The ARN isn't valid" error. The ARN is correct; the resource type is
unsupported.

The WebACL and its rules are still defined and versioned so they are ready to
attach. Two ways to close it, both a deliberate decision rather than a fix:

1. **CloudFront in front of the API**, with the ACL moved to CLOUDFRONT scope.
   The usual answer, and it also buys edge caching. Adds a hop and a cache
   invalidation story.
2. **Migrate to a REST API.** Roughly 3.5x the per-request cost and loses the
   JWT authorizer this design relies on.

What IS active in the meantime: API Gateway per-route throttling, and the
per-principal token bucket in `services/api` — the control that the rate limits
in `@family/contracts` actually describe. What is missing is the managed rule
groups (common exploits, bad inputs) and the IP-based rate rule.

## Not built

Stated plainly so nothing here is mistaken for working software.

- **Most mobile screens.** The feature layer beneath them — auth, billing, live
  sessions, location engine integration, privacy caches, map models — is
  implemented and tested. The Expo Router screens on top mostly are not.
- **Nothing is deployed anywhere.** No AWS resources beyond the accounts and
  access configuration themselves. No app has been built through EAS, submitted
  to TestFlight, or run on a physical device.
- **Background tracking has never run on a real device.** Both native engines
  compile. No claim is made about reliability, battery cost, geofence latency or
  update freshness until the real-device matrix in
  `docs/architecture/mobile-location-engine.md` has actually been executed.
- **`migrations/`** contains no migrations yet.

---

## Order of operations from here

1. `aws sso login --profile kinmap-development`
2. CDK bootstrap the three accounts
3. Deploy the development stack, confirm it comes up
4. Deploy mail forwarding, verify `support@kinmap.app` reaches your inbox
5. Deploy `WebStack` so the association file is actually served
6. Create the GitHub repository and push
7. First EAS development build, install on a real iPhone
8. Begin the real-device location matrix — the only thing that can substantiate
   any claim about background tracking
