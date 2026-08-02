#!/usr/bin/env bash
#
# Guards against the silent-drift failure mode where a CI job is renamed and the
# branch ruleset keeps requiring a check that no longer runs — leaving `main`
# effectively unprotected while still appearing green.
#
# Compares the job names in .github/workflows/ci.yml against the required checks
# configured in the repository ruleset.
#
set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

REQUIRED=(
  lint format typecheck unit-tests contract-tests infrastructure-tests
  cdk-synth security-scan dependency-audit
  mobile-ios-build-check mobile-android-build-check e2e-smoke
)

status=0

printf 'Checking ci.yml defines every required status check…\n' >&2
for check in "${REQUIRED[@]}"; do
  if grep -qE "^\s+name:\s+${check}\s*$" .github/workflows/ci.yml; then
    printf '  ✓ %s\n' "$check" >&2
  else
    printf '  ✗ %s is required by the ruleset but no job in ci.yml is named it\n' "$check" >&2
    status=1
  fi
done

# When run with repository access, compare against the live ruleset too.
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  repo="${GITHUB_REPOSITORY:-$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)}"
  if [[ -n "$repo" ]]; then
    printf '\nComparing against the live ruleset on %s…\n' "$repo" >&2
    live="$(gh api "repos/${repo}/rulesets" --jq '.[].id' 2>/dev/null | while read -r id; do
      gh api "repos/${repo}/rulesets/${id}" \
        --jq '.rules[]? | select(.type=="required_status_checks")
              | .parameters.required_status_checks[].context' 2>/dev/null
    done | sort -u || true)"
    if [[ -n "$live" ]]; then
      for check in $live; do
        grep -qE "^\s+name:\s+${check}\s*$" .github/workflows/ci.yml \
          || { printf '  ✗ ruleset requires "%s" which ci.yml never produces (branch is unprotected for it)\n' "$check" >&2; status=1; }
      done
    fi
  fi
fi

((status)) && printf '\nFix ci.yml job names or update the ruleset before merging.\n' >&2
exit "$status"
