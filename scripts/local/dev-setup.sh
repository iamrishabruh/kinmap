#!/usr/bin/env bash
#
# One-command local development setup for a new machine.
# Idempotent — safe to re-run.
#
set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

info() { printf '\033[34m[info]\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[33m[warn]\033[0m %s\n' "$*" >&2; }
ok()   { printf '\033[32m[ ok ]\033[0m %s\n' "$*" >&2; }

info "Checking Node version against .nvmrc…"
want="$(tr -d '[:space:]' < .nvmrc)"
have="$(node --version 2>/dev/null | sed 's/^v//' || echo none)"
if [[ "${have%%.*}" != "${want%%.*}" ]]; then
  warn "Node ${have} active, ${want} pinned. Run: nvm install && nvm use"
else
  ok "Node ${have}"
fi

info "Installing workspace dependencies…"
pnpm install

if [[ ! -f apps/mobile/.env.local ]]; then
  cp apps/mobile/.env.example apps/mobile/.env.local
  warn "Created apps/mobile/.env.local from the example — fill in real values."
fi

# Android SDK location, required by Gradle. Never committed.
if [[ -d "${ANDROID_HOME:-$HOME/Library/Android/sdk}" ]]; then
  sdk="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
  if [[ -d apps/mobile/android ]]; then
    printf 'sdk.dir=%s\n' "$sdk" > apps/mobile/android/local.properties
    ok "Wrote apps/mobile/android/local.properties"
  fi
else
  warn "Android SDK not found. Install it, or set ANDROID_HOME."
fi

if [[ "$(uname -s)" == "Darwin" && -d apps/mobile/ios ]]; then
  if command -v pod >/dev/null 2>&1; then
    info "Installing CocoaPods dependencies…"
    (cd apps/mobile/ios && pod install)
    ok "Pods installed"
  else
    warn "CocoaPods missing. Run: brew install cocoapods"
  fi
fi

ok "Setup complete."
cat >&2 <<'EOF'

Next steps:
  pnpm --filter @family/mobile prebuild    # regenerate native projects
  pnpm --filter @family/mobile ios         # build and run on a simulator
  pnpm --filter @family/mobile android     # build and run on an emulator
  pnpm test                                # run the test suite

Location behaviour cannot be tested in Expo Go — use a development build.
EOF
