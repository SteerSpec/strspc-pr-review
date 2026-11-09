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
#   - a write probe on the repo's latest PR: it starts a PENDING review, the same
#     endpoint the approval uses, and deletes it at once. 403 means the token
#     lacks Pull requests: write there; GitHub's x-accepted-github-permissions
#     header then says what it wanted. A 422 also passed the permission check:
#     GitHub only validates the request once the token may make it.
#
# Exits 1 when any token is missing or refused. Writes the table to
# $GITHUB_STEP_SUMMARY too when set.
set -uo pipefail

REPO="${1:?usage: token-check.sh <owner/repo> <ENV_NAME>...}"
shift
(($# > 0)) || { echo "usage: token-check.sh <owner/repo> <ENV_NAME>..." >&2; exit 2; }
API="${GITHUB_API_URL:-https://api.github.com}"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

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
  pr=""
  if [[ "$s" == 200 ]]; then
    pr=$(jq -r '.[0].number // empty' "$TMP/body")
    read="200${pr:+ (latest #$pr)}"
  else
    read="**$s** $(message)"
    failed=1
  fi

  if [[ -z "$pr" ]]; then
    write="not probed: no PR to probe"
  else
    s=$(call "$value" POST "/repos/$REPO/pulls/$pr/reviews" '{"body":"token-check probe, deleted at once"}')
    case "$s" in
      200)
        id=$(jq -r .id "$TMP/body")
        d=$(call "$value" DELETE "/repos/$REPO/pulls/$pr/reviews/$id")
        write="ok (pending review created and deleted: $d)"
        ;;
      422) write="ok (permission passed; 422 $(message))" ;;
      *)
        write="**$s** $(message); wanted: $(header x-accepted-github-permissions)"
        failed=1
        ;;
    esac
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
