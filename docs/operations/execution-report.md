# Execution report — Phase A discovery

Generated on the bootstrap machine before any installation, authentication, or
provisioning took place (spec §40 Phase A, §44).

Host: macOS (Darwin 25.5.0), arm64, 704 GiB free.

## 1. Tooling discovered

| Tool        | Found  | Version            | Notes                                                       |
| ----------- | ------ | ------------------ | ----------------------------------------------------------- |
| git         | yes    | 2.54.0             |                                                             |
| gh          | yes    | 2.92.0             | authenticated, see §3                                       |
| node        | yes    | 26.0.0             | **not** an LTS line; see §4                                 |
| corepack    | no     | —                  | unbundled from Node 25+; pnpm installed standalone instead  |
| pnpm        | yes    | 11.12.0            |                                                             |
| ruby        | yes    | 2.6.10             | macOS system Ruby; too old for modern CocoaPods/fastlane    |
| bundler     | yes    | 1.17.2             | ships with system Ruby                                      |
| fastlane    | yes    | (outdated)         | reports `update_fastlane` required                          |
| aws         | **no** | —                  | installed during bootstrap → 2.36.14                        |
| cdk         | **no** | —                  | installed during bootstrap → 2.1134.0                       |
| docker      | yes    | 28.3.2             |                                                             |
| jq          | yes    | —                  |                                                             |
| openssl     | yes    | —                  |                                                             |
| eas         | **no** | —                  | installed during bootstrap → 21.4.0                         |
| expo        | n/a    | —                  | invoked via `pnpm dlx` / local dependency                   |
| xcodebuild  | yes    | Xcode 26.5 (17F42) |                                                             |
| xcodes      | no     | —                  | optional                                                    |
| cocoapods   | **no** | —                  | installed during bootstrap → 1.17.0                         |
| swiftlint   | yes    | 0.63.2             |                                                             |
| swiftformat | yes    | 0.61.1             |                                                             |
| java        | **no** | —                  | no JRE at all; installed during bootstrap → OpenJDK 21.0.12 |
| gradle      | no     | —                  | Gradle wrapper is used instead; no system Gradle needed     |
| adb         | **no** | —                  | installed during bootstrap → 37.0.1                         |
| watchman    | **no** | —                  | installed during bootstrap                                  |
| terraform   | no     | —                  | optional; AWS infrastructure is CDK-only                    |
| gcloud      | yes    | 552.0.0            |                                                             |
| sentry-cli  | no     | —                  | required only for the observability phase                   |
| brew        | yes    | 6.0.12             |                                                             |

## 2. Blockers found and how each was resolved

1. **No Java runtime.** Android Gradle builds were impossible. `brew install --cask
temurin@21` failed because casks install into `/Library` and require a sudo
   password, which is unavailable non-interactively. Resolved by installing the
   **`openjdk@21` formula** instead, which installs into the Homebrew prefix and
   needs no elevation. The bootstrap script now recommends the formula explicitly.
2. **No Android SDK.** `ANDROID_HOME` was unset and no SDK existed. Installed
   `android-commandlinetools`, accepted licences, then installed
   `platform-tools`, `platforms;android-36` and `build-tools;36.0.0`.
3. **No CocoaPods.** `pod` was absent, so no iOS dependency resolution was
   possible. Installed via Homebrew (1.17.0), which vendors its own Ruby and so
   sidesteps the stale system Ruby.
4. **No iOS simulator runtime installed.** `xcrun simctl list runtimes` is empty.
   This does **not** block the spec's verification command, because
   `xcodebuild -sdk iphonesimulator build` only _compiles_ — the iOS Simulator
   SDK 26.5 is present. It **does** block actually _running_ the app on a
   simulator; a runtime must be downloaded (`xcodebuild -downloadPlatform iOS`,
   several GiB) before any simulator run or UI test.
5. **Node 26 is not a tested Expo line.** See §4.

## 3. Authentication state discovered

- **GitHub:** authenticated as `iamrishabruh` on github.com (keyring), git protocol
  SSH, token scopes `gist`, `read:org`, `repo`.
  - Two additional accounts hold **invalid** tokens: `get76x` on github.com and
    `rchouhan8` on github.gatech.edu. They are inactive and do not block work, but
    `gh` prints failures for them until they are removed with `gh auth logout`.
  - The active token **lacks the `workflow` scope**. Pushing `.github/workflows/**`
    over HTTPS will be rejected. SSH pushes are unaffected, and the remote is
    configured for SSH, so this is a warning rather than a hard blocker. To be safe:
    `gh auth refresh -h github.com -s workflow,admin:org,repo`.
- **AWS:** no CLI was installed, therefore **no profiles and no SSO session**. No
  AWS account IDs are known. All AWS work is blocked pending §5.
- **Expo/EAS:** CLI absent, therefore not authenticated.
- **Google Cloud:** `gcloud` present; active-account status not asserted here.
- **Apple:** Xcode present. No App Store Connect credentials, no Team ID.

## 4. Toolchain version decisions

The spec requires the latest _mutually compatible_ stable versions resolved at
execution time, and forbids silent major upgrades. Two decisions were forced:

**Node 24.18.1, not 26.0.0.** Node 26 was the only interpreter on the machine.
Expo and Metro track LTS lines, and Node 26 is not one. Node **24.18.1 (LTS
Krypton)** was installed via nvm and pinned in `.nvmrc`, `engines`, `eas.json`
and every CI workflow.

**TypeScript 6.0.3, not 7.0.2.** npm's `latest` tag for TypeScript is **7.0.2**,
but `typescript-eslint@8.65.0` declares `typescript: ">=4.8.4 <6.1.0"`. Adopting
TypeScript 7 would break linting across the entire monorepo. TypeScript **6.0.3**
is the highest mutually compatible stable release. This was independently
corroborated: the Expo SDK 57 default template itself pins `typescript: ~6.0.3`.
A Dependabot `ignore` rule prevents the trap being reintroduced.

Resolved version matrix actually used:

```
node 24.18.1 · pnpm 11.12.0 · typescript 6.0.3 · turbo 2.10.8
expo 57.0.9 · expo-router 57.0.9 · react-native 0.86.2 · react 19.2.3
eas-cli 21.4.0 · aws-cdk 2.1134.0 · aws-cdk-lib 2.263.0 · constructs 10.8.0
eslint 10.8.0 · typescript-eslint 8.65.0 · prettier 3.9.6
vitest 4.1.10 · jest 30.4.2 · zod 4.4.3
OpenJDK 21.0.12 · Android compileSdk 36 / build-tools 36.0.0 · Xcode 26.5
```

React Native 0.86.2 and React 19.2.3 were **not** chosen by hand — they are what
`create-expo-app@latest` pinned for Expo SDK 57, which is the authoritative
pairing.

## 5. Manual gates identified (cannot be automated)

These require a human account owner. None can be bypassed by any CLI or API, and
none were fabricated as complete.

| Gate                                                                        | Why it cannot be automated                                            |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Apple Developer Program enrollment, legal agreements, tax and banking setup | Account-holder identity and contract acceptance; no API exists        |
| Apple Team ID                                                               | Only visible after enrollment completes                               |
| App Store Connect `.p8` API key                                             | Downloadable exactly once, by an Account Holder/Admin, in the browser |
| Apple capability toggles, privacy labels, App Review declarations           | Console-only                                                          |
| Google Play Console: create the app                                         | The Play Developer API cannot create a new consumer application       |
| Google Play: upload the first signed AAB                                    | Required before API-driven releases function                          |
| Google Play: background-location declaration                                | Written justification plus video review                               |
| Google Play: service-account permission grant                               | Console-only                                                          |
| AWS account IDs and IAM Identity Center setup                               | Organisation owner action                                             |
| RevenueCat project and store credentials                                    | Console-only, and depends on the store gates above                    |

## 6. What was NOT done, and why

- **No GitHub repository was created.** Repository name, owner, and visibility are
  interactive inputs (spec §6) with no safe default, and creating a repository under
  the user's account is an outward-facing, hard-to-undo action. `bootstrap.sh --phase
github` performs this once configuration exists.
- **No AWS resources were provisioned.** No account IDs are known and no SSO session
  exists. Nothing was bootstrapped, deployed, or charged.
- **No Apple, Google, RevenueCat, or Sentry provisioning.** All blocked on §5.
- **No store submission of any kind.**

## 7. Build verification

Every claim below was produced by running the command and reading its output.
Anything not listed here was not verified and is not claimed.

| Check | Command | Result |
| --- | --- | --- |
| Typecheck | `pnpm typecheck` | **pass** — 21/21 workspace tasks |
| Lint | `pnpm lint` | **pass** — 21/21, zero errors |
| Format | `pnpm format:check` | **pass** |
| Unit tests | `pnpm test` | **pass** — 1019 tests across 9 packages |
| Secret scan | `scripts/validation/check-secrets.sh` | **pass** |
| CI job/ruleset agreement | `scripts/ci/verify-required-checks.sh` | **pass** — all 12 required checks map to real jobs |
| Workflow YAML | parsed all 19 files | **pass** |
| Native project generation | `expo prebuild --clean` | **pass** — `ios/` and `android/` generated |
| iOS dependency install | `pod install` | **pass** — 138 pods, `LocationEngine (0.1.0)` linked |
| Config plugins applied | inspected generated `Info.plist` / `AndroidManifest.xml` | **pass** |

Test counts by package: location-core 610, auth 101, validation 99, crypto 65,
schemas 42, observability 31, api-client 26, test-utils 23, contracts 22.

### Not verified

- **iOS compilation.** `xcodebuild` cannot resolve a build destination because
  no iOS simulator runtime is installed (the §2 blocker). `xcodebuild
  -downloadPlatform iOS` was started; until it completes and the build is run,
  **no claim is made that the iOS app compiles.**
- **Android compilation.** `./gradlew assembleDebug` was started; its result is
  recorded separately. Until it reports `BUILD SUCCESSFUL`, no claim is made.
- **Background tracking behaviour.** The native engines have never run on a real
  device. Per spec §42, no claim is made about background-location reliability
  until the real-device matrix has been executed.

## 8. Next exact command

```bash
cp bootstrap.config.example.json bootstrap.config.local.json
# edit it, then:
./scripts/bootstrap/bootstrap.sh --phase prerequisites
```
