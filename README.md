# Family Location

A consent-based family location-sharing platform for iOS and Android.

## The consent model comes first

This is a product that locates people. That only stays legitimate if the person
being located is genuinely in control, so the following are treated as
invariants rather than features — every pull request is reviewed against them:

A user is never located unless they have

1. created or authenticated into their own account,
2. joined a family,
3. explicitly enabled location sharing,
4. granted the operating-system permissions,

and, at all times, can

5. see that sharing is currently active,
6. pause or revoke sharing immediately,
7. leave the family,
8. delete their location history,
9. delete their account.

Consequences that show up throughout the codebase: precise coordinates never
reach logs, metrics, traces, Sentry, push payloads, or URLs; every sensitive
read is authorised server-side against family membership records and writes an
audit event; authorization denials are deliberately indistinguishable from one
another so the API cannot be used to probe whether someone exists, is in a
family, or has merely paused sharing; and a removed family member loses access
immediately, with the mobile client purging its cache.

There is no covert mode, no hidden indicator, and no administrator dashboard
that shows user location by default.

## Repository layout

```
apps/mobile          Expo SDK 57 app; committed ios/ and android/ native projects
apps/mobile/modules  Local Expo module: the native Swift/Kotlin location engine
packages/            Shared TypeScript: contracts, schemas, validation, auth,
                     crypto, location-core, api-client, observability, ...
services/            13 backend Lambda services
infrastructure/      AWS CDK v2 application, 15 stacks
apps/web             Static consent and policy site served from CloudFront
docs/                Architecture, operations, privacy, release documentation
scripts/             Bootstrap, validation, CI and migration tooling
```

## Toolchain

Pinned deliberately; see `docs/operations/execution-report.md` for why each
version was chosen.

|              |                                                                 |
| ------------ | --------------------------------------------------------------- |
| Node         | 24.18.1 (LTS) — pinned in `.nvmrc`, `engines`, `eas.json`, CI   |
| pnpm         | 11.20.0                                                         |
| TypeScript   | 6.0.3 — **not** 7.x, which `typescript-eslint` does not support |
| Expo SDK     | 57.0.9                                                          |
| React Native | 0.86.2 / React 19.2.3                                           |
| AWS CDK      | 2.1134.0 (`aws-cdk-lib` 2.263.0)                                |
| JDK          | 21 · Android compileSdk 36 · Xcode 26.5                         |

## Quickstart

```bash
nvm install && nvm use          # match .nvmrc
pnpm install
pnpm typecheck && pnpm lint && pnpm test

# Native projects are committed, but regenerate them after changing app.config.ts:
pnpm --filter @family/mobile prebuild:clean
```

Location behaviour **cannot** be tested in Expo Go. Use a development build:

```bash
pnpm mobile:build:dev:ios
pnpm mobile:build:dev:android
```

## Bootstrap

Provisioning is phased and idempotent. It never accepts a secret as a command
line argument, never echoes one, and writes secrets straight to the relevant
secret store rather than to this repository.

```bash
cp bootstrap.config.example.json bootstrap.config.local.json   # git-ignored
./scripts/bootstrap/bootstrap.sh --phase prerequisites
./scripts/bootstrap/bootstrap.sh --phase github
./scripts/bootstrap/bootstrap.sh --phase aws
```

Run `--phase all` to run every phase in dependency order. Phases that depend on
an unavoidable human action (Apple enrollment, the Play Console's first app and
first upload, background-location declarations) record the gate, explain exactly
what to do, and let independent phases continue.

## What is NOT yet true

Stated plainly, because this file previously said the opposite of the truth in
both directions — it claimed `services/` and `infrastructure/` were empty long
after they were deployed and serving. What follows is what is genuinely absent.

- **Nobody has used it.** Three environments are deployed and answer on
  `api.kinmap.app`, `api.staging.kinmap.app` and `api.dev.kinmap.app`, and the
  app builds, bundles and installs. The screens have now been run in a
  simulator, but no person has used it against a real device, so nothing here is
  evidence that it is good to use.
- **Sign in with Apple is wired, and has never been used.** The button is
  enabled, the provider is configured, and the account-creation path a federated
  sign-in takes has been fixed — it previously refused every such sign-up at the
  PreSignUp trigger. Nobody has completed one. Email sign-in works.
- **Email cannot reach a stranger.** Both AWS accounts are in the SES sandbox,
  so invitations only deliver to verified addresses until AWS lifts it.
- **Background tracking has never run on a real device.** Both native engines
  compile (Android `assembleDebug` and iOS `xcodebuild` both succeed), but no
  claim is made about their reliability, battery cost, or geofence latency until
  the real-device matrix has actually been executed.
- **The legal documents have not been reviewed by a lawyer.** They say so at the
  top of each one. The treatment of minors is the largest open question; see
  `docs/privacy/privacy-policy.md` §12.
- **Known API gaps are documented, not hidden.** `docs/operations/api-gaps.md`
  lists every client method the deployed API cannot fully serve.

`docs/operations/execution-report.md` records exactly what was verified, what
failed, and every manual gate that remains.

## Branching

`development` is the default branch. Production releases originate only from a
pull request from `development` into `main`.

```
feature/* → development → staging → PR development→main → production → store
```

## License

Proprietary. All rights reserved.
