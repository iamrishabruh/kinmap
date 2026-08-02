#!/usr/bin/env bash
#
# Refuse to let credential material enter Git history.
# Runs in CI on every pull request and locally before the initial commit.
#
set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

fail=0
report() { printf '  ✗ %s\n' "$*" >&2; fail=1; }

# Files that must never be tracked, matched against the Git index rather than
# the working tree — an ignored file on disk is fine, a committed one is not.
FORBIDDEN_PATHS=(
  '*.p8' '*.p12' '*.pem' '*.key' '*.keystore' '*.jks'
  '*.mobileprovision' '*.cer' '*.certSigningRequest'
  'google-services.json' 'GoogleService-Info.plist'
  '*service-account*.json' 'bootstrap.config.local.json'
  '.env' '.env.*' 'apps/mobile/credentials.json'
)

printf 'Checking tracked files for credential material…\n' >&2

# Versioned by design and containing no secret. Each is the counterpart of a
# *.local file that IS ignored.
ALLOWED_FILES=(
  'apps/mobile/ios/.xcode.env'   # documented by React Native as versioned
)

is_allowed() {
  local candidate="$1" allowed
  for allowed in "${ALLOWED_FILES[@]}"; do
    [[ "$candidate" == "$allowed" ]] && return 0
  done
  return 1
}

if git rev-parse --git-dir >/dev/null 2>&1; then
  tracked="$(git ls-files || true)"
  for pattern in "${FORBIDDEN_PATHS[@]}"; do
    # Anchor on the start of the basename, so a pattern like `.env` matches
    # `.env` and `dir/.env` but NOT `.xcode.env`.
    regex="(^|/)$(printf '%s' "$pattern" | sed 's/\./\\./g; s/\*/[^\/]*/g')\$"
    while IFS= read -r file; do
      [[ -z "$file" ]] && continue
      # .env.example is the documented template and holds no real values.
      [[ "$file" == *.env.example ]] && continue
      is_allowed "$file" && continue
      report "Tracked credential file: ${file}"
    done < <(printf '%s\n' "$tracked" | grep -E "$regex" || true)
  done
else
  printf '  (not a git repository — skipping index check)\n' >&2
  tracked=''
fi

# High-signal content patterns. Deliberately narrow to stay useful: a noisy
# scanner that everyone bypasses protects nothing.
declare -a CONTENT_PATTERNS=(
  '-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----|private key block'
  'AKIA[0-9A-Z]{16}|AWS access key id'
  'ASIA[0-9A-Z]{16}|AWS temporary access key'
  'ghp_[A-Za-z0-9]{36}|GitHub personal access token'
  'gho_[A-Za-z0-9]{36}|GitHub OAuth token'
  'github_pat_[A-Za-z0-9_]{80,}|GitHub fine-grained token'
  'xox[baprs]-[A-Za-z0-9-]{10,}|Slack token'
  'sk_live_[A-Za-z0-9]{20,}|Stripe live key'
  'AIza[0-9A-Za-z_-]{35}|Google API key'
  '"type": *"service_account"|Google service-account JSON'
  'sntrys_[A-Za-z0-9]{20,}|Sentry auth token'
)

SEARCH_EXCLUDES=(
  --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist
  --exclude-dir=cdk.out --exclude-dir=coverage --exclude-dir=.turbo
  --exclude-dir=Pods --exclude-dir=build --exclude-dir=.bootstrap-state
  --exclude=pnpm-lock.yaml --exclude=check-secrets.sh
)

for entry in "${CONTENT_PATTERNS[@]}"; do
  pattern="${entry%%|*}"
  label="${entry##*|}"
  if matches="$(grep -rInE "${SEARCH_EXCLUDES[@]}" -- "$pattern" . 2>/dev/null)"; then
    while IFS= read -r line; do
      [[ -z "$line" ]] && continue
      # Report the location only — never echo the matched secret itself.
      report "${label} at ${line%%:*}:$(printf '%s' "$line" | cut -d: -f2)"
    done <<<"$matches"
  fi
done

# A committed .env is the single most common leak vector.
if [[ -n "${tracked:-}" ]] && printf '%s\n' "$tracked" | grep -qE '(^|/)\.env$'; then
  report "A .env file is tracked by Git."
fi

if ((fail)); then
  printf '\nSecret scan FAILED. Remove the files or values above.\n' >&2
  printf 'If a secret was ever committed, rotate it — deleting the file is not enough.\n' >&2
  exit 1
fi

printf 'Secret scan passed.\n' >&2
