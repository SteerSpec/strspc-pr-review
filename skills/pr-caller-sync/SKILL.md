---
name: pr-caller-sync
description: Use when the pr-auto-approve action changes and caller repos must be updated to match — adding or removing event triggers, changing the job if: condition or concurrency group, adding an input callers should set, or any structural change callers have to mirror. Also use when rolling the action out to a new repo.
---

# Keeping caller workflows in sync

`strspc-pr-review` hosts the composite action (`action.yml`). Caller repos each have their own
workflow invoking it via `uses: SteerSpec/strspc-pr-review@v1`. The caller owns the triggers, the
`if:` guards and the concurrency group — so an action change often needs a matching caller change,
and a caller that isn't updated simply never forwards the new event.

## 1. See what changed

```bash
git diff main -- action.yml
cat templates/pr-auto-approve.yml   # the current recommended shape
```

| Action change | Caller must update |
|---|---|
| New event needed | add to `on:` |
| New `if:` branch | add the matching `||` branch |
| New concurrency fallback | update the group expression |
| New input | wire it to `vars.STRSPC_PR_AUTO_APPROVE_<INPUT>` like the others in the template |

## 2. Find the callers

```bash
gh search code "uses: SteerSpec/strspc-pr-review" --json repository,path
```

**Migrating a caller to variables** (template shape with `STRSPC_PR_AUTO_APPROVE_*`): sync only
once the release that introduced it is on `@v1` — an older action posts Slack messages to an empty
channel and does not enforce the base branch on PR events, which the new template relies on. It is a
one-time sync per repo; after it, policy changes are variable edits and need no PR. Before opening
the sync PR, translate the caller's current literals into variables — org-level when most repos
share the value, repo-level otherwise — or the synced caller silently falls back to the action's
defaults (`base-branch` = `main`, no `rounds-by-type`, `wait-for-copilot-seconds` = 0):

```bash
gh variable list --org <org>
gh variable list --repo <owner>/<repo>
gh variable set STRSPC_PR_AUTO_APPROVE_BASE_BRANCH --repo <owner>/<repo> --body develop
```

## 3. Per-repo values that are never copy-paste

The rollout showed these differ per repo and are the usual cause of a caller that does nothing:

- **Default branch** — set `STRSPC_PR_AUTO_APPROVE_BASE_BRANCH` (repo or org). The template has no
  `branches:` filter; the variable feeds both the `if:` pre-filter and the `base-branch` input.
- **Gating workflow names** in `workflow_run.workflows` — use that repo's real workflow `name:`
  values, and list **all** PR-gating workflows. Each fires its own event, and only the last to
  finish will see every other check complete.
- **Bot token secret name** — the template reads `secrets.BOT_GITHUB_TOKEN`; keep whatever name
  the repo already uses (SteerSpec callers use `secrets.BOT_TOKEN`). A wrong name reaches the
  action as an empty token.
- **Public vs private** — `wait-for-copilot-seconds` is free on public repos and billable on
  private ones.
- **Does the repo have PR-time CI at all?** If not, the action can never approve; add a minimal
  check rather than reaching for `allow-no-checks`.

## 4. Non-negotiables in every caller

- **`pull_request_target`, not `pull_request`.** `pull_request` runs the workflow definition from
  the PR head with secrets in scope — a token-exfiltration path. Never add an `actions/checkout`
  step to this workflow; that is the property making `pull_request_target` safe here.
- **Keep the fork guard.** Under `pull_request_target` it is load-bearing, not defensive.
- **`bot-login` and the loop guard read the same expression.** A literal in one and an unset
  variable in the other makes the guard `actor != ''` — always true, silently disabled.
- **Self-exclusion by job name.** Callers use `github.event.check_run.name != '<job-name>'` to break
  the feedback loop. The template's job is `auto-approve`; renaming the job means updating that
  string too.

## 5. Open the PRs

Updating `.github/workflows/` requires a token with **`workflow` scope**.

Committing via the API avoids cloning each repo. Use GraphQL `createCommitOnBranch`, not the REST
contents API: GitHub signs the former, while a contents-API commit made with a user token is
unsigned and cannot merge into a branch whose ruleset has `required_signatures`.

```bash
base=$(gh api repos/{owner}/{repo}/git/ref/heads/<default-branch> --jq .object.sha)
gh api repos/{owner}/{repo}/git/refs -f ref="refs/heads/ci/auto-approve" -f sha="$base"

# openssl, not base64: `base64 -i/-o` is BSD/macOS-only — on GNU coreutils `-i`
# means "ignore garbage" and `-o` is not a flag at all. `-A` keeps it on one line.
openssl base64 -A -in workflow.yml -out workflow.b64

jq -n --arg head "$base" --rawfile c workflow.b64 '{
  query: "mutation($i: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $i) { commit { oid } } }",
  variables: {i: {
    branch: {repositoryNameWithOwner: "{owner}/{repo}", branchName: "ci/auto-approve"},
    message: {headline: "ci: sync auto-approve caller"}, expectedHeadOid: $head,
    fileChanges: {additions: [{path: ".github/workflows/auto-approve.yml", contents: $c}]}}}}' \
  | gh api graphql --input -
```

Run `actionlint` on the file **before** committing — a syntax error lands in a repo whose PRs may
now require an approval the broken workflow can no longer produce.

## 6. Expect the first PR to need a bypass

Under `pull_request_target` the definition comes from the default branch, which doesn't yet contain
the workflow — so the PR that adds it cannot approve itself. Merge it with a bypass, then verify on
the **second** PR.
