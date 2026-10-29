---
name: pr-auto-approve-setup
description: Use when setting up, installing, or configuring the SteerSpec pr-auto-approve action in a repository — including "add auto-approve to this repo", "set up Copilot auto approval", writing or reviewing a caller workflow, or when a freshly added caller workflow never approves anything.
---

# Setting up pr-auto-approve

Wires `SteerSpec/strspc-pr-review@v1` into a repo so Copilot's clean review auto-approves PRs.

Every item below is here because it silently broke something in production. None are style
preferences — a wrong value usually produces **no error at all**, just a PR that never gets approved.

## 1. Check the prerequisites first

These are the three things the action cannot do for you. If any is missing, every run skips.

| Requirement | How to check | Failure mode if wrong |
|---|---|---|
| Copilot automatic code review enabled | Settings → Code review → Copilot, or an org ruleset requesting Copilot | every run: `no Copilot review yet` |
| A bot account that is **not** the PR author, with **write** access | `gh api repos/{owner}/{repo}/collaborators/{bot}/permission` | `PR author is the bot itself`, or the approval doesn't count |
| A PAT **owned by that bot**, with `Pull requests: write` (that alone) | `GH_TOKEN=<value> gh api user --jq .login` | `403`/`422` converted to a clean skip — no red check, easy to miss |

### The PAT is for approving, not for reading

The bot PAT posts the approval and nothing else. Everything the action *reads* — check runs, the
PR, its reviews — goes through the workflow's own `GITHUB_TOKEN`, via the `github-token` input that
defaults to it.

That split is not tidiness. Listing check runs requires the **`Checks`** permission, and
**fine-grained PATs cannot be granted `Checks` at all** — it appears in GitHub's permissions
reference but is not assignable. Check runs are readable without it on public repos and not on
private ones, so a PAT doing the reading works everywhere you are likely to test it and fails
permanently the first time it meets a private repo:

```
evaluation failed: 403 GET /repos/o/r/commits/<sha>/check-runs — Resource not accessible…
```

on a **green** `auto-approve` check, because API errors become a skip. If you are on a version
before this split, the only fixes are a classic PAT with `repo` scope or a GitHub App.

So keep `checks: read` in the caller's job permissions. It is load-bearing, not decorative.

Check the bot's **effective** permission with the `collaborators/.../permission` endpoint. Team
membership listings and the org's base permission can both say something different from what the
account actually has.

## 2. Copy the template, don't hand-roll

```bash
curl -o .github/workflows/auto-approve.yml \
  https://raw.githubusercontent.com/SteerSpec/strspc-pr-review/main/templates/pr-auto-approve.yml
```

The template's comments explain each trap inline — keep them. The only per-repo edit in the file
itself is the `workflow_run.workflows` list (below). Every other setting comes from a variable.

## 2a. Configure through variables, org first

The template reads each input from an Actions variable named `STRSPC_PR_AUTO_APPROVE_<INPUT>`
(`..._BOT_LOGIN`, `..._BASE_BRANCH`, `..._ROUNDS_THRESHOLD`, `..._ROUNDS_BY_TYPE`,
`..._COPILOT_OPTIONAL_PATHS`, `..._ALLOW_NO_CHECKS`, `..._REQUEST_COPILOT_REVIEW`,
`..._WAIT_FOR_COPILOT_SECONDS`, `..._COPILOT_ERROR_RETRIES`, `..._SLACK_CHANNEL`). Set the org-wide policy once, then override
it only in a repo that differs:

```bash
gh variable list --org <org>                       # what the org already provides
gh variable set STRSPC_PR_AUTO_APPROVE_ROUNDS_BY_TYPE --org <org> --visibility all \
  --body 'docs:1,chore:0,default:3'
gh variable set STRSPC_PR_AUTO_APPROVE_BASE_BRANCH --repo <owner>/<repo> --body develop   # override
```

- A repo variable **replaces** the org value whole. To change one `rounds-by-type` entry, write the
  full string.
- Unset means "action default", and so does an org variable whose repository access (`--visibility
  all|private|selected`) does not include this repo. Check access before blaming the action.
- GitHub rejects empty variables, so to restore a default in one repo, set the default value
  explicitly.
- A literal in `with:` still beats both variables, if a repo really needs to pin a value in code.

## 3. The traps, in the order people hit them

### `pull_request_target`, never `pull_request`

`pull_request` runs the workflow definition from the **PR's head commit** with your secrets in
scope, so anyone who can push a branch can edit the workflow in their own PR and exfiltrate the bot
token. `pull_request_target` *"runs in the context of the default branch of the base repository"*,
so the definition is never PR-controlled.

This is only safe because **the action never checks out PR code** — it only calls the GitHub API.
If you add an `actions/checkout` step to this workflow, that reasoning collapses.

It also makes the fork guard (`head.repo.full_name == github.repository`) load-bearing rather than
defensive. Keep it.

### Base branch comes from one variable

`STRSPC_PR_AUTO_APPROVE_BASE_BRANCH` (comma-separated, default `main`) feeds both the job `if:`
pre-filter and the `base-branch` input. The template deliberately has **no `branches:` filter** on
`pull_request_target`: `on:` cannot read variables, so a filter there would be a second copy to keep
in sync. A repo whose default branch is `develop` needs that variable set (at repo level if the org
value is `main`); otherwise every PR is skipped as `PR base ref 'develop' not in [main]`.

### `bot-login` and the loop guard must read the same thing

The `if:` compares `github.actor != <bot login>` to stop the bot's own approval re-triggering the
workflow. The template uses the identical expression in both places:
`vars.STRSPC_PR_AUTO_APPROVE_BOT_LOGIN || vars.PR_AUTO_APPROVE_BOT_LOGIN`. What fails open is a
**mismatch** — a literal in `bot-login` while the guard reads an unset variable becomes
`actor != ''`, always true. If both read the same unset variable, the action fails the job with
`bot-login is empty` before approving anything, so the gap is loud. If you hard-code the login, do
it in both places.

### `workflow_run` is required when CI is GitHub Actions

Actions creates its check runs with `GITHUB_TOKEN`, and `GITHUB_TOKEN`-generated events never start
a workflow run. So `check_run` never fires for your own CI — it only catches third-party app checks.
`workflow_run` is the re-entry point that works.

**List every workflow that gates PRs, not just one.** Each fires its own event, and whichever
finishes *last* is the one that will find all other checks complete. With only one listed, a PR
whose other workflow finishes later is never re-evaluated.

```yaml
workflow_run:
  workflows: ['CI', 'Action Test']   # all PR-gating workflows
  types: [completed]
```

**Read `.github/workflows/` to find them. Do not go by what ran on your PR.** The PR that adds this
caller usually touches only `.github/workflows/`, so any path-filtered workflow stays silent on it —
and a workflow you never saw run is one you will not think to list.

```bash
find .github/workflows -maxdepth 1 \( -name '*.yml' -o -name '*.yaml' \) | while read -r f; do
  grep -q 'pull_request' "$f" && echo "$f — $(grep -m1 '^name:' "$f")"
done
```

Both extensions, because Actions accepts both — matching only `*.yml` would skip a `.yaml`
workflow and produce exactly the omission this section warns about. `find` rather than a shell
glob because an unmatched glob is a hard error in zsh, which is the default shell on macOS.

Open each hit and check its `on:` block: keep the ones triggered by `pull_request` for your base
branch, and discard the `pull_request_target` false positives the grep also matches. Two shapes hide
from a quick scan — the array form (`on: [push, pull_request]`) and path filters, which is the one
that bites. A workflow filtered to `src/**` runs on every real PR and on none of your test ones.

Getting this wrong fails silently and late: the missing workflow finishes last on some future PR,
the re-entry it should have triggered never happens, and that PR sits unapproved with no error and
no red check.

### `wait-for-copilot-seconds` if Copilot reviews your PRs

Copilot cannot re-trigger the workflow at all: its check run is `GITHUB_TOKEN`-created, and any
workflow run Copilot itself triggers is held at `action_required` pending manual approval. So when
Copilot finishes *after* CI — the common ordering — nothing wakes the action and the PR sits
unapproved forever.

```yaml
wait-for-copilot-seconds: '300'
```

Makes the CI-triggered run wait for Copilot instead of skipping: for its check run while that is
the last check outstanding, and, once every check has completed, for the review itself (Copilot
no longer registers a check run on the head SHA). Free on public repos; consumes billable Actions
minutes on private ones, which is why it defaults to `0`.

### The first PR cannot approve itself

Because `pull_request_target` reads the definition from the default branch, the PR that *adds* this
workflow isn't covered by it. Expect to merge that one with an admin bypass or a human approval.
Every PR afterwards is automatic. Verify with the **second** PR, not the first.

### Repos with no PR-time CI

If nothing runs on `pull_request`, the action skips with `no checks on head SHA yet` and can never
approve. Prefer adding a minimal check over setting `allow-no-checks: 'true'` — otherwise the
approval rests on Copilot alone, with no CI evidence behind it.

### Leave `rounds-threshold` at 3

Setting it to `1` makes *every* Copilot review satisfy the threshold immediately, which disables the
clean-review, suppressed-comment and freshness rules entirely. The action degrades to "approve as
soon as Copilot reviewed at all, on whatever commit".

### Different rounds per commit type

`rounds-by-type: 'docs:1,chore:0,fix:3,default:3'` reads the type from the PR title; `0` approves on
green CI without a Copilot review. Any type mapped below the default (`0` included) applies only when
every changed file matches `copilot-optional-paths` (default `**/*.md,docs/**/*.md`); otherwise the PR
gets the default threshold. Keep `edited` in `pull_request_target.types` so retitles
re-evaluate. To stop Copilot reviewing those PRs at all, turn off the ruleset's automatic review and
set `request-copilot-review: 'true'`.

To retry automatically when Copilot's review errors ("unable to review this pull request"), set
`copilot-error-retries: '2'`; the default `0` leaves the re-request to a human.

## 4. Verify

Open a **second** PR and touch nothing:

```bash
gh run list --workflow=auto-approve.yml --limit 5 \
  --json event,status,conclusion,createdAt
gh run view <id> --log | grep 'decision='
```

Success looks like `decision=approved reason=copilot-clean (...)` from a run whose `event` is
`workflow_run` and whose `attempt` is `1`. If you had to re-run anything, it isn't working yet —
see the `pr-auto-approve-diagnose` skill.
