# Setup status

What is provisioned, what works, and what still needs a human. Nothing is listed
as done unless a command was run against the real environment and its output
checked. Where something is unproven, it says so.

> **This document was wrong for two days.** It described a healthy development
> environment while most of the backend could not start, the entire family and
> invitation surface returned 404, geofence evaluation had never run once, and
> every alarm paged an address that could not receive mail. Every stack
> reported `CREATE_COMPLETE` throughout. The section
> [Why everything looked fine](#why-everything-looked-fine) exists so that the
> next person does not trust a green dashboard the way this document did.

---

## Three environments, all deployed

| Environment | Account        | Domain               | Stacks | Verified |
| ----------- | -------------- | -------------------- | ------ | -------- |
| development | `000000000000` | `dev.kinmap.app`     | 15     | yes      |
| staging     | `000000000000` | `staging.kinmap.app` | 15     | yes      |
| production  | `000000000000` | `kinmap.app`         | 15     | yes      |

"Verified" means `GET /v1/health` returned 200 through the environment's own
CloudFront distribution, an authorised route returned 401 from the Cognito
authorizer rather than a CloudFront short-circuit, and the WebACL is attached to
the distribution serving that domain. Not "the stacks say CREATE_COMPLETE".

**DNS.** Each environment owns its own hosted zone in its own account:
`dev.kinmap.app` and `staging.kinmap.app` are delegated from the apex, and the
apex `kinmap.app` was moved out of the management account into production so
production can issue its own certificates and write its own records. The
registrar's name servers were switched after both delegations were copied across
and confirmed to answer identically; `api.dev` and `api.staging` were re-checked
after the switch and never stopped resolving.

### Development

AWS account `000000000000`, region `us-east-1`. **Fifteen stacks**, 25 Lambda
functions, 18 DynamoDB tables. Zero alarms firing. The Synthetics canary, which
runs outside the account holding no credentials, is passing.

### The API

Verified from outside AWS, against the real hostname:

```
GET  /v1/health          -> 200  {"status":"ok"}     (the only unauthenticated route)
GET  /v1/account         -> 401  (no token presented)
GET  /v1/places          -> 401  (reaches a handler; 404 until today)
GET  /v1/live-sessions   -> 401
GET  /v1/notifications   -> 401
GET  /v1/nope            -> 404  (the route table is not enumerable)
```

**Every declared route now reaches a function that implements it.** That was not
true this morning: 28 of 52 routes were integrated with `services/api`, which
registered a handler for none of them. A test now fails if a route is ever added
without one, and the allowlist of known-dead routes it reads is empty.

Route ownership: 35 to `api`, 12 to `family-service`, 5 to `invitation-service`,
3 to the location and webhook functions.

### Backend services

All 25 functions initialise. All seven scheduled maintenance jobs were executed
against the real environment and returned clean outcomes, including
`dispatch-deletions` — the step that hands an erasure request to the worker that
carries it out, which did not exist until today.

Mail forwarding works end to end: a message to `support@dev.kinmap.app` is
received by SES, stored, forwarded by Lambda, and delivered. Verified with real
messages; zero bounces, complaints or rejects.

The public site serves every path the association file advertises to iOS —
`/invite/*`, `/i/*`, `/live/*` — plus extensionless paths and a real 404 page.
`apple-app-site-association` returns 200 as `application/json` with no redirect.

### The privacy guarantee, proven

Scanning a location table with the production deploy role returns:

> `AccessDeniedException ... is not authorized to perform: dynamodb:Scan on
resource: .../kinmap-production-CurrentLocations with an explicit deny in an
identity-based policy`

while the same role scanning a non-location table returns `ResourceNotFound` —
i.e. that call was permitted. The deny is scoped exactly to location data.

All 18 tables verified for `PAY_PER_REQUEST` billing, customer-managed KMS
encryption and point-in-time recovery, with TTL on `expiresAt` for
`LocationHistory` (the 30-day retention promise) and `Invitations`.

---

## Why everything looked fine

Every defect below deployed cleanly and reported success. They are grouped by
the reason nothing caught them, because that is the transferable part.

**A Lambda's environment is never checked against the code that reads it.**
Seven functions were deployed without variables their own config loaders
demanded. Each loads config at module scope, so the module threw before a
handler existed and every invocation returned an opaque 502. Location upload,
both location reads, every push notification and all three store webhooks were
non-functional. _Now guarded:_ `NodeService` records which service's code each
function runs, and a test parses every service's real config loader and asserts
the synthesised environment satisfies it.

**A function that is never successfully invoked emits no error metric.** Every
Lambda error alarm sat `OK` throughout, because there were no invocations to
fail. An alarm on an error rate cannot see a service that cannot start.

**A health check that only probes a healthy component.** The canary passed the
whole time; it probes `/v1/health` on the one function whose environment was
complete.

**An API Gateway route is valid whether or not the Lambda knows the path.**
28 routes returned 404 to authenticated callers. _Now guarded:_ a test compares
declared routes against registered handlers.

**Nothing type-checks across an event bus.** Two producer/consumer pairs had
drifted, and because the consumers parse strictly, every message was rejected
and dead-lettered — so geofence evaluation had never run, and no live-session
refresh had ever been delivered. The queues were being drained, just into the
DLQ. _Now guarded:_ wire-contract tests holding the exact payload the other side
sends, duplicated deliberately so a shared import cannot mask drift.

**CloudFormation will happily build a distribution over an empty bucket.** DNS
resolved, TLS was valid, and every request returned 403 — including the
association file that makes an invitation link open the app. _Now guarded:_ a
test asserts every distribution has something publishing into its origin.

**An SNS subscription can be pending forever.** Both alarm topics subscribed
`alerts@kinmap.app`, a domain with no MX record, so the confirmation could never
arrive. Every alarm in the environment paged nobody.

**An alarm can watch a metric that does not exist.** Eight of fifteen alarm
metrics were emitted by no code at all. `location-ingestion` emitted none, so
the alarm meant to catch a dead ingestion pipeline was watching an empty stream.

**A guard can be added and be wrong.** Replacing the unsupported `SEARCH`
expressions with un-dimensioned metrics looked like a fix and was not:
CloudWatch treats each dimension set as a separate stream and never rolls them
up, so those alarms watched nothing. They now use Metrics Insights queries,
which alarms support _and_ which aggregate.

---

## Blocked on you

### 1. Things only you can do

- **Open the app.** Nobody has seen a screen. It builds, bundles, installs and
  typechecks; none of that is evidence that it is any good to use.
- **Confirm the two SNS subscriptions** for `alerts@dev.kinmap.app`. Until then
  no alarm in development reaches a person.
- **Sign in with Apple.** A Services ID and a Sign in with Apple key have to be
  created in the Apple Developer portal — the App Store Connect API exposes
  neither. The button is enabled and the account-creation path behind it now
  works; without those two portal artefacts the provider itself cannot complete
  an exchange.
- **SES production access — DENIED.** Case `178590242200368`. Production can
  only email verified addresses until this is appealed; see
  `docs/operations/ses-production-access.md` for exactly what to do. The API
  cannot resubmit after a denial, so the support case is the only route. Every invitation to a real person is
  undeliverable until AWS approves the request.
- **The real-device background location matrix.** Nothing that can be built
  substantiates a claim about background tracking. No such claim is made.

### 2. Decisions, now taken

Each of these was on this list as an open question. Three of them were
engineering decisions wearing a legal costume, and are settled below. One is
genuinely counsel's and is stated as narrowly as it can be.

- **The age band is now persisted.** `AgeBand` existed but nothing stored it, on
  the reasoning that no rule turned on a band yet. That reasoning had a hole in
  it: without a stored band, Sign in with Apple could not be age-gated at all —
  a federated account carries no date of birth — so federation was a way past
  the only age check the platform has. The band (never the date) is now written
  at account creation and on the acceptance screen, `UNDER_13` is never stored
  because that account is refused, and it is returned only on the holder's own
  profile read.
- **COPPA remains counsel's, and only one question of it.** Under-13 accounts
  cannot be created, server-side, on both the native and the federated path.
  Whether they _should_ be able to exist is the question, and it is a legal one:
  serving them lawfully requires verifiable parental consent under 16 CFR
  §312.5, which is a specified process, is a project rather than a patch, and
  blocks a US launch if the answer is yes. Everything the platform can do
  without that answer is done. See `docs/privacy/privacy-policy.md` §12.
- **Google / Firebase: skipped, not deferred.** Apple and email sign-in cover
  the product. Google Sign-In on iOS needs a Google Cloud OAuth client and
  Firebase brings a second analytics and messaging stack into a codebase whose
  whole argument is that location data has exactly one path through it. Adding a
  third identity provider before one person has used the first two is work
  against an unmeasured need. The `GOOGLE_*` variables stay in `.env.example` as
  empty, and `google-sign-in.ts` stays as the seam to fill if that changes.
- **AWS Config: not deployed, and not blocking anything.** The four sequencings
  tried against the real production account are recorded in
  `infrastructure/stacks/security-stack.ts`; the short version is that Config's
  recorder and delivery channel are mutually dependent and the only shapes that
  work require running the first deploy twice, which is not a property a
  repeatable deploy may have. It is a one-time account baseline — Control Tower,
  or a script making three API calls in order — and it belongs outside the CDK
  app. GuardDuty, Security Hub, IAM Access Analyzer, the CloudTrail organisation
  trail and AWS Backup are all running, so this is a gap in configuration
  _recording_, not in detection.

---

## Repository

|                |                                                                       |
| -------------- | --------------------------------------------------------------------- |
| Monorepo       | pnpm + Turborepo, 38 workspace projects                               |
| Mobile         | Expo SDK 57.0.9, React Native 0.86.2, committed `ios/` and `android/` |
| Native engines | iOS Swift + Android Kotlin location engine; **both compile**          |
| Backend        | 17 Lambda services                                                    |
| Infrastructure | AWS CDK v2, 15 stacks, synthesises for all three environments         |
| CI             | 15 workflows, all 12 required status checks map to real jobs          |

Gates, all green: `typecheck` 38/38, `lint` 38/38 zero errors, `test` 38/38 with
**1,683 tests**, `format:check` clean, secret scan clean.

> TypeScript is pinned to **6.0.3, not the "latest" 7.0.2** — `typescript-eslint`
> caps at `<6.1.0`, so TS 7 breaks linting across the repo.

Toolchain: Node 24.18.1 (LTS), pnpm 11.20.0, TypeScript 6.0.3, OpenJDK 21,
Android SDK 36, Xcode 26.5, CocoaPods 1.17.0, AWS CLI 2.36, CDK 2.1134.0,
EAS CLI 21.4.0, Sentry CLI 0.40.0.

### Mobile app

`apps/mobile/.env.local` (git-ignored) is populated from deployed CloudFormation
outputs. EAS project **`@rishabruh/kinmap`**, id
`7cfe193d-e29a-404d-a2f2-20f858aa9c32`. `eas config` resolves cleanly and reports
bundle identifier `app.kinmap.dev`, matching the Apple portal.

> `APP_BUNDLE_ID` is the **base** id, `app.kinmap`. `app.config.ts` appends the
> variant suffix, so putting the suffixed id there yields `app.kinmap.dev.dev` —
> an identifier that exists nowhere, failing the build with a signing error that
> names the wrong cause.

### Apple Developer portal

Provisioned through the App Store Connect API, verified idempotent.

| Bundle ID            | Resource     | Capabilities                                                |
| -------------------- | ------------ | ----------------------------------------------------------- |
| `app.kinmap`         | `AXDG4JXHJW` | `APPLE_ID_AUTH`, `PUSH_NOTIFICATIONS`, `ASSOCIATED_DOMAINS` |
| `app.kinmap.dev`     | `F97PVDB3KH` | same                                                        |
| `app.kinmap.staging` | `M6Z9F2YLW2` | same                                                        |

> This table used to claim Sign in with Apple was enabled. It was not, on any of
> the three, and had never been. The provisioning script asked for
> `SIGN_IN_WITH_APPLE`, which is not a value Apple accepts — the real identifier
> is `APPLE_ID_AUTH`, and it additionally requires a configuration. Apple
> rejected both mistakes with HTTP 409, and the script treated _every_ 409 as
> "already enabled", so it printed success and the docs copied it. Verified now
> by reading the capabilities back from the API rather than from the script's
> own report.

### Identifiers

Recorded in `bootstrap.config.local.json` (git-ignored). Domain `kinmap.app`,
hosted zone `Z00000000000000000`; dev subdomain `dev.kinmap.app`, delegated
zone `Z00000000000000000`; Apple Team ID `HH7Q2DUJ9U`; ASC key `XXXXXXXXXX`,
issuer `00000000-0000-0000-0000-000000000000`; Expo `rishabruh`; Sentry org
`reachmind`; GitHub `iamrishabruh`. Seller name: Rishabh Chouhan.

The App Store Connect `.p8` is at `~/.private/AuthKey_XXXXXXXXXX.p8`, owner-only,
never committed, never logged, never passed as a command-line argument.

---

## WAF now protects the API — closed

For a long time the WebACL was deployed, reviewed, versioned and filtering
nothing. WAFv2 attaches only to an ALB, an API Gateway **REST** API, AppSync, a
Cognito user pool, App Runner or CloudFront, and this platform serves an API
Gateway **HTTP** API. Nothing failed and no alarm fired; the only evidence was a
comment saying so.

CloudFront now serves `api.<domain>` in all three environments and carries the
ACL at CLOUDFRONT scope. API Gateway moved to the origin hostname, and the
default `execute-api` endpoint is disabled **everywhere**, not only in
production — leaving it open in development would have meant the environment
used to rehearse changes was the one where the protection being rehearsed was
absent.

Caching is disabled outright rather than tuned down: every route is either
authorised per-principal or a provider webhook, so a cached response is one
family member's location served to another.

Verified in development and staging: `/v1/health` returns 200 through the
distribution, `/v1/families` returns 401 from the Cognito authorizer rather than
a CloudFront short-circuit (so the `Authorization` header is being forwarded),
a POST body reaches the origin, and the raw `execute-api` hostname no longer
answers. Two synth-time guards were confirmed to fail when the ACL is put back
to REGIONAL and when the default endpoint is re-enabled.

**The bypass is closed.** CloudFront injects a generated secret as an origin
request header, and every function the API routes to refuses a request without
it. Verified against the live development environment:

| Request                                        | Result                               |
| ---------------------------------------------- | ------------------------------------ |
| `api.dev.kinmap.app/v1/health`                 | 200                                  |
| `api.dev.kinmap.app/v1/families`               | 401 from the Cognito authorizer      |
| origin hostname `/v1/health`                   | **404**                              |
| origin hostname `/v1/webhooks/revenuecat`      | **404**                              |
| origin + a guessed header                      | **404**                              |
| through the edge + an attacker-supplied header | unchanged — CloudFront overwrites it |

**What that does and does not mean.** No Lambda invocation is possible at the
origin without the header: either this check answers 404, or — on an
authenticated route — the JWT authorizer answers 401 before the function is
ever invoked. So no compute runs and no data is reachable off-edge.

What is still reachable without passing the WebACL is API Gateway itself: an
unauthenticated request to the origin gets a 401 from the authorizer, and that
costs an API Gateway request. That is a smaller surface than it was — request
cost rather than compute or data — but it is not nothing, and the honest way to
close it entirely is mutual TLS on the custom domain, which is not built.

Enforcement is a per-environment flag because the header and the requirement
land in different stacks and CDK deploys them in the wrong order. The rollout is
two deploys of one commit; the flag is what makes the safe order impossible to
get wrong, and a synth guard fails on a partial rollout in either direction.

---

## The mobile app

Sign-in, sign-up, email verification, MFA, password recovery, terms re-acceptance,
onboarding and the family map are implemented on top of the existing feature
layer, and `expo export` bundles all of it.

Three things were found only by building the screens, and each had been true for
a long time:

- **Metro could never have bundled this app.** Workspace packages write relative
  imports with a `.js` extension, which Node's ESM resolver requires and Metro
  resolves literally. There was no `metro.config.js`. It went unnoticed because
  the app had one route file that imported no workspace package — the EAS builds
  that passed earlier were building an app with no screens in it.
- **`installAuthBridge()` had no caller**, so every authenticated request went
  out without a token, despite its own docstring saying installing it is "the
  first thing the root layout does".
- **The routing guard was never mounted.** `routing.ts` held the entire
  navigation decision and nothing evaluated it, so a cold start hit the
  unmatched-route screen and a successful sign-in left the user on the sign-in
  form.

That is four instances this week of carefully written logic wired to nothing —
counting the deletion dispatcher and the `FamilyApi` transport. It is the failure
mode this codebase is most prone to, and most of the guard tests added this week
aim at it.

`docs/operations/api-gaps.md` records eleven methods the deployed API cannot
fully serve, each documented rather than stubbed.

## Not built, and not claimed

- **The screens exist and the app bundles, but none has run on a device.**
  Twenty route files, an implemented `FamilyApi` transport, a mounted routing
  guard, and `expo export` producing a 5.9MB iOS bundle. What has NOT happened is
  anybody opening it: no screen has been seen, no flow walked, no layout checked
  against a real display. Compiling and bundling say nothing about whether it
  works.
- **Background tracking has never run on a real device.** Both native engines
  compile. No claim is made about reliability, battery cost, geofence latency or
  update freshness until the real-device matrix in
  `docs/architecture/mobile-location-engine.md` has been executed.
- **No app has been built through EAS**, submitted to TestFlight, or run on a
  physical device.
- **No end-to-end user journey has been exercised.** Every route now reaches a
  handler and returns the right answer to an unauthenticated caller, but no
  account has been created, no family formed, no location ingested. Routes
  answering correctly at the edge is not the same as the product working.
- **`migrations/`** contains no migrations yet.

### Fixed since this list was written

- ~~**Staging and production carry no application infrastructure.**~~ Both now
  carry all fifteen stacks; see the table at the top of this document, which
  contradicted this bullet for some time.
- ~~**A federated sign-in produces no account row.**~~ Fixed twice, because the
  first fix was not enough. `pre-token-generation.ts` provisions the profile at
  the first moment a federated user has a subject — but PreSignUp was still
  refusing every federated sign-up before that could ever run, because it
  demanded a terms acceptance and a date of birth that the hosted UI's
  authorization-code grant cannot carry. Both are now gated after the fact, on
  the acceptance screen, against a profile that honestly records neither until
  the user provides them.
- ~~**`custom:device_id` is not minted.**~~ Still not minted, and now a decision
  rather than a gap: the claim cannot survive a token refresh, because Cognito
  passes no `clientMetadata` on `REFRESH_TOKEN_AUTH`. The reasoning is in
  `packages/auth/src/device-binding.ts`.
- ~~**Branding is inconsistent below the surface.**~~ The schemes are
  `kinmap-dev` / `kinmap-staging` / `kinmap` and the background task identifiers
  are `app.kinmap.engine.*`. Done in the window where it was free — no build has
  ever been installed by anybody, so no link was broken. The Kotlin package
  namespace `com.familylocation.locationengine` is deliberately left alone: it is
  internal, is registered with no store, does not appear in any user-visible
  identifier, and renaming it is a directory move across every file in the engine
  for no gain.
- ~~**No GitHub repository.**~~ `iamrishabruh/kinmap`, and `origin` is
  configured. It is **public** — this document said private in two places, which
  is the kind of error that matters here rather than a detail: several decisions
  in this repository, including moving the account identifiers into secrets and
  redacting the pool name from every fixture, are justified by the fact that
  anybody can read this. They are correct. The description of why was not.

---

## Building the app

Use the wrapper, not `eas build` directly:

```bash
pnpm build:ios development            # ad-hoc, for a registered device
pnpm build:ios development-simulator  # no signing at all
```

It exists because a bare `eas build` goes wrong in three ways that are invisible
until it does something surprising:

- **The EAS CLI does not load `.env.local`.** The Expo CLI does. Without it the
  config fell back to defaults, and when those were placeholders EAS created a
  **new project** rather than failing. That happened twice. The defaults are
  pinned now and a check asserts it, but the file still carries the API URL and
  Cognito ids the build embeds.
- **Apple credentials otherwise want an Apple ID and password.** The wrapper
  points EAS at the App Store Connect API key already on file: no password, no
  two-factor prompt, no session expiring mid-build. Only the key's path is
  exported; the key is never echoed, logged or passed as an argument.
- **`~/.app-store/auth/` caches the last identity used.** It had the _Expo_
  username written into it, so EAS kept proposing a username that could never
  authenticate against Apple.

> **Config plugins must be JavaScript.** The EAS CLI resolves them with a plain
> `require`, which cannot load `.ts` — `node -e "require('./plugins/…')"` fails
> with MODULE_NOT_FOUND. The Expo CLI registers a TypeScript loader first, so
> `expo prebuild` applies them correctly while every `eas build` dies. `eas
config` does not evaluate plugins at all and cannot detect this.

> **`runtimeVersion` must be a literal**, not `{ policy: 'appVersion' }`.
> Policies are managed-workflow only, and this project commits `ios/` and
> `android/`. It must move with `version`: the runtime version decides whether
> an OTA update may run against an installed binary.

`pnpm validate:mobile-identity` checks all of the above — project identity
without env help, plugin resolvability under a plain `node`, and runtime-version
drift. It runs in CI.

A simulator build has been verified end to end: native project, the autolinked
Swift engine, both config plugins and the JS bundle all compile, artifact
produced.

## Order of operations from here

Every outstanding step is written out, with the exact commands, in
[`first-run.md`](./first-run.md).

1. Confirm the two SNS alarm subscriptions, so an alarm reaches a person.
2. Verify two addresses in development SES — that is all the invitation flow
   needs. Production access is a launch blocker, not a testing one.
3. First development build onto a real iPhone — `pnpm build:ios development`,
   run interactively once so EAS can create the distribution certificate. The
   device is already registered and a development certificate exists.
4. Create an account against the live development API — the first end-to-end
   journey, and the first thing that exercises Cognito, the API and DynamoDB
   together.
5. Tap an invitation link on the device and confirm it opens the app rather than
   Safari — the only proof that universal links work.
6. Begin the real-device location matrix — the only thing that can substantiate
   any claim about background tracking.
7. Open the SES production-access appeal, from the production account.
8. Create the Apple Services ID and the Sign in with Apple key in the developer
   portal — the two artefacts the App Store Connect API cannot produce.

Already done, kept so the sequence reads:

- ~~Create the GitHub repository and push.~~ `iamrishabruh/kinmap`, public.
- ~~Decide the WAF architecture, then deploy staging.~~ CloudFront, and staging
  is live and verified.
- ~~Production.~~ Deployed, with explicit approval, after moving the apex zone
  into the production account.
- ~~Origin verification, so the CloudFront hop cannot be bypassed.~~ Closed; see
  the WAF section above for what it does and does not mean.
