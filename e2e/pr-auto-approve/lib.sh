# SPDX-License-Identifier: Apache-2.0
# shellcheck shell=bash
#
# Shared helpers for the pr-auto-approve e2e harnesses.
#
# Sourced by:
#   run.sh      — synthetic tier (fakes Copilot via test-copilot-logins)
#   copilot.sh  — real-Copilot tier
#
# Entrypoints own `set -euo pipefail`; this file only defines state and
# functions, so sourcing it can never change the caller's shell options.
#
# Environment variables:
#   E2E_REPO                — full name of the repo under test. Falls back to
#                             E2E_SANDBOX_REPO, the name run.sh has always used
#                             and the README documents.
#   E2E_REVIEWER_LOGIN      — identity used to post synthetic reviews (synthetic tier)
#   E2E_APPROVER_LOGIN      — login expected to post the APPROVED review
#   E2E_BASE_BRANCH         — base branch PRs target (default: main)
#   E2E_TIMEOUT             — seconds to wait per scenario (default: 180)
#   E2E_GRACE               — seconds to wait before asserting no approval (default: 60)
#   E2E_APPROVE_CHECK_PATTERN — substring of the auto-approve check name to exclude from CI polling

# Fail fast on macOS system Bash 3.2 — the harnesses' scenario tables are
# associative arrays, which require Bash 4+.
if ((BASH_VERSINFO[0] < 4)); then
  printf 'error: Bash 4+ required (you are running %s). On macOS: brew install bash\n' "$BASH_VERSION" >&2
  exit 2
fi

REPO="${E2E_REPO:-${E2E_SANDBOX_REPO:-owner/sandbox-repo}}"
REVIEWER="${E2E_REVIEWER_LOGIN:-my-bot}"
APPROVER_LOGIN="${E2E_APPROVER_LOGIN:-my-bot}"
BASE_BRANCH="${E2E_BASE_BRANCH:-main}"
TIMEOUT="${E2E_TIMEOUT:-180}"
POLL_INTERVAL=10
APPROVE_CHECK_PATTERN="${E2E_APPROVE_CHECK_PATTERN:-Auto-approve if Copilot conditions met}"

log()  { printf '\033[1;34m[e2e]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[ok]\033[0m  %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[1;31m[fail]\033[0m %s\n' "$*" >&2; exit 1; }

# Portable single-line base64 encoding — GitHub's Contents API rejects
# wrapped or newline-terminated payloads. Works on macOS (BSD) and Linux (GNU).
b64_oneline() {
  base64 | tr -d '\n\r '
}

# Assert `gh` is authenticated as the expected identity. Parameterised because
# the two tiers need different ones: the synthetic tier authenticates as the
# REVIEWER (it posts the reviews itself), while the real-Copilot tier
# authenticates as the PR AUTHOR and lets Copilot do the reviewing.
require_gh() {
  local expected="${1:-$REVIEWER}" actor
  command -v gh >/dev/null || fail "gh not installed"
  actor=$(gh api user -q .login)
  [[ "$actor" == "$expected" ]] || fail "gh is authed as '$actor', expected '$expected'"
}

# --- PR lifecycle helpers -------------------------------------------------

new_branch() {
  local scenario="$1"
  local ts
  ts=$(date -u +%Y%m%d-%H%M%S)
  printf 'e2e/%s-%s' "$scenario" "$ts"
}

create_pr() {
  local branch="$1" title="$2"
  local path="e2e-marker.txt"
  local content
  content=$(printf 'e2e run: %s\n' "$branch" | b64_oneline)
  local base_sha
  base_sha=$(gh api "repos/$REPO/branches/$BASE_BRANCH" -q .commit.sha)
  [[ -n "$base_sha" ]] || fail "could not read $BASE_BRANCH SHA from $REPO"
  gh api -X POST "repos/$REPO/git/refs" \
    -f ref="refs/heads/$branch" -f sha="$base_sha" >/dev/null
  gh api -X PUT "repos/$REPO/contents/$path" \
    -f message="e2e: $branch" \
    -f content="$content" \
    -f branch="$branch" >/dev/null
  local -a extra_args=()
  [[ -n "${3:-}" ]] && extra_args+=("$3")
  gh pr create -R "$REPO" --base "$BASE_BRANCH" --head "$branch" \
    --title "$title" --body "e2e scenario PR — auto-closed by harness" "${extra_args[@]}"
}

close_pr() {
  local pr_num="$1"
  gh pr close -R "$REPO" "$pr_num" --delete-branch 2>/dev/null || true
}

# Wait until all non-auto-approve check runs on the PR head are completed.
wait_for_ci() {
  local pr_num="$1" deadline head_sha result total pending
  deadline=$(( $(date +%s) + TIMEOUT ))
  log "waiting for CI checks on PR #$pr_num to complete…"
  while (( $(date +%s) < deadline )); do
    if ! head_sha=$(gh api "repos/$REPO/pulls/$pr_num" -q .head.sha 2>&1); then
      warn "wait_for_ci: failed to get head SHA: $head_sha"
      sleep "$POLL_INTERVAL"
      continue
    fi
    [[ -n "$head_sha" ]] || { sleep "$POLL_INTERVAL"; continue; }

    if ! result=$(gh api "repos/$REPO/commits/$head_sha/check-runs?per_page=100" 2>&1 \
         | jq --arg pattern "$APPROVE_CHECK_PATTERN" '{
           total: ([.check_runs[] | select((.name | contains($pattern) | not))] | length),
           pending: ([.check_runs[] | select((.name | contains($pattern) | not) and .status != "completed")] | length)
         }' 2>&1); then
      warn "wait_for_ci: gh api failed: $result"
      sleep "$POLL_INTERVAL"
      continue
    fi

    total=$(printf '%s' "$result" | jq -r .total)
    pending=$(printf '%s' "$result" | jq -r .pending)

    if [[ "$total" != "0" && "$pending" == "0" ]]; then
      log "CI checks completed ($total check(s))"
      return 0
    fi
    sleep "$POLL_INTERVAL"
  done
  fail "wait_for_ci: timed out waiting for CI on PR #$pr_num"
}

# Exit codes:
#   0 — APPROVED review by $APPROVER_LOGIN found
#   1 — reviews fetched, no matching approval yet
#   2 — `gh api` errored (network, auth, rate limit)
has_bot_approval() {
  local pr_num="$1" reviews
  if ! reviews=$(gh api "repos/$REPO/pulls/$pr_num/reviews" 2>&1); then
    warn "gh api failed while polling PR #$pr_num: $reviews"
    return 2
  fi
  printf '%s' "$reviews" | jq -e --arg login "$APPROVER_LOGIN" \
    '[.[] | select(.user.login == $login and .state == "APPROVED")] | length > 0' \
    >/dev/null
}

wait_for_approval() {
  local pr_num="$1" deadline rc
  deadline=$(( $(date +%s) + TIMEOUT ))
  while (( $(date +%s) < deadline )); do
    has_bot_approval "$pr_num"
    rc=$?
    case $rc in
      0) return 0 ;;
      1) : ;;
      2) : ;;
    esac
    sleep "$POLL_INTERVAL"
  done
  return 1
}

wait_not_approved() {
  local pr_num="$1"
  local grace="${E2E_GRACE:-60}"
  sleep "$grace"
  if has_bot_approval "$pr_num"; then return 1; fi
  return 0
}
