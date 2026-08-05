#!/usr/bin/env bash
#
# Shared helpers for scripts/aws/*.
# Sourced, never executed directly.
#
# Everything user-facing (logging, prompts, `die`) comes from the bootstrap
# helper library so that the AWS scripts look and behave exactly like the rest
# of the bootstrap. This file adds only what is specific to the Organizations /
# IAM Identity Center work: the constant identifiers for this org, account
# resolution, an identity guard, and a dry-run aware mutation wrapper.
#
# shellcheck source-path=SCRIPTDIR
# shellcheck disable=SC2016,SC2034
#   SC2016: the jq programs below use $name for *jq* variables bound with --arg.
#           Single quotes are correct; shell expansion must not happen there.
#   SC2034: this is a library. Its constants are read by the scripts that source
#           it, which shellcheck cannot see from inside this file.

set -Eeuo pipefail

# Sourcing this file twice would re-run the `readonly` assignments in common.sh
# and abort under `set -e`. Make it idempotent.
if [[ -n "${KINMAP_AWS_COMMON_SOURCED:-}" ]]; then
  return 0
fi
KINMAP_AWS_COMMON_SOURCED=1

KINMAP_AWS_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../bootstrap/lib/common.sh
source "${KINMAP_AWS_LIB_DIR}/../../bootstrap/lib/common.sh"

# ---------------------------------------------------------------------------
# Constants for this organization
#
# These are identifiers, not secrets: an OU id or an Identity Center instance
# arn is useless without credentials. Hard-coding them is deliberate — a typo'd
# OU id silently attaches a guardrail to the wrong part of the tree, and that
# is a far worse failure than a merge conflict.
# ---------------------------------------------------------------------------

KINMAP_APP_NAME='kinmap'

# Organization management account. Holds Organizations and Identity Center.
KINMAP_MANAGEMENT_ACCOUNT_ID='000000000000'

# Organizations is a global service; its endpoint lives in us-east-1.
KINMAP_ORG_REGION='us-east-1'

# Identity Center is a *regional* service and this instance is in us-east-2.
# Every sso-admin / identitystore call must carry this region.
KINMAP_IDENTITY_CENTER_REGION='us-east-2'
KINMAP_INSTANCE_ARN='arn:aws:sso:::instance/ssoins-xxxxxxxxxxxxxxxx'
KINMAP_IDENTITY_STORE_ID='d-xxxxxxxxxx'

# Organizational units.
KINMAP_OU_NONPRODUCTION='ou-xxxx-xxxxxxxx'
KINMAP_OU_PRODUCTION='ou-xxxx-xxxxxxxx'

# Environments, in dependency order. The member account name and the CDK
# resource prefix are both `kinmap-<env>`, which is why one list serves both.
KINMAP_ENVIRONMENTS=(development staging production)
KINMAP_NONPRODUCTION_ENVIRONMENTS=(development staging)

# Workload regions. us-east-1 is primary (CloudFront and its ACM certificate
# must live there); us-west-2 is the disaster-recovery region.
KINMAP_PRIMARY_REGION='us-east-1'
KINMAP_DR_REGION='us-west-2'
KINMAP_ALLOWED_REGIONS=(us-east-1 us-west-2)

# The tables whose rows describe where a human being physically was.
#
#   CurrentLocations  the latest fix per device
#   LocationHistory   the trail, retained for HISTORY_RETENTION_DAYS
#   SavedPlaces       home, school, work — coordinates by another name
#   GeofenceState     "inside/outside <place>" is a coordinate with the
#                     precision thrown away, and it still says where you are
#   LiveSessions      an active real-time follow of a named person
#
# Every deny in this directory is scoped to exactly this list. Tables such as
# Users or Subscriptions are ordinary operational data and are not restricted:
# an overbroad deny that blocks routine work gets removed, and then nothing is
# protected at all.
KINMAP_LOCATION_TABLES=(CurrentLocations LocationHistory SavedPlaces GeofenceState LiveSessions)

# Profile that resolves to the management account. Override with the flag or
# the environment variable rather than editing this file.
KINMAP_MANAGEMENT_PROFILE="${KINMAP_MANAGEMENT_PROFILE:-${KINMAP_APP_NAME}-management}"

# CDK bootstrap qualifier. Anything else changes every bootstrap resource name.
KINMAP_CDK_QUALIFIER="${KINMAP_CDK_QUALIFIER:-hnb659fds}"

# Set by each script's flag parser.
DRY_RUN=false
ASSUME_YES=false

# ---------------------------------------------------------------------------
# Scratch space
#
# State lives in files rather than shell variables because the mutation helpers
# below are routinely called inside `$( )`, and a subshell cannot write back to
# its parent's variables. A change recorded in a subshell that never reaches the
# summary is a silent lie about what the script did.
# ---------------------------------------------------------------------------

KINMAP_TMP_DIR="$(mktemp -d)"
KINMAP_CHANGE_LOG="${KINMAP_TMP_DIR}/changes.log"
: >"$KINMAP_CHANGE_LOG"

kinmap_cleanup() {
  if [[ -n "${KINMAP_TMP_DIR:-}" && -d "$KINMAP_TMP_DIR" ]]; then
    rm -rf "$KINMAP_TMP_DIR"
  fi
  return 0
}
trap kinmap_cleanup EXIT

# ---------------------------------------------------------------------------
# Failure handling
# ---------------------------------------------------------------------------

KINMAP_SCRIPT_NAME="$(basename "$0")"

aws_on_error() {
  local exit_code=$? line="$1"
  log_error "${KINMAP_SCRIPT_NAME} failed at line ${line} (exit ${exit_code})."
  {
    printf '\n%sRecovery%s\n' "$C_BOLD" "$C_RESET"
    printf '  1. Every operation in this script checks for existence first, so\n'
    printf '     re-running after the cause is fixed is safe.\n'
    printf '  2. See what is still outstanding without changing anything:\n'
    printf '       ./scripts/aws/%s --dry-run\n' "$KINMAP_SCRIPT_NAME"
    printf '  3. If the session expired:\n'
    printf '       aws sso login --profile %s\n' "$KINMAP_MANAGEMENT_PROFILE"
    printf '  4. If the call was AccessDenied, confirm the profile really is the\n'
    printf '     management account (%s):\n' "$KINMAP_MANAGEMENT_ACCOUNT_ID"
    printf '       aws sts get-caller-identity --profile %s\n' "$KINMAP_MANAGEMENT_PROFILE"
  } >&2
  exit "$exit_code"
}

# ---------------------------------------------------------------------------
# Change tracking
#
# "Prints what it changed" is a hard requirement here: an operator re-running a
# guardrail script needs to tell at a glance whether it was a no-op.
# ---------------------------------------------------------------------------

record_change() { printf '%s\n' "$1" >>"$KINMAP_CHANGE_LOG"; }

print_change_summary() {
  local count
  count="$(wc -l <"$KINMAP_CHANGE_LOG" | tr -d '[:space:]')"

  log_step "Summary"
  if [[ "$count" == "0" ]]; then
    log_ok "No changes — everything was already in the desired state."
    return 0
  fi

  local entry
  while IFS= read -r entry; do
    [[ -n "$entry" ]] || continue
    printf '  %s•%s %s\n' "$C_GREEN" "$C_RESET" "$entry" >&2
  done <"$KINMAP_CHANGE_LOG"

  if [[ "$DRY_RUN" == "true" ]]; then
    log_warn "${count} change(s) NOT applied (--dry-run). Re-run without --dry-run to apply."
  else
    log_ok "${count} change(s) applied."
  fi
}

# ---------------------------------------------------------------------------
# Dry-run aware mutation
# ---------------------------------------------------------------------------

# Usage: mutate "<human description>" <command...>
# Discards stdout; use `mutate_capture` when the response is needed.
mutate() {
  local description="$1"
  shift
  if [[ "$DRY_RUN" == "true" ]]; then
    log_info "would ${description}"
    printf '        %s\n' "$(printf '%q ' "$@")" >&2
    record_change "(dry-run) ${description}"
    return 0
  fi
  log_info "${description}"
  "$@" >/dev/null
  record_change "${description}"
}

# Like `mutate`, but leaves stdout attached to the terminal. Used for tools
# whose progress output is the point of watching them run, such as `cdk`.
mutate_stream() {
  local description="$1"
  shift
  if [[ "$DRY_RUN" == "true" ]]; then
    log_info "would ${description}"
    printf '        %s\n' "$(printf '%q ' "$@")" >&2
    record_change "(dry-run) ${description}"
    return 0
  fi
  log_info "${description}"
  "$@"
  record_change "${description}"
}

# Usage: value="$(mutate_capture "<description>" "<dry-run stdout>" <command...>)"
# Writes the command's stdout to stdout so a created id can be captured. In
# dry-run mode the placeholder is emitted instead, so the caller can continue
# and report the whole intended plan rather than stopping at the first create.
mutate_capture() {
  local description="$1" placeholder="$2"
  shift 2
  if [[ "$DRY_RUN" == "true" ]]; then
    log_info "would ${description}"
    printf '        %s\n' "$(printf '%q ' "$@")" >&2
    record_change "(dry-run) ${description}"
    printf '%s' "$placeholder"
    return 0
  fi
  log_info "${description}"
  "$@"
  record_change "${description}"
}

# True when an identifier is a dry-run placeholder rather than a real one, so
# downstream steps describe themselves instead of calling AWS with garbage.
is_placeholder() { [[ "$1" == DRY-RUN-* ]]; }

# ---------------------------------------------------------------------------
# Tooling and credentials
# ---------------------------------------------------------------------------

require_aws_tools() {
  require_command aws
  require_command jq
  local version
  version="$(aws --version 2>&1 || true)"
  case "$version" in
    aws-cli/2.*) : ;;
    *) log_warn "Expected AWS CLI v2; found: ${version}" ;;
  esac
}

# Ambient credentials are the most dangerous thing in this directory: a shell
# that still has AWS_ACCESS_KEY_ID or AWS_PROFILE exported from a previous task
# can silently outrank --profile inside a CDK/SDK credential chain. Clearing
# them means the only credential source is the profile we then verify.
strip_ambient_credentials() {
  local found=() name
  for name in AWS_PROFILE AWS_DEFAULT_PROFILE AWS_ACCESS_KEY_ID \
    AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_SECURITY_TOKEN \
    AWS_CREDENTIAL_EXPIRATION AWS_ROLE_ARN AWS_WEB_IDENTITY_TOKEN_FILE; do
    if [[ -n "${!name:-}" ]]; then
      found+=("$name")
      unset "$name"
    fi
  done
  if ((${#found[@]})); then
    log_warn "Cleared ambient AWS credentials from this shell: ${found[*]}"
    log_warn "Every call below resolves credentials only through an explicit --profile."
  fi
}

# Hard identity guard. Nothing runs before this passes.
#
# The failure being prevented is concrete and has happened to everyone at least
# once: a profile named `kinmap-production` that, because of a stale SSO cache
# or a copied config block, actually resolves to development — or the reverse.
verify_profile_account() {
  local profile="$1" expected="$2" label="$3" actual=''

  if ! actual="$(aws sts get-caller-identity --profile "$profile" \
    --query Account --output text 2>/dev/null)"; then
    log_error "Profile '${profile}' has no valid session."
    log_info "Sign in with: aws sso login --profile ${profile}"
    if [[ "$ASSUME_YES" == "false" ]] && [[ -t 0 ]] &&
      confirm "Run 'aws sso login --profile ${profile}' now?"; then
      aws sso login --profile "$profile"
      actual="$(aws sts get-caller-identity --profile "$profile" --query Account --output text)"
    else
      die "Refusing to continue without a verified identity for ${label}."
    fi
  fi

  if [[ "$actual" != "$expected" ]]; then
    log_error '════════════════════════════════════════════════════════════'
    log_error ' ACCOUNT MISMATCH — REFUSING TO CONTINUE'
    log_error "   profile  : ${profile}"
    log_error "   expected : ${expected}  (${label})"
    log_error "   actual   : ${actual}"
    log_error '════════════════════════════════════════════════════════════'
    die "Fix the profile ('aws sso logout && aws sso login --profile ${profile}') and re-run."
  fi

  log_ok "Verified profile '${profile}' -> account ${actual} (${label})."
}

# ---------------------------------------------------------------------------
# Configuration and account resolution
# ---------------------------------------------------------------------------

# Like `cfg`, but returns empty rather than dying when the key or file is absent.
cfg_optional() {
  local key="$1"
  if [[ ! -f "$CONFIG_FILE" ]]; then
    return 0
  fi
  jq -r --arg k "$key" 'getpath($k | split(".")) // empty' "$CONFIG_FILE" 2>/dev/null || true
}

account_name_for_env() { printf '%s-%s' "$KINMAP_APP_NAME" "$1"; }

# The CDK `resourcePrefix` from infrastructure/config/*.ts — `kinmap-production`.
# Physical table names are `<prefix>-<TableName>`.
resource_prefix_for_env() { printf '%s-%s' "$KINMAP_APP_NAME" "$1"; }

expected_ou_for_env() {
  case "$1" in
    production) printf '%s' "$KINMAP_OU_PRODUCTION" ;;
    development | staging) printf '%s' "$KINMAP_OU_NONPRODUCTION" ;;
    *) die "Unknown environment: $1" ;;
  esac
}

is_production_env() { [[ "$1" == "production" ]]; }

# Resolves the member account id for an environment. Precedence:
#   1. KINMAP_ACCOUNT_ID_<ENV>        — explicit override, always wins
#   2. Organizations, by account name — authoritative once accounts exist
#   3. bootstrap.config.local.json    — the pre-Organizations fallback
# Memoized in a file so a loop over environments and regions does not re-query,
# and so the memo survives being called from inside a command substitution.
resolve_account_id() {
  local env="$1" cache_file override_var value='' name

  cache_file="${KINMAP_TMP_DIR}/account-${env}"
  if [[ -s "$cache_file" ]]; then
    printf '%s' "$(<"$cache_file")"
    return 0
  fi

  override_var="KINMAP_ACCOUNT_ID_$(printf '%s' "$env" | tr '[:lower:]' '[:upper:]')"
  value="${!override_var:-}"

  if [[ -z "$value" ]]; then
    name="$(account_name_for_env "$env")"
    value="$(aws organizations list-accounts \
      --region "$KINMAP_ORG_REGION" \
      --profile "$KINMAP_MANAGEMENT_PROFILE" \
      --query "Accounts[?Name=='${name}' && Status=='ACTIVE'].Id | [0]" \
      --output text 2>/dev/null || true)"
    if [[ "$value" == "None" ]]; then
      value=''
    fi
  fi

  if [[ -z "$value" ]]; then
    value="$(cfg_optional "aws.accounts.${env}")"
    if [[ -n "$value" ]]; then
      log_warn "Account id for '${env}' came from bootstrap.config.local.json, not Organizations."
    fi
  fi

  if [[ ! "$value" =~ ^[0-9]{12}$ ]]; then
    log_error "Cannot resolve a 12-digit account id for '${env}'."
    log_info "Either create the '$(account_name_for_env "$env")' account in Organizations, or export"
    log_info "  ${override_var}=<12-digit account id>"
    die "Unresolved account for environment '${env}'."
  fi

  if [[ "$value" == "$KINMAP_MANAGEMENT_ACCOUNT_ID" ]]; then
    log_error "Environment '${env}' resolved to the MANAGEMENT account ${value}."
    log_error "Workloads must never run in the account that owns the organization:"
    log_error "service control policies cannot restrict the management account, so"
    log_error "every guardrail in scripts/aws would be inert there."
    die "Refusing to treat the management account as the '${env}' member account."
  fi

  printf '%s' "$value" >"$cache_file"
  printf '%s' "$value"
}

# The OU an account currently sits in, or empty if it is directly under root.
account_ou_id() {
  local account_id="$1" parent
  parent="$(aws organizations list-parents \
    --child-id "$account_id" \
    --region "$KINMAP_ORG_REGION" \
    --profile "$KINMAP_MANAGEMENT_PROFILE" \
    --query 'Parents[0].Id' --output text 2>/dev/null || true)"
  if [[ "$parent" == "None" ]]; then
    parent=''
  fi
  printf '%s' "$parent"
}

# Warns rather than dies when an account is not where we expect. These scripts
# never move an account between OUs — that is an Organizations change with its
# own blast radius — but a misplaced account is not covered by the SCPs, and
# that must be impossible to miss.
warn_on_unexpected_ou() {
  local env="$1" account_id="$2" expected actual
  expected="$(expected_ou_for_env "$env")"
  actual="$(account_ou_id "$account_id")"

  if [[ -z "$actual" ]]; then
    log_warn "Could not determine the OU of ${account_id} (${env}); skipping placement check."
    return 0
  fi
  if [[ "$actual" == "$expected" ]]; then
    return 0
  fi

  log_warn "Account ${account_id} (${env}) is in OU ${actual}, expected ${expected}."
  log_warn "Service control policies attached to ${expected} do NOT apply to it."
  log_warn "Move it with:"
  log_warn "  aws organizations move-account --profile ${KINMAP_MANAGEMENT_PROFILE} \\"
  log_warn "    --account-id ${account_id} --source-parent-id ${actual} \\"
  log_warn "    --destination-parent-id ${expected}"
}

# ---------------------------------------------------------------------------
# Policy document helpers
# ---------------------------------------------------------------------------

# Canonical JSON (sorted keys, no whitespace) so "did this policy change?" is a
# string comparison rather than a diff of AWS's own formatting.
json_canonical() { jq -S -c '.'; }

# Every ARN, index, stream, export and backup of the location-bearing tables in
# one account. The region is wildcarded on purpose: the same tables exist in
# us-east-1 and in the us-west-2 disaster-recovery region, and a deny that
# covers only the primary region is not a deny.
location_table_resource_arns() {
  local account_id="$1" prefix="$2" table
  local arns=()
  for table in "${KINMAP_LOCATION_TABLES[@]}"; do
    arns+=("arn:aws:dynamodb:*:${account_id}:table/${prefix}-${table}")
    arns+=("arn:aws:dynamodb:*:${account_id}:table/${prefix}-${table}/index/*")
    arns+=("arn:aws:dynamodb:*:${account_id}:table/${prefix}-${table}/stream/*")
    arns+=("arn:aws:dynamodb:*:${account_id}:table/${prefix}-${table}/export/*")
    arns+=("arn:aws:dynamodb:*:${account_id}:table/${prefix}-${table}/backup/*")
  done
  printf '%s\n' "${arns[@]}" | jq -R -s -c 'split("\n") | map(select(length > 0))'
}

# The alias CDK puts on the customer-managed key that wraps coordinates
# (infrastructure/stacks/foundation-stack.ts: alias/${resourcePrefix}-coordinates).
coordinate_key_alias() { printf 'alias/%s-coordinates' "$1"; }

# ---------------------------------------------------------------------------
# Shared flag help
# ---------------------------------------------------------------------------

print_common_flags() {
  cat >&2 <<'EOF'
Common flags:
  --profile <name>   AWS profile for the management account
                     (default: kinmap-management, or $KINMAP_MANAGEMENT_PROFILE)
  --dry-run          Print every intended change and make none
  --yes              Never prompt; fail instead of asking
  -h, --help         This message
EOF
}
