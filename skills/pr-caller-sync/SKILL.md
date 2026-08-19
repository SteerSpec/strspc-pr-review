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
| New input | wire it up if it changes behaviour they need |

## 2. Find the callers

```bash
gh search code "uses: SteerSpec/strspc-pr-review" --json repository,path
```

## 3. Per-repo values that are never copy-paste

The rollout showed these differ per repo and are the usual cause of a caller that does nothing:

- **Default branch** — must agree in three places: `on.pull_request_target.branches`, the `if:`
  `base.ref` check, and the `base-branch` input.
- **Gating workflow names** in `workflow_run.workflows` — use that repo's real workflow `name:`
  values, and list **all** PR-gating workflows. Each fires its own event, and only the last to
  finish will see every other check complete.
- **Public vs private** — `wait-for-copilot-seconds` is free on public repos and billable on
  private ones.
- **Does the repo have PR-time CI at all?** If not, the action can never approve; add a minimal
  check rather than reaching for `allow-no-checks`.

## 4. Non-negotiables in every caller

- **`pull_request_target`, not `pull_request`.** `pull_request` runs the workflow definition from
  the PR head with secrets in scope — a token-exfiltration path. Never add an `actions/checkout`
  step to this workflow; that is the property making `pull_request_target` safe here.
- **Keep the fork guard.** Under `pull_request_target` it is load-bearing, not defensive.
- **`bot-login` as a literal.** An unset variable makes the loop guard `actor != ''` — always true,
  silently disabled.
- **Self-exclusion by job name.** Callers use `github.event.check_run.name != '<job-name>'` to break
  the feedback loop. The template's job is `auto-approve`; renaming the job means updating that
  string too.

## 5. Open the PRs

Updating `.github/workflows/` requires a token with **`workflow` scope**.

Committing via the API avoids cloning each repo:

```bash
gh api repos/{owner}/{repo}/git/refs -f ref="refs/heads/ci/auto-approve" -f sha="<default-branch-sha>"
base64 -i workflow.yml -o workflow.b64
gh api repos/{owner}/{repo}/contents/.github/workflows/auto-approve.yml -X PUT \
  -f message="ci: sync auto-approve caller" -F content=@workflow.b64 -f branch="ci/auto-approve"
```

Run `actionlint` on the file **before** committing — a syntax error lands in a repo whose PRs may
now require an approval the broken workflow can no longer produce.

## 6. Expect the first PR to need a bypass

Under `pull_request_target` the definition comes from the default branch, which doesn't yet contain
the workflow — so the PR that adds it cannot approve itself. Merge it with a bypass, then verify on
the **second** PR.
