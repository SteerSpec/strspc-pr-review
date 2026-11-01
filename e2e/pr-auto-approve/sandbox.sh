#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Keeps the synthetic-tier sandbox in a known shape, as code.
#
#   sandbox.sh setup        one-time, as a repo admin: bot access and rulesets
#   sandbox.sh sync <sha>   put the action at <sha> under test
#   sandbox.sh reset        close PRs, restore the fixture files, and put develop on main
#   sandbox.sh status       show what is under test
#
# Everything is idempotent, so CI can run `sync` before each suite and a failed
# run leaves nothing for the next one to trip on.
#
# Unlike sandbox-vars.sh, none of this needs admin:org: run.sh sets repo variables
# for each scenario's profile. sandbox-vars.sh stays the test of org precedence.
set -euo pipefail

SCRIPT_DIR="$(cd "${BASH_SOURCE[0]%/*}" && pwd)"
# shellcheck source=e2e/pr-auto-approve/lib.sh
source "$SCRIPT_DIR/lib.sh"

REPO="${E2E_REPO:-${E2E_SANDBOX_REPO:-testbed-multi-org/strspc-pr-review-sandbox}}"
ACTION_REPO="${ACTION_REPO:-SteerSpec/strspc-pr-review}"
BOT_LOGIN="${E2E_APPROVER_LOGIN:-cnslr-bt}"
REVIEWER_LOGIN="${E2E_REVIEWER_LOGIN:-pleberre}"
WORKFLOW=.github/workflows/pr-auto-approve.yml
CI=.github/workflows/ci.yml

# --- setup ------------------------------------------------------------------

# Production's rulesets, so a merge here means what it means there. Prod's
# merge-method rulesets have no bypass; these allow the enterprise owner, because
# `sync` and `reset` commit to main and force-move develop. Scenarios merge as the
# bot, which has no bypass, so a merge they make proves the rules were met.
ruleset() { # name, ref, approvals, merge method(s) as a JSON array
  jq -n --arg name "$1" --arg ref "$2" --argjson count "$3" --argjson methods "$4" '{
    name: $name, target: "branch", enforcement: "active",
    bypass_actors: [{actor_id: null, actor_type: "EnterpriseOwner", bypass_mode: "always"}],
    conditions: {ref_name: {include: [$ref], exclude: []}},
    rules: [{type: "pull_request", parameters: {
      allowed_merge_methods: $methods,
      dismiss_stale_reviews_on_push: ($count > 0),
      require_code_owner_review: false,
      require_last_push_approval: false,
      required_approving_review_count: $count,
      required_review_thread_resolution: ($count > 0)}}]}'
}

# Writes the whole definition either way, so a re-run repairs a ruleset that has
# drifted instead of accepting anything with the right name.
ensure_ruleset() {
  local name="$1" id
  id=$(gh api "repos/$REPO/rulesets" | jq -r --arg n "$name" '.[] | select(.name == $n) | .id')
  if [[ -n "$id" ]]; then
    ruleset "$@" | gh api -X PUT "repos/$REPO/rulesets/$id" --input - >/dev/null
    log "ruleset $name updated"
  else
    ruleset "$@" | gh api -X POST "repos/$REPO/rulesets" --input - >/dev/null
    log "ruleset $name created"
  fi
}

setup() {
  # authorCanPushToRepository is what makes an approval standing, so a read-only
  # bot would make every promotion scenario skip.
  gh api -X PUT "repos/$REPO/collaborators/$BOT_LOGIN" -f permission=push >/dev/null
  log "$BOT_LOGIN has write"
  ensure_ruleset pr-mandatory-main refs/heads/main 1 '["merge"]'
  ensure_ruleset pr-mandatory-develop refs/heads/develop 1 '["squash"]'
}

# --- sync -------------------------------------------------------------------

has_branch() { gh api "repos/$REPO/branches/$1" >/dev/null 2>&1; }

raw() { # repo, path, ref
  gh api "repos/$1/contents/$2?ref=$3" -H 'Accept: application/vnd.github.raw'
}

# The template at $1, pinned to $1, with the two sandbox-only inputs added.
render_caller() {
  raw "$ACTION_REPO" templates/pr-auto-approve.yml "$1" | awk \
    -v sha="$1" -v repo="$ACTION_REPO" -v reviewer="$REVIEWER_LOGIN" -v sandbox="$REPO" '
    $0 == "      - uses: " repo "@v1" { print "      - uses: " repo "@" sha; used = 1; next }
    { print }
    /^          bot-github-token: / {
      print ""
      print "          # Sandbox only: treat the e2e reviewer as Copilot and allow the bot-authored"
      print "          # PRs through the self-approval guard. Never set these in a production caller."
      print "          test-copilot-logins: " reviewer
      print "          sandbox-repos: " sandbox
      added = 1
    }
    END { if (!used || !added) exit 1 }'
}

ci_workflow() {
  cat <<'EOF'
name: CI

# The caller's workflow_run trigger matches this workflow by NAME, so keep it
# literally "CI". It only has to give the e2e harness a check to wait for.
on:
  pull_request:
    branches: [main, develop]

permissions:
  contents: read

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - run: sleep 10
EOF
}

# The smallest config release.js can read. `simple` owns version.txt.
release_config() {
  jq -n '{packages: {".": {"release-type": "simple"}}}'
}

# Commits only a real change, so a sync of the same SHA moves nothing.
put() { # path, content
  local current
  current=$(raw "$REPO" "$1" main 2>/dev/null || true)
  [[ "$current" == "$2" ]] && return 0
  commit_file main "$1" "$2"$'\n' "chore(e2e): sync $1"
  log "updated $1"
}

# A profile unsets a variable by deleting the repo's copy, which would expose an
# org variable of the same name and change what the scenario tests. sandbox-vars.sh
# creates such variables on purpose, so this also catches a run it left behind.
refuse_org_variables() {
  local leaked
  leaked=$(gh api "repos/$REPO/actions/organization-variables" --paginate \
    --jq '.variables[].name | select(startswith("STRSPC_PR_AUTO_APPROVE_"))') \
    || fail "cannot list the org variables visible to $REPO"
  [[ -z "$leaked" ]] || fail "org variables would leak into the profiles: $leaked (run sandbox-vars.sh down)"
}

sync() {
  local sha="${1:?usage: sandbox.sh sync <sha>}" caller
  refuse_org_variables
  reset_prs
  caller=$(render_caller "$sha") || fail "template at $sha lacks the expected uses:/bot-github-token: lines"
  put "$WORKFLOW" "$caller"
  put "$CI" "$(ci_workflow)"
  restore
  gh variable set STRSPC_PR_AUTO_APPROVE_BOT_LOGIN -R "$REPO" --body "$BOT_LOGIN"
  ok "sandbox at $sha"
}

# --- reset ------------------------------------------------------------------

# Only what the harness opens: e2e/ branches, release heads and promotions. Closes
# without deleting branches, because a promotion's head is develop.
reset_prs() {
  local n prefix
  while read -r n; do
    [[ -n "$n" ]] && gh pr close "$n" -R "$REPO" >/dev/null
  done < <(gh pr list -R "$REPO" --state open --limit 100 --json number,headRefName --jq '.[]
    | select(.headRefName == "develop" or (.headRefName | test("^(e2e/|release-please--)")))
    | .number')
  for prefix in e2e/ release-please--; do
    while read -r n; do
      [[ -n "$n" ]] && gh api -X DELETE "repos/$REPO/git/refs/heads/$n" >/dev/null
    done < <(gh api --paginate "repos/$REPO/git/matching-refs/heads/$prefix" \
      --jq '.[].ref | ltrimstr("refs/heads/")')
  done
}

# main only moves forward: the enterprise Compliance ruleset forbids a force-push
# to the default branch, even for its owner. So a scenario's mark on main is put
# right with a new commit, and develop, which can be force-moved, follows it.
restore() {
  local sha
  put release-please-config.json "$(release_config)"
  put .release-please-manifest.json '{".": "0.1.0"}'
  sha=$(gh api "repos/$REPO/git/ref/heads/main" -q .object.sha)
  if has_branch develop; then
    gh api -X PATCH "repos/$REPO/git/refs/heads/develop" -f sha="$sha" -F force=true >/dev/null
  else
    gh api -X POST "repos/$REPO/git/refs" -f ref=refs/heads/develop -f sha="$sha" >/dev/null
  fi
}

ref_or_none() { # a 404's error body goes to stdout, so print only on success
  local out
  out=$(gh api "repos/$REPO/git/ref/$1" -q .object.sha 2>/dev/null) && echo "$out" || echo none
}

status() {
  log "repo: $REPO"
  raw "$REPO" "$WORKFLOW" main | grep -E '^[[:space:]]+- uses: ' | sed 's/^ */    /'
  log "main:     $(ref_or_none heads/main)"
  log "develop:  $(ref_or_none heads/develop)"
  gh variable list -R "$REPO"
}

case "${1:-}" in
  setup) setup ;;
  sync) sync "${2:-}" ;;
  reset) reset_prs; restore ;;
  status) status ;;
  *) fail "usage: $0 setup|sync <sha>|reset|status" ;;
esac
