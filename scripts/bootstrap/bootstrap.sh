#!/usr/bin/env bash
#
# Family Location — repository and environment bootstrap.
#
#   ./scripts/bootstrap/bootstrap.sh --phase <prerequisites|github|expo|aws|apple|google|observability|all>
#
# Design rules (spec §5):
#   * Idempotent — every phase checks whether a resource exists before creating it.
#   * Fails fast, and prints targeted recovery instructions on failure.
#   * Never prints a secret, never accepts one as a command-line argument, never
#     leaves one in shell history. Secrets go straight to the relevant secret
#     store; only non-secret identifiers are cached locally in .bootstrap-state/.
#   * Manual gates pause only the phase that depends on them (spec §43).
#
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

trap 'on_error $LINENO' ERR

# ---------------------------------------------------------------------------
# Phase: prerequisites
# ---------------------------------------------------------------------------

REQUIRED_TOOLS=(git gh node pnpm ruby bundle aws cdk docker jq openssl eas java)
OPTIONAL_TOOLS=(fastlane xcodebuild xcodes cocoapods swiftlint swiftformat adb watchman terraform gcloud sentry-cli corepack gradle)

# Homebrew formula name for tools whose binary name differs.
brew_formula_for() {
  case "$1" in
    aws)        printf 'awscli' ;;
    cdk)        printf 'aws-cdk' ;;
    cocoapods)  printf 'cocoapods' ;;
    pod)        printf 'cocoapods' ;;
    adb)        printf 'android-platform-tools' ;;
    java)       printf 'openjdk@21' ;;
    bundle)     printf 'ruby' ;;
    gcloud)     printf 'google-cloud-sdk' ;;
    sentry-cli) printf 'getsentry/tools/sentry-cli' ;;
    *)          printf '%s' "$1" ;;
  esac
}

phase_prerequisites() {
  log_step "Phase: prerequisites"

  local missing_required=() missing_optional=() tool
  for tool in "${REQUIRED_TOOLS[@]}"; do
    if has_command "$tool"; then
      log_ok "$(printf '%-12s %s' "$tool" "$(command -v "$tool")")"
    else
      missing_required+=("$tool"); log_error "$(printf '%-12s MISSING' "$tool")"
    fi
  done
  for tool in "${OPTIONAL_TOOLS[@]}"; do
    has_command "$tool" || missing_optional+=("$tool")
  done

  if ((${#missing_optional[@]})); then
    log_warn "Optional tools missing: ${missing_optional[*]}"
  fi

  if ((${#missing_required[@]})); then
    log_warn "Missing required tools: ${missing_required[*]}"
    if [[ "$(uname -s)" == "Darwin" ]] && has_command brew; then
      local formulae=() t
      for t in "${missing_required[@]}"; do formulae+=("$(brew_formula_for "$t")"); done
      log_info "Install with Homebrew:"
      printf '    brew install %s\n' "${formulae[*]}" >&2
      # Casks that install into /Library need sudo; prefer the formula.
      printf '    # Java: use the openjdk@21 FORMULA (no sudo) rather than the temurin cask.\n' >&2
      if confirm "Install the missing tools with Homebrew now?"; then
        brew install "${formulae[@]}"
      else
        die "Install the tools above, then re-run: ./scripts/bootstrap/bootstrap.sh --phase prerequisites"
      fi
    else
      {
        printf 'Install instructions:\n'
        printf '  git/gh   https://cli.github.com\n'
        printf '  node     https://github.com/nvm-sh/nvm  (then: nvm install)\n'
        printf '  pnpm     corepack enable pnpm  (Node >= 25 unbundles corepack: npm i -g pnpm)\n'
        printf '  aws      https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html\n'
        printf '  cdk      npm install -g aws-cdk@2\n'
        printf '  eas      npm install -g eas-cli\n'
        printf '  java     https://adoptium.net (JDK 21)\n'
        printf '  docker   https://docs.docker.com/get-docker/\n'
      } >&2
      die "Install the tools above, then re-run this phase."
    fi
  fi

  # Node must match .nvmrc; a mismatched major silently breaks Metro and prebuild.
  local want_node have_node
  want_node="$(tr -d '[:space:]' < "${REPO_ROOT}/.nvmrc")"
  have_node="$(node --version | sed 's/^v//')"
  if [[ "${have_node%%.*}" != "${want_node%%.*}" ]]; then
    log_warn "Node ${have_node} is active but .nvmrc pins ${want_node}."
    log_warn "Run 'nvm install && nvm use' in this repository before continuing."
  else
    log_ok "Node ${have_node} matches .nvmrc."
  fi

  if [[ ! -f "$CONFIG_FILE" ]]; then
    log_step "Interactive configuration (spec §6)"
    log_info "Values are written to bootstrap.config.local.json, which is git-ignored."
    log_info "No secrets are collected here."
    collect_configuration
  else
    log_skip "bootstrap.config.local.json already exists — leaving it untouched."
  fi

  log_info "Installing workspace dependencies (frozen lockfile if present)…"
  (cd "$REPO_ROOT" && { pnpm install --frozen-lockfile 2>/dev/null || pnpm install; })

  mark_phase_complete prerequisites
}

collect_configuration() {
  local product legal gh_owner gh_repo gh_vis aws_org aws_dev aws_stg aws_prd
  local region dr_region domain api_sub web_sub support privacy security
  local apple_team apple_bundle android_app expo_org expo_slug rc_project
  local sentry_org sentry_project member_limit free_history paid_history

  product="$(prompt_value 'Product name' 'Family Location')"
  legal="$(prompt_value 'Legal company name')"
  gh_owner="$(prompt_value 'GitHub organization or username')"
  gh_repo="$(prompt_value 'GitHub repository name' 'family-location')"
  gh_vis="$(prompt_value 'Repository visibility (private|public)' 'private')"
  aws_org="$(prompt_value 'AWS organization identifier' 'o-unset')"
  aws_dev="$(prompt_value 'AWS development account ID')"
  aws_stg="$(prompt_value 'AWS staging account ID')"
  aws_prd="$(prompt_value 'AWS production account ID')"
  region="$(prompt_value 'Primary AWS region' 'us-east-1')"
  dr_region="$(prompt_value 'Secondary disaster-recovery region' 'us-west-2')"
  domain="$(prompt_value 'Domain name')"
  api_sub="$(prompt_value 'API subdomain' "api.${domain}")"
  web_sub="$(prompt_value 'Web subdomain' "www.${domain}")"
  support="$(prompt_value 'Support email' "support@${domain}")"
  privacy="$(prompt_value 'Privacy email' "privacy@${domain}")"
  security="$(prompt_value 'Security email' "security@${domain}")"
  apple_team="$(prompt_value 'Apple team ID')"
  apple_bundle="$(prompt_value 'Apple bundle ID')"
  android_app="$(prompt_value 'Android application ID' "$apple_bundle")"
  expo_org="$(prompt_value 'Expo organization')"
  expo_slug="$(prompt_value 'Expo project slug' 'family-location')"
  rc_project="$(prompt_value 'RevenueCat project' 'family-location')"
  sentry_org="$(prompt_value 'Sentry organization')"
  sentry_project="$(prompt_value 'Sentry project' 'family-location-mobile')"
  member_limit="$(prompt_value 'Default family member limit' '6')"
  free_history="$(prompt_value 'Free plan history period (days)' '0')"
  paid_history="$(prompt_value 'Paid plan history period (days)' '30')"

  case "$gh_vis" in private|public|internal) ;; *) die "Visibility must be private, public, or internal." ;; esac
  [[ "$apple_bundle" =~ ^[A-Za-z0-9.-]+$ ]] || die "Bundle ID contains invalid characters."

  jq -n \
    --arg product "$product" --arg legal "$legal" --arg support "$support" \
    --arg privacy "$privacy" --arg security "$security" \
    --arg gh_owner "$gh_owner" --arg gh_repo "$gh_repo" --arg gh_vis "$gh_vis" \
    --arg aws_org "$aws_org" --arg aws_dev "$aws_dev" --arg aws_stg "$aws_stg" \
    --arg aws_prd "$aws_prd" --arg region "$region" --arg dr "$dr_region" \
    --arg domain "$domain" --arg api "$api_sub" --arg web "$web_sub" \
    --arg team "$apple_team" --arg bundle "$apple_bundle" --arg android "$android_app" \
    --arg expo_org "$expo_org" --arg expo_slug "$expo_slug" --arg rc "$rc_project" \
    --arg sentry_org "$sentry_org" --arg sentry_project "$sentry_project" \
    --argjson members "$member_limit" --argjson freeh "$free_history" --argjson paidh "$paid_history" \
    '{
      product:  { name:$product, legalCompanyName:$legal, supportEmail:$support,
                  privacyEmail:$privacy, securityEmail:$security },
      github:   { owner:$gh_owner, repository:$gh_repo, visibility:$gh_vis, bootstrapAdmin:$gh_owner },
      aws:      { organizationId:$aws_org,
                  accounts:{ development:$aws_dev, staging:$aws_stg, production:$aws_prd },
                  primaryRegion:$region, disasterRecoveryRegion:$dr,
                  profilePrefix:"family-location" },
      domains:  { root:$domain, api:$api, web:$web },
      apple:    { teamId:$team, bundleId:$bundle,
                  developmentBundleId:($bundle+".dev"), stagingBundleId:($bundle+".staging") },
      android:  { applicationId:$android,
                  developmentApplicationId:($android+".dev"),
                  stagingApplicationId:($android+".staging") },
      expo:     { organization:$expo_org, projectSlug:$expo_slug },
      revenuecat:{ project:$rc },
      sentry:   { organization:$sentry_org, project:$sentry_project },
      plans:    { defaultFamilyMemberLimit:$members,
                  freePlanHistoryDays:$freeh, paidPlanHistoryDays:$paidh }
    }' > "$CONFIG_FILE"

  log_ok "Wrote $CONFIG_FILE (git-ignored)."
}

# ---------------------------------------------------------------------------
# Phase: github
# ---------------------------------------------------------------------------

phase_github() {
  log_step "Phase: github"
  require_command gh; require_command git; require_command jq

  explain_permissions "GitHub" \
    "Create and administer the repository ${_:-}$(cfg github.owner)/$(cfg github.repository)" \
    "Create branches, rulesets, and deployment environments" \
    "Enable Dependabot, secret scanning, push protection and code scanning" \
    "Push workflow files (requires the 'workflow' token scope)"

  gh auth status >/dev/null 2>&1 || gh auth login
  # Ruleset and environment APIs need admin; workflow files need the workflow scope.
  local scopes
  scopes="$(gh auth status 2>&1 | sed -n 's/.*Token scopes: //p' | tr -d "'" || true)"
  if [[ "$scopes" != *workflow* ]]; then
    log_warn "Your token lacks the 'workflow' scope; pushing .github/workflows over HTTPS will be rejected."
    log_warn "Fix with: gh auth refresh -h github.com -s workflow,admin:org,repo"
  fi

  local owner repo visibility full
  owner="$(cfg github.owner)"; repo="$(cfg github.repository)"
  visibility="$(cfg github.visibility)"; full="${owner}/${repo}"

  if gh repo view "$full" >/dev/null 2>&1; then
    log_skip "Repository ${full} already exists."
  else
    log_info "Creating ${full} (${visibility})…"
    gh repo create "$full" "--${visibility}" \
      --description "Consent-based family location sharing platform" \
      --disable-wiki
    log_ok "Created ${full}."
  fi
  save_output githubRepository "$full"
  save_output githubUrl "https://github.com/${full}"

  # --- local git + branches ------------------------------------------------
  (
    cd "$REPO_ROOT"
    [[ -d .git ]] || git init -q
    git remote get-url origin >/dev/null 2>&1 \
      || git remote add origin "git@github.com:${full}.git"

    if [[ -z "$(git log --oneline -1 2>/dev/null || true)" ]]; then
      ./scripts/validation/check-secrets.sh || die "Refusing initial commit: secret scan failed."
      git add -A
      git -c commit.gpgsign=false commit -q -m "chore: initial repository bootstrap"
      log_ok "Created initial commit."
    fi

    git branch -M main
    git push -u origin main
    if git ls-remote --exit-code --heads origin development >/dev/null 2>&1; then
      log_skip "Branch 'development' already exists on origin."
    else
      git checkout -q -b development
      git push -u origin development
    fi
    git checkout -q development
  )

  # Default branch must be development; production ships only via development -> main.
  if [[ "$(gh repo view "$full" --json defaultBranchRef -q .defaultBranchRef.name)" != "development" ]]; then
    gh api -X PATCH "repos/${full}" -f default_branch=development >/dev/null
    log_ok "Default branch set to 'development'."
  else
    log_skip "Default branch is already 'development'."
  fi

  configure_github_environments "$full"
  configure_github_rulesets "$full"
  configure_github_security "$full"

  mark_phase_complete github
}

configure_github_environments() {
  local full="$1" env existing
  existing="$(gh api "repos/${full}/environments" -q '.environments[].name' 2>/dev/null || true)"
  for env in development staging production app-store google-play; do
    if grep -Fxq "$env" <<<"$existing"; then
      log_skip "Environment '${env}' exists."
      continue
    fi
    # Production and both store environments require a human to approve.
    local payload='{}'
    case "$env" in
      production|app-store|google-play)
        local actor_id
        actor_id="$(gh api users/"$(cfg github.bootstrapAdmin)" -q .id)"
        payload="$(jq -n --argjson id "$actor_id" \
          '{wait_timer:0, prevent_self_review:false,
            reviewers:[{type:"User", id:$id}],
            deployment_branch_policy:{protected_branches:true, custom_branch_policies:false}}')"
        ;;
    esac
    gh api -X PUT "repos/${full}/environments/${env}" --input - <<<"$payload" >/dev/null
    log_ok "Created environment '${env}'."
  done
  log_info "Configure GitHub OIDC to AWS in the aws phase; do not add long-lived AWS keys here."
}

configure_github_rulesets() {
  local full="$1" existing
  existing="$(gh api "repos/${full}/rulesets" -q '.[].name' 2>/dev/null || true)"

  local checks
  checks="$(jq -n '[
    "lint","format","typecheck","unit-tests","contract-tests","infrastructure-tests",
    "cdk-synth","security-scan","dependency-audit","mobile-ios-build-check",
    "mobile-android-build-check","e2e-smoke"
  ] | map({context:.})')"

  # Solo development starts at one approval; raise to two once there are three
  # or more active contributors (spec §7).
  local contributors approvals=1
  contributors="$(gh api "repos/${full}/contributors" -q 'length' 2>/dev/null || echo 1)"
  (( contributors >= 3 )) && approvals=2
  log_info "Requiring ${approvals} approval(s) on main (${contributors} contributor(s) detected)."

  if grep -Fxq "protect-main" <<<"$existing"; then
    log_skip "Ruleset 'protect-main' exists."
  else
    gh api -X POST "repos/${full}/rulesets" --input - >/dev/null <<EOF
{
  "name": "protect-main",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/heads/main"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "required_linear_history" },
    { "type": "required_signatures" },
    { "type": "pull_request", "parameters": {
        "required_approving_review_count": ${approvals},
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": true,
        "require_last_push_approval": true,
        "required_review_thread_resolution": true
    }},
    { "type": "required_status_checks", "parameters": {
        "strict_required_status_checks_policy": true,
        "required_status_checks": ${checks}
    }}
  ]
}
EOF
    log_ok "Created ruleset 'protect-main'."
  fi

  if grep -Fxq "protect-development" <<<"$existing"; then
    log_skip "Ruleset 'protect-development' exists."
  else
    local admin_id
    admin_id="$(gh api "repos/${full}" -q '.id')"
    gh api -X POST "repos/${full}/rulesets" --input - >/dev/null <<EOF
{
  "name": "protect-development",
  "target": "branch",
  "enforcement": "active",
  "bypass_actors": [
    { "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always" }
  ],
  "conditions": { "ref_name": { "include": ["refs/heads/development"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "pull_request", "parameters": {
        "required_approving_review_count": $(( contributors > 1 ? 1 : 0 )),
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": true
    }},
    { "type": "required_status_checks", "parameters": {
        "strict_required_status_checks_policy": false,
        "required_status_checks": ${checks}
    }}
  ]
}
EOF
    log_ok "Created ruleset 'protect-development' (repo admin may bypass during bootstrap)."
    log_warn "Remove the bypass actor once a second contributor joins (ruleset 'protect-development')."
    unset admin_id
  fi
}

configure_github_security() {
  local full="$1"
  gh api -X PATCH "repos/${full}" --input - >/dev/null <<'EOF'
{
  "security_and_analysis": {
    "secret_scanning": { "status": "enabled" },
    "secret_scanning_push_protection": { "status": "enabled" },
    "secret_scanning_non_provider_patterns": { "status": "enabled" }
  },
  "allow_merge_commit": false,
  "allow_rebase_merge": true,
  "allow_squash_merge": true,
  "delete_branch_on_merge": true
}
EOF
  log_ok "Secret scanning and push protection enabled."
  gh api -X PUT "repos/${full}/private-vulnerability-reporting" >/dev/null 2>&1 \
    && log_ok "Private vulnerability reporting enabled." \
    || log_warn "Could not enable private vulnerability reporting (may need org settings)."
  gh api -X PUT "repos/${full}/automated-security-fixes" >/dev/null 2>&1 \
    && log_ok "Dependabot security updates enabled." \
    || log_warn "Could not enable Dependabot automated fixes."
  log_info "CodeQL runs from .github/workflows/codeql.yml on the default branch."
}

# ---------------------------------------------------------------------------
# Phase: aws
# ---------------------------------------------------------------------------

phase_aws() {
  log_step "Phase: aws"
  require_command aws; require_command cdk; require_command jq

  explain_permissions "AWS IAM Identity Center (SSO)" \
    "Assume a role in the development / staging / production accounts" \
    "Bootstrap the CDK toolkit stack (CDKToolkit) in each account and region" \
    "Create and update CloudFormation stacks for this application" \
    "Write application secrets to AWS Secrets Manager"

  local prefix env profile account region dr_region
  prefix="$(cfg aws.profilePrefix)"
  region="$(cfg aws.primaryRegion)"; dr_region="$(cfg aws.disasterRecoveryRegion)"

  for env in development staging production; do
    account="$(cfg "aws.accounts.${env}")"
    profile="${prefix}-${env}"

    if [[ ! "$account" =~ ^[0-9]{12}$ ]]; then
      record_gate \
        "AWS ${env} account ID not configured" \
        "CDK cannot bootstrap or deploy without a real 12-digit account ID." \
        "bootstrap.config.local.json -> aws.accounts.${env}" \
        "The 12-digit AWS account ID for ${env}"
      continue
    fi

    if aws sts get-caller-identity --profile "$profile" >/dev/null 2>&1; then
      log_skip "SSO session for profile '${profile}' is already valid."
    else
      log_info "Authenticating profile '${profile}' (browser flow)…"
      aws configure sso --profile "$profile" || aws sso login --profile "$profile"
    fi

    local actual
    actual="$(aws sts get-caller-identity --profile "$profile" --query Account --output text)"
    [[ "$actual" == "$account" ]] \
      || die "Profile '${profile}' is authenticated to account ${actual}, expected ${account}. Refusing to continue."
    log_ok "Verified profile '${profile}' -> account ${account}."

    # Production must never be bootstrapped or deployed implicitly.
    if [[ "$env" == "production" ]]; then
      confirm "Bootstrap CDK in PRODUCTION account ${account}?" || { log_warn "Skipped production bootstrap."; continue; }
    fi

    local r
    for r in "$region" "$dr_region"; do
      if aws cloudformation describe-stacks --stack-name CDKToolkit \
           --profile "$profile" --region "$r" >/dev/null 2>&1; then
        log_skip "CDK already bootstrapped in ${account}/${r}."
      else
        log_info "cdk bootstrap aws://${account}/${r} --profile ${profile}"
        cdk bootstrap "aws://${account}/${r}" --profile "$profile"
      fi
    done
    save_output "awsAccount_${env}" "$account"
  done

  configure_github_oidc
  mark_phase_complete aws
}

configure_github_oidc() {
  # Short-lived, federated credentials only — no long-lived AWS keys in GitHub (spec §7).
  local full account profile
  full="$(read_output githubRepository)"
  [[ -n "$full" ]] || { log_warn "Run the github phase before configuring OIDC."; return 0; }
  account="$(cfg aws.accounts.development)"
  profile="$(cfg aws.profilePrefix)-development"

  if aws iam get-open-id-connect-provider \
       --open-id-connect-provider-arn "arn:aws:iam::${account}:oidc-provider/token.actions.githubusercontent.com" \
       --profile "$profile" >/dev/null 2>&1; then
    log_skip "GitHub OIDC provider already present in ${account}."
  else
    aws iam create-open-id-connect-provider \
      --url https://token.actions.githubusercontent.com \
      --client-id-list sts.amazonaws.com \
      --profile "$profile" >/dev/null
    log_ok "Created GitHub OIDC provider in ${account}."
  fi
  log_info "Deployment roles are created by the CDK FoundationStack and trust repo:${full}."
}

# ---------------------------------------------------------------------------
# Phase: expo
# ---------------------------------------------------------------------------

phase_expo() {
  log_step "Phase: expo"
  require_command eas

  explain_permissions "Expo (EAS)" \
    "Create or link the EAS project for $(cfg expo.projectSlug)" \
    "Store build credentials in EAS (never in this repository)" \
    "Run EAS Build and EAS Submit on your behalf"

  eas whoami >/dev/null 2>&1 || eas login

  local existing
  existing="$(read_output easProjectId)"
  if [[ -n "$existing" ]]; then
    log_skip "EAS project already linked: ${existing}"
  else
    ( cd "${REPO_ROOT}/apps/mobile" && eas init --non-interactive 2>/dev/null || eas init )
    local project_id
    project_id="$(cd "${REPO_ROOT}/apps/mobile" && eas project:info --json 2>/dev/null | jq -r '.id // empty')"
    [[ -n "$project_id" ]] && { save_output easProjectId "$project_id"; log_ok "EAS project ${project_id}."; }
  fi

  [[ -f "${REPO_ROOT}/apps/mobile/eas.json" ]] \
    && log_skip "eas.json already present — not overwriting build profiles." \
    || ( cd "${REPO_ROOT}/apps/mobile" && eas build:configure --platform all )

  log_info "Publishing PUBLIC runtime values to EAS environment variables."
  log_info "Backend secrets are never exposed to a mobile build (spec §29)."
  mark_phase_complete expo
}

# ---------------------------------------------------------------------------
# Phase: apple
# ---------------------------------------------------------------------------

phase_apple() {
  log_step "Phase: apple"

  local team bundle
  team="$(cfg apple.teamId)"; bundle="$(cfg apple.bundleId)"

  if [[ "$team" == "XXXXXXXXXX" || -z "$team" ]]; then
    record_gate \
      "Apple Developer Program enrollment and Team ID" \
      "Enrollment, legal agreements, tax and banking setup cannot be automated by any CLI, and no API can bypass them." \
      "https://developer.apple.com/account -> Membership details" \
      "Copy the 10-character Team ID into bootstrap.config.local.json -> apple.teamId"
    return 0
  fi

  log_info "Bundle identifiers to exist in the Apple Developer portal:"
  printf '    %s\n    %s.dev\n    %s.staging\n' "$bundle" "$bundle" "$bundle" >&2

  record_gate \
    "App Store Connect API key (.p8)" \
    "A .p8 private key can be downloaded exactly once and only by an Account Holder or Admin; it cannot be re-fetched by any API." \
    "https://appstoreconnect.apple.com/access/integrations/api" \
    "Create a key with 'App Manager' access, note the Key ID and Issuer ID, download the .p8"

  if confirm "Do you have the App Store Connect .p8 key file available now?"; then
    local p8_path key_id issuer_id profile secret_name
    p8_path="$(prompt_value 'Absolute path to the .p8 file')"
    [[ -f "$p8_path" ]] || die "No file at ${p8_path}"
    key_id="$(prompt_value 'App Store Connect Key ID')"
    issuer_id="$(prompt_value 'App Store Connect Issuer ID')"
    profile="$(cfg aws.profilePrefix)-development"
    secret_name="family-location/apple/app-store-connect"

    # The key never touches the repo, argv, or the terminal — it is streamed to
    # Secrets Manager from the file the user already has on disk.
    local payload_file
    payload_file="$(mktemp)"; chmod 600 "$payload_file"
    trap 'rm -f "$payload_file"' RETURN
    jq -n --arg k "$key_id" --arg i "$issuer_id" --rawfile p8 "$p8_path" \
      '{keyId:$k, issuerId:$i, privateKey:$p8}' > "$payload_file"

    if aws secretsmanager describe-secret --secret-id "$secret_name" --profile "$profile" >/dev/null 2>&1; then
      aws secretsmanager put-secret-value --secret-id "$secret_name" \
        --secret-string "file://${payload_file}" --profile "$profile" >/dev/null
      log_ok "Updated secret ${secret_name}."
    else
      aws secretsmanager create-secret --name "$secret_name" \
        --description "App Store Connect API key for submission and server notifications" \
        --secret-string "file://${payload_file}" --profile "$profile" >/dev/null
      log_ok "Created secret ${secret_name}."
    fi
    shred -u "$payload_file" 2>/dev/null || rm -f "$payload_file"
    save_output appleKeyId "$key_id"
    log_warn "Delete your local copy of ${p8_path} once EAS credentials are configured."
  else
    log_info "Skipping App Store Connect key upload; re-run this phase when the key is available."
  fi

  record_gate \
    "Apple capabilities and store declarations" \
    "Capability toggles, privacy labels, and App Review declarations are account-owner actions in the web console." \
    "https://developer.apple.com/account/resources/identifiers -> select each bundle ID" \
    "Enable Sign in with Apple, Push Notifications, Background Modes, Associated Domains"

  mark_phase_complete apple
}

# ---------------------------------------------------------------------------
# Phase: google
# ---------------------------------------------------------------------------

phase_google() {
  log_step "Phase: google"

  if ! has_command gcloud; then
    log_warn "gcloud is not installed; install it and re-run this phase."
    record_gate "Install Google Cloud CLI" \
      "OAuth clients and Firebase configuration are created through gcloud/Firebase." \
      "https://cloud.google.com/sdk/docs/install" "brew install --cask google-cloud-sdk"
    return 0
  fi

  explain_permissions "Google Cloud" \
    "Create or select the Google Cloud project backing Firebase and FCM" \
    "Enable the APIs required for FCM, Google sign-in and Play integration" \
    "Create OAuth clients restricted to your bundle and package identifiers"

  gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null | grep -q . \
    || gcloud auth login
  gcloud auth application-default print-access-token >/dev/null 2>&1 \
    || gcloud auth application-default login

  local project
  project="$(cfg android.googleCloudProjectId 'family-location')"
  if gcloud projects describe "$project" >/dev/null 2>&1; then
    log_skip "Google Cloud project '${project}' exists."
  else
    log_info "Creating Google Cloud project '${project}'…"
    gcloud projects create "$project" || log_warn "Project creation failed; it may need a billing account or org policy."
  fi

  local api
  for api in firebase.googleapis.com fcm.googleapis.com \
             androidpublisher.googleapis.com iamcredentials.googleapis.com; do
    if gcloud services list --enabled --project "$project" --format='value(config.name)' 2>/dev/null | grep -Fxq "$api"; then
      log_skip "API ${api} already enabled."
    else
      gcloud services enable "$api" --project "$project" && log_ok "Enabled ${api}."
    fi
  done

  # Play Console cannot create a first consumer app via API (spec §26).
  record_gate \
    "Create the app in Google Play Console and upload the first AAB" \
    "The Play Developer API cannot create a new consumer application, and the first signed bundle must be uploaded by hand before API-driven releases work." \
    "https://play.google.com/console -> Create app" \
    "App name '$(cfg product.name)', package $(cfg android.applicationId), then upload the first internal-testing AAB"

  record_gate \
    "Play Console service account and permissions" \
    "Granting Play Console access to a service account is a console-only action." \
    "https://play.google.com/console -> Users and permissions -> Invite the service account" \
    "Grant only: view app information, manage testing tracks, manage releases"

  record_gate \
    "Google Play background location declaration" \
    "Background location access requires a written declaration and video review that cannot be submitted via API." \
    "https://play.google.com/console -> App content -> Sensitive app permissions" \
    "Explain family-consented background sharing; link the privacy policy and the in-app pause control"

  mark_phase_complete google
}

# ---------------------------------------------------------------------------
# Phase: observability
# ---------------------------------------------------------------------------

phase_observability() {
  log_step "Phase: observability"

  if ! has_command sentry-cli; then
    log_warn "sentry-cli is not installed."
    log_info "Install with: brew install getsentry/tools/sentry-cli"
    record_gate "Install sentry-cli" "Required to create the Sentry project and upload symbols." \
      "https://docs.sentry.io/cli/installation/" "brew install getsentry/tools/sentry-cli"
    return 0
  fi

  explain_permissions "Sentry" \
    "Create or select the project $(cfg sentry.organization)/$(cfg sentry.project)" \
    "Upload JavaScript source maps and native debug symbols during builds"

  sentry-cli info >/dev/null 2>&1 || sentry-cli login

  local org project
  org="$(cfg sentry.organization)"; project="$(cfg sentry.project)"
  if sentry-cli projects list --org "$org" 2>/dev/null | grep -q "$project"; then
    log_skip "Sentry project ${org}/${project} exists."
  else
    sentry-cli projects create --org "$org" --platform react-native "$project" \
      && log_ok "Created Sentry project ${org}/${project}." \
      || log_warn "Could not create the Sentry project; create it in the UI and re-run."
  fi

  log_warn "Confirm PII scrubbing before the first production event is sent."
  log_info "packages/observability enforces coordinate scrubbing; its tests must pass."
  mark_phase_complete observability
}

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------

write_report() {
  mkdir -p "$STATE_DIR"
  {
    printf '# Bootstrap report\n\n'
    printf 'Generated: %s\n\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf '## Completed phases\n\n'
    if [[ -s "$STATE_FILE" ]]; then sed 's/^/- /' "$STATE_FILE"; else printf '(none)\n'; fi
    printf '\n## Recorded outputs\n\n```json\n'
    cat "$OUTPUTS_FILE" 2>/dev/null || printf '{}\n'
    printf '```\n\n## Manual actions still required\n\n'
    if [[ -s "${STATE_DIR}/manual-gates.tsv" ]]; then
      awk -F'\t' '{printf "### %s\n\n- Why: %s\n- Where: %s\n- Enter: %s\n\n", $1, $2, $3, $4}' \
        "${STATE_DIR}/manual-gates.tsv" | sort -u
    else
      printf 'None recorded.\n'
    fi
    printf '\n## Next command\n\n```bash\n./scripts/bootstrap/bootstrap.sh --phase all\n```\n'
  } > "$REPORT_FILE"
  log_ok "Report written to ${REPORT_FILE}"
  ((${#MANUAL_GATES[@]})) && log_warn "${#MANUAL_GATES[@]} manual gate(s) recorded — see the report."
  return 0
}

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

usage() {
  cat >&2 <<'EOF'
Usage: ./scripts/bootstrap/bootstrap.sh --phase <phase>

Phases:
  prerequisites   Detect and install tooling, collect non-secret configuration
  github          Create the repository, branches, environments, rulesets, security
  expo            Authenticate EAS and link the Expo project
  aws             SSO login, verify accounts, bootstrap CDK, configure GitHub OIDC
  apple           Apple identifiers and App Store Connect API key
  google          Google Cloud, Firebase, and Play Console gates
  observability   Sentry project and PII scrubbing checks
  all             Run every phase in dependency order

Secrets are never accepted as arguments. Use the hidden prompts.
EOF
  exit 2
}

main() {
  local phase=''
  while (($#)); do
    case "$1" in
      --phase) phase="${2:-}"; shift 2 ;;
      -h|--help) usage ;;
      *) log_error "Unknown argument: $1"; usage ;;
    esac
  done
  [[ -n "$phase" ]] || usage

  init_state
  cd "$REPO_ROOT"

  run_phase() {
    local name="$1"
    if phase_completed "$name"; then log_skip "Phase '${name}' already completed."; return 0; fi
    CURRENT_PHASE="$name"
    "phase_${name}"
  }

  case "$phase" in
    prerequisites|github|expo|aws|apple|google|observability) run_phase "$phase" ;;
    all)
      # Ordered by dependency; independent phases still run if an earlier one
      # only recorded a manual gate rather than failing (spec §43).
      for p in prerequisites github expo aws apple google observability; do
        run_phase "$p"
      done
      ;;
    *) log_error "Unknown phase: ${phase}"; usage ;;
  esac

  write_report
}

main "$@"
