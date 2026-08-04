#!/usr/bin/env bash
#
# Run an EAS build with the environment it actually needs.
#
# There are three separate reasons a bare `eas build` misbehaves, and all of
# them are invisible until it does something surprising:
#
#  1. The EAS CLI does not load `.env.local` the way the Expo CLI does. Without
#     it the app config falls back to defaults, and when those were placeholders
#     EAS silently created a NEW project rather than failing. That happened
#     twice. The defaults are pinned now, but loading the file keeps the API URL
#     and Cognito ids correct too.
#
#  2. Apple credential operations otherwise want an Apple ID and password. This
#     project has an App Store Connect API key, which is strictly better: no
#     password, no two-factor prompt, no session that expires mid-build, and
#     nothing interactive to get wrong. Pointing EAS at it removes the login
#     entirely.
#
#  3. `~/.app-store/auth/` caches whatever identity was used last. It had the
#     *Expo* username written into it, so EAS kept proposing a username that
#     could never authenticate against Apple.
#
# Usage:
#   scripts/mobile/eas-build.sh development           # ad-hoc build for a registered device
#   scripts/mobile/eas-build.sh development-simulator # simulator, needs no signing at all
set -euo pipefail

profile="${1:-development}"
shift || true

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root/apps/mobile"

if [[ ! -f .env.local ]]; then
  echo "apps/mobile/.env.local is missing. It holds the API URL and Cognito ids" >&2
  echo "this build embeds; without it the app points at nothing." >&2
  exit 1
fi

# shellcheck disable=SC1091
set -a
. ./.env.local
set +a

ASC_KEY="${HOME}/.private/AuthKey_XXXXXXXXXX.p8"
if [[ -f "$ASC_KEY" ]]; then
  # Never echoed, never passed as an argument — only its path is exported.
  export EXPO_ASC_API_KEY_PATH="$ASC_KEY"
  export EXPO_ASC_KEY_ID='XXXXXXXXXX'
  export EXPO_ASC_ISSUER_ID='00000000-0000-0000-0000-000000000000'
  export EXPO_APPLE_TEAM_ID='HH7Q2DUJ9U'
  echo "Using the App Store Connect API key for Apple credentials (no Apple ID login)."
else
  echo "warning: ${ASC_KEY} not found — EAS will ask for an Apple ID instead." >&2
fi

export EXPO_NO_TELEMETRY=1

echo "Building profile '${profile}'…"
exec npx eas build --profile "$profile" --platform ios "$@"
