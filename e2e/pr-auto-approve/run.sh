#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# e2e harness for the pr-auto-approve action — SYNTHETIC tier.
#
# Copilot is faked here: this script posts reviews as E2E_REVIEWER_LOGIN and the
# sandbox's caller workflow sets test-copilot-logins so decide.js treats them as
# Copilot reviews. That makes every scenario deterministic and fast, at the cost
# of not exercising real Copilot at all — so it cannot detect drift in Copilot's
# own output format. A real-Copilot tier that can is planned, and lib.sh is
# factored to be shared with it; nothing covers that gap today.
#
# scenarios.json holds each scenario's profile, expected decision and reason. A
# function here only sets the scene and calls expect_outcome. Every scenario runs
# by default, and a failure is recorded without ending the run.
#
# Prereqs:
#   - Bash 4+ (macOS ships 3.2; `brew install bash` and run via
#     /opt/homebrew/bin/bash or /usr/local/bin/bash)
#   - gh authenticated as E2E_REVIEWER_LOGIN
#   - E2E_BOT_TOKEN for E2E_APPROVER_LOGIN
#   - The sandbox provisioned by sandbox.sh sync
#
# Environment variables are documented in lib.sh and the README.
set -euo pipefail

SCRIPT_DIR="$(cd "${BASH_SOURCE[0]%/*}" && pwd)"
# shellcheck source=e2e/pr-auto-approve/lib.sh
source "$SCRIPT_DIR/lib.sh"

# --- Synthetic-review helpers --------------------------------------------
# Only this tier posts reviews itself; the real-Copilot tier never does.

post_review() {
  local pr_num="$1" event="$2" body="${3:-e2e synthetic review}"
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

# Opens a PR and registers it for the cleanup trap. Sets PR_NUM.
open_pr() {
  local name="$1" title="$2" extra="${3:-}" path="${4:-}" url
  url=$(create_pr "$(new_branch "$name")" "$title" "$extra" "$path")
  PR_NUM="${url##*/}"
  OPEN_PRS+=("$PR_NUM")
}

# As open_pr, with the approver as author: GitHub refuses REQUEST_CHANGES from a
# PR's own author, and that is the identity posting the fake Copilot reviews.
open_pr_as_bot() {
  local name="$1" title="$2" url
  url=$(as_bot create_pr "$(new_branch "$name")" "$title")
  PR_NUM="${url##*/}"
  OPEN_PRS+=("$PR_NUM")
}

# --- Scenarios -----------------------------------------------------------

scenario_copilot_clean() {
  open_pr clean "e2e: copilot-clean"
  wait_for_ci "$PR_NUM"
  post_review "$PR_NUM" COMMENT "LGTM (e2e clean review, 0 line comments)"
  expect_outcome "$PR_NUM"
}

scenario_copilot_with_comments() {
  open_pr comments "e2e: copilot-with-comments"
  wait_for_ci "$PR_NUM"
  post_review_with_comment "$PR_NUM" "please address these"
  expect_outcome "$PR_NUM"
}

scenario_suppressed_comments() {
  local body
  open_pr suppressed "e2e: suppressed-comments"
  wait_for_ci "$PR_NUM"
  # Zero inline comments, but the body carries Copilot's real collapsed block —
  # the shape that reads as "generated no new comments" via the comments API.
  # Transcribed from the 2026-08 production format; the pre-2026-08 wording is
  # covered by the unit tests, and the action matches both.
  body='## Pull request overview

Copilot reviewed 1 out of 1 changed files in this pull request and generated no new comments.

<details>
<summary>Suppressed comments (1)</summary>

**Previously missed (1)** — in code that hasn'"'"'t changed since the last review.

**e2e-marker.txt:1**
* e2e synthetic suppressed finding
</details>'
  post_review "$PR_NUM" COMMENT "$body"
  expect_outcome "$PR_NUM"
}

scenario_three_rounds() {
  open_pr rounds "e2e: three-rounds"
  wait_for_ci "$PR_NUM"
  post_review_with_comment "$PR_NUM" "round 1"
  post_review_with_comment "$PR_NUM" "round 2"
  post_review_with_comment "$PR_NUM" "round 3"
  expect_outcome "$PR_NUM"
}

scenario_changes_requested() {
  open_pr_as_bot changes "e2e: changes-requested"
  wait_for_ci "$PR_NUM"
  post_review_with_comment "$PR_NUM" "round 1"
  post_review_with_comment "$PR_NUM" "round 2"
  post_review "$PR_NUM" REQUEST_CHANGES "blocking — do not merge"
  expect_outcome "$PR_NUM"
}

scenario_draft() {
  open_pr draft "e2e: draft" "--draft"
  wait_for_ci "$PR_NUM"
  post_review "$PR_NUM" COMMENT "clean review on a draft"
  expect_outcome "$PR_NUM"
}

# The next four need the `types` profile. They post NO Copilot review: type 0
# means none is required.

scenario_type_zero_docs() {
  open_pr type-zero-docs "chore: e2e type-zero docs" "" "docs/e2e-marker.md"
  wait_for_ci "$PR_NUM"
  expect_outcome "$PR_NUM"
}

scenario_type_zero_code() {
  # e2e-marker.txt is outside copilot-optional-paths, so the title must not help.
  open_pr type-zero-code "chore: e2e type-zero code"
  wait_for_ci "$PR_NUM"
  expect_outcome "$PR_NUM"
}

scenario_retitle_approves() {
  open_pr retitle-approves "feat: e2e retitle" "" "docs/e2e-marker.md"
  wait_for_ci "$PR_NUM"
  wait_decision "$PR_NUM" skip '^no Copilot review yet' "$SCENARIO_SINCE" \
    || fail "$SCENARIO: did not skip before the retitle"
  local since
  since=$(now_utc)
  gh pr edit -R "$REPO" "$PR_NUM" --title "chore: e2e retitle" >/dev/null
  expect_outcome "$PR_NUM" "$since"
}

scenario_retitle_withdraws() {
  open_pr retitle-withdraws "chore: e2e retitle withdraw" "" "docs/e2e-marker.md"
  wait_for_ci "$PR_NUM"
  wait_for_approval "$PR_NUM" "$ZERO_APPROVAL_RE" || fail "$SCENARIO: no initial approval"
  local since
  since=$(now_utc)
  gh pr edit -R "$REPO" "$PR_NUM" --title "feat: e2e retitle withdraw" >/dev/null
  wait_approval_withdrawn "$PR_NUM" "$ZERO_APPROVAL_RE" || fail "$SCENARIO: approval still stands"
  expect_outcome "$PR_NUM" "$since"
}

# Asks for a real Copilot review on the code PR, so it spends one. The sandbox
# must not have the automatic Copilot ruleset, or the docs half cannot pass.
scenario_request_copilot() {
  open_pr request-copilot-code "feat: e2e request copilot"
  wait_copilot_requested "$PR_NUM" || fail "$SCENARIO: Copilot was not requested on the code PR"

  open_pr request-copilot-docs "docs: e2e request copilot" "" "docs/e2e-marker.md"
  wait_for_ci "$PR_NUM"
  expect_outcome "$PR_NUM"
  local rc=0
  copilot_review_requested "$PR_NUM" || rc=$?
  [[ $rc -eq 1 ]] || fail "$SCENARIO: Copilot was requested on the docs PR (rc=$rc)"
}

# --- Runner --------------------------------------------------------------

# GitHub stamps createdAt with its own clock, so leave room for ours to differ.
now_utc() {
  date -u -d '-10 seconds' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null ||
    date -u -v-10S +%Y-%m-%dT%H:%M:%SZ
}

# In a subshell so `fail` ends the scenario and not the suite, and so the trap
# closes its PRs however it ends.
run_scenario() (
  SCENARIO="$1"
  SCENARIO_SINCE=$(now_utc)
  OPEN_PRS=()
  PR_NUM=""
  # shellcheck disable=SC2329  # invoked by the trap
  cleanup() {
    local n
    for n in "${OPEN_PRS[@]:-}"; do
      [[ -n "$n" ]] && close_pr "$n"
    done
  }
  trap cleanup EXIT
  log "scenario: $SCENARIO"
  "scenario_${SCENARIO//-/_}"
)

require_gh "$REVIEWER"

mapfile -t ALL < <(jq -r '.scenarios[].name' "$MANIFEST")
if (($# > 0)); then
  SELECTED=("$@")
else
  SELECTED=("${ALL[@]}")
fi
for s in "${SELECTED[@]}"; do
  [[ " ${ALL[*]} " == *" $s "* ]] || fail "unknown scenario: $s (valid: ${ALL[*]})"
done

log "sandbox repo: $REPO"
log "base branch: $BASE_BRANCH"
log "reviewer: $REVIEWER  approver: $APPROVER_LOGIN  timeout: ${TIMEOUT}s"

declare -A RESULTS=()
failed=0
profile=""
for s in "${SELECTED[@]}"; do
  next=$(scenario_field "$s" profile)
  if [[ "$next" != "$profile" ]]; then
    apply_profile "$next"
    profile="$next"
  fi
  started=$SECONDS
  if run_scenario "$s"; then
    RESULTS[$s]="pass ($((SECONDS - started))s)"
    ok "$s"
  else
    RESULTS[$s]="FAIL ($((SECONDS - started))s)"
    warn "$s failed"
    failed=$((failed + 1))
  fi
done

{
  printf '| Scenario | Result |\n|---|---|\n'
  for s in "${SELECTED[@]}"; do
    printf '| %s | %s |\n' "$s" "${RESULTS[$s]}"
  done
} | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"

((failed == 0)) || fail "$failed of ${#SELECTED[@]} scenarios failed"
ok "all ${#SELECTED[@]} scenarios passed"
