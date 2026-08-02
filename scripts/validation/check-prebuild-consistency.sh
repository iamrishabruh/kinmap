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

status=0

# Generated artefacts that legitimately differ run-to-run.
DIFF_EXCLUDES=(
  -x 'Pods' -x 'build' -x '.gradle' -x 'local.properties'
  -x 'xcuserdata' -x '*.xcworkspace' -x '.cxx' -x 'gradlew' -x 'gradlew.bat'
  -x '*.lock' -x '.xcode.env.local'
)

for platform in ios android; do
  [[ -d "${scratch}/${platform}.committed" ]] || continue
  if diff -r "${DIFF_EXCLUDES[@]}" "${scratch}/${platform}.committed" "$platform" > "${scratch}/${platform}.diff" 2>&1; then
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
