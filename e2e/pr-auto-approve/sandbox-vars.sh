#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Puts the synthetic-tier sandbox on the variable-driven caller template
# (STRSPC_PR_AUTO_APPROVE_* org + repo variables) so run.sh exercises the
# org/repo precedence, and puts it back afterwards.
#
#   sandbox-vars.sh up       back up the sandbox state, then migrate it
#   sandbox-vars.sh status   show the effective configuration
#   sandbox-vars.sh down     restore everything `up` changed, from the backup
#
# Run it as an org admin of $ORG: org variables need the admin:org scope and
# the workflow file needs the workflow scope:
#   gh auth refresh -h github.com -s admin:org,workflow
#
# What `up` changes (all of it is undone by `down`):
#   org   STRSPC_PR_AUTO_APPROVE_{BOT_LOGIN,BASE_BRANCH,ROUNDS_BY_TYPE,
#         WAIT_FOR_COPILOT_SECONDS}, visible to the sandbox repo ONLY
#   repo  STRSPC_PR_AUTO_APPROVE_ROUNDS_BY_TYPE override; PR_AUTO_APPROVE_BOT_LOGIN
#         removed so the bot login can only come from the new org variable
#   main  .github/workflows/pr-auto-approve.yml regenerated from the template at
#         $ACTION_SHA (pinned there too, since it is unreleased); ci.yml widened
#         to PRs against develop
#   develop branch created, for the base-branch override scenario
#
# The org ROUNDS_BY_TYPE deliberately lacks chore:0 and the repo override adds
# it, so the type-zero scenarios pass only if the repo variable wins.
set -euo pipefail

ORG="${ORG:-testbed-multi-org}"
REPO_NAME="${REPO_NAME:-strspc-pr-review-sandbox}"
REPO="$ORG/$REPO_NAME"
ACTION_REPO="${ACTION_REPO:-SteerSpec/strspc-pr-review}"
# No default: a pinned default went stale here and tested an old build unnoticed.
# Only `up` needs it, so `status` and `down` still work without one.
ACTION_SHA="${ACTION_SHA:-}"
BOT_LOGIN="${BOT_LOGIN:-cnslr-bt}"
REVIEWER_LOGIN="${REVIEWER_LOGIN:-pleberre}"
STATE_DIR="${STATE_DIR:-$HOME/.cache/strspc-e2e/$ORG-$REPO_NAME}"

WORKFLOW=.github/workflows/pr-auto-approve.yml
CI=.github/workflows/ci.yml
P=STRSPC_PR_AUTO_APPROVE_
ORG_VARS="BOT_LOGIN BASE_BRANCH ROUNDS_BY_TYPE WAIT_FOR_COPILOT_SECONDS"
# The only repo variables this script (or its printed matrix) touches. `down`
# restores exactly these, so a variable someone else adds or changes in the
# meantime survives the rollback.
REPO_VARS="${P}ROUNDS_BY_TYPE ${P}BASE_BRANCH PR_AUTO_APPROVE_BOT_LOGIN"

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }

org_value() {
  case "$1" in
    BOT_LOGIN) echo "$BOT_LOGIN" ;;
    BASE_BRANCH) echo main ;;
    ROUNDS_BY_TYPE) echo 'default:3' ;;
    WAIT_FOR_COPILOT_SECONDS) echo 300 ;;
  esac
}

# --- GitHub helpers ---------------------------------------------------------

raw() { gh api "repos/$1/contents/$2?ref=${3:-main}" -H 'Accept: application/vnd.github.raw'; }
blob_sha() { gh api "repos/$REPO/contents/$1?ref=main" --jq .sha; }

put_file() { # path, local file, message
  local b64
  b64=$(openssl base64 -A -in "$2")
  gh api -X PUT "repos/$REPO/contents/$1" -f message="$3" -f content="$b64" \
    -f branch=main -f sha="$(blob_sha "$1")" --jq .commit.sha >/dev/null
}

has_branch() { gh api "repos/$REPO/branches/$1" >/dev/null 2>&1; }

preflight() {
  command -v jq >/dev/null || die "jq is required"
  command -v openssl >/dev/null || die "openssl is required"
  gh api "orgs/$ORG/actions/variables" >/dev/null 2>&1 \
    || die "cannot read $ORG org variables: run 'gh auth refresh -h github.com -s admin:org,workflow' as an org admin"
  gh api "repos/$REPO" >/dev/null || die "no access to $REPO"
}

# --- up ---------------------------------------------------------------------

backup() {
  [[ ! -e "$STATE_DIR" ]] || die "backup already exists at $STATE_DIR (run 'down' first, or remove it)"
  mkdir -p "$STATE_DIR"
  log "backing up to $STATE_DIR"
  raw "$REPO" "$WORKFLOW" >"$STATE_DIR/workflow.yml"
  raw "$REPO" "$CI" >"$STATE_DIR/ci.yml"
  local v
  for v in $REPO_VARS; do
    if ! gh api "repos/$REPO/actions/variables/$v" >"$STATE_DIR/repo-$v.json" 2>/dev/null; then
      rm -f "$STATE_DIR/repo-$v.json"
      touch "$STATE_DIR/repo-$v.absent"
    fi
  done
  for v in $ORG_VARS; do
    if gh api "orgs/$ORG/actions/variables/$P$v" >"$STATE_DIR/org-$v.json" 2>/dev/null; then
      if [[ $(jq -r .visibility "$STATE_DIR/org-$v.json") == selected ]]; then
        # Paginated (30 per page): a truncated list would narrow the variable's
        # access on restore.
        gh api --paginate "orgs/$ORG/actions/variables/$P$v/repositories" \
          --jq '.repositories[].name' | paste -sd, - >"$STATE_DIR/org-$v.repos"
      fi
    else
      rm -f "$STATE_DIR/org-$v.json"
      touch "$STATE_DIR/org-$v.absent"
    fi
  done
  has_branch develop || touch "$STATE_DIR/develop.absent"
}

render_workflow() { # -> stdout
  raw "$ACTION_REPO" templates/pr-auto-approve.yml "$ACTION_SHA" | awk \
    -v sha="$ACTION_SHA" -v repo="$ACTION_REPO" -v reviewer="$REVIEWER_LOGIN" -v sandbox="$REPO" '
    $0 == "      - uses: " repo "@v1" {
      print "      - uses: " repo "@" sha " # unreleased develop build under test"; used = 1; next
    }
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

up() {
  [[ -n "$ACTION_SHA" ]] || die "set ACTION_SHA to the pushed commit to test"
  preflight
  backup

  log "org variables (visibility: selected → $REPO_NAME only)"
  local v
  for v in $ORG_VARS; do
    gh variable set "$P$v" --org "$ORG" --visibility selected --repos "$REPO_NAME" --body "$(org_value "$v")"
    echo "    $P$v=$(org_value "$v")"
  done

  log "repo variables"
  gh variable set "${P}ROUNDS_BY_TYPE" --repo "$REPO" --body 'chore:0,default:3'
  echo "    ${P}ROUNDS_BY_TYPE=chore:0,default:3 (override)"
  if gh variable delete PR_AUTO_APPROVE_BOT_LOGIN --repo "$REPO" 2>/dev/null; then
    echo "    PR_AUTO_APPROVE_BOT_LOGIN deleted"
  fi

  log "caller workflow from $ACTION_REPO@${ACTION_SHA:0:7}"
  render_workflow >"$STATE_DIR/new-workflow.yml" || die "template did not have the expected uses:/bot-github-token: lines"
  if command -v actionlint >/dev/null; then
    actionlint -shellcheck= "$STATE_DIR/new-workflow.yml" || die "rendered workflow fails actionlint"
  fi
  put_file "$WORKFLOW" "$STATE_DIR/new-workflow.yml" "chore(e2e): variable-driven caller at ${ACTION_SHA:0:7}"

  log "ci.yml: run on PRs against main and develop"
  sed 's/^    branches: \[main\]$/    branches: [main, develop]/' "$STATE_DIR/ci.yml" >"$STATE_DIR/new-ci.yml"
  if ! cmp -s "$STATE_DIR/ci.yml" "$STATE_DIR/new-ci.yml"; then
    put_file "$CI" "$STATE_DIR/new-ci.yml" "chore(e2e): run CI on PRs against develop"
  fi

  if [[ -e "$STATE_DIR/develop.absent" ]]; then
    log "creating develop from main"
    gh api -X POST "repos/$REPO/git/refs" -f ref=refs/heads/develop \
      -f sha="$(gh api "repos/$REPO/git/ref/heads/main" --jq .object.sha)" >/dev/null
  fi

  status
  cat <<EOF

Test matrix (run as $REVIEWER_LOGIN, with bash 4+):

  export E2E_REPO=$REPO E2E_REVIEWER_LOGIN=$REVIEWER_LOGIN E2E_APPROVER_LOGIN=$BOT_LOGIN

  1. Org variables reach the action (bot login, base branch main):
       e2e/pr-auto-approve/run.sh
  2. The repo variable beats the org one (org: default:3, repo: chore:0,...):
       e2e/pr-auto-approve/run.sh type-zero-docs type-zero-code
  3. Base branch from a repo override, no branches: filter:
       gh variable set ${P}BASE_BRANCH --repo $REPO --body develop
       E2E_BASE_BRANCH=develop e2e/pr-auto-approve/run.sh copilot-clean
       gh variable delete ${P}BASE_BRANCH --repo $REPO
  4. Whitespace-only base branch still lets main through:
       gh variable set ${P}BASE_BRANCH --repo $REPO --body ' , '
       e2e/pr-auto-approve/run.sh copilot-clean
       gh variable delete ${P}BASE_BRANCH --repo $REPO

Restore with: $0 down
EOF
}

# --- status -----------------------------------------------------------------

status() {
  log "org variables ($ORG)"
  local v out
  for v in $ORG_VARS; do
    # gh api writes a 404's error body to stdout, so capture and print only on success.
    if out=$(gh api "orgs/$ORG/actions/variables/$P$v" --jq '"    \(.name)=\(.value)  [\(.visibility)]"' 2>/dev/null); then
      echo "$out"
    else
      echo "    $P$v (unset)"
    fi
  done
  log "repo variables ($REPO)"
  gh api --paginate "repos/$REPO/actions/variables" --jq '.variables[] | "    \(.name)=\(.value)"'
  log "caller"
  raw "$REPO" "$WORKFLOW" \
    | grep -E '^[[:space:]]+- uses: |vars\.STRSPC_PR_AUTO_APPROVE_BOT_LOGIN|^[[:space:]]+branches:' \
    | sed 's/^ */    /' || true
}

# --- down -------------------------------------------------------------------

down() {
  preflight
  [[ -d "$STATE_DIR" ]] || die "no backup at $STATE_DIR"

  log "restoring caller workflow and ci.yml"
  put_file "$WORKFLOW" "$STATE_DIR/workflow.yml" "chore(e2e): restore caller from before the variable test"
  if ! cmp -s "$STATE_DIR/ci.yml" <(raw "$REPO" "$CI"); then
    put_file "$CI" "$STATE_DIR/ci.yml" "chore(e2e): restore ci.yml"
  fi

  log "restoring org variables"
  local v vis
  for v in $ORG_VARS; do
    if [[ -e "$STATE_DIR/org-$v.absent" ]]; then
      gh variable delete "$P$v" --org "$ORG" 2>/dev/null || true
      echo "    $P$v deleted"
    else
      vis=$(jq -r .visibility "$STATE_DIR/org-$v.json")
      if [[ $vis == selected ]]; then
        gh variable set "$P$v" --org "$ORG" --visibility selected \
          --repos "$(cat "$STATE_DIR/org-$v.repos")" --body "$(jq -r .value "$STATE_DIR/org-$v.json")"
      else
        gh variable set "$P$v" --org "$ORG" --visibility "$vis" --body "$(jq -r .value "$STATE_DIR/org-$v.json")"
      fi
      echo "    $P$v restored"
    fi
  done

  log "restoring repo variables"
  for v in $REPO_VARS; do
    if [[ -e "$STATE_DIR/repo-$v.absent" ]]; then
      gh variable delete "$v" --repo "$REPO" 2>/dev/null && echo "    $v deleted" || true
    else
      gh variable set "$v" --repo "$REPO" --body "$(jq -r .value "$STATE_DIR/repo-$v.json")"
      echo "    $v restored"
    fi
  done

  if [[ -e "$STATE_DIR/develop.absent" ]] && has_branch develop; then
    log "deleting develop"
    gh api -X DELETE "repos/$REPO/git/refs/heads/develop"
  fi

  rm -rf "$STATE_DIR"
  status
}

case "${1:-}" in
  up) up ;;
  status) status ;;
  down) down ;;
  *) die "usage: $0 up|status|down" ;;
esac
