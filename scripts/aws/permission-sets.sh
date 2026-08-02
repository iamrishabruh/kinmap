#!/usr/bin/env bash
#
# Kinmap — IAM Identity Center permission sets and account assignments.
#
#   ./scripts/aws/permission-sets.sh [--dry-run] [--profile <mgmt-profile>] [--yes]
#
# ---------------------------------------------------------------------------
# Why this file exists, and why it is not simply "AdministratorAccess everywhere"
# ---------------------------------------------------------------------------
#
# This product stores where people are. Not "where a device connected from" —
# where a named child, partner or parent physically stood, minute by minute, for
# the last thirty days. That is the most sensitive category of data an ordinary
# consumer app ever holds, and it changes what "admin access" is allowed to mean.
#
# The governing idea here is that **deploying the infrastructure and reading the
# rows are different privileges**, and only the first one is granted by default.
#
# Concretely: rolling a Lambda, adding a global secondary index, resizing a
# table, fixing an API Gateway stage — all of that is routine, happens under
# time pressure, and must not require an identity that is also able to run
# `aws dynamodb scan --table-name kinmap-production-LocationHistory`. Those are
# unrelated capabilities that only look similar because AWS historically bundled
# them into one blunt policy. So KinmapProdDeploy can create, alter and delete
# the location tables — the *containers* — while an explicit Deny stops it from
# reading a single item out of them, and a second Deny stops it decrypting the
# customer-managed key those coordinates are wrapped with.
#
# The residual paths are acknowledged rather than hidden:
#
#   * A deployer can still ship code that reads the table, because that is what
#     deploying means. The control for that is code review, a two-branch release
#     flow, and CloudTrail — not IAM.
#   * `cdk deploy` runs its CloudFormation changes through the bootstrap
#     execution role, which by default is AdministratorAccess. Pass
#     `--cfn-exec-policy` to bootstrap-accounts.sh to narrow that too.
#   * Genuine emergencies exist. They are served by KinmapProdBreakGlass, which
#     is deliberately named so that a single grep of CloudTrail for
#     "BreakGlass" answers "did anyone use god-mode last night?".
#
# Everything below is idempotent: each object is looked up before it is created,
# and each policy document is compared before it is written.
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
# Desired state
# ---------------------------------------------------------------------------

PS_ADMIN='KinmapAdmin'
PS_PROD_DEPLOY='KinmapProdDeploy'
PS_BREAK_GLASS='KinmapProdBreakGlass'
PS_READ_ONLY='KinmapReadOnly'

# Session durations (ISO-8601). Eight hours for non-production because that is
# a working day and re-authenticating mid-debug helps nobody. One hour for
# anything that touches production, because a stolen or forgotten production
# session is the thing we are actually defending against.
DURATION_ADMIN='PT8H'
DURATION_PROD_DEPLOY='PT1H'
DURATION_BREAK_GLASS='PT1H'
# Read-only still sees names, family structure and device metadata, so it is not
# "harmless". Four hours: long enough for an audit or a support shift.
DURATION_READ_ONLY='PT4H'

MANAGED_ADMIN='arn:aws:iam::aws:policy/AdministratorAccess'
MANAGED_READ_ONLY='arn:aws:iam::aws:policy/ReadOnlyAccess'

# Assignments target *groups*, never individual users. A person leaving the
# project is then one group membership removal rather than an archaeology
# expedition through per-account assignments.
GROUP_ADMINS="${KINMAP_GROUP_ADMINS:-KinmapAdmins}"
GROUP_PROD_DEPLOYERS="${KINMAP_GROUP_PROD_DEPLOYERS:-KinmapProdDeployers}"
GROUP_AUDITORS="${KINMAP_GROUP_AUDITORS:-KinmapAuditors}"
GROUP_BREAK_GLASS="${KINMAP_GROUP_BREAK_GLASS:-KinmapBreakGlass}"

# Profile prefix for the member-account profiles. Only used opportunistically,
# to resolve the real coordinate-key ARNs; the script works fine without them.
WORKLOAD_PROFILE_PREFIX="${KINMAP_WORKLOAD_PROFILE_PREFIX:-${KINMAP_APP_NAME}}"

SSO=()
IDS=()

# ---------------------------------------------------------------------------
# Arguments
# ---------------------------------------------------------------------------

usage() {
  cat >&2 <<'EOF'
Usage: ./scripts/aws/permission-sets.sh [options]

Idempotently creates the Kinmap IAM Identity Center permission sets and assigns
them to the member accounts.

  KinmapAdmin           AdministratorAccess, NON-PRODUCTION accounts only, 8h
  KinmapProdDeploy      Production deploys; may administer the location tables
                        but may not read their rows or decrypt coordinates, 1h
  KinmapProdBreakGlass  AdministratorAccess on production, 1h, NOT assigned —
                        the command to assign it is printed instead
  KinmapReadOnly        ReadOnlyAccess minus location data and coordinate
                        decryption, all accounts, 4h

EOF
  print_common_flags
  cat >&2 <<'EOF'

Extra flags:
  --workload-profile-prefix <p>  Prefix of the member-account profiles used to
                                 resolve real KMS key ARNs (default: kinmap)

Environment overrides:
  KINMAP_ACCOUNT_ID_DEVELOPMENT / _STAGING / _PRODUCTION
  KINMAP_GROUP_ADMINS / _PROD_DEPLOYERS / _AUDITORS / _BREAK_GLASS
EOF
  exit 2
}

parse_args() {
  while (($#)); do
    case "$1" in
      --dry-run) DRY_RUN=true; shift ;;
      --yes | -y) ASSUME_YES=true; shift ;;
      --profile) KINMAP_MANAGEMENT_PROFILE="${2:?--profile needs a value}"; shift 2 ;;
      --workload-profile-prefix) WORKLOAD_PROFILE_PREFIX="${2:?--workload-profile-prefix needs a value}"; shift 2 ;;
      -h | --help) usage ;;
      *) log_error "Unknown argument: $1"; usage ;;
    esac
  done
}

# ---------------------------------------------------------------------------
# Identity Center primitives
# ---------------------------------------------------------------------------

verify_instance() {
  local found
  found="$("${SSO[@]}" list-instances --output json 2>/dev/null |
    jq -r --arg arn "$KINMAP_INSTANCE_ARN" \
      '.Instances[] | select(.InstanceArn == $arn) | .IdentityStoreId' || true)"

  if [[ -z "$found" ]]; then
    log_error "Identity Center instance ${KINMAP_INSTANCE_ARN} was not found in"
    log_error "${KINMAP_IDENTITY_CENTER_REGION} using profile '${KINMAP_MANAGEMENT_PROFILE}'."
    die "Identity Center is regional — check that the instance really lives in ${KINMAP_IDENTITY_CENTER_REGION}."
  fi
  if [[ "$found" != "$KINMAP_IDENTITY_STORE_ID" ]]; then
    die "Instance reports identity store '${found}' but this script is pinned to '${KINMAP_IDENTITY_STORE_ID}'."
  fi
  log_ok "Identity Center instance verified (identity store ${found})."
}

# stdout: the permission set ARN, or empty when it does not exist.
permission_set_arn_by_name() {
  local want="$1" arn name
  while IFS= read -r arn; do
    [[ -n "$arn" ]] || continue
    name="$("${SSO[@]}" describe-permission-set \
      --instance-arn "$KINMAP_INSTANCE_ARN" \
      --permission-set-arn "$arn" \
      --query 'PermissionSet.Name' --output text 2>/dev/null || true)"
    if [[ "$name" == "$want" ]]; then
      printf '%s' "$arn"
      return 0
    fi
  done < <("${SSO[@]}" list-permission-sets --instance-arn "$KINMAP_INSTANCE_ARN" \
    --output json 2>/dev/null | jq -r '.PermissionSets[]?' || true)
  return 0
}

# stdout: the permission set ARN (real, or a DRY-RUN- placeholder).
ensure_permission_set() {
  local name="$1" description="$2" duration="$3" arn current_duration

  arn="$(permission_set_arn_by_name "$name")"

  if [[ -z "$arn" ]]; then
    arn="$(mutate_capture "create permission set ${name} (session ${duration})" \
      "DRY-RUN-permission-set-${name}" \
      "${SSO[@]}" create-permission-set \
      --instance-arn "$KINMAP_INSTANCE_ARN" \
      --name "$name" \
      --description "$description" \
      --session-duration "$duration" \
      --tags "Key=app,Value=${KINMAP_APP_NAME}" \
      "Key=managed-by,Value=scripts/aws/permission-sets.sh" \
      --query 'PermissionSet.PermissionSetArn' --output text)"
    printf '%s' "$arn"
    return 0
  fi

  log_skip "Permission set ${name} exists."

  # Drift: a session duration that has been widened by hand is a real finding,
  # not cosmetic — an 8-hour production session is most of a night.
  current_duration="$("${SSO[@]}" describe-permission-set \
    --instance-arn "$KINMAP_INSTANCE_ARN" --permission-set-arn "$arn" \
    --query 'PermissionSet.SessionDuration' --output text 2>/dev/null || true)"
  if [[ "$current_duration" != "$duration" ]]; then
    mutate "reset ${name} session duration ${current_duration} -> ${duration}" \
      "${SSO[@]}" update-permission-set \
      --instance-arn "$KINMAP_INSTANCE_ARN" \
      --permission-set-arn "$arn" \
      --description "$description" \
      --session-duration "$duration"
  fi

  printf '%s' "$arn"
}

ensure_managed_policy() {
  local ps_arn="$1" ps_name="$2" policy_arn="$3" attached

  if is_placeholder "$ps_arn"; then
    log_info "would attach ${policy_arn} to ${ps_name}"
    record_change "(dry-run) attach ${policy_arn} to ${ps_name}"
    return 0
  fi

  attached="$("${SSO[@]}" list-managed-policies-in-permission-set \
    --instance-arn "$KINMAP_INSTANCE_ARN" --permission-set-arn "$ps_arn" \
    --output json 2>/dev/null | jq -r --arg a "$policy_arn" \
    '.AttachedManagedPolicies[]? | select(.Arn == $a) | .Arn' || true)"

  if [[ -n "$attached" ]]; then
    log_skip "${ps_name} already has ${policy_arn##*/}."
    return 0
  fi

  mutate "attach ${policy_arn##*/} to ${ps_name}" \
    "${SSO[@]}" attach-managed-policy-to-permission-set \
    --instance-arn "$KINMAP_INSTANCE_ARN" \
    --permission-set-arn "$ps_arn" \
    --managed-policy-arn "$policy_arn"
}

ensure_inline_policy() {
  local ps_arn="$1" ps_name="$2" policy_file="$3" current desired

  desired="$(json_canonical <"$policy_file")"

  if is_placeholder "$ps_arn"; then
    log_info "would put the inline policy on ${ps_name}"
    printf '        %s\n' "$(jq -c '.Statement | map(.Sid)' <"$policy_file")" >&2
    record_change "(dry-run) put inline policy on ${ps_name}"
    return 0
  fi

  current="$("${SSO[@]}" get-inline-policy-for-permission-set \
    --instance-arn "$KINMAP_INSTANCE_ARN" --permission-set-arn "$ps_arn" \
    --query 'InlinePolicy' --output text 2>/dev/null || true)"

  if [[ -n "$current" && "$current" != "None" ]]; then
    local normalized
    normalized="$(printf '%s' "$current" | json_canonical 2>/dev/null || true)"
    if [[ "$normalized" == "$desired" ]]; then
      log_skip "${ps_name} inline policy is already correct."
      return 0
    fi
    log_warn "${ps_name} inline policy differs from the desired document; replacing it."
  fi

  mutate "put inline policy on ${ps_name} ($(jq -r '.Statement | length' <"$policy_file") statements)" \
    "${SSO[@]}" put-inline-policy-to-permission-set \
    --instance-arn "$KINMAP_INSTANCE_ARN" \
    --permission-set-arn "$ps_arn" \
    --inline-policy "file://${policy_file}"
}

# A permission set change is inert until it is re-provisioned into every account
# it is already assigned to. Forgetting this is the classic "I tightened the
# policy and nothing happened" bug.
provision_permission_set() {
  local ps_arn="$1" ps_name="$2" accounts

  if is_placeholder "$ps_arn"; then
    return 0
  fi

  accounts="$("${SSO[@]}" list-accounts-for-provisioned-permission-set \
    --instance-arn "$KINMAP_INSTANCE_ARN" --permission-set-arn "$ps_arn" \
    --output json 2>/dev/null | jq -r '.AccountIds[]?' || true)"

  if [[ -z "$accounts" ]]; then
    log_skip "${ps_name} is not provisioned to any account yet; nothing to refresh."
    return 0
  fi

  mutate "re-provision ${ps_name} into all assigned accounts" \
    "${SSO[@]}" provision-permission-set \
    --instance-arn "$KINMAP_INSTANCE_ARN" \
    --permission-set-arn "$ps_arn" \
    --target-type ALL_PROVISIONED_ACCOUNTS
}

# ---------------------------------------------------------------------------
# Identity store groups
# ---------------------------------------------------------------------------

# stdout: group id (real, or a DRY-RUN- placeholder).
ensure_group() {
  local name="$1" description="$2" group_id='' identifier

  # AlternateIdentifier is a tagged union whose AttributeValue is a document
  # type; the CLI's key=value shorthand is unreliable for it, so build real JSON.
  identifier="$(jq -n --arg v "$name" \
    '{UniqueAttribute: {AttributePath: "displayName", AttributeValue: $v}}')"

  group_id="$("${IDS[@]}" get-group-id \
    --identity-store-id "$KINMAP_IDENTITY_STORE_ID" \
    --alternate-identifier "$identifier" \
    --query 'GroupId' --output text 2>/dev/null || true)"

  if [[ -n "$group_id" && "$group_id" != "None" ]]; then
    log_skip "Group ${name} exists (${group_id})."
    printf '%s' "$group_id"
    return 0
  fi

  # If the identity source is an external IdP, groups arrive over SCIM and the
  # API refuses to create them. That is a manual gate, not a script bug.
  if ! group_id="$(mutate_capture "create identity store group ${name}" \
    "DRY-RUN-group-${name}" \
    "${IDS[@]}" create-group \
    --identity-store-id "$KINMAP_IDENTITY_STORE_ID" \
    --display-name "$name" \
    --description "$description" \
    --query 'GroupId' --output text)"; then
    log_warn "Could not create group '${name}' in the identity store."
    record_gate \
      "Create the Identity Center group '${name}'" \
      "The identity source appears to be an external IdP, so groups are provisioned by SCIM and cannot be created through the API." \
      "https://${KINMAP_IDENTITY_STORE_ID}.awsapps.com/start -> IAM Identity Center -> Groups" \
      "Group name '${name}' — ${description}"
    printf 'DRY-RUN-group-%s' "$name"
    return 0
  fi

  printf '%s' "$group_id"
}

# ---------------------------------------------------------------------------
# Assignments
# ---------------------------------------------------------------------------

assignment_exists() {
  local ps_arn="$1" account_id="$2" principal_id="$3" hit
  hit="$("${SSO[@]}" list-account-assignments \
    --instance-arn "$KINMAP_INSTANCE_ARN" \
    --account-id "$account_id" \
    --permission-set-arn "$ps_arn" \
    --output json 2>/dev/null | jq -r --arg p "$principal_id" \
    '.AccountAssignments[]? | select(.PrincipalId == $p) | .PrincipalId' || true)"
  [[ -n "$hit" ]]
}

wait_for_assignment() {
  local request_id="$1" label="$2" attempt=0 status='' reason=''

  while ((attempt < 30)); do
    status="$("${SSO[@]}" describe-account-assignment-creation-status \
      --instance-arn "$KINMAP_INSTANCE_ARN" \
      --account-assignment-creation-request-id "$request_id" \
      --query 'AccountAssignmentCreationStatus.Status' --output text 2>/dev/null || true)"
    case "$status" in
      SUCCEEDED)
        log_ok "Assignment ${label} succeeded."
        return 0
        ;;
      FAILED)
        reason="$("${SSO[@]}" describe-account-assignment-creation-status \
          --instance-arn "$KINMAP_INSTANCE_ARN" \
          --account-assignment-creation-request-id "$request_id" \
          --query 'AccountAssignmentCreationStatus.FailureReason' --output text 2>/dev/null || true)"
        die "Assignment ${label} FAILED: ${reason}"
        ;;
      *) : ;;
    esac
    attempt=$((attempt + 1))
    sleep 2
  done

  log_warn "Assignment ${label} is still IN_PROGRESS after 60s; it will most likely finish on its own."
  log_info "Check with: aws sso-admin describe-account-assignment-creation-status \\"
  log_info "  --region ${KINMAP_IDENTITY_CENTER_REGION} --instance-arn ${KINMAP_INSTANCE_ARN} \\"
  log_info "  --account-assignment-creation-request-id ${request_id}"
  return 0
}

ensure_assignment() {
  local ps_arn="$1" ps_name="$2" account_id="$3" account_label="$4"
  local group_id="$5" group_name="$6" request_id

  if is_placeholder "$ps_arn" || is_placeholder "$group_id"; then
    log_info "would assign ${ps_name} to ${group_name} on ${account_label} (${account_id})"
    record_change "(dry-run) assign ${ps_name} -> ${group_name} on ${account_label}"
    return 0
  fi

  if assignment_exists "$ps_arn" "$account_id" "$group_id"; then
    log_skip "${ps_name} already assigned to ${group_name} on ${account_label}."
    return 0
  fi

  request_id="$(mutate_capture \
    "assign ${ps_name} to group ${group_name} on ${account_label} (${account_id})" \
    'DRY-RUN-request' \
    "${SSO[@]}" create-account-assignment \
    --instance-arn "$KINMAP_INSTANCE_ARN" \
    --target-id "$account_id" \
    --target-type AWS_ACCOUNT \
    --permission-set-arn "$ps_arn" \
    --principal-type GROUP \
    --principal-id "$group_id" \
    --query 'AccountAssignmentCreationStatus.RequestId' --output text)"

  if [[ "$request_id" == "DRY-RUN-request" ]]; then
    return 0
  fi
  wait_for_assignment "$request_id" "${ps_name} on ${account_label}"
}

# The inverse check. KinmapAdmin on production would quietly undo the entire
# point of this file, so we look for it every run and shout if it is there.
assert_not_assigned() {
  local ps_arn="$1" ps_name="$2" account_id="$3" account_label="$4" principals

  if is_placeholder "$ps_arn"; then
    return 0
  fi

  principals="$("${SSO[@]}" list-account-assignments \
    --instance-arn "$KINMAP_INSTANCE_ARN" \
    --account-id "$account_id" \
    --permission-set-arn "$ps_arn" \
    --output json 2>/dev/null | jq -r \
    '.AccountAssignments[]? | "\(.PrincipalType) \(.PrincipalId)"' || true)"

  if [[ -z "$principals" ]]; then
    log_ok "${ps_name} is correctly NOT assigned on ${account_label}."
    return 0
  fi

  log_error "${ps_name} IS ASSIGNED on ${account_label} (${account_id}):"
  local line
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    log_error "  ${line}"
    # Deliberately not removed automatically: revoking access to production
    # while someone is mid-incident is its own outage.
    printf '    aws sso-admin delete-account-assignment --region %s \\\n' "$KINMAP_IDENTITY_CENTER_REGION" >&2
    printf '      --instance-arn %s --target-id %s --target-type AWS_ACCOUNT \\\n' "$KINMAP_INSTANCE_ARN" "$account_id" >&2
    printf '      --permission-set-arn %s \\\n' "$ps_arn" >&2
    printf '      --principal-type %s --principal-id %s\n' "${line%% *}" "${line##* }" >&2
  done <<<"$principals"
  record_change "FINDING: ${ps_name} is assigned on ${account_label} and should not be"
}

# ---------------------------------------------------------------------------
# Policy documents
# ---------------------------------------------------------------------------

# Best effort: if we can reach a member account, pin the deny to the real key
# ARN as well as to the alias. Before the first `cdk deploy` the key does not
# exist yet and the alias condition alone carries the policy.
resolve_coordinate_key_arns() {
  local env="$1" prefix profile region arn
  local arns=()
  prefix="$(resource_prefix_for_env "$env")"
  profile="${WORKLOAD_PROFILE_PREFIX}-${env}"

  for region in "${KINMAP_ALLOWED_REGIONS[@]}"; do
    arn="$(aws kms describe-key \
      --key-id "$(coordinate_key_alias "$prefix")" \
      --profile "$profile" --region "$region" \
      --query 'KeyMetadata.Arn' --output text 2>/dev/null || true)"
    if [[ -n "$arn" && "$arn" != "None" ]]; then
      arns+=("$arn")
    fi
  done

  if ((${#arns[@]} == 0)); then
    printf '[]'
    return 0
  fi
  printf '%s\n' "${arns[@]}" | jq -R -s -c 'split("\n") | map(select(length > 0))'
}

# The two denies that define this whole directory, built for one or more
# environments. Everything else in a policy document is ordinary plumbing.
build_deny_statements() {
  local envs=("$@")
  local env account prefix
  local table_arns='[]' kms_resources='[]' aliases='[]' key_arns='[]'
  local chunk

  for env in "${envs[@]}"; do
    account="$(resolve_account_id "$env")"
    prefix="$(resource_prefix_for_env "$env")"

    chunk="$(location_table_resource_arns "$account" "$prefix")"
    table_arns="$(jq -n --argjson a "$table_arns" --argjson b "$chunk" '$a + $b')"

    kms_resources="$(jq -n --argjson a "$kms_resources" \
      --arg b "arn:aws:kms:*:${account}:key/*" '$a + [$b]')"
    aliases="$(jq -n --argjson a "$aliases" \
      --arg b "$(coordinate_key_alias "$prefix")" '$a + [$b]')"

    chunk="$(resolve_coordinate_key_arns "$env")"
    key_arns="$(jq -n --argjson a "$key_arns" --argjson b "$chunk" '$a + $b')"
  done

  jq -n \
    --argjson tables "$table_arns" \
    --argjson kmsResources "$kms_resources" \
    --argjson aliases "$aliases" \
    --argjson keyArns "$key_arns" \
    '[
      {
        Sid: "DenyReadingLocationData",
        Effect: "Deny",
        Action: [
          "dynamodb:GetItem",
          "dynamodb:BatchGetItem",
          "dynamodb:Query",
          "dynamodb:Scan",
          "dynamodb:PartiQLSelect",
          "dynamodb:GetRecords",
          "dynamodb:ExportTableToPointInTime",
          "dynamodb:RestoreTableFromBackup",
          "dynamodb:RestoreTableToPointInTime"
        ],
        Resource: $tables
      },
      {
        Sid: "DenyDecryptingCoordinateKeyByAlias",
        Effect: "Deny",
        Action: ["kms:Decrypt", "kms:ReEncryptFrom"],
        Resource: $kmsResources,
        Condition: {
          "ForAnyValue:StringEquals": { "kms:ResourceAliases": $aliases }
        }
      },
      {
        Sid: "DenyReadingSecretValues",
        Effect: "Deny",
        Action: ["secretsmanager:GetSecretValue"],
        Resource: "*"
      }
    ]
    + (if ($keyArns | length) > 0 then [{
        Sid: "DenyDecryptingCoordinateKeyByArn",
        Effect: "Deny",
        Action: ["kms:Decrypt", "kms:ReEncryptFrom"],
        Resource: $keyArns
      }] else [] end)'
}

write_prod_deploy_policy() {
  local out_file="$1" account prefix denies allows
  account="$(resolve_account_id production)"
  prefix="$(resource_prefix_for_env production)"

  denies="$(build_deny_statements production)"

  allows="$(jq -n \
    --arg account "$account" \
    --arg qualifier "$KINMAP_CDK_QUALIFIER" \
    '[
      {
        Sid: "CloudFormationDeployment",
        Effect: "Allow",
        Action: ["cloudformation:*"],
        Resource: "*"
      },
      {
        Sid: "AssumeCdkBootstrapRoles",
        Effect: "Allow",
        Action: ["sts:AssumeRole", "sts:TagSession", "sts:GetCallerIdentity"],
        Resource: ("arn:aws:iam::" + $account + ":role/cdk-" + $qualifier + "-*")
      },
      {
        Sid: "CdkAssetStaging",
        Effect: "Allow",
        Action: [
          "s3:GetObject", "s3:GetObjectVersion", "s3:PutObject",
          "s3:DeleteObject", "s3:ListBucket", "s3:GetBucketLocation",
          "s3:GetEncryptionConfiguration", "s3:AbortMultipartUpload",
          "s3:ListBucketMultipartUploads", "s3:ListMultipartUploadParts"
        ],
        Resource: [
          ("arn:aws:s3:::cdk-" + $qualifier + "-assets-" + $account + "-*"),
          ("arn:aws:s3:::cdk-" + $qualifier + "-assets-" + $account + "-*/*")
        ]
      },
      {
        Sid: "CdkContainerAssets",
        Effect: "Allow",
        Action: [
          "ecr:GetAuthorizationToken", "ecr:BatchCheckLayerAvailability",
          "ecr:InitiateLayerUpload", "ecr:UploadLayerPart",
          "ecr:CompleteLayerUpload", "ecr:PutImage", "ecr:BatchGetImage",
          "ecr:GetDownloadUrlForLayer", "ecr:DescribeRepositories",
          "ecr:DescribeImages"
        ],
        Resource: ("arn:aws:ecr:*:" + $account + ":repository/cdk-" + $qualifier + "-*")
      },
      {
        Sid: "BootstrapAndApplicationParameters",
        Effect: "Allow",
        Action: [
          "ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath",
          "ssm:PutParameter", "ssm:DeleteParameter", "ssm:DescribeParameters",
          "ssm:AddTagsToResource", "ssm:RemoveTagsFromResource",
          "ssm:ListTagsForResource"
        ],
        Resource: [
          ("arn:aws:ssm:*:" + $account + ":parameter/cdk-bootstrap/*"),
          ("arn:aws:ssm:*:" + $account + ":parameter/kinmap/*")
        ]
      },
      {
        Sid: "ApiComputeAndOperationsAdministration",
        Effect: "Allow",
        Action: [
          "lambda:*", "apigateway:*", "logs:*", "cloudwatch:*",
          "sns:*", "sqs:*", "events:*", "scheduler:*", "states:*",
          "xray:*", "acm:*", "route53:*", "cloudfront:*",
          "cognito-idp:*", "cognito-identity:*", "wafv2:*",
          "application-autoscaling:*", "synthetics:*", "firehose:*",
          "budgets:*", "tag:GetResources", "tag:TagResources",
          "tag:UntagResources", "cloudtrail:DescribeTrails",
          "cloudtrail:GetTrailStatus", "guardduty:Get*", "guardduty:List*",
          "config:Describe*", "config:Get*"
        ],
        Resource: "*"
      },
      {
        Sid: "BucketAdministrationNotObjectReads",
        Effect: "Allow",
        Action: [
          "s3:CreateBucket", "s3:DeleteBucket", "s3:ListAllMyBuckets",
          "s3:GetBucket*", "s3:PutBucket*", "s3:DeleteBucketPolicy",
          "s3:GetEncryptionConfiguration", "s3:PutEncryptionConfiguration",
          "s3:GetLifecycleConfiguration", "s3:PutLifecycleConfiguration",
          "s3:GetAccountPublicAccessBlock", "s3:PutAccountPublicAccessBlock",
          "s3:GetReplicationConfiguration", "s3:PutReplicationConfiguration"
        ],
        Resource: "*"
      },
      {
        Sid: "KmsKeyAdministrationWithoutDataUse",
        Effect: "Allow",
        Action: [
          "kms:CreateKey", "kms:CreateAlias", "kms:UpdateAlias",
          "kms:DeleteAlias", "kms:DescribeKey", "kms:ListAliases",
          "kms:ListKeys", "kms:ListResourceTags", "kms:TagResource",
          "kms:UntagResource", "kms:GetKeyPolicy", "kms:PutKeyPolicy",
          "kms:GetKeyRotationStatus", "kms:EnableKeyRotation",
          "kms:EnableKey", "kms:ScheduleKeyDeletion", "kms:CancelKeyDeletion"
        ],
        Resource: "*"
      },
      {
        Sid: "SecretsMetadataAdministration",
        Effect: "Allow",
        Action: [
          "secretsmanager:CreateSecret", "secretsmanager:UpdateSecret",
          "secretsmanager:DescribeSecret", "secretsmanager:ListSecrets",
          "secretsmanager:TagResource", "secretsmanager:UntagResource",
          "secretsmanager:GetResourcePolicy", "secretsmanager:PutResourcePolicy",
          "secretsmanager:DeleteSecret", "secretsmanager:RestoreSecret",
          "secretsmanager:RotateSecret"
        ],
        Resource: "*"
      },
      {
        Sid: "DynamoDbTableAndIndexAdministration",
        Effect: "Allow",
        Action: [
          "dynamodb:CreateTable", "dynamodb:UpdateTable", "dynamodb:DeleteTable",
          "dynamodb:DescribeTable", "dynamodb:ListTables", "dynamodb:DescribeLimits",
          "dynamodb:UpdateTimeToLive", "dynamodb:DescribeTimeToLive",
          "dynamodb:TagResource", "dynamodb:UntagResource",
          "dynamodb:ListTagsOfResource", "dynamodb:DescribeContinuousBackups",
          "dynamodb:UpdateContinuousBackups", "dynamodb:DescribeStream",
          "dynamodb:ListStreams", "dynamodb:CreateBackup",
          "dynamodb:DescribeBackup", "dynamodb:ListBackups",
          "dynamodb:DescribeExport", "dynamodb:DescribeImport",
          "dynamodb:UpdateContributorInsights",
          "dynamodb:DescribeContributorInsights",
          "dynamodb:DescribeTableReplicaAutoScaling",
          "dynamodb:UpdateTableReplicaAutoScaling",
          "dynamodb:EnableKinesisStreamingDestination",
          "dynamodb:DisableKinesisStreamingDestination",
          "dynamodb:DescribeKinesisStreamingDestination"
        ],
        Resource: "*"
      },
      {
        Sid: "IamReadOnly",
        Effect: "Allow",
        Action: ["iam:Get*", "iam:List*", "iam:SimulatePrincipalPolicy"],
        Resource: "*"
      },
      {
        Sid: "PassServiceRolesToAwsServicesOnly",
        Effect: "Allow",
        Action: ["iam:PassRole"],
        Resource: "*",
        Condition: {
          StringEquals: {
            "iam:PassedToService": [
              "lambda.amazonaws.com", "apigateway.amazonaws.com",
              "events.amazonaws.com", "states.amazonaws.com",
              "scheduler.amazonaws.com", "dynamodb.amazonaws.com",
              "sns.amazonaws.com", "sqs.amazonaws.com",
              "firehose.amazonaws.com", "logs.amazonaws.com",
              "cloudformation.amazonaws.com"
            ]
          }
        }
      },
      {
        Sid: "DenyCreatingAlternateIdentities",
        Effect: "Deny",
        Action: [
          "iam:CreateUser", "iam:CreateAccessKey", "iam:UpdateAccessKey",
          "iam:CreateLoginProfile", "iam:UpdateLoginProfile",
          "iam:AttachUserPolicy", "iam:PutUserPolicy",
          "iam:CreateServiceSpecificCredential",
          "iam:ResetServiceSpecificCredential",
          "iam:UpdateAssumeRolePolicy",
          "iam:DeleteRolePermissionsBoundary",
          "iam:DeleteUserPermissionsBoundary",
          "iam:CreateSAMLProvider", "iam:UpdateSAMLProvider",
          "iam:CreateOpenIDConnectProvider",
          "iam:AddClientIDToOpenIDConnectProvider"
        ],
        Resource: "*"
      },
      {
        Sid: "DenyAssumingAnyRoleExceptCdkBootstrapRoles",
        Effect: "Deny",
        Action: ["sts:AssumeRole", "sts:AssumeRoleWithSAML", "sts:AssumeRoleWithWebIdentity"],
        NotResource: [("arn:aws:iam::" + $account + ":role/cdk-" + $qualifier + "-*")]
      }
    ]')"

  jq -n --argjson allows "$allows" --argjson denies "$denies" \
    '{Version: "2012-10-17", Statement: ($allows + $denies)}' >"$out_file"

  log_info "Built ${PS_PROD_DEPLOY} policy for ${prefix} in account ${account}."
}

write_read_only_policy() {
  local out_file="$1" denies
  denies="$(build_deny_statements "${KINMAP_ENVIRONMENTS[@]}")"
  jq -n --argjson denies "$denies" \
    '{Version: "2012-10-17", Statement: $denies}' >"$out_file"
  log_info "Built ${PS_READ_ONLY} deny overlay for all ${#KINMAP_ENVIRONMENTS[@]} environments."
}

# ---------------------------------------------------------------------------
# Break glass
# ---------------------------------------------------------------------------

print_break_glass_instructions() {
  local ps_arn="$1" account_id="$2" group_id="$3"

  {
    printf '\n%s┌─ BREAK GLASS ────────────────────────────────────────%s\n' "$C_YELLOW" "$C_RESET"
    printf '%s│%s %s exists but is deliberately NOT assigned.\n' "$C_YELLOW" "$C_RESET" "$PS_BREAK_GLASS"
    printf '%s│%s\n' "$C_YELLOW" "$C_RESET"
    printf '%s│%s Assigning it is a decision, taken by a human, that is worth\n' "$C_YELLOW" "$C_RESET"
    printf '%s│%s writing down. Unassign it again when the incident is over.\n' "$C_YELLOW" "$C_RESET"
    printf '%s│%s\n' "$C_YELLOW" "$C_RESET"
    printf '%s│%s To grant it:\n' "$C_YELLOW" "$C_RESET"
    printf '%s│%s   aws sso-admin create-account-assignment \\\n' "$C_YELLOW" "$C_RESET"
    printf '%s│%s     --region %s \\\n' "$C_YELLOW" "$C_RESET" "$KINMAP_IDENTITY_CENTER_REGION"
    printf '%s│%s     --profile %s \\\n' "$C_YELLOW" "$C_RESET" "$KINMAP_MANAGEMENT_PROFILE"
    printf '%s│%s     --instance-arn %s \\\n' "$C_YELLOW" "$C_RESET" "$KINMAP_INSTANCE_ARN"
    printf '%s│%s     --target-id %s --target-type AWS_ACCOUNT \\\n' "$C_YELLOW" "$C_RESET" "$account_id"
    printf '%s│%s     --permission-set-arn %s \\\n' "$C_YELLOW" "$C_RESET" "$ps_arn"
    printf '%s│%s     --principal-type GROUP --principal-id %s\n' "$C_YELLOW" "$C_RESET" "$group_id"
    printf '%s│%s\n' "$C_YELLOW" "$C_RESET"
    printf '%s│%s To revoke it (do this the same day):\n' "$C_YELLOW" "$C_RESET"
    printf '%s│%s   aws sso-admin delete-account-assignment \\\n' "$C_YELLOW" "$C_RESET"
    printf '%s│%s     --region %s --profile %s \\\n' "$C_YELLOW" "$C_RESET" "$KINMAP_IDENTITY_CENTER_REGION" "$KINMAP_MANAGEMENT_PROFILE"
    printf '%s│%s     --instance-arn %s \\\n' "$C_YELLOW" "$C_RESET" "$KINMAP_INSTANCE_ARN"
    printf '%s│%s     --target-id %s --target-type AWS_ACCOUNT \\\n' "$C_YELLOW" "$C_RESET" "$account_id"
    printf '%s│%s     --permission-set-arn %s \\\n' "$C_YELLOW" "$C_RESET" "$ps_arn"
    printf '%s│%s     --principal-type GROUP --principal-id %s\n' "$C_YELLOW" "$C_RESET" "$group_id"
    printf '%s│%s\n' "$C_YELLOW" "$C_RESET"
    printf '%s│%s Every use is visible in CloudTrail. Look for the role name:\n' "$C_YELLOW" "$C_RESET"
    printf '%s│%s   AWSReservedSSO_%s_*\n' "$C_YELLOW" "$C_RESET" "$PS_BREAK_GLASS"
    printf '%s└──────────────────────────────────────────────────────%s\n' "$C_YELLOW" "$C_RESET"
  } >&2
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

main() {
  parse_args "$@"
  require_aws_tools
  strip_ambient_credentials

  SSO=(aws sso-admin --region "$KINMAP_IDENTITY_CENTER_REGION" --profile "$KINMAP_MANAGEMENT_PROFILE")
  IDS=(aws identitystore --region "$KINMAP_IDENTITY_CENTER_REGION" --profile "$KINMAP_MANAGEMENT_PROFILE")

  log_step "Kinmap IAM Identity Center permission sets"
  if [[ "$DRY_RUN" == "true" ]]; then
    log_warn "DRY RUN — nothing will be created or modified."
  fi

  verify_profile_account "$KINMAP_MANAGEMENT_PROFILE" "$KINMAP_MANAGEMENT_ACCOUNT_ID" 'organization management'
  verify_instance

  # ---- accounts ----------------------------------------------------------
  log_step "Resolving member accounts"
  local env account
  for env in "${KINMAP_ENVIRONMENTS[@]}"; do
    account="$(resolve_account_id "$env")"
    log_ok "$(printf '%-12s %s' "$env" "$account")"
    warn_on_unexpected_ou "$env" "$account"
  done

  local production_account
  production_account="$(resolve_account_id production)"

  # ---- groups ------------------------------------------------------------
  log_step "Identity store groups"
  local admins_id deployers_id auditors_id breakglass_id
  admins_id="$(ensure_group "$GROUP_ADMINS" 'Full administrative access to the non-production Kinmap accounts.')"
  deployers_id="$(ensure_group "$GROUP_PROD_DEPLOYERS" 'Deploys Kinmap production infrastructure. Cannot read location data.')"
  auditors_id="$(ensure_group "$GROUP_AUDITORS" 'Read-only across Kinmap accounts, excluding location data.')"
  breakglass_id="$(ensure_group "$GROUP_BREAK_GLASS" 'Emergency production administrators. Assigned only during an incident.')"

  # ---- policy documents --------------------------------------------------
  log_step "Building policy documents"
  local prod_deploy_policy read_only_policy
  prod_deploy_policy="${KINMAP_TMP_DIR}/prod-deploy.json"
  read_only_policy="${KINMAP_TMP_DIR}/read-only.json"
  write_prod_deploy_policy "$prod_deploy_policy"
  write_read_only_policy "$read_only_policy"

  # ---- KinmapAdmin -------------------------------------------------------
  log_step "${PS_ADMIN} — AdministratorAccess, non-production only"
  local admin_arn
  admin_arn="$(ensure_permission_set "$PS_ADMIN" \
    'Full administrative access to the non-production Kinmap accounts. Never assigned to production.' \
    "$DURATION_ADMIN")"
  ensure_managed_policy "$admin_arn" "$PS_ADMIN" "$MANAGED_ADMIN"
  for env in "${KINMAP_NONPRODUCTION_ENVIRONMENTS[@]}"; do
    # Belt and braces: the list is already non-production, but this loop is the
    # one place where a future edit could quietly widen admin to production.
    if is_production_env "$env"; then
      die "Refusing: '${env}' is production and must not receive ${PS_ADMIN}."
    fi
    account="$(resolve_account_id "$env")"
    ensure_assignment "$admin_arn" "$PS_ADMIN" "$account" "$env" "$admins_id" "$GROUP_ADMINS"
  done
  # Standing invariant, re-checked on every run.
  assert_not_assigned "$admin_arn" "$PS_ADMIN" "$production_account" 'production'
  provision_permission_set "$admin_arn" "$PS_ADMIN"

  # ---- KinmapProdDeploy --------------------------------------------------
  log_step "${PS_PROD_DEPLOY} — deploy production without being able to read it"
  local deploy_arn
  deploy_arn="$(ensure_permission_set "$PS_PROD_DEPLOY" \
    'Deploys Kinmap production infrastructure. Administers the location tables but is explicitly denied reading their items and decrypting the coordinate key.' \
    "$DURATION_PROD_DEPLOY")"
  ensure_inline_policy "$deploy_arn" "$PS_PROD_DEPLOY" "$prod_deploy_policy"
  ensure_assignment "$deploy_arn" "$PS_PROD_DEPLOY" "$production_account" 'production' \
    "$deployers_id" "$GROUP_PROD_DEPLOYERS"
  provision_permission_set "$deploy_arn" "$PS_PROD_DEPLOY"

  # ---- KinmapReadOnly ----------------------------------------------------
  log_step "${PS_READ_ONLY} — ReadOnlyAccess minus the location data"
  local read_only_arn
  read_only_arn="$(ensure_permission_set "$PS_READ_ONLY" \
    'Read-only across every Kinmap account, with location table data and coordinate-key decryption explicitly denied.' \
    "$DURATION_READ_ONLY")"
  ensure_managed_policy "$read_only_arn" "$PS_READ_ONLY" "$MANAGED_READ_ONLY"
  ensure_inline_policy "$read_only_arn" "$PS_READ_ONLY" "$read_only_policy"
  for env in "${KINMAP_ENVIRONMENTS[@]}"; do
    account="$(resolve_account_id "$env")"
    ensure_assignment "$read_only_arn" "$PS_READ_ONLY" "$account" "$env" "$auditors_id" "$GROUP_AUDITORS"
  done
  provision_permission_set "$read_only_arn" "$PS_READ_ONLY"

  # ---- KinmapProdBreakGlass ----------------------------------------------
  log_step "${PS_BREAK_GLASS} — created, not assigned"
  local break_glass_arn
  break_glass_arn="$(ensure_permission_set "$PS_BREAK_GLASS" \
    'EMERGENCY ONLY. AdministratorAccess on Kinmap production, including the ability to read location data. Assign for the duration of an incident and revoke immediately after; every use is visible in CloudTrail under AWSReservedSSO_KinmapProdBreakGlass_*.' \
    "$DURATION_BREAK_GLASS")"
  ensure_managed_policy "$break_glass_arn" "$PS_BREAK_GLASS" "$MANAGED_ADMIN"
  assert_not_assigned "$break_glass_arn" "$PS_BREAK_GLASS" "$production_account" 'production'
  provision_permission_set "$break_glass_arn" "$PS_BREAK_GLASS"
  print_break_glass_instructions "$break_glass_arn" "$production_account" "$breakglass_id"

  # ---- next steps --------------------------------------------------------
  log_step "Group membership"
  log_info "Permission sets are assigned to GROUPS. Nobody has access until they are in one:"
  log_info "  aws identitystore create-group-membership --region ${KINMAP_IDENTITY_CENTER_REGION} \\"
  log_info "    --profile ${KINMAP_MANAGEMENT_PROFILE} --identity-store-id ${KINMAP_IDENTITY_STORE_ID} \\"
  log_info "    --group-id <group-id> --member-id UserId=<user-id>"
  log_info "Find a user id with: aws identitystore list-users --region ${KINMAP_IDENTITY_CENTER_REGION} \\"
  log_info "    --profile ${KINMAP_MANAGEMENT_PROFILE} --identity-store-id ${KINMAP_IDENTITY_STORE_ID}"

  print_change_summary
}

main "$@"
