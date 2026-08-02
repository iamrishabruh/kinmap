# Apple automation

Automation for the parts of the Apple Developer portal that have an API. Written
in TypeScript, run with `tsx`, no external dependencies — the App Store Connect
JWT is minted here with `node:crypto`.

| File                | What it is                                                             |
| ------------------- | ---------------------------------------------------------------------- |
| `asc-client.ts`     | App Store Connect API client: ES256 JWT, typed errors, retry, paging.  |
| `bundle-ids.ts`     | Idempotent reconciliation of the three Kinmap bundle identifiers.      |
| `__tests__/`        | `vitest` suite for the client, including the DER→JOSE signature codec. |
| `vitest.config.mts` | Runs that suite (`scripts/` is not a workspace package).               |
| `tsconfig.json`     | Typechecks this directory; `scripts/` has no package of its own.       |

## Running it

```sh
export ASC_KEY_ID=XXXXXXXXXX
export ASC_ISSUER_ID=00000000-0000-0000-0000-000000000000
export ASC_KEY_PATH=~/.private/AuthKey_XXXXXXXXXX.p8

pnpm apple:bundle-ids --dry-run   # report what would change
pnpm apple:bundle-ids             # apply
```

The script is idempotent: running it twice makes no changes the second time. It
exits `0` on success, `1` if any bundle identifier could not be reconciled, and
`2` for a usage or credential problem.

### Environment

| Variable        | Required | Example                                | Notes                                                                                     |
| --------------- | -------- | -------------------------------------- | ----------------------------------------------------------------------------------------- |
| `ASC_KEY_ID`    | yes      | `XXXXXXXXXX`                           | The 10-character key id shown beside the key in App Store Connect. Becomes the JWT `kid`. |
| `ASC_ISSUER_ID` | yes      | `00000000-0000-0000-0000-000000000000` | The team's issuer UUID, shown above the key list. Becomes the JWT `iss`.                  |
| `ASC_KEY_PATH`  | yes      | `~/.private/AuthKey_XXXXXXXXXX.p8`     | Path to the `.p8` on disk. `~` is expanded.                                               |
| `ASC_TEAM_ID`   | no       | `HH7Q2DUJ9U`                           | Apple Developer Team ID used as `seedId`. Defaults to Kinmap's team.                      |

None of those four values is a secret — they are identifiers, and they are
useless without the private key. **The `.p8` is the secret.** It is read from
disk at runtime, never committed, never logged, never passed as a command-line
argument, and never placed in an environment variable. If any variable is
missing the script refuses to run rather than proceeding with a partial
credential.

Store the key at `~/.private/AuthKey_<key id>.p8` with mode `600`. A `.p8` can
be downloaded exactly once, at creation time; there is no API that re-issues it.
If it is lost, revoke the key and create a new one.

The key needs the **App Manager** (or Admin) role. A Developer-role key can read
identifiers but returns `403 FORBIDDEN` when creating one.

### Tests

```sh
pnpm exec vitest run --config scripts/apple/vitest.config.mts
pnpm exec tsc -p scripts/apple/tsconfig.json
```

## What `bundle-ids.ts` reconciles

| Identifier           | Name             | Environment |
| -------------------- | ---------------- | ----------- |
| `app.kinmap`         | `Kinmap`         | production  |
| `app.kinmap.dev`     | `Kinmap Dev`     | development |
| `app.kinmap.staging` | `Kinmap Staging` | staging     |

For each one it looks the identifier up, creates it (platform `IOS`) if absent,
and then enables:

- `SIGN_IN_WITH_APPLE` — the only supported sign-in method.
- `PUSH_NOTIFICATIONS` — arrival/departure and live-session notifications.
- `ASSOCIATED_DOMAINS` — universal links for invitations, plus `webcredentials`.

Capabilities that are already enabled are left alone; re-enabling one is not an
error. Background modes are declared in the Info.plist
(`apps/mobile/app.config.ts`), not through `bundleIdCapabilities`, so they are
not managed here.

`ACCESS_WIFI_INFORMATION` is deliberately **not** requested. It exposes the
current SSID/BSSID, which is itself a location signal; Kinmap derives position
from Core Location alone, so requesting it would widen both the app's data
footprint and its App Review surface for no functional gain.

Apple restricts identifier _names_ to letters, numbers and spaces, which is why
the names above are not simply the identifiers.

## Associated Domains is only half of universal links

Enabling the `ASSOCIATED_DOMAINS` capability does **not** make universal links
work. It only permits the entitlement. Links open in the app only when all of
the following also hold:

1. `apps/mobile/app.config.ts` lists the domain, which it does when `APP_DOMAIN`
   is set at build time — `applinks:<domain>` and `webcredentials:<domain>`.
2. `https://<domain>/.well-known/apple-app-site-association` is served with:
   - HTTP status `200` — **no redirect at any point**, not even `http`→`https`
     or apex→`www`. Apple's CDN does not follow redirects and treats one as a
     hard failure.
   - `Content-Type: application/json`.
   - **No** `.json` file extension in the path.
   - Valid JSON containing `<Team ID>.<bundle id>`, e.g.
     `HH7Q2DUJ9U.app.kinmap`, in `applinks.details[].appID` (or `appIDs`).
   - A publicly reachable URL: no authentication, no geo-blocking, no bot
     challenge. Apple's CDN fetches it, not the device.
3. The file is fetched by Apple's CDN and cached. Changes can take up to 24
   hours to propagate; a development build with the `applinks:` entitlement
   prefixed by `?` bypasses the CDN and fetches directly from the domain, which
   is the fastest way to test a change.

The file lives at `apps/web/public/.well-known/apple-app-site-association` and
is served by the static site; `apps/web/tests` guards its shape. Verify a
deployment with:

```sh
curl -sSIL https://kinmap.app/.well-known/apple-app-site-association
```

Look for exactly one `HTTP/2 200` and `content-type: application/json`. More
than one status line means there is a redirect, and universal links will not
work.

## What is not automated

Apple has no API for these; they remain manual, and the bootstrap records them
as gates (see `scripts/bootstrap/bootstrap.sh`, phase `apple`):

- Developer Program enrolment, legal agreements, tax and banking.
- Creating the App Store Connect API key and downloading the `.p8`.
- Push notification key (`.p8` for APNs) creation.
- Privacy nutrition labels and App Review declarations.
