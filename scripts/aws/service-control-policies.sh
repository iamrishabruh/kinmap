#!/usr/bin/env bash
#
# Kinmap — organization service control policies.
#
#   ./scripts/aws/service-control-policies.sh [--dry-run] [--profile <mgmt-profile>] [--yes]
#
# ---------------------------------------------------------------------------
# What an SCP is for here
# ---------------------------------------------------------------------------
#
# The permission sets in permission-sets.sh answer "what may this person do?".
# An SCP answers a different question: "what may happen in this account at all,
# no matter who is asking or what IAM policy says yes?". It is the only control
# that still holds after a credential leak, a mis-scoped role, or an
# administrator having a bad day.
#
# So the SCPs here are deliberately narrow and all of one kind: they forbid the
# handful of actions that would destroy evidence, destroy data, or move the
# workload somewhere nobody is watching. They do not try to express least
# privilege — that is the permission sets' job, and an SCP that tries to do it
# ends up detached the first time it blocks a deploy at 2am.
#
#   Production OU
#     - leaving the organization        (an account outside the org has no SCPs)
#     - disabling CloudTrail            (destroys the record of everything else)
#     - disabling GuardDuty / Config    (same, for detection and drift)
#     - deleting KMS keys               (irreversible loss of every coordinate)
#     - deleting DynamoDB backups       (the only route back from a bad migration)
#     - any region outside us-east-1 / us-west-2
#           Not a cost control. Location data is subject to promises made in the
#           privacy policy about where it is stored, and a table quietly created
#           in ap-south-1 breaks those promises silently.
#
#   Root (i.e. every member account)
#     - all root-user actions           (root has no MFA story worth relying on,
#                                        cannot be scoped by IAM, and is never
#                                        the right tool for routine work)
#
# Idempotent: policies are looked up by name, their content compared, and
# attachments checked before anything is attached.
#
# shellcheck source-path=SCRIPTDIR
# shellcheck disable=SC2016
#   jq programs use $name for jq variables. Single quotes are correct there.

set -Eeuo pipefail

KINMAP_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/aws-common.sh
source "${KINMAP_SCRIPT_DIR}/lib/aws-common.sh"

trap 'aws_on_error $LINENO' ERR

SCP_PRODUCTION_GUARDRAILS='KinmapProductionGuardrails'
SCP_REGION_LOCK='KinmapProductionRegionLock'
SCP_DENY_ROOT='KinmapDenyRootUser'

ORG=()

# ---------------------------------------------------------------------------
# Arguments
# ---------------------------------------------------------------------------

usage() {
  cat >&2 <<'EOF'
Usage: ./scripts/aws/service-control-policies.sh [options]

Creates and attaches the Kinmap service control policies.

  KinmapProductionGuardrails  -> Production OU
      deny leaving the organization; deny disabling CloudTrail, GuardDuty and
      Config; deny deleting KMS keys; deny deleting DynamoDB / AWS Backup
      recovery points.

  KinmapProductionRegionLock  -> Production OU
      deny every regional action outside us-east-1 and us-west-2.

  KinmapDenyRootUser          -> organization root
      deny all root-user actions. SCPs never apply to the management account,
      so this affects member accounts only — which is the intent.

EOF
  print_common_flags
  exit 2
}

parse_args() {
  while (($#)); do
    case "$1" in
      --dry-run) DRY_RUN=true; shift ;;
      --yes | -y) ASSUME_YES=true; shift ;;
      --profile) KINMAP_MANAGEMENT_PROFILE="${2:?--profile needs a value}"; shift 2 ;;
      -h | --help) usage ;;
      *) log_error "Unknown argument: $1"; usage ;;
    esac
  done
}

# ---------------------------------------------------------------------------
# Organizations primitives
# ---------------------------------------------------------------------------

organization_root_id() {
  local root_id
  root_id="$("${ORG[@]}" list-roots --query 'Roots[0].Id' --output text 2>/dev/null || true)"
  if [[ -z "$root_id" || "$root_id" == "None" ]]; then
    die "Could not list organization roots. Is '${KINMAP_MANAGEMENT_PROFILE}' the management account?"
  fi
  printf '%s' "$root_id"
}

# SCPs are an opt-in policy type. On an organization that has never used them
# the attach call fails with a message that does not say "enable the type", so
# check and enable explicitly.
ensure_scp_policy_type_enabled() {
  local root_id="$1" status
  status="$("${ORG[@]}" list-roots --output json |
    jq -r --arg r "$root_id" \
      '.Roots[] | select(.Id == $r) | .PolicyTypes[]? | select(.Type == "SERVICE_CONTROL_POLICY") | .Status')"

  if [[ "$status" == "ENABLED" ]]; then
    log_skip "SERVICE_CONTROL_POLICY is already enabled on root ${root_id}."
    return 0
  fi

  mutate "enable SERVICE_CONTROL_POLICY on root ${root_id}" \
    "${ORG[@]}" enable-policy-type --root-id "$root_id" --policy-type SERVICE_CONTROL_POLICY
}

verify_organizational_unit() {
  local ou_id="$1" expected_name="$2" actual
  actual="$("${ORG[@]}" describe-organizational-unit \
    --organizational-unit-id "$ou_id" \
    --query 'OrganizationalUnit.Name' --output text 2>/dev/null || true)"

  if [[ -z "$actual" || "$actual" == "None" ]]; then
    die "Organizational unit ${ou_id} (expected '${expected_name}') does not exist."
  fi
  if [[ "$actual" != "$expected_name" ]]; then
    log_error "OU ${ou_id} is named '${actual}', but this script expects '${expected_name}'."
    die "Refusing to attach guardrails to an OU that is not the one they were written for."
  fi
  log_ok "OU ${ou_id} verified as '${actual}'."
}

# stdout: the policy id (real, or a DRY-RUN- placeholder).
ensure_policy() {
  local name="$1" description="$2" content_file="$3"
  local policy_id current desired size

  size="$(json_canonical <"$content_file" | wc -c | tr -d '[:space:]')"
  if ((size > 5120)); then
    die "SCP '${name}' is ${size} bytes; the AWS hard limit is 5120. Split it."
  fi
  log_info "$(printf '%-30s %s bytes' "$name" "$size")"

  policy_id="$("${ORG[@]}" list-policies --filter SERVICE_CONTROL_POLICY --output json 2>/dev/null |
    jq -r --arg n "$name" '.Policies[] | select(.Name == $n) | .Id' || true)"

  if [[ -z "$policy_id" ]]; then
    policy_id="$(mutate_capture "create SCP ${name}" "DRY-RUN-policy-${name}" \
      "${ORG[@]}" create-policy \
      --name "$name" \
      --description "$description" \
      --type SERVICE_CONTROL_POLICY \
      --content "file://${content_file}" \
      --query 'Policy.PolicySummary.Id' --output text)"
    printf '%s' "$policy_id"
    return 0
  fi

  desired="$(json_canonical <"$content_file")"
  current="$("${ORG[@]}" describe-policy --policy-id "$policy_id" \
    --query 'Policy.Content' --output text 2>/dev/null | json_canonical 2>/dev/null || true)"

  if [[ "$current" == "$desired" ]]; then
    log_skip "SCP ${name} (${policy_id}) content is already correct."
  else
    log_warn "SCP ${name} content differs from the desired document; updating it."
    mutate "update SCP ${name} (${policy_id})" \
      "${ORG[@]}" update-policy --policy-id "$policy_id" \
      --description "$description" --content "file://${content_file}"
  fi

  printf '%s' "$policy_id"
}

ensure_attachment() {
  local policy_id="$1" policy_name="$2" target_id="$3" target_label="$4" attached

  if is_placeholder "$policy_id"; then
    log_info "would attach ${policy_name} to ${target_label} (${target_id})"
    record_change "(dry-run) attach ${policy_name} to ${target_label}"
    return 0
  fi

  attached="$("${ORG[@]}" list-policies-for-target \
    --target-id "$target_id" --filter SERVICE_CONTROL_POLICY --output json 2>/dev/null |
    jq -r --arg id "$policy_id" '.Policies[] | select(.Id == $id) | .Id' || true)"

  if [[ -n "$attached" ]]; then
    log_skip "${policy_name} is already attached to ${target_label}."
    return 0
  fi

  mutate "attach ${policy_name} to ${target_label} (${target_id})" \
    "${ORG[@]}" attach-policy --policy-id "$policy_id" --target-id "$target_id"
}

# An SCP is a filter, not a grant. If FullAWSAccess has been detached from a
# target, that target is deny-by-default and every deploy in it is already
# broken — a state worth naming out loud rather than debugging from symptoms.
warn_if_full_access_missing() {
  local target_id="$1" target_label="$2" found
  found="$("${ORG[@]}" list-policies-for-target \
    --target-id "$target_id" --filter SERVICE_CONTROL_POLICY --output json 2>/dev/null |
    jq -r '.Policies[] | select(.Name == "FullAWSAccess") | .Id' || true)"

  if [[ -z "$found" ]]; then
    log_warn "FullAWSAccess is NOT attached to ${target_label} (${target_id})."
    log_warn "SCPs are allow-list filters: without it, everything in that scope is denied."
  fi
}

# ---------------------------------------------------------------------------
# Policy documents
# ---------------------------------------------------------------------------

write_production_guardrails() {
  local out_file="$1"
  jq -n --arg qualifier "$KINMAP_CDK_QUALIFIER" '{
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "DenyLeavingTheOrganization",
        Effect: "Deny",
        Action: ["organizations:LeaveOrganization"],
        Resource: "*"
      },
      {
        Sid: "DenyDisablingSecurityServices",
        Effect: "Deny",
        Action: [
          "cloudtrail:StopLogging",
          "cloudtrail:DeleteTrail",
          "cloudtrail:DeleteEventDataStore",
          "cloudtrail:StopEventDataStoreIngestion",
          "guardduty:DeleteDetector",
          "guardduty:DeleteMembers",
          "guardduty:DisassociateMembers",
          "guardduty:DisassociateFromMasterAccount",
          "guardduty:DisassociateFromAdministratorAccount",
          "guardduty:StopMonitoringMembers",
          "guardduty:DeletePublishingDestination",
          "config:DeleteConfigurationRecorder",
          "config:StopConfigurationRecorder",
          "config:DeleteDeliveryChannel",
          "config:DeleteRetentionConfiguration",
          "config:DeleteConfigurationAggregator"
        ],
        Resource: "*"
      },
      {
        Sid: "DenyReconfiguringSecurityServicesOutsideIaC",
        Effect: "Deny",
        Action: [
          "cloudtrail:UpdateTrail",
          "cloudtrail:PutEventSelectors",
          "cloudtrail:UpdateEventDataStore",
          "guardduty:UpdateDetector",
          "guardduty:UpdatePublishingDestination",
          "config:PutConfigurationRecorder",
          "config:PutDeliveryChannel",
          "config:PutRetentionConfiguration"
        ],
        Resource: "*",
        Condition: {
          ArnNotLike: {
            "aws:PrincipalArn": [
              ("arn:aws:iam::*:role/cdk-" + $qualifier + "-cfn-exec-role-*")
            ]
          }
        }
      },
      {
        Sid: "DenyDestroyingEncryptionKeys",
        Effect: "Deny",
        Action: [
          "kms:ScheduleKeyDeletion",
          "kms:DisableKey",
          "kms:DisableKeyRotation"
        ],
        Resource: "*"
      },
      {
        Sid: "DenyDestroyingBackups",
        Effect: "Deny",
        Action: [
          "dynamodb:DeleteBackup",
          "backup:DeleteBackupPlan",
          "backup:DeleteBackupSelection",
          "backup:DeleteBackupVault",
          "backup:DeleteBackupVaultAccessPolicy",
          "backup:DeleteBackupVaultLockConfiguration",
          "backup:DeleteBackupVaultNotifications",
          "backup:DeleteRecoveryPoint",
          "backup:DisassociateRecoveryPoint",
          "backup:UpdateRecoveryPointLifecycle",
          "backup:StopBackupJob",
          "backup:PutBackupVaultAccessPolicy"
        ],
        Resource: "*"
      }
    ]
  }' >"$out_file"
}

# ---------------------------------------------------------------------------
# Region lock
#
# `aws:RequestedRegion` is absent on global endpoints, so a plain deny would
# lock out IAM, Organizations, STS, Route53, CloudFront and — critically here —
# the Identity Center endpoints in us-east-2, which is NOT a workload region.
# Losing the ability to sign in is a self-inflicted outage, so those services
# are listed in NotAction.
#
# Service-linked roles are exempt from SCPs by design, so no condition on
# aws:PrincipalArn is needed to keep AWS's own automation working.
# ---------------------------------------------------------------------------

write_region_lock() {
  local out_file="$1" regions
  regions="$(printf '%s\n' "${KINMAP_ALLOWED_REGIONS[@]}" |
    jq -R -s -c 'split("\n") | map(select(length > 0))')"

  jq -n --argjson regions "$regions" '{
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "DenyRegionsOutsideTheApprovedList",
        Effect: "Deny",
        NotAction: [
          "a4b:*",
          "account:*",
          "artifact:*",
          "aws-marketplace:*",
          "aws-portal:*",
          "billing:*",
          "budgets:*",
          "ce:*",
          "cloudfront:*",
          "consolidatedbilling:*",
          "cur:*",
          "ec2:DescribeRegions",
          "globalaccelerator:*",
          "health:*",
          "iam:*",
          "identitystore:*",
          "invoicing:*",
          "notifications:*",
          "organizations:*",
          "payments:*",
          "pricing:*",
          "route53:*",
          "route53domains:*",
          "s3:GetAccountPublicAccessBlock",
          "s3:ListAccessPoints",
          "s3:ListAllMyBuckets",
          "s3:PutAccountPublicAccessBlock",
          "shield:*",
          "signin:*",
          "sso:*",
          "sso-directory:*",
          "sts:*",
          "support:*",
          "supportplans:*",
          "tax:*",
          "trustedadvisor:*",
          "waf:*"
        ],
        Resource: "*",
        Condition: {
          StringNotEquals: { "aws:RequestedRegion": $regions }
        }
      }
    ]
  }' >"$out_file"
}

write_deny_root_user() {
  local out_file="$1"
  jq -n '{
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "DenyAllRootUserActions",
        Effect: "Deny",
        Action: "*",
        Resource: "*",
        Condition: {
          StringLike: { "aws:PrincipalArn": ["arn:aws:iam::*:root"] }
        }
      }
    ]
  }' >"$out_file"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

main() {
  parse_args "$@"
  require_aws_tools
  strip_ambient_credentials

  ORG=(aws organizations --region "$KINMAP_ORG_REGION" --profile "$KINMAP_MANAGEMENT_PROFILE")

  log_step "Kinmap service control policies"
  if [[ "$DRY_RUN" == "true" ]]; then
    log_warn "DRY RUN — nothing will be created, updated or attached."
  fi

  verify_profile_account "$KINMAP_MANAGEMENT_PROFILE" "$KINMAP_MANAGEMENT_ACCOUNT_ID" 'organization management'

  local root_id
  root_id="$(organization_root_id)"
  log_ok "Organization root: ${root_id}"

  ensure_scp_policy_type_enabled "$root_id"

  log_step "Verifying organizational units"
  verify_organizational_unit "$KINMAP_OU_PRODUCTION" 'Production'
  verify_organizational_unit "$KINMAP_OU_NONPRODUCTION" 'NonProduction'

  log_step "Building policy documents"
  local guardrails_file region_lock_file deny_root_file
  guardrails_file="${KINMAP_TMP_DIR}/production-guardrails.json"
  region_lock_file="${KINMAP_TMP_DIR}/region-lock.json"
  deny_root_file="${KINMAP_TMP_DIR}/deny-root-user.json"
  write_production_guardrails "$guardrails_file"
  write_region_lock "$region_lock_file"
  write_deny_root_user "$deny_root_file"

  # ---- Production OU -----------------------------------------------------
  log_step "Production OU (${KINMAP_OU_PRODUCTION})"
  warn_if_full_access_missing "$KINMAP_OU_PRODUCTION" 'Production OU'

  local guardrails_id region_lock_id
  guardrails_id="$(ensure_policy "$SCP_PRODUCTION_GUARDRAILS" \
    'Kinmap production guardrails: cannot leave the org, cannot disable CloudTrail/GuardDuty/Config, cannot delete KMS keys or backups.' \
    "$guardrails_file")"
  ensure_attachment "$guardrails_id" "$SCP_PRODUCTION_GUARDRAILS" \
    "$KINMAP_OU_PRODUCTION" 'Production OU'

  region_lock_id="$(ensure_policy "$SCP_REGION_LOCK" \
    "Kinmap production region lock: regional actions are denied outside ${KINMAP_ALLOWED_REGIONS[*]}." \
    "$region_lock_file")"
  ensure_attachment "$region_lock_id" "$SCP_REGION_LOCK" \
    "$KINMAP_OU_PRODUCTION" 'Production OU'

  # ---- Root --------------------------------------------------------------
  log_step "Organization root (${root_id})"
  warn_if_full_access_missing "$root_id" 'organization root'

  local deny_root_id
  deny_root_id="$(ensure_policy "$SCP_DENY_ROOT" \
    'Kinmap: deny all root-user actions in member accounts. Does not affect the management account, which SCPs never restrict.' \
    "$deny_root_file")"

  # Attaching at the root touches every account in the organization. Ask once.
  local proceed=true
  if [[ "$DRY_RUN" == "false" && "$ASSUME_YES" == "false" ]]; then
    log_warn "Attaching ${SCP_DENY_ROOT} to the root applies it to EVERY member account."
    log_warn "Root-only tasks (closing an account, some S3 bucket-policy recovery) will"
    log_warn "then require temporarily detaching it — see scripts/aws/README.md."
    if ! confirm "Attach ${SCP_DENY_ROOT} to root ${root_id}?"; then
      proceed=false
    fi
  fi

  if [[ "$proceed" == "true" ]]; then
    ensure_attachment "$deny_root_id" "$SCP_DENY_ROOT" "$root_id" 'organization root'
  else
    log_warn "Skipped attaching ${SCP_DENY_ROOT}. Attach it later with:"
    log_warn "  aws organizations attach-policy --profile ${KINMAP_MANAGEMENT_PROFILE} \\"
    log_warn "    --policy-id ${deny_root_id} --target-id ${root_id}"
  fi

  log_step "Reminder"
  log_info "SCPs never restrict the management account (${KINMAP_MANAGEMENT_ACCOUNT_ID})."
  log_info "Keep it empty of workloads: it is the one account these guardrails cannot cover."

  print_change_summary
}

main "$@"
