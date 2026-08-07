#!/usr/bin/env bash
#
# Verify the committed native projects still match app.config.ts.
#
# The ios/ and android/ directories are committed (spec §8) so that native code
# is reviewable, but that only helps if they are regenerated when configuration
# changes. This runs `expo prebuild` into a scratch directory and diffs the
# result, so a stale native project fails CI instead of failing at build time.
#
set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MOBILE="${REPO_ROOT}/apps/mobile"
cd "$MOBILE"

if [[ ! -d ios && ! -d android ]]; then
  printf 'No native projects committed yet — run: pnpm --filter @family/mobile prebuild\n' >&2
  exit 0
fi

scratch="$(mktemp -d)"
cleanup() { rm -rf "$scratch"; }
trap cleanup EXIT

printf 'Regenerating native projects to compare against the committed ones…\n' >&2

cp -R ios "${scratch}/ios.committed" 2>/dev/null || true
cp -R android "${scratch}/android.committed" 2>/dev/null || true

APP_VARIANT="${APP_VARIANT:-development}" npx expo prebuild --clean --no-install >/dev/null

# Xcode object identifiers are not content.
#
# `project.pbxproj` addresses every object by a 24-character hex id. Most are
# derived and stable across runs, but config plugins that add a build phase
# mint a fresh random one each time — the "[Expo Dev Launcher] Strip Local
# Network Keys for Release" phase does exactly that. So two prebuilds of an
# unchanged configuration always differed on those lines, and this check could
# never have gone green for iOS however the project was regenerated.
#
# Blanking the identifiers keeps everything that carries meaning: the object
# type, every build setting, and the human-readable name Xcode writes in the
# trailing comment. A phase that is added, removed or renamed still shows up.
# Written through a temp file rather than with `sed -i`, whose argument
# handling differs between BSD and GNU sed — and no `\b`, which BSD sed does
# not support. The first version of this used both and silently normalised
# nothing, so the check went on failing on exactly the lines it was meant to
# ignore. An id is 24 uppercase hex characters and every neighbour is
# punctuation, so no word boundary is needed.
normalise_object_ids() {
  local file tmp
  for file in "$1"/*.xcodeproj/project.pbxproj; do
    [[ -f "$file" ]] || continue
    tmp="${file}.normalised"
    sed -E 's/[0-9A-F]{24}/<OBJECT-ID>/g' "$file" > "$tmp"
    mv "$tmp" "$file"
  done
}

# Normalise COPIES only. `ios.committed` is what gets moved back over the
# working tree at the end, so rewriting it in place would leave the repository
# holding a project full of `<OBJECT-ID>` placeholders.
cp -R "${scratch}/ios.committed" "${scratch}/ios.a" 2>/dev/null || true
cp -R ios "${scratch}/ios.b" 2>/dev/null || true
normalise_object_ids "${scratch}/ios.a"
normalise_object_ids "${scratch}/ios.b"

status=0

# Generated artefacts that legitimately differ run-to-run.
#
# `DerivedData` is here because `ios/.gitignore` already declares it ignorable
# and this list did not, so the check failed for anybody who had pointed
# `xcodebuild -derivedDataPath` at it — a perfectly ordinary thing to do, and
# what the ignore rule exists to permit. It never reaches CI; it made the check
# unrunnable locally, which is where it is most useful.
DIFF_EXCLUDES=(
  -x 'Pods' -x 'build' -x 'DerivedData' -x '.gradle' -x 'local.properties'
  -x 'xcuserdata' -x '*.xcworkspace' -x '.cxx' -x 'gradlew' -x 'gradlew.bat'
  -x '*.lock' -x '.xcode.env.local'
  # Written by `pod install`, which neither this regeneration nor the committed
  # tree now contains — see .gitignore. Excluded so a developer who has run a
  # local build still gets a clean result.
  -x 'PrivacyInfo.xcprivacy'
  # Expo generates a debug signing keystore, and .gitignore keeps it out of the
  # repository — it is a local signing artefact, not configuration. So the
  # regenerated tree has one and a fresh checkout does not.
  -x 'debug.keystore'
)

for platform in ios android; do
  [[ -d "${scratch}/${platform}.committed" ]] || continue

  # iOS compares the id-normalised copies; android has no such problem.
  if [[ "$platform" == ios ]]; then
    left="${scratch}/ios.a"
    right="${scratch}/ios.b"
  else
    left="${scratch}/${platform}.committed"
    right="$platform"
  fi
  # `-b` — whitespace differences are not drift.
  #
  # The regeneration above runs `--no-install`, and `expo prebuild` writes
  # Info.plist with two-space indentation. `pod install`, which the documented
  # developer command DOES run, rewrites the same file with tabs through
  # Xcode's plist serializer. So the committed file and the regenerated one
  # differed on every line of Info.plist, permanently, whichever way round they
  # were generated — the check could not be made to pass by committing the
  # output it asked for.
  #
  # Indentation in a generated plist carries no meaning, and no drift this
  # check exists to catch — a bundle id, a permission string, a background
  # mode, an associated domain — is expressible as whitespace alone.
  if diff -r -b "${DIFF_EXCLUDES[@]}" "$left" "$right" > "${scratch}/${platform}.diff" 2>&1; then
    printf '  ✓ %s matches app.config.ts\n' "$platform" >&2
  else
    printf '  ✗ %s is out of date with app.config.ts:\n' "$platform" >&2
    head -40 "${scratch}/${platform}.diff" >&2
    status=1
  fi
done

# Restore the committed projects so the check is non-destructive.
rm -rf ios android
[[ -d "${scratch}/ios.committed" ]] && mv "${scratch}/ios.committed" ios
[[ -d "${scratch}/android.committed" ]] && mv "${scratch}/android.committed" android

if ((status)); then
  printf '\nRun: pnpm --filter @family/mobile prebuild:clean, then commit the result.\n' >&2
fi
exit "$status"
