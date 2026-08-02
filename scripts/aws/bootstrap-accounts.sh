#!/usr/bin/env bash
#
# Kinmap — CDK bootstrap for every member account and region.
#
#   ./scripts/aws/bootstrap-accounts.sh [--dry-run] [--env <env|all>] [--region <region|all>]
#
# ---------------------------------------------------------------------------
# The failure this script exists to prevent
# ---------------------------------------------------------------------------
#
# `cdk bootstrap` creates a CloudFormation execution role with very broad
# permissions and an asset bucket that every future deploy trusts. Running it
# against the wrong account is not a cosmetic mistake: it plants a trusted
# deployment path in an account nobody meant to open, and if the accident goes
# the other way — a shell still holding development credentials, a profile
# copied and half-edited, a stale SSO cache — the first "production deploy"
# lands in development and the real production is never bootstrapped at all.
#
# Two mechanical guards, before anything is created:
#
#   1. Ambient AWS_* credentials are stripped from the environment, so the only
#      credential source is the profile named on the command line. Environment
#      variables outrank profiles in parts of the SDK credential chain, and a
#      forgotten `export AWS_ACCESS_KEY_ID` is exactly how a "--profile
#      kinmap-production" command ends up somewhere else.
#   2. `sts get-caller-identity` is called for the profile and compared against
#      the account id Organizations reports for that environment. A mismatch is
#      a hard, loud stop — never a warning, never a prompt.
#
# No credential is ever passed in argv. The AWS CLI reads the SSO token from
# ~/.aws/sso/cache itself; this script only ever names a profile.
#
# shellcheck source-path=SCRIPTDIR
# shellcheck disable=SC2016
#   jq programs use $name for jq variables. Single quotes are correct there.

set -Eeuo pipefail

KINMAP_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/aws-common.sh
source "${KINMAP_SCRIPT_DIR}/lib/aws-common.sh"

trap 'aws_on_error $LINENO' ERR

# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------

PROFILE_PREFIX="${KINMAP_WORKLOAD_PROFILE_PREFIX:-${KINMAP_APP_NAME}}"
SELECTED_ENVS=()
SELECTED_REGIONS=()
SKIP_EXISTING=false
TERMINATION_PROTECTION=true

# The managed policy CloudFormation itself runs with once bootstrapped. The CDK
# default is AdministratorAccess. Narrowing it is the single most effective
# hardening available here, because the deploy permission set's denies do not
# constrain what CloudFormation does on its behalf — see scripts/aws/README.md.
CFN_EXEC_POLICY="${KINMAP_CFN_EXEC_POLICY:-arn:aws:iam::aws:policy/AdministratorAccess}"

# Accounts allowed to assume this account's deploy role. Empty by default:
# deployments come from GitHub OIDC roles created inside each account by
# FoundationStack, so no cross-account trust is required.
TRUST_ACCOUNTS=()

CDK_BIN=''

# ---------------------------------------------------------------------------
# Arguments
# ---------------------------------------------------------------------------

usage() {
  cat >&2 <<'EOF'
Usage: ./scripts/aws/bootstrap-accounts.sh [options]

Runs `cdk bootstrap` in each Kinmap member account and region, refusing to
proceed unless the profile provably resolves to the expected account.

Options:
  --env <name|all>            development | staging | production | all (default: all)
  --region <region|all>       us-east-1 | us-west-2 | all (default: all)
  --profile-prefix <p>        Member-account profile prefix (default: kinmap,
                              i.e. kinmap-development / -staging / -production)
  --cfn-exec-policy <arn>     Managed policy CloudFormation deploys with
                              (default: AdministratorAccess)
  --trust <account-id>        Additional account allowed to deploy here.
                              May be repeated.
  --skip-existing             Skip an account/region that is already bootstrapped
  --no-termination-protection Do not enable termination protection on CDKToolkit

EOF
  print_common_flags
  cat >&2 <<'EOF'

Environment overrides:
  KINMAP_ACCOUNT_ID_DEVELOPMENT / _STAGING / _PRODUCTION
  KINMAP_WORKLOAD_PROFILE_PREFIX, KINMAP_CFN_EXEC_POLICY, KINMAP_CDK_QUALIFIER
EOF
  exit 2
}

parse_args() {
  local env_arg='all' region_arg='all'

  while (($#)); do
    case "$1" in
      --dry-run) DRY_RUN=true; shift ;;
      --yes | -y) ASSUME_YES=true; shift ;;
      --profile) KINMAP_MANAGEMENT_PROFILE="${2:?--profile needs a value}"; shift 2 ;;
      --profile-prefix) PROFILE_PREFIX="${2:?--profile-prefix needs a value}"; shift 2 ;;
      --env) env_arg="${2:?--env needs a value}"; shift 2 ;;
      --region) region_arg="${2:?--region needs a value}"; shift 2 ;;
      --cfn-exec-policy) CFN_EXEC_POLICY="${2:?--cfn-exec-policy needs a value}"; shift 2 ;;
      --trust) TRUST_ACCOUNTS+=("${2:?--trust needs a value}"); shift 2 ;;
      --skip-existing) SKIP_EXISTING=true; shift ;;
      --no-termination-protection) TERMINATION_PROTECTION=false; shift ;;
      -h | --help) usage ;;
      *) log_error "Unknown argument: $1"; usage ;;
    esac
  done

  case "$env_arg" in
    all) SELECTED_ENVS=("${KINMAP_ENVIRONMENTS[@]}") ;;
    development | staging | production) SELECTED_ENVS=("$env_arg") ;;
    *) log_error "Unknown environment: ${env_arg}"; usage ;;
  esac

  case "$region_arg" in
    all) SELECTED_REGIONS=("${KINMAP_ALLOWED_REGIONS[@]}") ;;
    *) SELECTED_REGIONS=("$region_arg") ;;
  esac
}

# ---------------------------------------------------------------------------
# Preconditions
# ---------------------------------------------------------------------------

# Prefer the CDK CLI pinned in this workspace. A globally installed `cdk` of a
# different major writes a different bootstrap template, and "works on my
# machine" then means "wrote a different trust policy into production".
resolve_cdk_binary() {
  local workspace_cdk="${REPO_ROOT}/node_modules/.bin/cdk"

  if [[ -x "$workspace_cdk" ]]; then
    CDK_BIN="$workspace_cdk"
  elif has_command cdk; then
    CDK_BIN="$(command -v cdk)"
    log_warn "Using the global CDK CLI at ${CDK_BIN}; the workspace pin was not found."
    log_warn "Prefer: pnpm install (which provides node_modules/.bin/cdk)."
  else
    die "No CDK CLI found. Run 'pnpm install' at the repository root."
  fi

  log_ok "CDK CLI ${CDK_BIN} ($("$CDK_BIN" --version 2>/dev/null || echo 'version unknown'))"
}

# A region outside the approved list is denied by the production region-lock
# SCP, so bootstrapping there would half-succeed and leave a broken stack.
validate_regions() {
  local region allowed found
  for region in "${SELECTED_REGIONS[@]}"; do
    found=false
    for allowed in "${KINMAP_ALLOWED_REGIONS[@]}"; do
      if [[ "$region" == "$allowed" ]]; then
        found=true
      fi
    done
    if [[ "$found" == "false" ]]; then
      log_error "Region '${region}' is not in the approved list: ${KINMAP_ALLOWED_REGIONS[*]}"
      die "The production region-lock SCP denies it; bootstrapping there would fail halfway."
    fi
  done
}

# Two environments resolving to the same account id means the account mapping is
# wrong, and "bootstrap production" would in fact target development.
assert_accounts_are_distinct() {
  local env account duplicates
  local pairs=()

  for env in "${SELECTED_ENVS[@]}"; do
    account="$(resolve_account_id "$env")"
    pairs+=("${account} ${env}")
  done

  duplicates="$(printf '%s\n' "${pairs[@]}" | cut -d' ' -f1 | sort | uniq -d)"

  if [[ -n "$duplicates" ]]; then
    log_error "Two or more environments resolve to the same AWS account:"
    printf '%s\n' "${pairs[@]}" | sed 's/^/    /' >&2
    log_error "Separate accounts are the isolation boundary for this platform."
    die "Refusing to bootstrap an ambiguous account mapping."
  fi
}

# Best effort. When the management profile has no session we fall back to the
# local config for account ids, and say so rather than pretending otherwise.
check_management_identity() {
  if aws sts get-caller-identity --profile "$KINMAP_MANAGEMENT_PROFILE" >/dev/null 2>&1; then
    verify_profile_account "$KINMAP_MANAGEMENT_PROFILE" \
      "$KINMAP_MANAGEMENT_ACCOUNT_ID" 'organization management'
    return 0
  fi
  log_warn "No active session for the management profile '${KINMAP_MANAGEMENT_PROFILE}'."
  log_warn "Expected account ids will come from KINMAP_ACCOUNT_ID_* or bootstrap.config.local.json."
  log_warn "For an authoritative mapping: aws sso login --profile ${KINMAP_MANAGEMENT_PROFILE}"
}

# ---------------------------------------------------------------------------
# Bootstrap
# ---------------------------------------------------------------------------

# stdout: the deployed bootstrap version, or empty when never bootstrapped.
bootstrap_version() {
  local profile="$1" region="$2" version
  version="$(aws ssm get-parameter \
    --name "/cdk-bootstrap/${KINMAP_CDK_QUALIFIER}/version" \
    --profile "$profile" --region "$region" \
    --query 'Parameter.Value' --output text 2>/dev/null || true)"
  if [[ "$version" == "None" ]]; then
    version=''
  fi
  printf '%s' "$version"
}

bootstrap_one() {
  local env="$1" region="$2" account="$3" profile="$4"
  local existing label
  label="${env}/${region}"

  existing="$(bootstrap_version "$profile" "$region")"
  if [[ -n "$existing" ]]; then
    log_info "${label}: already bootstrapped at version ${existing}."
    if [[ "$SKIP_EXISTING" == "true" ]]; then
      log_skip "${label}: --skip-existing, leaving it alone."
      return 0
    fi
  else
    log_info "${label}: not bootstrapped yet."
  fi

  local cmd=(
    "$CDK_BIN" bootstrap "aws://${account}/${region}"
    --profile "$profile"
    --qualifier "$KINMAP_CDK_QUALIFIER"
    --toolkit-stack-name CDKToolkit
    --cloudformation-execution-policies "$CFN_EXEC_POLICY"
    --tags "app=${KINMAP_APP_NAME}"
    --tags "environment=${env}"
    --tags "managed-by=scripts/aws/bootstrap-accounts.sh"
  )

  if [[ "$TERMINATION_PROTECTION" == "true" ]]; then
    cmd+=(--termination-protection)
  fi

  local trusted
  if ((${#TRUST_ACCOUNTS[@]} > 0)); then
    for trusted in "${TRUST_ACCOUNTS[@]}"; do
      cmd+=(--trust "$trusted")
    done
  fi

  # `cdk` streams progress for several minutes; watching it is the point.
  mutate_stream "cdk bootstrap ${label} (account ${account})" "${cmd[@]}"

  if [[ "$DRY_RUN" == "true" ]]; then
    return 0
  fi

  local after
  after="$(bootstrap_version "$profile" "$region")"
  if [[ -z "$after" ]]; then
    die "${label}: bootstrap reported success but /cdk-bootstrap/${KINMAP_CDK_QUALIFIER}/version is missing."
  fi
  log_ok "${label}: bootstrap version ${after}."
}

bootstrap_environment() {
  local env="$1" account profile region
  account="$(resolve_account_id "$env")"
  profile="${PROFILE_PREFIX}-${env}"

  log_step "${env} — account ${account}, profile ${profile}"

  # The guard. Everything after this line trusts that the profile is the
  # account we think it is, so nothing may run before it.
  verify_profile_account "$profile" "$account" "$env"
  warn_on_unexpected_ou "$env" "$account"

  if is_production_env "$env" && [[ "$ASSUME_YES" == "false" && "$DRY_RUN" == "false" ]]; then
    log_warn "About to bootstrap PRODUCTION (${account})."
    log_warn "This creates a CloudFormation execution role with: ${CFN_EXEC_POLICY}"
    if ! confirm "Continue with production?"; then
      log_warn "Skipped production. Nothing was changed in ${account}."
      return 0
    fi
  fi

  for region in "${SELECTED_REGIONS[@]}"; do
    bootstrap_one "$env" "$region" "$account" "$profile"
  done
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

main() {
  parse_args "$@"
  require_aws_tools
  require_command node
  strip_ambient_credentials

  # The repository root has no cdk.json, so an explicit `aws://account/region`
  # argument can never be mistaken for "synthesize the application".
  cd "$REPO_ROOT"

  log_step "Kinmap CDK bootstrap"
  if [[ "$DRY_RUN" == "true" ]]; then
    log_warn "DRY RUN — no account will be bootstrapped."
  fi
  log_info "Environments : ${SELECTED_ENVS[*]}"
  log_info "Regions      : ${SELECTED_REGIONS[*]}"
  log_info "Qualifier    : ${KINMAP_CDK_QUALIFIER}"
  log_info "Exec policy  : ${CFN_EXEC_POLICY}"

  if [[ "$CFN_EXEC_POLICY" == 'arn:aws:iam::aws:policy/AdministratorAccess' ]]; then
    log_warn "CloudFormation will deploy with AdministratorAccess."
    log_warn "That role is not constrained by the KinmapProdDeploy denies. To narrow it,"
    log_warn "create a customer-managed policy and pass --cfn-exec-policy <arn>."
  fi

  resolve_cdk_binary
  validate_regions
  check_management_identity
  assert_accounts_are_distinct

  local env
  for env in "${SELECTED_ENVS[@]}"; do
    bootstrap_environment "$env"
  done

  log_step "Next"
  log_info "Bootstrapped accounts are ready for: pnpm cdk:deploy"
  log_info "Guardrails: ./scripts/aws/service-control-policies.sh"
  log_info "Human access: ./scripts/aws/permission-sets.sh"

  print_change_summary
}

main "$@"
