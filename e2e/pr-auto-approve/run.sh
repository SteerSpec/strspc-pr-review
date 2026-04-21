#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# e2e harness for the pr-auto-approve reusable workflow.
# Drives scenarios against a sandbox repository.
#
# Prereqs:
#   - Bash 4+ (macOS ships 3.2; `brew install bash` and run via
#     /opt/homebrew/bin/bash or /usr/local/bin/bash)
#   - gh authenticated as the bot account (or a user matching E2E_REVIEWER_LOGIN)
#   - The sandbox repo exists with a default branch and a base branch (default: main)
#   - The pr-auto-approve workflow is deployed to the sandbox repo with
#     test_copilot_logins set to the reviewer login and sandbox_repos set to the
#     sandbox repo full name
#
# Environment variables:
#   E2E_SANDBOX_REPO        — full name of the sandbox repo (default: owner/sandbox-repo)
#   E2E_REVIEWER_LOGIN      — gh auth identity used to post synthetic reviews
#   E2E_APPROVER_LOGIN      — login expected to post the APPROVED review
#   E2E_BASE_BRANCH         — base branch PRs target (default: main)
#   E2E_TIMEOUT             — seconds to wait per scenario (default: 180)
#   E2E_GRACE               — seconds to wait before asserting no approval (default: 60)
#   E2E_APPROVE_CHECK_PATTERN — substring of the auto-approve check name to exclude from CI polling
set -euo pipefail

# Fail fast on macOS system Bash 3.2 — associative arrays require Bash 4+.
if ((BASH_VERSINFO[0] < 4)); then
  printf 'error: Bash 4+ required (you are running %s). On macOS: brew install bash\n' "$BASH_VERSION" >&2
  exit 2
fi

# Portable single-line base64 encoding — GitHub's Contents API rejects
# wrapped or newline-terminated payloads. Works on macOS (BSD) and Linux (GNU).
b64_oneline() {
  base64 | tr -d '\n\r '
}

SANDBOX="${E2E_SANDBOX_REPO:-owner/sandbox-repo}"
REVIEWER="${E2E_REVIEWER_LOGIN:-my-bot}"
APPROVER_LOGIN="${E2E_APPROVER_LOGIN:-my-bot}"
BASE_BRANCH="${E2E_BASE_BRANCH:-main}"
TIMEOUT="${E2E_TIMEOUT:-180}"
POLL_INTERVAL=10
APPROVE_CHECK_PATTERN="${E2E_APPROVE_CHECK_PATTERN:-Auto-approve if Copilot conditions met}"

log() { printf '\033[1;34m[e2e]\033[0m %s\n' "$*"; }
ok()  { printf '\033[1;32m[ok]\033[0m  %s\n' "$*"; }
fail(){ printf '\033[1;31m[fail]\033[0m %s\n' "$*" >&2; exit 1; }

require_gh() {
  command -v gh >/dev/null || fail "gh not installed"
  local actor
  actor=$(gh api user -q .login)
  [[ "$actor" == "$REVIEWER" ]] || fail "gh is authed as '$actor', expected '$REVIEWER' (set E2E_REVIEWER_LOGIN to override)"
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
  base_sha=$(gh api "repos/$SANDBOX/branches/$BASE_BRANCH" -q .commit.sha)
  [[ -n "$base_sha" ]] || fail "could not read $BASE_BRANCH SHA from $SANDBOX"
  gh api -X POST "repos/$SANDBOX/git/refs" \
    -f ref="refs/heads/$branch" -f sha="$base_sha" >/dev/null
  gh api -X PUT "repos/$SANDBOX/contents/$path" \
    -f message="e2e: $branch" \
    -f content="$content" \
    -f branch="$branch" >/dev/null
  local -a extra_args=()
  [[ -n "${3:-}" ]] && extra_args+=("$3")
  gh pr create -R "$SANDBOX" --base "$BASE_BRANCH" --head "$branch" \
    --title "$title" --body "e2e scenario PR — auto-closed by harness" "${extra_args[@]}"
}

post_review() {
  local pr="$1" event="$2" body="${3:-e2e synthetic review}"
  local pr_num
  pr_num=$(basename "$pr")
  gh api -X POST "repos/$SANDBOX/pulls/$pr_num/reviews" \
    -f event="$event" -f body="$body" >/dev/null
}

post_review_with_comment() {
  local pr_num="$1" body="$2"
  local head_sha
  head_sha=$(gh api "repos/$SANDBOX/pulls/$pr_num" -q .head.sha)
  [[ -n "$head_sha" ]] || fail "could not read head SHA for PR #$pr_num"
  local payload
  payload=$(jq -nc \
    --arg event "COMMENT" \
    --arg body "$body" \
    --arg commit_id "$head_sha" \
    '{event: $event, body: $body, commit_id: $commit_id,
      comments: [{path: "e2e-marker.txt", line: 1, side: "RIGHT", body: "nit from e2e"}]}')
  gh api -X POST "repos/$SANDBOX/pulls/$pr_num/reviews" --input - <<< "$payload" >/dev/null
}

close_pr() {
  local pr_num="$1" branch="$2"
  gh pr close -R "$SANDBOX" "$pr_num" --delete-branch 2>/dev/null || true
}

# Wait until all non-auto-approve check runs on the PR head are completed.
wait_for_ci() {
  local pr_num="$1" deadline head_sha result total pending
  deadline=$(( $(date +%s) + TIMEOUT ))
  log "waiting for CI checks on PR #$pr_num to complete…"
  while (( $(date +%s) < deadline )); do
    if ! head_sha=$(gh api "repos/$SANDBOX/pulls/$pr_num" -q .head.sha 2>&1); then
      printf '\033[1;33m[warn]\033[0m wait_for_ci: failed to get head SHA: %s\n' "$head_sha" >&2
      sleep "$POLL_INTERVAL"
      continue
    fi
    [[ -n "$head_sha" ]] || { sleep "$POLL_INTERVAL"; continue; }

    if ! result=$(gh api "repos/$SANDBOX/commits/$head_sha/check-runs?per_page=100" 2>&1 \
         | jq --arg pattern "$APPROVE_CHECK_PATTERN" '{
           total: ([.check_runs[] | select((.name | contains($pattern) | not))] | length),
           pending: ([.check_runs[] | select((.name | contains($pattern) | not) and .status != "completed")] | length)
         }' 2>&1); then
      printf '\033[1;33m[warn]\033[0m wait_for_ci: gh api failed: %s\n' "$result" >&2
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
  if ! reviews=$(gh api "repos/$SANDBOX/pulls/$pr_num/reviews" 2>&1); then
    printf '\033[1;33m[warn]\033[0m gh api failed while polling PR #%s: %s\n' "$pr_num" "$reviews" >&2
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

# --- Scenarios -----------------------------------------------------------

scenario_copilot_clean() {
  log "scenario: copilot-clean (expect approved)"
  local branch pr pr_num
  branch=$(new_branch "clean")
  pr=$(create_pr "$branch" "e2e: copilot-clean")
  pr_num=$(basename "$pr")
  wait_for_ci "$pr_num"
  log "PR #$pr_num — CI done, posting clean COMMENT review"
  post_review "$pr" COMMENT "LGTM (e2e clean review, 0 line comments)"
  log "waiting up to ${TIMEOUT}s for $APPROVER_LOGIN approval…"
  if wait_for_approval "$pr_num"; then
    ok "copilot-clean → approved"
  else
    close_pr "$pr_num" "$branch"
    fail "copilot-clean: no approval within ${TIMEOUT}s"
  fi
  close_pr "$pr_num" "$branch"
}

scenario_copilot_with_comments() {
  log "scenario: copilot-with-comments (expect skip)"
  local branch pr pr_num
  branch=$(new_branch "comments")
  pr=$(create_pr "$branch" "e2e: copilot-with-comments")
  pr_num=$(basename "$pr")
  wait_for_ci "$pr_num"
  log "PR #$pr_num — CI done, posting review with a line comment"
  post_review_with_comment "$pr_num" "please address these"
  if wait_not_approved "$pr_num"; then
    ok "copilot-with-comments → not approved"
  else
    close_pr "$pr_num" "$branch"
    fail "copilot-with-comments: unexpectedly approved"
  fi
  close_pr "$pr_num" "$branch"
}

scenario_three_rounds() {
  log "scenario: three-rounds (expect approved after 3rd review)"
  local branch pr pr_num
  branch=$(new_branch "rounds")
  pr=$(create_pr "$branch" "e2e: three-rounds")
  pr_num=$(basename "$pr")
  wait_for_ci "$pr_num"
  post_review_with_comment "$pr_num" "round 1"
  post_review_with_comment "$pr_num" "round 2"
  post_review_with_comment "$pr_num" "round 3"
  if wait_for_approval "$pr_num"; then
    ok "three-rounds → approved"
  else
    close_pr "$pr_num" "$branch"
    fail "three-rounds: no approval within ${TIMEOUT}s"
  fi
  close_pr "$pr_num" "$branch"
}

scenario_changes_requested() {
  log "scenario: changes-requested (expect skip even at 3 rounds)"
  # GitHub forbids a PR author from posting REQUEST_CHANGES on their own PR.
  local author
  author=$(gh api user -q .login)
  if [[ "$author" == "$REVIEWER" ]]; then
    log "skip: reviewer ($REVIEWER) == PR author — GitHub blocks self-REQUEST_CHANGES"
    ok "changes-requested → skipped (needs separate author/reviewer identities)"
    return 0
  fi
  local branch pr pr_num
  branch=$(new_branch "changes")
  pr=$(create_pr "$branch" "e2e: changes-requested")
  pr_num=$(basename "$pr")
  wait_for_ci "$pr_num"
  post_review_with_comment "$pr_num" "round 1"
  post_review_with_comment "$pr_num" "round 2"
  post_review "$pr" REQUEST_CHANGES "blocking — do not merge"
  if wait_not_approved "$pr_num"; then
    ok "changes-requested → not approved"
  else
    close_pr "$pr_num" "$branch"
    fail "changes-requested: unexpectedly approved"
  fi
  close_pr "$pr_num" "$branch"
}

scenario_draft() {
  log "scenario: draft (expect workflow-skipped by if: guard)"
  local branch pr pr_num
  branch=$(new_branch "draft")
  pr=$(create_pr "$branch" "e2e: draft" "--draft")
  pr_num=$(basename "$pr")
  wait_for_ci "$pr_num"
  post_review "$pr" COMMENT "clean review on a draft"
  if wait_not_approved "$pr_num"; then
    ok "draft → not approved"
  else
    close_pr "$pr_num" "$branch"
    fail "draft: unexpectedly approved"
  fi
  close_pr "$pr_num" "$branch"
}

# --- Runner --------------------------------------------------------------

require_gh

declare -A SCENARIOS=(
  [copilot-clean]=scenario_copilot_clean
  [copilot-with-comments]=scenario_copilot_with_comments
  [three-rounds]=scenario_three_rounds
  [changes-requested]=scenario_changes_requested
  [draft]=scenario_draft
)

SELECTED=("${@:-copilot-clean copilot-with-comments three-rounds changes-requested draft}")
if [[ ${#SELECTED[@]} -eq 1 ]] && [[ ${SELECTED[0]} =~ \  ]]; then
  read -r -a SELECTED <<< "${SELECTED[0]}"
fi

log "sandbox repo: $SANDBOX"
log "base branch: $BASE_BRANCH"
log "reviewer: $REVIEWER  approver: $APPROVER_LOGIN  timeout: ${TIMEOUT}s"

for s in "${SELECTED[@]}"; do
  fn="${SCENARIOS[$s]:-}"
  [[ -n "$fn" ]] || fail "unknown scenario: $s (valid: ${!SCENARIOS[*]})"
  "$fn"
done

ok "all scenarios passed"
