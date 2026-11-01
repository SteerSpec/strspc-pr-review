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

# --- copilot-clean-on ----------------------------------------------------
# The bodies in fixtures/ follow Copilot's ccr-overview-v2 format.

fixture() { cat "$SCRIPT_DIR/fixtures/$1.md"; }

scenario_clean_verdict_closer_look() {
  open_pr clean-verdict "e2e: closer look under verdict"
  wait_for_ci "$PR_NUM"
  post_review "$PR_NUM" COMMENT "$(fixture closer-look-no-open-issues)"
  expect_outcome "$PR_NUM"
}

scenario_clean_open_closer_look() {
  open_pr clean-open "e2e: closer look under no-open-issues"
  wait_for_ci "$PR_NUM"
  post_review "$PR_NUM" COMMENT "$(fixture closer-look-no-open-issues)"
  expect_outcome "$PR_NUM"
}

scenario_clean_open_with_issue() {
  open_pr clean-open-issue "e2e: open issue under no-open-issues"
  wait_for_ci "$PR_NUM"
  post_review "$PR_NUM" COMMENT "$(fixture closer-look-open-issue)"
  expect_outcome "$PR_NUM"
}

scenario_clean_open_changes_recommended() {
  open_pr clean-open-changes "e2e: changes recommended under no-open-issues"
  wait_for_ci "$PR_NUM"
  post_review "$PR_NUM" COMMENT "$(fixture changes-recommended)"
  expect_outcome "$PR_NUM"
}

# --- Promotion and release paths -----------------------------------------
# These change main and develop, so run_scenario resets the sandbox first. Setup
# merges run as the reviewer, who may bypass the rulesets. The final
# merge of a passing scenario runs as the bot, who may not: that one proves the
# PR merges without a bypass.

RELEASE_HEAD=release-please--branches--main

# Lands a type-0 PR on develop with the bot's approval. Sets LANDED.
land_approved() {
  local saved="$BASE_BRANCH"
  BASE_BRANCH=develop
  open_pr land-approved "chore: e2e approved change" "" "docs/e2e-marker.md"
  BASE_BRANCH="$saved"
  wait_for_ci "$PR_NUM"
  wait_for_approval "$PR_NUM" "$ZERO_APPROVAL_RE" || fail "$SCENARIO: setup PR was not approved"
  gh pr merge "$PR_NUM" -R "$REPO" --squash >/dev/null
  LANDED="$PR_NUM"
}

# Lands a PR on develop with no approval at all. Sets LANDED.
land_unapproved() {
  local title="$1" saved="$BASE_BRANCH"
  BASE_BRANCH=develop
  open_pr land-unapproved "$title"
  BASE_BRANCH="$saved"
  wait_for_ci "$PR_NUM"
  gh pr merge "$PR_NUM" -R "$REPO" --squash --admin >/dev/null
  LANDED="$PR_NUM"
}

open_promotion() {
  local url
  url=$(gh pr create -R "$REPO" --base main --head develop --title "$1" \
    --body "e2e scenario PR — auto-closed by harness")
  PR_NUM="${url##*/}"
  KEPT_PRS+=("$PR_NUM")
}

# A PR shaped like release-please's: one verified commit on its head branch.
open_release() {
  local head="$1" path="$2" url
  gh api -X POST "repos/$REPO/git/refs" -f ref="refs/heads/$head" \
    -f sha="$(gh api "repos/$REPO/git/ref/heads/main" -q .object.sha)" >/dev/null
  # Differs each time, because an earlier scenario may have merged this file.
  commit_file "$head" "$path" "0.1.$(date +%s)"$'\n' "chore(main): release 0.1.1"
  url=$(gh pr create -R "$REPO" --base main --head "$head" --title "chore(main): release 0.1.1" \
    --body "e2e scenario PR — auto-closed by harness")
  PR_NUM="${url##*/}"
  OPEN_PRS+=("$PR_NUM")
}

merge_as_bot() {
  as_bot gh pr merge "$PR_NUM" -R "$REPO" --merge >/dev/null \
    || fail "$SCENARIO: the bot could not merge, so the rules were not met"
}

scenario_promotion_clean() {
  land_approved
  open_promotion "chore: promote develop to main"
  wait_for_ci "$PR_NUM"
  expect_outcome "$PR_NUM"
  wait_for_approval "$PR_NUM" "$ZERO_APPROVAL_RE" || fail "$SCENARIO: approval is not stamped threshold=0"
  merge_as_bot
}

scenario_promotion_unapproved() {
  land_unapproved "fix: e2e unapproved change"
  open_promotion "chore: promote develop to main"
  wait_for_ci "$PR_NUM"
  expect_outcome "$PR_NUM"
}

scenario_promotion_late_approval() {
  land_unapproved "fix: e2e approved too late"
  as_bot gh api -X POST "repos/$REPO/pulls/$LANDED/reviews" \
    -f event=APPROVE -f body="e2e approval after the merge" >/dev/null
  open_promotion "chore: promote develop to main"
  wait_for_ci "$PR_NUM"
  expect_outcome "$PR_NUM"
}

scenario_promotion_title_feat() {
  land_approved
  open_promotion "feat: promote develop to main"
  wait_for_ci "$PR_NUM"
  expect_outcome "$PR_NUM"
}

scenario_promotion_other_head() {
  open_pr promotion-other "chore: e2e not a promotion"
  wait_for_ci "$PR_NUM"
  expect_outcome "$PR_NUM"
}

scenario_promotion_withdraw() {
  land_approved
  open_promotion "chore: promote develop to main"
  wait_for_ci "$PR_NUM"
  wait_for_approval "$PR_NUM" "$ZERO_APPROVAL_RE" || fail "$SCENARIO: no initial approval"
  local since
  since=$(now_utc)
  gh pr edit -R "$REPO" "$PR_NUM" --title "feat: promote develop to main" >/dev/null
  wait_approval_withdrawn "$PR_NUM" "$ZERO_APPROVAL_RE" || fail "$SCENARIO: approval still stands"
  expect_outcome "$PR_NUM" "$since"
}

scenario_release_clean() {
  open_release "$RELEASE_HEAD" version.txt
  wait_for_ci "$PR_NUM"
  expect_outcome "$PR_NUM"
  merge_as_bot
}

scenario_release_unpromoted() {
  land_unapproved "fix: e2e waiting on develop"
  open_release "$RELEASE_HEAD" version.txt
  wait_for_ci "$PR_NUM"
  expect_outcome "$PR_NUM"
}

scenario_release_hidden_chore() {
  land_approved
  open_release "$RELEASE_HEAD" version.txt
  wait_for_ci "$PR_NUM"
  expect_outcome "$PR_NUM"
}

scenario_release_wrong_author() {
  open_release "$RELEASE_HEAD" version.txt
  wait_for_ci "$PR_NUM"
  expect_outcome "$PR_NUM"
}

scenario_release_stranger_commit() {
  open_release "$RELEASE_HEAD" version.txt
  as_bot commit_file "$RELEASE_HEAD" CHANGELOG.md $'# Changelog\n' "chore(main): edit the changelog"
  wait_for_ci "$PR_NUM"
  expect_outcome "$PR_NUM"
}

scenario_release_foreign_file() {
  open_release "$RELEASE_HEAD" src/e2e-marker.txt
  wait_for_ci "$PR_NUM"
  expect_outcome "$PR_NUM"
}

scenario_release_no_config() {
  delete_file main release-please-config.json "chore(e2e): remove the release config"
  open_release "$RELEASE_HEAD" version.txt
  wait_for_ci "$PR_NUM"
  expect_outcome "$PR_NUM"
}

scenario_release_other_head() {
  open_release "$RELEASE_HEAD--extra" version.txt
  wait_for_ci "$PR_NUM"
  expect_outcome "$PR_NUM"
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
  set -eE
  # Without this, a failed command ends the scenario with nothing in the log.
  # shellcheck disable=SC2154  # BASH_COMMAND is set by bash
  trap 'warn "failed at run.sh:$LINENO: $BASH_COMMAND"' ERR
  SCENARIO="$1"
  SCENARIO_SINCE=$(now_utc)
  OPEN_PRS=()
  KEPT_PRS=()
  PR_NUM=""
  LANDED=""
  # shellcheck disable=SC2329  # invoked by the trap
  cleanup() {
    local n
    for n in "${OPEN_PRS[@]:-}"; do
      [[ -n "$n" ]] && close_pr "$n"
    done
    # A promotion's head is develop, which close_pr would delete.
    # It may have merged, which close refuses, and that must not fail the scenario.
    for n in "${KEPT_PRS[@]:-}"; do
      [[ -n "$n" ]] && { gh pr close "$n" -R "$REPO" >/dev/null 2>&1 || true; }
    done
    return 0
  }
  trap cleanup EXIT
  log "scenario: $SCENARIO"
  if [[ "$(scenario_field "$SCENARIO" profile)" == routes* ]]; then
    E2E_REPO="$REPO" "$SCRIPT_DIR/sandbox.sh" reset
  fi
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

assert_pinned

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
  # Not `if run_scenario` or `run_scenario || ...`: a function called as a condition
  # runs with errexit off all the way down, and `set -e` inside it has no effect,
  # so a failed setup command would not stop the scenario.
  set +e
  run_scenario "$s"
  rc=$?
  set -e
  if ((rc == 0)); then
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

assert_pinned
E2E_REPO="$REPO" "$SCRIPT_DIR/sandbox.sh" reset

((failed == 0)) || fail "$failed of ${#SELECTED[@]} scenarios failed"
ok "all ${#SELECTED[@]} scenarios passed"
