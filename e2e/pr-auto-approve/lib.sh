# SPDX-License-Identifier: Apache-2.0
# shellcheck shell=bash
#
# Shared helpers for the pr-auto-approve e2e harnesses.
#
# Sourced by run.sh, the synthetic tier (which fakes Copilot via
# test-copilot-logins), and sandbox.sh. Split out ahead of a second, real-Copilot
# harness that would otherwise duplicate run.sh's lines; that harness does not
# exist yet, which is why require_gh and the repo variable are parameterised.
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
#   E2E_CALLER_WORKFLOW     — the sandbox's caller workflow file (default: pr-auto-approve.yml)
#   E2E_BOT_TOKEN           — token for the approver login, which authors the PR
#                             some scenarios need from a second identity

# Fail fast on macOS system Bash 3.2 — the harnesses' scenario tables are
# associative arrays, which require Bash 4+.
if ((BASH_VERSINFO[0] < 4)); then
  printf 'error: Bash 4+ required (you are running %s). On macOS: brew install bash\n' "$BASH_VERSION" >&2
  exit 2
fi

REPO="${E2E_REPO:-${E2E_SANDBOX_REPO:-owner/sandbox-repo}}"
MANIFEST="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/scenarios.json"
REVIEWER="${E2E_REVIEWER_LOGIN:-my-bot}"
APPROVER_LOGIN="${E2E_APPROVER_LOGIN:-my-bot}"
BASE_BRANCH="${E2E_BASE_BRANCH:-main}"
TIMEOUT="${E2E_TIMEOUT:-180}"
POLL_INTERVAL=10
APPROVE_CHECK_PATTERN="${E2E_APPROVE_CHECK_PATTERN:-auto-approve}"
CALLER_WORKFLOW="${E2E_CALLER_WORKFLOW:-pr-auto-approve.yml}"
LOG_DIR="${E2E_LOG_DIR:-$(mktemp -d)}"

# Body stamp of an approval that rests on rounds-by-type 0 (or the legacy marker).
# shellcheck disable=SC2034  # read by run.sh, which sources this file
ZERO_APPROVAL_RE='pr-auto-approve:(threshold=0|copilot-optional)'

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

# Runs a command as the approver login. A scenario that needs this and has no
# token fails: reporting it as passed is how changes-requested went untested.
as_bot() {
  [[ -n "${E2E_BOT_TOKEN:-}" ]] || fail "E2E_BOT_TOKEN is required by this scenario"
  GH_TOKEN="$E2E_BOT_TOKEN" "$@"
}

# Commits one file with createCommitOnBranch, which GitHub signs. The contents
# API leaves a user token's commit unsigned, and neither the Signed Commit
# ruleset nor the release path's verified-author gate would accept that.
commit_file() {
  local branch="$1" path="$2" text="$3" message="$4" head
  head=$(gh api "repos/$REPO/git/ref/heads/$branch" -q .object.sha)
  [[ -n "$head" ]] || fail "could not read $branch from $REPO"
  jq -n --arg repo "$REPO" --arg branch "$branch" --arg head "$head" --arg path "$path" \
    --arg message "$message" --arg contents "$(printf '%s' "$text" | b64_oneline)" '{
      query: "mutation($i: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $i) { commit { oid } } }",
      variables: {i: {
        branch: {repositoryNameWithOwner: $repo, branchName: $branch},
        message: {headline: $message}, expectedHeadOid: $head,
        fileChanges: {additions: [{path: $path, contents: $contents}]}}}}' \
    | gh api graphql --input - >/dev/null
}

# As commit_file, for removing a file.
delete_file() {
  local branch="$1" path="$2" message="$3" head
  head=$(gh api "repos/$REPO/git/ref/heads/$branch" -q .object.sha)
  [[ -n "$head" ]] || fail "could not read $branch from $REPO"
  jq -n --arg repo "$REPO" --arg branch "$branch" --arg head "$head" --arg path "$path" \
    --arg message "$message" '{
      query: "mutation($i: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $i) { commit { oid } } }",
      variables: {i: {
        branch: {repositoryNameWithOwner: $repo, branchName: $branch},
        message: {headline: $message}, expectedHeadOid: $head,
        fileChanges: {deletions: [{path: $path}]}}}}' \
    | gh api graphql --input - >/dev/null
}

create_pr() {
  local branch="$1" title="$2"
  # $3 is an extra `gh pr create` flag (e.g. --draft); $4 overrides the file the
  # PR changes, which the rounds-by-type scenarios need to be docs-only.
  local path="${4:-e2e-marker.txt}"
  local base_sha
  base_sha=$(gh api "repos/$REPO/branches/$BASE_BRANCH" -q .commit.sha)
  [[ -n "$base_sha" ]] || fail "could not read $BASE_BRANCH SHA from $REPO"
  gh api -X POST "repos/$REPO/git/refs" \
    -f ref="refs/heads/$branch" -f sha="$base_sha" >/dev/null
  commit_file "$branch" "$path" "$(printf 'e2e run: %s\n' "$branch")" "$title"
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

# The optional second argument is a regex the approval's body must match. The
# type-0 scenarios pass $ZERO_APPROVAL_RE: the testbed's ruleset also gets a
# real Copilot review, so a bare "approved" cannot tell a type-0 approval from
# a legitimate copilot-clean one.
#
# Exit codes:
#   0 — APPROVED review by $APPROVER_LOGIN found
#   1 — reviews fetched, no matching approval yet
#   2 — `gh api` errored (network, auth, rate limit)
has_bot_approval() {
  local pr_num="$1" body_re="${2:-}" reviews
  if ! reviews=$(gh api "repos/$REPO/pulls/$pr_num/reviews" 2>&1); then
    warn "gh api failed while polling PR #$pr_num: $reviews"
    return 2
  fi
  printf '%s' "$reviews" | jq -e --arg login "$APPROVER_LOGIN" --arg re "$body_re" \
    '[.[] | select(.user.login == $login and .state == "APPROVED" and ((.body // "") | test($re)))] | length > 0' \
    >/dev/null
}

wait_for_approval() {
  local pr_num="$1" body_re="${2:-}" deadline rc
  deadline=$(( $(date +%s) + TIMEOUT ))
  while (( $(date +%s) < deadline )); do
    has_bot_approval "$pr_num" "$body_re"
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
  local pr_num="$1" body_re="${2:-}"
  local grace="${E2E_GRACE:-60}"
  local rc attempt
  sleep "$grace"
  # rc 2 is an API error, not "no approval": retry rather than pass on it.
  for attempt in 1 2 3; do
    rc=0
    has_bot_approval "$pr_num" "$body_re" || rc=$?
    [[ $rc -ne 2 ]] && break
    [[ $attempt -lt 3 ]] && sleep "$POLL_INTERVAL"
  done
  [[ $rc -eq 1 ]]
}

# --- Decisions -----------------------------------------------------------
#
# A missing approval proves nothing: a crash, a wrong token and a skipped job all
# look the same as a correct refusal. So every scenario asserts what the action
# decided, from the line it logs:
#
#   pr-auto-approve pr=<n> decision=<d> reason=<r>
#
# Runs cannot be matched to a PR by SHA or branch: workflow_run events carry the
# default branch, whichever PR they judged. The pr= field is what ties them.

# Prints "<decision> <reason>" for each evaluation of the PR since $2, oldest
# first. Logs of finished runs never change, so each is fetched once. Returns 1
# if anything could not be read: empty output must mean "no decisions", never
# "the API failed". Skipped and cancelled runs have no evaluation to read.
decision_lines() {
  local pr_num="$1" since="$2" runs ids id log text
  runs=$(gh run list -R "$REPO" --workflow "$CALLER_WORKFLOW" --limit 40 \
    --json databaseId,status,conclusion,createdAt 2>/dev/null) || return 1
  ids=$(printf '%s' "$runs" | jq -r --arg s "$since" \
    '[.[] | select(.status == "completed" and .createdAt >= $s
      and (.conclusion == "success" or .conclusion == "failure"))]
     | sort_by(.createdAt) | .[].databaseId') || return 1
  for id in $ids; do
    log="$LOG_DIR/$id.log"
    if [[ ! -e "$log" ]]; then
      text=$(gh run view "$id" -R "$REPO" --log 2>/dev/null) || return 1
      printf '%s\n' "$text" | grep -oE 'pr-auto-approve pr=[0-9a-z]+ decision=.*' >"$log" || true
    fi
    sed -nE "s/^pr-auto-approve pr=$pr_num decision=([a-z]+) reason=(.*)\$/\1 \2/p" "$log"
  done
}

# Poll until an evaluation since $4 made decision $2 with a reason matching $3.
# Any matching line counts: "check still running" comes first, and a run after
# an approval reports that the bot already approved.
wait_decision() {
  local pr_num="$1" decision="$2" reason_re="$3" since="$4" deadline lines="" seen reason
  deadline=$(( $(date +%s) + TIMEOUT ))
  while (( $(date +%s) < deadline )); do
    lines=$(decision_lines "$pr_num" "$since") || lines=""
    # Bash's own match: awk -v rewrites the regex's backslashes, and BSD awk then
    # rejects `\(`. Keeps the same ERE scenarios.json is written in.
    while read -r seen reason; do
      [[ "$seen" == "$decision" && "$reason" =~ $reason_re ]] && return 0
    done <<< "$lines"
    sleep "$POLL_INTERVAL"
  done
  warn "PR #$pr_num: no '$decision' decision matching /$reason_re/. Decisions seen:"
  printf '%s\n' "${lines:-(none)}" >&2
  return 1
}

# The caller's job if: must have stopped the PR before the action ran. That takes
# proof on both sides: a caller run for this branch that GitHub reports as
# skipped, and a readable run history with no decision for this PR. Nothing
# having happened yet, or an API failure, must not pass.
wait_no_decision() {
  local pr_num="$1" since="$2" branch deadline runs lines
  branch=$(gh pr view "$pr_num" -R "$REPO" --json headRefName -q .headRefName) || return 1
  sleep "${E2E_GRACE:-60}"
  deadline=$(( $(date +%s) + TIMEOUT ))
  while (( $(date +%s) < deadline )); do
    if runs=$(gh run list -R "$REPO" --workflow "$CALLER_WORKFLOW" --limit 40 \
        --json headBranch,conclusion,createdAt 2>/dev/null) &&
      printf '%s' "$runs" | jq -e --arg b "$branch" --arg s "$since" \
        'any(.[]; .headBranch == $b and .conclusion == "skipped" and .createdAt >= $s)' >/dev/null &&
      lines=$(decision_lines "$pr_num" "$since"); then
      [[ -z "$lines" ]] && return 0
      warn "PR #$pr_num: unexpected decisions: $lines"
      return 1
    fi
    sleep "$POLL_INTERVAL"
  done
  warn "PR #$pr_num: no skipped caller run seen on $branch since $since"
  return 1
}

# Reads a field of a scenario from scenarios.json.
scenario_field() {
  jq -r --arg n "$1" --arg f "$2" '.scenarios[] | select(.name == $n) | .[$f] // ""' "$MANIFEST"
}

# Asserts the outcome scenarios.json states for the running scenario, since $2
# (default: the scenario's start). Both halves matter: the decision proves why,
# and the review proves GitHub holds what the action claims it did.
expect_outcome() {
  local pr_num="$1" since="${2:-$SCENARIO_SINCE}" decision reason_re
  # shellcheck disable=SC2153  # run_scenario in run.sh sets SCENARIO
  decision=$(scenario_field "$SCENARIO" decision)
  reason_re=$(scenario_field "$SCENARIO" reason)
  case "$decision" in
    approved)
      # From the review, not the log: the run that approves is often cancelled
      # by the next one, and the review is what GitHub actually holds.
      wait_for_approval "$pr_num" "Auto-approved: ${reason_re#^}" \
        || fail "$SCENARIO: no approval with a reason matching /$reason_re/"
      ;;
    skip)
      wait_decision "$pr_num" skip "$reason_re" "$since" || fail "$SCENARIO: wrong decision"
      wait_not_approved "$pr_num" || fail "$SCENARIO: approved after all"
      ;;
    none)
      wait_no_decision "$pr_num" "$since" || fail "$SCENARIO: the action ran"
      wait_not_approved "$pr_num" || fail "$SCENARIO: approved after all"
      ;;
    *) fail "$SCENARIO: scenarios.json has no decision" ;;
  esac
}

# Sets the repo variables of a scenarios.json profile, and unsets every variable
# another profile uses, so nothing carries over from the previous one. {reviewer}
# in a value is E2E_REVIEWER_LOGIN, the identity that authors the release PRs.
apply_profile() {
  local profile="$1" name value
  while read -r name; do
    value=$(jq -r --arg p "$profile" --arg n "$name" '.profiles[$p][$n] // empty' "$MANIFEST")
    value="${value//\{reviewer\}/$REVIEWER}"
    if [[ -n "$value" ]]; then
      gh variable set "STRSPC_PR_AUTO_APPROVE_$name" -R "$REPO" --body "$value"
    else
      gh variable delete "STRSPC_PR_AUTO_APPROVE_$name" -R "$REPO" 2>/dev/null || true
    fi
  done < <(jq -r '[.profiles[] | keys[]] | unique | .[]' "$MANIFEST")
}

# Poll until the caller workflow has a successful run of $event on $branch that
# started after $since (ISO-8601 UTC). Proves a trigger fired, independent of
# who approved: the testbed's ruleset also gets a real Copilot review, so an
# approval alone cannot show that a retitle re-evaluated the PR.
wait_caller_run() {
  local branch="$1" event="$2" since="$3" deadline runs
  deadline=$(( $(date +%s) + TIMEOUT ))
  while (( $(date +%s) < deadline )); do
    if runs=$(gh run list -R "$REPO" --workflow "$CALLER_WORKFLOW" --limit 30 \
      --json headBranch,event,status,conclusion,createdAt 2>/dev/null) &&
      printf '%s' "$runs" | jq -e --arg b "$branch" --arg e "$event" --arg s "$since" \
        '[.[] | select(.headBranch == $b and .event == $e and .createdAt > $s and .status == "completed" and .conclusion == "success")] | length > 0' \
        >/dev/null; then
      return 0
    fi
    sleep "$POLL_INTERVAL"
  done
  return 1
}

# 0 when the PR timeline records a review request for Copilot, 1 when it does
# not, 2 on an API error. The REST request for copilot-pull-request-reviewer[bot]
# shows up there as review_requested for the reviewer `Copilot`.
copilot_review_requested() {
  local pr_num="$1" events
  if ! events=$(gh api "repos/$REPO/issues/$pr_num/events" --paginate 2>&1); then
    return 2
  fi
  # --paginate prints one array per page: slurp them so a match on an earlier
  # page is not lost to a later page without one.
  printf '%s' "$events" | jq -es \
    '[.[][] | select(.event == "review_requested" and .requested_reviewer.login == "Copilot")] | length > 0' \
    >/dev/null
}

# Poll until Copilot has been requested as a reviewer on the PR.
wait_copilot_requested() {
  local pr_num="$1" deadline rc
  deadline=$(( $(date +%s) + TIMEOUT ))
  while (( $(date +%s) < deadline )); do
    rc=0
    copilot_review_requested "$pr_num" || rc=$?
    [[ $rc -eq 0 ]] && return 0
    sleep "$POLL_INTERVAL"
  done
  return 1
}

# Poll until the approver has NO live approval on the PR (it was dismissed).
wait_approval_withdrawn() {
  local pr_num="$1" body_re="${2:-}" deadline rc
  deadline=$(( $(date +%s) + TIMEOUT ))
  while (( $(date +%s) < deadline )); do
    rc=0
    has_bot_approval "$pr_num" "$body_re" || rc=$?
    [[ $rc -eq 1 ]] && return 0
    sleep "$POLL_INTERVAL"
  done
  return 1
}
