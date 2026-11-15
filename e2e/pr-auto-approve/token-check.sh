#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Checks the tokens a workflow was given, without printing them, against a repo.
#
#   token-check.sh <owner/repo> <ENV_NAME>[@login][+actions]...
#
# @login fails the check unless GET /user names that account: a token created
# under the wrong account passes every permission probe and still breaks the
# suite (the e2e harness posts its reviews as the admin token's owner, and the
# bot cannot approve a PR it opened). +actions adds an Actions write probe.
#
# For each named environment variable it reports:
#   - present, length, kind (prefix) and whether the value carries whitespace,
#     the usual trace of a bad paste
#   - a fingerprint: the first 16 hex of the SHA-256 of the exact value. Compare
#     it with the token you meant to store:
#       printf %s "$TOKEN" | shasum -a 256 | cut -c1-16
#   - GET /user: whether GitHub accepts it, as whom, and its expiry
#   - GET the repo and its pulls: whether it reaches the repo and can read PRs
#   - a write probe. On an open PR it starts a PENDING review, the endpoint the
#     approval uses, and deletes it at once. With no open PR it sends a no-op
#     PATCH of the latest PR, which needs the same Pull requests: write. On a
#     refusal, GitHub's x-accepted-github-permissions header says what it wanted.
#     Any answer but success fails the check, a 422 included.
#   - with +actions, an Actions write probe: a workflow_dispatch of
#     $TOKEN_CHECK_WORKFLOW (default pr-auto-approve.yml) on a ref that does not
#     exist. GitHub checks the permission first, so its "No ref found" 422
#     means the token may start workflows and nothing ran; a 403 means it may
#     not. Any other 422 fails: it says nothing about the permission.
#
# Exits 1 when any token is missing or refused. Writes the table to
# $GITHUB_STEP_SUMMARY too when set.
set -uo pipefail

USAGE="usage: token-check.sh <owner/repo> <ENV_NAME>[@login][+actions]..."
REPO="${1:?$USAGE}"
shift
(($# > 0)) || { echo "$USAGE" >&2; exit 2; }
WORKFLOW="${TOKEN_CHECK_WORKFLOW:-pr-auto-approve.yml}"
# A ref no branch or tag can have: git refuses '..' in a ref name.
NO_REF="token-check..no-such-ref"
API="${GITHUB_API_URL:-https://api.github.com}"
TMP=$(mktemp -d)
# A probe review still standing when the script ends, by cancellation or any
# other exit, is deleted here, so a cancelled run leaves nothing on the PR.
PROBE_TOKEN="" PROBE_PATH=""
# shellcheck disable=SC2329  # invoked by the trap
cleanup() {
  if [[ -n "$PROBE_PATH" ]]; then
    call "$PROBE_TOKEN" DELETE "$PROBE_PATH" >/dev/null || true
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# One request with the token in a curl config on stdin, never in argv.
# Prints the status; the body lands in $TMP/body, the headers in $TMP/headers.
call() { # token, method, path, [json body]
  local data=()
  [[ -n "${4:-}" ]] && data=(--data "$4")
  printf 'header = "Authorization: Bearer %s"\n' "$1" |
    curl -sS -K - -X "$2" ${data[@]+"${data[@]}"} \
      -H 'Accept: application/vnd.github+json' -H 'X-GitHub-Api-Version: 2022-11-28' \
      -D "$TMP/headers" -o "$TMP/body" -w '%{http_code}' "$API$3" 2>/dev/null || echo 000
}
header() { tr -d '\r' <"$TMP/headers" | awk -v h="$1" 'tolower($0) ~ "^" h ":" { sub(/^[^:]*: */, ""); print }' | tail -1; }
message() { jq -r '.message // empty' "$TMP/body" 2>/dev/null | head -c 120; }

kind() {
  case "$1" in
    github_pat_*) echo fine-grained ;;
    ghp_*) echo classic ;;
    ghs_*) echo app-installation ;;
    gho_*) echo oauth ;;
    *) echo unknown ;;
  esac
}

failed=0
rows=()
for spec in "$@"; do
  actions=""
  [[ "$spec" == *+actions ]] && { actions=1; spec="${spec%+actions}"; }
  name="${spec%%@*}" want=""
  [[ "$spec" == *@* ]] && want="${spec#*@}"
  [[ "$name" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || { echo "bad spec '$spec'; $USAGE" >&2; exit 2; }
  value="${!name:-}"
  if [[ -z "$value" ]]; then
    rows+=("| \`$name\` | **missing** | | | | | | |")
    failed=1
    continue
  fi
  fp=$(printf %s "$value" | sha256sum | cut -c1-16)
  shape="$(kind "$value"), ${#value} chars"
  if [[ "$value" =~ [[:space:]] ]]; then
    shape="$shape, **contains whitespace**"
    failed=1
  fi

  s=$(call "$value" GET /user)
  if [[ "$s" == 200 ]]; then
    login=$(jq -r .login "$TMP/body")
    user="$login, expires $(header github-authentication-token-expiration)"
    user="${user%, expires }"
    if [[ -n "$want" && "${login,,}" != "${want,,}" ]]; then
      user="**$login, not $want**"
      failed=1
    fi
  else
    user="**$s** $(message)"
    rows+=("| \`$name\` | \`$fp\` | $shape | $user | | | | |")
    failed=1
    continue
  fi

  s=$(call "$value" GET "/repos/$REPO")
  repo="$s"
  [[ "$s" == 200 ]] || { repo="**$s** $(message)"; failed=1; }

  s=$(call "$value" GET "/repos/$REPO/pulls?state=all&per_page=1")
  latest=""
  if [[ "$s" == 200 ]]; then
    latest=$(jq -r '.[0].number // empty' "$TMP/body")
    read="200${latest:+ (latest #$latest)}"
  else
    read="**$s** $(message)"
    failed=1
  fi

  # The review probe needs an OPEN PR: GitHub refuses a review on a closed one
  # with a 422, which would say nothing about the token. Without one, a no-op
  # PATCH of the latest PR asks for the same permission and changes nothing.
  open=""
  s=$(call "$value" GET "/repos/$REPO/pulls?state=open&per_page=1")
  [[ "$s" == 200 ]] && open=$(jq -r '.[0].number // empty' "$TMP/body")
  if [[ -n "$open" ]]; then
    s=$(call "$value" POST "/repos/$REPO/pulls/$open/reviews" '{"body":"token-check probe, deleted at once"}')
    if [[ "$s" == 200 ]]; then
      id=$(jq -r .id "$TMP/body")
      PROBE_TOKEN="$value" PROBE_PATH="/repos/$REPO/pulls/$open/reviews/$id"
      # Forget the probe only once it is gone: until then the EXIT trap retries it.
      for wait in 0 2 5; do
        sleep "$wait"
        d=$(call "$value" DELETE "$PROBE_PATH")
        [[ "$d" == 2?? ]] && break
      done
      if [[ "$d" == 2?? ]]; then
        PROBE_TOKEN="" PROBE_PATH=""
        write="ok (pending review on #$open created and deleted)"
      else
        write="ok, but **cleanup failed**: DELETE $d $(message); remove pending review $id on #$open"
        failed=1
        # Probing another token would overwrite the only record of this review.
        rows+=("| \`$name\` | \`$fp\` | $shape | $user | $repo | $read | $write | |")
        rows+=("| (stopped) | | | | | | the remaining tokens were not checked | |")
        break
      fi
    else
      write="**$s** $(message); wanted: $(header x-accepted-github-permissions)"
      failed=1
    fi
  elif [[ -n "$latest" ]]; then
    s=$(call "$value" PATCH "/repos/$REPO/pulls/$latest" '{}')
    if [[ "$s" == 200 ]]; then
      write="ok (no open PR: no-op PATCH of #$latest)"
    else
      write="**$s** $(message); wanted: $(header x-accepted-github-permissions)"
      failed=1
    fi
  else
    write="**not probed**: the repo has no PR"
    failed=1
  fi

  act=""
  if [[ -n "$actions" ]]; then
    s=$(call "$value" POST "/repos/$REPO/actions/workflows/$WORKFLOW/dispatches" "$(jq -nc --arg r "$NO_REF" '{ref: $r}')")
    # Only the ref's own refusal proves the permission: a malformed body is a 422 too.
    [[ "$s" == 422 && "$(message)" != "No ref found for: $NO_REF" ]] && s="422-other"
    case "$s" in
      422) act="ok (dispatch of $WORKFLOW refused only for its ref)" ;;
      422-other) act="**422** $(message)"; failed=1 ;;
      403) act="**403** $(message); wanted: $(header x-accepted-github-permissions)"; failed=1 ;;
      404) act="**404** $(message): no $WORKFLOW, or no access"; failed=1 ;;
      *) act="**$s** $(message)"; failed=1 ;;
    esac
  fi
  rows+=("| \`$name\` | \`$fp\` | $shape | $user | $repo | $read | $write | $act |")
done

{
  echo "Tokens checked against \`$REPO\`:"
  echo
  echo "| Secret | SHA-256 (16) | Shape | GET /user | GET repo | Read PRs | Write probe | Actions write |"
  echo "|---|---|---|---|---|---|---|---|"
  printf '%s\n' "${rows[@]}"
} | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"
exit "$failed"
