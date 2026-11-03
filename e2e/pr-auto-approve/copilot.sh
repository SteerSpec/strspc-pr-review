#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# e2e harness for the pr-auto-approve action — REAL-COPILOT tier.
#
# Copilot reviews for real here, so this tier can see what the synthetic one
# cannot: Copilot changing its output underneath the action. Each push costs a
# Copilot review, which is a premium request, so it runs on demand and before a
# release, never on a schedule.
#
# Copilot's verdict is not deterministic, so a scenario cannot state its decision.
# Each one asserts three things instead (oracle.jq holds the first two):
#
#   probe   every Copilot review is in a shape Copilot is known to post, its
#           reviewer is a known Copilot login, and no Copilot check has a name the
#           action does not know. Anything else is drift and fails the scenario.
#   oracle  the action's decision is the one an independent jq oracle computes from
#           what GitHub holds. A mismatch fails the scenario.
#   intent  the fixture got the outcome it was written for (clean approved, buggy
#           skipped). A miss only warns: Copilot may judge a fixture differently.
#
# Prereqs: Bash 4+, jq, gh authenticated as E2E_AUTHOR_LOGIN (the enterprise owner,
# who authors the PRs and resets the testbed), and the testbed provisioned by
# `sandbox.sh --real setup` and `sync`, with its BOT_TOKEN_COPILOT secret set.
#
#   copilot.sh                 every scenario in copilot-scenarios.json
#   copilot.sh real-clean      just these
#
# Environment, beyond lib.sh's:
#   E2E_AUTHOR_LOGIN     who gh is authenticated as (default: pleberre)
#   E2E_COPILOT_TIMEOUT  seconds to wait for Copilot to review a push (900)
#   E2E_SETTLE_TIMEOUT   seconds to wait for the caller's runs to finish after it (900)
#   E2E_TIMEOUT          as in lib.sh, but 900 by default: CI waits on Copilot's check
set -euo pipefail

SCRIPT_DIR="$(cd "${BASH_SOURCE[0]%/*}" && pwd)"
export E2E_REPO="${E2E_REPO:-testbed-multi-org/strspc-pr-review-copilot}"
export E2E_APPROVER_LOGIN="${E2E_APPROVER_LOGIN:-cnslr-bt}"
# wait_for_ci waits for every check but the caller's, Copilot's included when it
# posts one, and a review takes minutes. lib.sh reads this when sourced.
export E2E_TIMEOUT="${E2E_TIMEOUT:-900}"
# shellcheck source=e2e/pr-auto-approve/lib.sh
source "$SCRIPT_DIR/lib.sh"

REAL_MANIFEST="$SCRIPT_DIR/copilot-scenarios.json"
FIXTURES="$SCRIPT_DIR/fixtures/real"
AUTHOR="${E2E_AUTHOR_LOGIN:-pleberre}"
COPILOT_TIMEOUT="${E2E_COPILOT_TIMEOUT:-900}"
SETTLE_TIMEOUT="${E2E_SETTLE_TIMEOUT:-900}"
# The testbed sets neither, so the action's defaults apply.
THRESHOLD=3
CLEAN_ON=verdict
# Copilot's identities, kept here independently of decide.js: a review or check
# from a Copilot-like identity outside these lists is drift the probe reports.
COPILOT_LOGINS='["copilot-pull-request-reviewer[bot]","github-copilot[bot]"]'
COPILOT_CHECKS='["copilot-pull-request-reviewer","github-copilot"]'

real_field() { jq -r --arg n "$1" --arg f "$2" '.scenarios[] | select(.name == $n) | .[$f]' "$REAL_MANIFEST"; }
real_steps() { jq -r --arg n "$1" '.scenarios[] | select(.name == $n) | .steps[]' "$REAL_MANIFEST"; }
oracle() { jq -c -L "$SCRIPT_DIR" "include \"oracle\"; $1"; }

now_utc() {
  date -u -d '-10 seconds' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null ||
    date -u -v-10S +%Y-%m-%dT%H:%M:%SZ
}

pr_head() { gh api "repos/$REPO/pulls/$1" -q .head.sha; }

# Every review on the PR, as one array.
all_reviews() { gh api "repos/$REPO/pulls/$1/reviews" --paginate | jq -s 'add // []'; }

# Polls until a Copilot review, of any kind, names this head. Any bot with Copilot
# in its login counts, so a new Copilot login reaches the probe, which reports it,
# instead of timing out here.
wait_copilot_review() {
  local pr="$1" head="$2" deadline
  deadline=$(( $(date +%s) + COPILOT_TIMEOUT ))
  log "waiting for Copilot to review ${head:0:8} on PR #$pr…"
  while (( $(date +%s) < deadline )); do
    if all_reviews "$pr" 2>/dev/null | jq -e --arg h "$head" --argjson l "$COPILOT_LOGINS" \
        'any(.[]; .commit_id == $h and ((.user.login as $u | $l | index($u))
           or (.user.type == "Bot" and (.user.login | test("copilot"; "i")))))' >/dev/null; then
      return 0
    fi
    sleep "$POLL_INTERVAL"
  done
  fail "Copilot did not review ${head:0:8} in ${COPILOT_TIMEOUT}s"
}

# The caller's runs since $1, oldest first: id, event, status.
caller_runs() {
  gh api "repos/$REPO/actions/workflows/$CALLER_WORKFLOW/runs?per_page=100&created=%3E%3D$1" \
    -q '.workflow_runs | sort_by(.created_at) | .[] | [.id, .event, .status, .conclusion] | @tsv'
}

# Polls until every caller run since $1 has finished and one of them ran on CI
# completing: that is the run the wait input keeps alive until Copilot reviews.
wait_settled() {
  local since="$1" deadline runs
  deadline=$(( $(date +%s) + SETTLE_TIMEOUT ))
  while (( $(date +%s) < deadline )); do
    if runs=$(caller_runs "$since" 2>/dev/null) &&
      ! awk -F'\t' '$3 != "completed" && $3 != "action_required" { busy = 1 } END { exit !busy }' <<<"$runs" &&
      awk -F'\t' '$2 == "workflow_run" { found = 1 } END { exit !found }' <<<"$runs"; then
      return 0
    fi
    sleep "$POLL_INTERVAL"
  done
  fail "the caller's runs since $since did not finish in ${SETTLE_TIMEOUT}s"
}

# "<event>\t<decision>\t<waited>\t<reason>" for each evaluation of PR $1 since $2,
# oldest first. waited is 1 when that run polled for Copilot's review. Finished
# runs' logs never change, so each is read once.
real_decisions() {
  local pr="$1" since="$2" id event conclusion log text
  while IFS=$'\t' read -r id event _ conclusion; do
    [[ "$conclusion" == success || "$conclusion" == failure ]] || continue
    log="$LOG_DIR/$id.log"
    if [[ ! -e "$log" ]]; then
      # A log GitHub has not finished storing is not cached, so it is read again.
      text=$(gh run view "$id" -R "$REPO" --log 2>/dev/null) || continue
      grep -oE 'pr-auto-approve(:| pr=)[^\r]*' <<<"$text" >"$log" || true
    fi
    awk -v pr="$pr" -v event="$event" '
      /pr-auto-approve: waiting for Copilot to review/ { waited = 1 }
      index($0, "pr-auto-approve pr=" pr " decision=") == 1 {
        line = $0
        sub(/^pr-auto-approve pr=[0-9]+ decision=/, "", line)
        decision = line; sub(/ reason=.*/, "", decision)
        reason = line; sub(/^[a-z]+ reason=/, "", reason)
        print event "\t" decision "\t" (waited ? 1 : 0) "\t" reason
      }' "$log"
  done < <(caller_runs "$since")
}

# Everything the oracle reads, from GitHub: the head, its first failed check, and
# each review, with its inline comment count when it is Copilot's. Checks are read
# as the action reads them: an unfinished run of the caller's own job is ignored, a
# finished one still counts, and only the latest attempt of each (name, app) does.
snapshot() {
  local pr="$1" head="$2" checks reviews id n
  checks=$(gh api "repos/$REPO/commits/$head/check-runs?per_page=100")
  reviews=$(all_reviews "$pr")
  for id in $(jq -r --argjson l "$COPILOT_LOGINS" '.[] | select(.user.login as $u | $l | index($u)) | .id' <<<"$reviews"); do
    n=$(gh api "repos/$REPO/pulls/$pr/reviews/$id/comments" --paginate | jq -s 'add // [] | length')
    reviews=$(jq --argjson id "$id" --argjson n "$n" 'map(if .id == $id then .comments = $n else . end)' <<<"$reviews")
  done
  jq -n --arg head "$head" --argjson checks "$checks" --argjson reviews "$reviews" \
    --argjson logins "$COPILOT_LOGINS" --argjson threshold "$THRESHOLD" --arg clean_on "$CLEAN_ON" --arg pattern "$APPROVE_CHECK_PATTERN" '{
      head: $head, threshold: $threshold, clean_on: $clean_on, logins: $logins,
      failed_check: ([[$checks.check_runs[]
        | select(((.name | contains($pattern)) and .status != "completed") | not)]
        | group_by([.name, .app.id]) | map(max_by(.started_at // .completed_at // ""))
        | .[] | select(.status == "completed"
            and (.conclusion | IN("success", "neutral", "skipped", "cancelled", "stale") | not))
        | "\(.name) (\(.conclusion))"] | first),
      checks: [$checks.check_runs[] | {name, app: .app.slug, status, conclusion}],
      reviews: [$reviews[] | .comments //= 0]}'
}

# Drift the probe finds in a snapshot, one line each; nothing when all is known.
drift() {
  jq -r -L "$SCRIPT_DIR" --argjson checks "$COPILOT_CHECKS" 'include "oracle";
    (.logins) as $l
    | (.reviews[] | select(.user.login as $u | $l | index($u)) | probe as $p
        | $p.drift[] | "review \(.id): \(.)"),
      (.reviews[] | select(.user.type == "Bot" and (.user.login | test("copilot"; "i")) and (.user.login as $u | $l | index($u) | not))
        | "review \(.id): unknown Copilot login \(.user.login)"),
      (.checks[] | select(((.name + " " + (.app // "")) | test("copilot"; "i")) and (.name as $n | $checks | index($n) | not))
        | "check \(.name) (app \(.app)): unknown Copilot check name")'
}

# Excerpts of the Copilot reviews the probe flagged, so drift can be read off the log.
show_drift_bodies() {
  jq -r --argjson l "$COPILOT_LOGINS" -L "$SCRIPT_DIR" 'include "oracle";
    .reviews[] | select((.user.login as $u | $l | index($u)) and (probe | .drift | length > 0))
    | "--- review \(.id) ---\n\(.body[:1200])"'
}

# The bot's live approval of the head, as its reason, or nothing.
approval_reason() {
  all_reviews "$1" | jq -r --arg b "$APPROVER_LOGIN" --arg h "$2" '
    [.[] | select(.user.login == $b and .state == "APPROVED" and .commit_id == $h)] | last
    | select(. != null) | .body | sub("^Auto-approved: "; "") | split("\n") | first'
}

# Settles one push and judges it. Sets ACTUAL, EXPECTED and VIA for the caller;
# fails the scenario on drift or on the oracle's disagreement.
judge_step() {
  local pr="$1" since="$2" head snap found expected reason line event decision waited
  head=$(pr_head "$pr")
  wait_for_ci "$pr"
  wait_copilot_review "$pr" "$head"
  wait_settled "$since"
  sleep "${E2E_GRACE:-15}"
  [[ "$(pr_head "$pr")" == "$head" ]] || fail "PR #$pr moved while it was judged"

  snap=$(snapshot "$pr" "$head")
  printf '%s\n' "$snap" >"$LOG_DIR/snapshot-$pr-${head:0:8}.json"
  found=$(drift <<<"$snap")
  if [[ -n "$found" ]]; then
    warn "Copilot's output is not in a known shape:"
    printf '%s\n' "$found" >&2
    show_drift_bodies <<<"$snap" >&2
    DRIFT=1
  fi
  if jq -e '[.checks[] | select(.name | test("copilot"; "i"))] | length == 0' <<<"$snap" >/dev/null; then
    log "no Copilot check run on ${head:0:8}"
  fi

  expected=$(oracle expect <<<"$snap")
  EXPECTED="$(jq -r .decision <<<"$expected") /$(jq -r .reason <<<"$expected")/"
  reason=$(approval_reason "$pr" "$head")
  VIA=""
  if [[ -n "$reason" ]]; then
    ACTUAL="approved $reason"
    # Which run approved, and whether it had to wait for Copilot to do it.
    line=$(real_decisions "$pr" "$since" | awk -F'\t' '$2 == "approved"' | tail -n 1)
    if [[ -n "$line" ]]; then
      IFS=$'\t' read -r event decision waited _ <<<"$line"
      VIA="$event"
      if ((waited)); then VIA="$VIA, waited for Copilot"; fi
    else
      VIA="run not found"
    fi
  else
    line=$(real_decisions "$pr" "$since" | awk -F'\t' '$4 !~ /^(check still running|no checks on head SHA yet)/' | tail -n 1)
    [[ -n "$line" ]] || fail "no evaluation of PR #$pr since $since"
    IFS=$'\t' read -r event decision waited reason <<<"$line"
    ACTUAL="$decision $reason"
    VIA="$event"
  fi
  log "oracle: $EXPECTED"
  log "action: $ACTUAL${VIA:+ ($VIA)}"
  [[ "${ACTUAL%% *}" == "$(jq -r .decision <<<"$expected")" && "${ACTUAL#* }" =~ $(jq -r .reason <<<"$expected") ]] ||
    fail "the action decided '$ACTUAL', the oracle expects $EXPECTED"
  ((DRIFT == 0)) || fail "drift in Copilot's output (above)"
}

# In a subshell so `fail` ends the scenario, not the suite, and the trap closes
# its PR however it ends. Writes its summary row to $ROW_FILE.
run_real_scenario() (
  set -eE
  # shellcheck disable=SC2154  # BASH_COMMAND is set by bash
  trap 'warn "failed at copilot.sh:$LINENO: $BASH_COMMAND"' ERR
  local name="$1" title branch pr="" step i=0 since intent url steps
  PR_NUM=""
  DRIFT=0 ACTUAL="" EXPECTED="" VIA=""
  # shellcheck disable=SC2329  # invoked by the trap
  cleanup() {
    [[ -n "$PR_NUM" ]] && close_pr "$PR_NUM"
    # \x1f, not a tab: read collapses empty tab-separated fields.
    printf '%s\x1f%s\x1f%s\n' "${ACTUAL:-none}" "${VIA:-}" "$DRIFT" >"$ROW_FILE"
    return 0
  }
  trap cleanup EXIT
  log "scenario: $name"
  title=$(real_field "$name" title)
  intent=$(real_field "$name" intent)
  branch=$(new_branch "$name")
  gh api -X POST "repos/$REPO/git/refs" -f ref="refs/heads/$branch" \
    -f sha="$(gh api "repos/$REPO/branches/$BASE_BRANCH" -q .commit.sha)" >/dev/null
  # An array, not `while read`: a gh call in the loop could read the steps' stdin.
  mapfile -t steps < <(real_steps "$name")
  for step in "${steps[@]}"; do
    i=$((i + 1))
    since=$(now_utc)
    commit_dir "$branch" "$FIXTURES/$step" "$title ($name, step $i: $step)" >/dev/null
    if [[ -z "$pr" ]]; then
      url=$(gh pr create -R "$REPO" --base "$BASE_BRANCH" --head "$branch" --title "$title" \
        --body "e2e real-Copilot scenario $name — auto-closed by copilot.sh")
      pr="${url##*/}"
      PR_NUM="$pr"
      log "PR #$pr"
    fi
    log "step $i: $step"
    judge_step "$pr" "$since"
  done
  [[ "${ACTUAL%% *}" == "$intent" ]] ||
    warn "$name: intended '$intent', Copilot's review led to '$ACTUAL'. The oracle agreed, so this is Copilot's judgement, not the action's"
)

require_gh "$AUTHOR"
gh secret list -R "$REPO" --json name -q '.[].name' | grep -qx BOT_TOKEN_COPILOT ||
  fail "$REPO has no BOT_TOKEN_COPILOT secret, so the bot cannot approve (see the README)"

mapfile -t ALL < <(jq -r '.scenarios[].name' "$REAL_MANIFEST")
if (($# > 0)); then SELECTED=("$@"); else SELECTED=("${ALL[@]}"); fi
for s in "${SELECTED[@]}"; do
  [[ " ${ALL[*]} " == *" $s "* ]] || fail "unknown scenario: $s (valid: ${ALL[*]})"
done
pushes=0
for s in "${SELECTED[@]}"; do pushes=$((pushes + $(real_steps "$s" | wc -l))); done

log "testbed: $REPO"
log "author: $AUTHOR  approver: $APPROVER_LOGIN"
log "about $pushes Copilot review(s), each a premium request"
assert_pinned
"$SCRIPT_DIR/sandbox.sh" --real reset

ROW_FILE=$(mktemp)
declare -A ROWS=()
failed=0
intent_missed=0
for s in "${SELECTED[@]}"; do
  started=$SECONDS
  : >"$ROW_FILE"
  set +e
  run_real_scenario "$s"
  rc=$?
  set -e
  actual="" via="" drifted=0
  IFS=$'\x1f' read -r actual via drifted <"$ROW_FILE" || true
  intent=$(real_field "$s" intent)
  verdict=pass
  ((rc == 0)) || { verdict=FAIL; failed=$((failed + 1)); }
  [[ "${drifted:-0}" == 1 ]] && verdict="$verdict, drift"
  met=yes
  [[ "${actual%% *}" == "$intent" ]] || { met="no (wanted $intent)"; intent_missed=$((intent_missed + 1)); }
  # A scenario claiming wait-for-copilot-seconds proves it only when the run that
  # approved had to wait for Copilot's review.
  if jq -e --arg n "$s" '.scenarios[] | select(.name == $n) | .inputs | index("wait-for-copilot-seconds")' \
      "$REAL_MANIFEST" >/dev/null && [[ "${actual%% *}" == approved && "$via" != *waited* ]]; then
    warn "$s: approved, but no approving run waited for Copilot, so wait-for-copilot-seconds was not exercised"
    met="$met; wait not exercised"
  fi
  ROWS[$s]="| $s | $verdict ($((SECONDS - started))s) | $met | ${actual:-none} | ${via:-} |"
done

{
  printf '| Scenario | Result | Intent met | Decision | Run |\n|---|---|---|---|---|\n'
  for s in "${SELECTED[@]}"; do printf '%s\n' "${ROWS[$s]}"; done
  # The approval regexes are only exercised by a review that reached copilot-clean.
  if ! printf '%s\n' "${ROWS[@]}" | grep -q 'approved copilot-clean'; then
    printf '\n**No review reached copilot-clean in this run**, so the approval path was not exercised against real Copilot.\n'
  fi
} | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"

assert_pinned
"$SCRIPT_DIR/sandbox.sh" --real reset

((intent_missed == 0)) || warn "$intent_missed scenario(s) missed their intent; see the table"
((failed == 0)) || fail "$failed of ${#SELECTED[@]} scenarios failed"
ok "all ${#SELECTED[@]} scenarios passed"
