#!/usr/bin/env bash
# Shared helpers for the bootstrap phases.
# Sourced, never executed directly.

set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
readonly REPO_ROOT
readonly STATE_DIR="${REPO_ROOT}/.bootstrap-state"
readonly STATE_FILE="${STATE_DIR}/completed-phases"
readonly OUTPUTS_FILE="${STATE_DIR}/outputs.json"
readonly REPORT_FILE="${STATE_DIR}/bootstrap-report.md"
readonly CONFIG_FILE="${REPO_ROOT}/bootstrap.config.local.json"
readonly CONFIG_EXAMPLE="${REPO_ROOT}/bootstrap.config.example.json"

# --- Output -----------------------------------------------------------------
# All of these write to stderr so that stdout stays clean for value-returning
# functions used in command substitution.

if [[ -t 2 ]]; then
  C_RESET=$'\033[0m'; C_RED=$'\033[31m'; C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'; C_BLUE=$'\033[34m'; C_DIM=$'\033[2m'; C_BOLD=$'\033[1m'
else
  C_RESET=''; C_RED=''; C_GREEN=''; C_YELLOW=''; C_BLUE=''; C_DIM=''; C_BOLD=''
fi

log_info()  { printf '%s[info]%s  %s\n'  "$C_BLUE"   "$C_RESET" "$*" >&2; }
log_ok()    { printf '%s[ ok ]%s  %s\n'  "$C_GREEN"  "$C_RESET" "$*" >&2; }
log_warn()  { printf '%s[warn]%s  %s\n'  "$C_YELLOW" "$C_RESET" "$*" >&2; }
log_error() { printf '%s[fail]%s  %s\n'  "$C_RED"    "$C_RESET" "$*" >&2; }
log_step()  { printf '\n%s==>%s %s%s%s\n' "$C_BLUE" "$C_RESET" "$C_BOLD" "$*" "$C_RESET" >&2; }
log_skip()  { printf '%s[skip]%s  %s\n'  "$C_DIM"    "$C_RESET" "$*" >&2; }

die() { log_error "$*"; exit 1; }

# --- Manual gates (spec §43) ------------------------------------------------
# A gate is an action only a human account owner can perform. We explain exactly
# why, where, and what to enter; we pause only the dependent phase.

MANUAL_GATES=()

record_gate() {
  local title="$1" reason="$2" location="$3" values="$4"
  MANUAL_GATES+=("${title}|${reason}|${location}|${values}")
  {
    printf '\n%s┌─ MANUAL ACTION REQUIRED ─────────────────────────────%s\n' "$C_YELLOW" "$C_RESET"
    printf '%s│%s %s\n' "$C_YELLOW" "$C_RESET" "$title"
    printf '%s│%s Why:   %s\n' "$C_YELLOW" "$C_RESET" "$reason"
    printf '%s│%s Where: %s\n' "$C_YELLOW" "$C_RESET" "$location"
    printf '%s│%s Enter: %s\n' "$C_YELLOW" "$C_RESET" "$values"
    printf '%s└──────────────────────────────────────────────────────%s\n' "$C_YELLOW" "$C_RESET"
  } >&2
  mkdir -p "$STATE_DIR"
  printf '%s\t%s\t%s\t%s\n' "$title" "$reason" "$location" "$values" \
    >> "${STATE_DIR}/manual-gates.tsv"
}

# --- Phase state ------------------------------------------------------------

init_state() {
  mkdir -p "$STATE_DIR"
  touch "$STATE_FILE"
  [[ -f "$OUTPUTS_FILE" ]] || printf '{}\n' > "$OUTPUTS_FILE"
}

phase_completed() { grep -Fxq "$1" "$STATE_FILE" 2>/dev/null; }

mark_phase_complete() {
  phase_completed "$1" || printf '%s\n' "$1" >> "$STATE_FILE"
  log_ok "Phase '$1' complete."
}

# Non-secret generated identifiers live in an ignored local file so re-runs are
# idempotent and so nothing sensitive reaches Git (spec §5).
save_output() {
  local key="$1" value="$2" tmp
  tmp="$(mktemp)"
  jq --arg k "$key" --arg v "$value" '.[$k] = $v' "$OUTPUTS_FILE" > "$tmp"
  mv "$tmp" "$OUTPUTS_FILE"
}

read_output() { jq -r --arg k "$1" '.[$k] // empty' "$OUTPUTS_FILE" 2>/dev/null; }

# --- Configuration ----------------------------------------------------------

cfg() {
  local key="$1" default="${2-}" value
  [[ -f "$CONFIG_FILE" ]] || die "Missing $CONFIG_FILE. Run: ./scripts/bootstrap/bootstrap.sh --phase prerequisites"
  value="$(jq -r --arg k "$key" 'getpath($k | split(".")) // empty' "$CONFIG_FILE")"
  if [[ -z "$value" || "$value" == "null" ]]; then
    if [[ -n "$default" ]]; then printf '%s' "$default"; return 0; fi
    die "Config key '$key' is not set in $CONFIG_FILE"
  fi
  printf '%s' "$value"
}

# --- Prompting --------------------------------------------------------------
# Secrets are read with a hidden prompt and passed to the relevant secret store
# via stdin or a process-substituted file. They are never echoed, never placed in
# argv (where `ps` would expose them), and never written to shell history.

prompt_value() {
  local prompt="$1" default="${2-}" reply
  if [[ -n "$default" ]]; then
    read -r -p "$(printf '%s [%s]: ' "$prompt" "$default")" reply </dev/tty
    printf '%s' "${reply:-$default}"
  else
    while :; do
      read -r -p "$(printf '%s: ' "$prompt")" reply </dev/tty
      [[ -n "$reply" ]] && { printf '%s' "$reply"; return 0; }
      log_warn "A value is required."
    done
  fi
}

# Usage: prompt_secret "APNs key" VAR_NAME   -> assigns to the named variable.
# The value is never printed and never returned through command substitution.
prompt_secret() {
  local prompt="$1" __outvar="$2" value=''
  read -r -s -p "$(printf '%s (input hidden): ' "$prompt")" value </dev/tty
  printf '\n' >&2
  [[ -n "$value" ]] || die "No value entered for: $prompt"
  printf -v "$__outvar" '%s' "$value"
}

confirm() {
  local prompt="$1" reply
  read -r -p "$(printf '%s [y/N]: ' "$prompt")" reply </dev/tty
  [[ "$reply" =~ ^[Yy]$ ]]
}

explain_permissions() {
  local service="$1"; shift
  {
    printf '\n%sBefore authenticating with %s%s\n' "$C_BOLD" "$service" "$C_RESET"
    printf 'This grants the bootstrap the following access:\n'
    local scope
    for scope in "$@"; do printf '  • %s\n' "$scope"; done
    printf 'No credential is written to this repository.\n\n'
  } >&2
}

# --- Tooling ----------------------------------------------------------------

has_command() { command -v "$1" >/dev/null 2>&1; }

require_command() {
  has_command "$1" || die "Required tool '$1' is missing. Run: ./scripts/bootstrap/bootstrap.sh --phase prerequisites"
}

# --- Error trap (spec §5: recovery instructions) ----------------------------

CURRENT_PHASE='(none)'

on_error() {
  local exit_code=$? line=$1
  log_error "Phase '${CURRENT_PHASE}' failed at line ${line} (exit ${exit_code})."
  {
    printf '\n%sRecovery%s\n' "$C_BOLD" "$C_RESET"
    printf '  1. Nothing from this phase was recorded as complete, so it is safe to re-run.\n'
    printf '  2. Fix the cause reported above.\n'
    printf '  3. Re-run only this phase:\n'
    printf '       ./scripts/bootstrap/bootstrap.sh --phase %s\n' "$CURRENT_PHASE"
    printf '  4. Completed phases so far:\n'
    if [[ -s "$STATE_FILE" ]]; then sed 's/^/       - /' "$STATE_FILE"; else printf '       (none)\n'; fi
    printf '  5. Independent phases can continue meanwhile, for example:\n'
    printf '       ./scripts/bootstrap/bootstrap.sh --phase github\n'
  } >&2
  exit "$exit_code"
}
