#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# e2e harness for the pr-auto-approve reusable workflow — SYNTHETIC tier.
#
# Copilot is faked here: this script posts reviews as E2E_REVIEWER_LOGIN and the
# sandbox's caller workflow sets test-copilot-logins so decide.js treats them as
# Copilot reviews. That makes every scenario deterministic and fast, at the cost
# of not exercising real Copilot at all — copilot.sh covers that.
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
# Environment variables are documented in lib.sh and the README.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=e2e/pr-auto-approve/lib.sh
source "$SCRIPT_DIR/lib.sh"

# --- Synthetic-review helpers --------------------------------------------
# Only this tier posts reviews itself; the real-Copilot tier never does.

post_review() {
  local pr="$1" event="$2" body="${3:-e2e synthetic review}"
  local pr_num
  pr_num=$(basename "$pr")
  gh api -X POST "repos/$REPO/pulls/$pr_num/reviews" \
    -f event="$event" -f body="$body" >/dev/null
}

post_review_with_comment() {
  local pr_num="$1" body="$2"
  local head_sha
  head_sha=$(gh api "repos/$REPO/pulls/$pr_num" -q .head.sha)
  [[ -n "$head_sha" ]] || fail "could not read head SHA for PR #$pr_num"
  local payload
  payload=$(jq -nc \
    --arg event "COMMENT" \
    --arg body "$body" \
    --arg commit_id "$head_sha" \
    '{event: $event, body: $body, commit_id: $commit_id,
      comments: [{path: "e2e-marker.txt", line: 1, side: "RIGHT", body: "nit from e2e"}]}')
  gh api -X POST "repos/$REPO/pulls/$pr_num/reviews" --input - <<< "$payload" >/dev/null
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
    close_pr "$pr_num"
    fail "copilot-clean: no approval within ${TIMEOUT}s"
  fi
  close_pr "$pr_num"
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
    close_pr "$pr_num"
    fail "copilot-with-comments: unexpectedly approved"
  fi
  close_pr "$pr_num"
}

scenario_suppressed_comments() {
  log "scenario: suppressed-comments (expect skip)"
  local branch pr pr_num body
  branch=$(new_branch "suppressed")
  pr=$(create_pr "$branch" "e2e: suppressed-comments")
  pr_num=$(basename "$pr")
  wait_for_ci "$pr_num"
  # Zero inline comments, but the body carries Copilot's real collapsed block —
  # the shape that reads as "generated no new comments" via the comments API.
  body='Reviewed 1 out of 1 changed files and generated no new comments.

<details>
<summary>Comments suppressed due to low confidence (1)</summary>

**e2e-marker.txt:1**
* e2e synthetic low-confidence finding
</details>'
  log "PR #$pr_num — CI done, posting clean review with a suppressed-comments block"
  post_review "$pr" COMMENT "$body"
  if wait_not_approved "$pr_num"; then
    ok "suppressed-comments → not approved"
  else
    close_pr "$pr_num"
    fail "suppressed-comments: unexpectedly approved"
  fi
  close_pr "$pr_num"
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
    close_pr "$pr_num"
    fail "three-rounds: no approval within ${TIMEOUT}s"
  fi
  close_pr "$pr_num"
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
    close_pr "$pr_num"
    fail "changes-requested: unexpectedly approved"
  fi
  close_pr "$pr_num"
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
    close_pr "$pr_num"
    fail "draft: unexpectedly approved"
  fi
  close_pr "$pr_num"
}

# --- Runner --------------------------------------------------------------

require_gh "$REVIEWER"

declare -A SCENARIOS=(
  [copilot-clean]=scenario_copilot_clean
  [copilot-with-comments]=scenario_copilot_with_comments
  [suppressed-comments]=scenario_suppressed_comments
  [three-rounds]=scenario_three_rounds
  [changes-requested]=scenario_changes_requested
  [draft]=scenario_draft
)

SELECTED=("${@:-copilot-clean copilot-with-comments suppressed-comments three-rounds changes-requested draft}")
if [[ ${#SELECTED[@]} -eq 1 ]] && [[ ${SELECTED[0]} =~ \  ]]; then
  read -r -a SELECTED <<< "${SELECTED[0]}"
fi

log "sandbox repo: $REPO"
log "base branch: $BASE_BRANCH"
log "reviewer: $REVIEWER  approver: $APPROVER_LOGIN  timeout: ${TIMEOUT}s"

for s in "${SELECTED[@]}"; do
  fn="${SCENARIOS[$s]:-}"
  [[ -n "$fn" ]] || fail "unknown scenario: $s (valid: ${!SCENARIOS[*]})"
  "$fn"
done

ok "all scenarios passed"
