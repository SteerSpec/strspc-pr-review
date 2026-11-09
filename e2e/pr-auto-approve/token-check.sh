#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Checks the tokens a workflow was given, without printing them, against a repo.
#
#   token-check.sh <owner/repo> <ENV_NAME>...
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
#
# Exits 1 when any token is missing or refused. Writes the table to
# $GITHUB_STEP_SUMMARY too when set.
set -uo pipefail

REPO="${1:?usage: token-check.sh <owner/repo> <ENV_NAME>...}"
shift
(($# > 0)) || { echo "usage: token-check.sh <owner/repo> <ENV_NAME>..." >&2; exit 2; }
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
for name in "$@"; do
  value="${!name:-}"
  if [[ -z "$value" ]]; then
    rows+=("| \`$name\` | **missing** | | | | | |")
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
    user="$(jq -r .login "$TMP/body"), expires $(header github-authentication-token-expiration)"
    user="${user%, expires }"
  else
    user="**$s** $(message)"
    rows+=("| \`$name\` | \`$fp\` | $shape | $user | | | |")
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
        rows+=("| \`$name\` | \`$fp\` | $shape | $user | $repo | $read | $write |")
        rows+=("| (stopped) | | | | | | the remaining tokens were not checked |")
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
  rows+=("| \`$name\` | \`$fp\` | $shape | $user | $repo | $read | $write |")
done

{
  echo "Tokens checked against \`$REPO\`:"
  echo
  echo "| Secret | SHA-256 (16) | Shape | GET /user | GET repo | Read PRs | Write probe |"
  echo "|---|---|---|---|---|---|---|"
  printf '%s\n' "${rows[@]}"
} | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"
exit "$failed"
