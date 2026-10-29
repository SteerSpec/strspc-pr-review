# PR Auto-Approve (Copilot)

> Merge faster. Let Copilot drive.

[![GitHub Marketplace](https://img.shields.io/badge/Marketplace-PR%20Auto--Approve-blue?logo=github)](https://github.com/marketplace/actions/pr-auto-approve-copilot)
[![CI](https://github.com/SteerSpec/strspc-pr-review/actions/workflows/test-pr-auto-approve.yml/badge.svg)](https://github.com/SteerSpec/strspc-pr-review/actions/workflows/test-pr-auto-approve.yml)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-green.svg)](.nvmrc)

A GitHub Action that automatically approves pull requests once GitHub Copilot signals the code is ready — no human click required for the rubber-stamp.

---

## Why

Requiring an approving review on every PR is good policy. The trouble is that a lot of PRs have
nobody meaningful to ask.

A Dependabot bump. A one-line docs fix in an internal tooling repo. Any PR at all in a repository
with one maintainer, who cannot approve their own work because GitHub blocks self-approval. In each
case the rule is doing its job — nothing merges unreviewed — while the review itself is a click
somebody performs without reading, or worse, a PR that sits for days waiting for one.

This action fills that review slot with something that actually looked at the diff: it approves as
`bot-login` once **CI is green and Copilot's review is clean**, and refuses otherwise.

**Where it earns its place**

- **Bot PRs** — Dependabot, Renovate, release automation. High volume, low judgement, and the thing
  most likely to make a required-review rule feel like tax.
- **Solo-maintained repos** where a ruleset requires a review nobody is available to give.
- **Internal repos** where the review requirement is org policy rather than a genuine second pair of
  eyes.

**Where it does not belong**

This rubber-stamps *Copilot's* verdict, and Copilot is not a reviewer for anything that matters.
Keep `CODEOWNERS` and required human reviewers on sensitive paths — the bot's approval fills a slot,
it should not be your only gate. The rounds-threshold escape hatch below is deliberately blunt, and
worth understanding before you rely on it.

The reason to trust it with the cases above is that it is specific about when it **won't** approve —
stale reviews, findings Copilot hid from the inline comments, a failing check, a changed commit.
Those rules are next.

---

## How it works

When a PR opens, the action requests `bot-login` as a reviewer and lets GitHub Copilot's automatic review run. On every relevant event afterward — new commits, a submitted Copilot review, or a completed CI check — it re-evaluates:

```
All CI checks passed?  ──No──▶  skip
        │
       Yes
        │
Copilot reviewed?  ──No──▶  skip
        │
       Yes
        ├── Latest review clean AND fresh?  ──Yes──▶  approve ✓
        │   (0 inline comments, no suppressed
        │    comments, reviewed the current commit)
        │
        └── ≥ N rounds of Copilot review?  ──Yes──▶  approve ✓
                                                      (default N = 3)
```

A review is only "clean" when Copilot left no inline comments **and** its body carries no suppressed-comments block. Copilot's summary can read as clean while findings sit in a collapsed block, and those comments are absent from the review-comments API — so a body scan is the only way to see them.

GitHub has changed that block's wording at least once (`Comments suppressed due to low confidence (N)` became `Suppressed comments (N)`), so the action matches both. Treat the markup as unstable rather than as a contract.

The review must also name the **current head commit**. A push dismisses the bot's approval under branch protection, but leaves Copilot's `COMMENTED` review in place — those aren't dismissed — so without this check the new commit would inherit a verdict on the old one. A review that carries no commit at all can't prove freshness either, and is treated the same way.

The rounds threshold is unaffected by both rules: it remains an unconditional escape hatch, so neither a suppressed block that never clears nor a missing re-review can wedge a PR forever.

> **Configuration tradeoff.** That escape hatch is what `rounds-threshold` tunes, so setting it to `1` makes *every* Copilot review satisfy it immediately — the clean, suppressed-comment, and freshness rules are then never evaluated, and the action degrades to "approve as soon as Copilot has reviewed at all, on whatever commit". Keep it at 2 or higher unless that is genuinely what you want.

Only PRs targeting the configured base branch(es) are eligible; draft PRs, fork PRs, and PRs the bot itself authored are skipped. The base-branch, draft, and fork gates are enforced by the caller workflow's `if:` (see [Usage](#usage)) for `pull_request_target`/`pull_request_review` events, and re-applied by the action itself when it re-hydrates a PR from a `check_run`/`workflow_run` event — so if you write your own caller `if:` instead of the template, keep those conditions. The bot never approves its own PR (except in test `sandbox-repos`). `CHANGES_REQUESTED` always blocks, regardless of round count. Approvals are idempotent and bound to the head commit — once the bot holds an `APPROVED` review for the current SHA the action exits cleanly, and a new push re-triggers evaluation.

Every run records a one-line `reason` (also exposed as the [`reason` output](#outputs)) explaining what it did — see [Troubleshooting](#troubleshooting).

---

## Prerequisites

Before the action can approve anything, three things must be in place:

- **GitHub Copilot code review, set to review PRs automatically** for the repo (or org). The action reads Copilot's verdict — it does *not* trigger Copilot itself, so if Copilot never reviews, every run simply skips with `no Copilot review yet`. Enable it under **Settings → Code review → Copilot** (or an org/repo ruleset that requests Copilot on PRs).
- **A dedicated bot GitHub account** — *not* your own. GitHub blocks self-approval, so the account that posts the approval must differ from PR authors. Add it to the repo as a **collaborator with write access**. Its login is what you pass as `bot-login`.
- **A fine-grained Personal Access Token for that bot account**, stored as the `BOT_GITHUB_TOKEN` secret. It needs **`Pull requests: write` and nothing else** — it is used for exactly one call, posting the approval, which has to come from an account that isn't the PR author. (`Pull requests: write` is a *fine-grained* permission; the classic-PAT equivalent is `repo`, which also works but grants far more than this action can use.)

Everything the action *reads* — check runs, the PR, its reviews — goes through the workflow's own `GITHUB_TOKEN` instead, via the [`github-token`](#inputs) input that defaults to it. That split is not tidiness: listing check runs needs the **`Checks`** permission, and fine-grained PATs cannot be granted it at all. A PAT doing the reading therefore works on public repositories, where check runs are readable without it, and fails with `403` **forever** on private ones. See [Usage](#usage) for the full explanation, and keep `checks: read` in your caller's job permissions.

You don't install anything on your side — the action runs on `github-script` (Node) inside the Action itself.

---

## Quick start

**1. Copy the workflow template**

```bash
curl -o .github/workflows/pr-auto-approve.yml \
  https://raw.githubusercontent.com/SteerSpec/strspc-pr-review/main/templates/pr-auto-approve.yml
```

**2. Set a repository variable**

```
PR_AUTO_APPROVE_BOT_LOGIN = <your-bot-account-login>
```

**3. Add a repository secret**

```
BOT_GITHUB_TOKEN = <PAT for the bot — `Pull requests: write` is all it needs>
```

**4. Optional: Slack notifications**

```
SLACK_BOT_TOKEN = <xoxb-... token with chat:write scope>
```

Open a PR targeting your base branch — Copilot drives the approval from here.

---

## Usage

The caller workflow snippet (from [`templates/pr-auto-approve.yml`](templates/pr-auto-approve.yml)):

```yaml
on:
  pull_request_target:   # NOT pull_request — see the security note below
    branches: [main]
    types: [opened, ready_for_review, synchronize, reopened, edited]
  pull_request_review:
    types: [submitted]
  check_run:            # third-party app checks only — see the note below
    types: [completed]
  workflow_run:         # required if your CI is GitHub Actions
    workflows: ['CI']
    types: [completed]

jobs:
  auto-approve:
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write
      contents: read
      checks: read
    concurrency:
      group: >-
        pr-auto-approve-${{ github.repository }}-${{
          github.event.pull_request.number ||
          github.event.check_run.pull_requests[0].number ||
          github.event.workflow_run.pull_requests[0].number ||
          github.run_id
        }}
      cancel-in-progress: true
    if: >-
      (
        (
          github.event_name == 'pull_request_target' ||
          (
            github.event_name == 'pull_request_review' &&
            github.actor != vars.PR_AUTO_APPROVE_BOT_LOGIN
          )
        ) &&
        github.event.pull_request.base.ref == 'main' &&
        github.event.pull_request.draft == false &&
        github.event.pull_request.head.repo.full_name == github.repository
      ) || (
        github.event_name == 'check_run' &&
        github.event.check_run.name != 'auto-approve' &&
        github.event.check_run.pull_requests[0] != null
      ) || (
        github.event_name == 'workflow_run' &&
        github.event.workflow_run.conclusion == 'success' &&
        github.event.workflow_run.head_repository.full_name == github.repository &&
        github.event.workflow_run.pull_requests[0] != null
      )
    steps:
      - uses: SteerSpec/strspc-pr-review@v1
        with:
          bot-login: ${{ vars.PR_AUTO_APPROVE_BOT_LOGIN }}
          bot-github-token: ${{ secrets.BOT_GITHUB_TOKEN }}
          # slack-bot-token: ${{ secrets.SLACK_BOT_TOKEN }}
```

**Base branches.** `base-branch` accepts a single branch or a comma-separated set
(e.g. `develop,main`; whitespace-only falls back to `main`). It gates **3 points that
must list the same branches**: the `on.pull_request_target.branches:` filter, the job `if:`
`base.ref` check, and the `base-branch` input. For multiple branches, set
`branches: [main, develop]` and change the `base.ref` line to
`contains(fromJSON('["main","develop"]'), github.event.pull_request.base.ref)`.

**Why `pull_request_target` and not `pull_request`.** This workflow holds a bot PAT.
For a **same-repo** PR, the `pull_request` event runs the workflow definition from the
PR's **head commit** with your secrets in scope — so anyone who can push a branch
could edit the workflow in their own PR and exfiltrate the token. That token can
approve PRs, so leaking it means self-approving arbitrary changes.
`pull_request_target` instead *"runs in the context of the **default branch of the
base repository**"*, so the definition is never PR-controlled. Note it is the
**default** branch, not the PR's base branch — those differ whenever a PR targets a
non-default branch.

The usual `pull_request_target` warning is about checking out and executing PR code
with secrets in scope. This action never checks anything out — it only calls the
GitHub API — which is what makes the swap safe here. **If you add a checkout step,
that reasoning no longer holds.**

Two consequences worth knowing:

- The **fork guard** (`head.repo.full_name == github.repository`) becomes load-bearing
  rather than defensive, since `pull_request_target` would otherwise run with secrets
  for a fork-associated PR. Keep it.
- The **bootstrap PR cannot approve itself.** The definition comes from the base
  branch, which doesn't have the workflow yet, so the PR that *adds* this file needs a
  human approval or an admin bypass. Every PR after it is handled automatically.

`pull_request_review` needs no such change: it *"will only trigger a workflow run if the
workflow file exists on the default branch"*, so its definition is not PR-controlled
either. Note that its `GITHUB_REF` is still the PR **merge ref** — so a `checkout` step
in that job would pull PR code with secrets in scope, which is another reason not to add
one.

**If your CI is GitHub Actions, you need the `workflow_run` trigger.** `check_run`
alone is not enough, and the failure is silent. GitHub Actions creates its check
runs with `GITHUB_TOKEN`, and events generated by `GITHUB_TOKEN` never start a new
workflow run — that's GitHub's recursion guard. So `check_run: completed` never
fires for your own Actions jobs; it only catches checks posted by third-party apps.

Why that matters: if Copilot's review lands **before** CI finishes, the
review-triggered run skips with `check still running`, and nothing re-evaluates the
PR afterwards. It sits unapproved with no error anywhere. The `workflow_run`
trigger supplies the missing "CI is green now" signal.

Set `workflows:` to the `name:` of **every** workflow that gates PRs, not just the
obvious one — whichever finishes last is the run that sees all other checks
complete, so one left out is a PR that never gets re-evaluated. Find them by
reading `.github/workflows/`, not by watching what ran on the PR that adds this
file: that PR usually touches only `.github/workflows/`, so a path-filtered
workflow stays silent on it and looks like it doesn't exist. Watch for the array
form (`on: [push, pull_request]`) too. The
[`pr-auto-approve-setup`](skills/pr-auto-approve-setup/SKILL.md) skill has the
enumeration command.

**`checks: read` in the caller's job permissions is load-bearing** (`pull-requests: write`,
`checks: read` and `contents: read` are all the action asks of that token; `contents: read` is for
the commit comparison that lists a PR's changed files when `rounds-by-type` relaxes its type). The
action reads check runs with the workflow's `GITHUB_TOKEN` (the `github-token` input, default
`${{ github.token }}`); only the approval itself is posted with `bot-github-token`. That split exists because listing check runs
requires the `Checks` permission, which fine-grained PATs cannot be granted — so a PAT doing the
reading works on public repos and fails with `403` forever on private ones. The bot PAT therefore
needs only `Pull requests: write`.

Keep both the `workflow_run` branch in the job `if:` and
`github.event.workflow_run.pull_requests[0].number ||` in the concurrency group —
[`templates/pr-auto-approve.yml`](templates/pr-auto-approve.yml) ships all three
wired up. The `if:` branch's `pull_requests[0] != null` check matters: `workflow_run`
fires for every completed run of the named workflow, including non-PR runs (e.g. a
push to main), which have an empty `pull_requests` array — without the guard those
trigger a wasted job run and a noisy "skipped" Slack notification.

### Copilot cannot re-trigger the workflow

`workflow_run` fixes the case where Copilot reviews **before** CI. The mirror case —
Copilot reviewing **after** CI, which is the common one — cannot be fixed with a
trigger at all, because every signal Copilot could send is suppressed:

| Signal | Why it never runs the job |
|---|---|
| `check_run` | Copilot's check run is created with `GITHUB_TOKEN` (recursion guard) |
| `pull_request_review` | The run **is** created, then held at `action_required` pending manual approval |
| `workflow_run` from Copilot's own review workflow | Same actor, so same approval gate |

That second row is a GitHub behaviour change, not a configuration mistake. In our own
repo the identical workflow, event and actor executed normally on 2026-07-25 and was
gated on 2026-08-18, with no enterprise policy, no enabled org Actions policy, and an
unchanged fork-PR approval tier. Copilot has no org membership, and GitHub offers no
way to grant it any.

So the wait has to happen inside a run that a non-gated actor started. Set
`wait-for-copilot-seconds` and the run triggered by **CI completing** will poll until
Copilot's check finishes rather than skipping with `check still running`:

```yaml
      - uses: SteerSpec/strspc-pr-review@v1
        with:
          bot-login: ${{ vars.PR_AUTO_APPROVE_BOT_LOGIN }}
          bot-github-token: ${{ secrets.BOT_GITHUB_TOKEN }}
          wait-for-copilot-seconds: '300'
```

Since 2026-10 Copilot no longer registers a check run on the head SHA at all: it
posts its review from its own workflow. The same budget therefore also polls the
PR's reviews until Copilot has reviewed the current head (or enough rounds exist for
`rounds-threshold`), so a run that starts seconds before the review lands waits for
it instead of skipping with `no Copilot review yet`. After a wait the check runs are
fetched again and the CI gates re-applied, so a rerun or a late check still blocks.

It is opt-in (`0` by default) because waiting consumes billable Actions minutes on
private repos — it is free on public ones. Copilot typically reports within ~3
minutes, so `300` leaves headroom. Both waits are deliberately narrow. The check-run
wait only runs while Copilot's check is the **last** one outstanding, so an unrelated
slow or hung job can never consume the timeout. The review wait only starts once every
check has completed, and it ends as soon as Copilot has reviewed the current head. On
expiry the action skips as before, having logged a warning. A Copilot check that
finishes red is still caught by the normal failing-check gate, and the gates are
re-applied after the review wait.

---

## Claude Code skills

If you use [Claude Code](https://claude.com/claude-code), this repo ships skills that automate the
setup and the debugging:

```
/plugin marketplace add SteerSpec/.claude
/plugin install strspc-pr-review-skills@steerspec
```

Both lines are needed: adding the marketplace registers it, and the skills live in their own
cross-linked plugin resolved from this repository at its release tag.

| Skill | Use it when |
|---|---|
| `pr-auto-approve-setup` | Adding the action to a repo — walks the prerequisites and the traps below |
| `pr-auto-approve-diagnose` | A PR isn't being approved and you need the `reason` behind it |
| `pr-caller-sync` | The action changed and caller repos need matching updates |

The skills live in [`skills/`](skills/) in this repository and are pinned by release tag in the
marketplace, so an installed skill always matches a released version of the action rather than
describing behaviour that hasn't shipped.

They're a convenience, not a requirement — everything they do is documented on this page.

---

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `bot-login` | **Yes** | — | GitHub login of the bot that posts the approval |
| `bot-github-token` | **Yes** | — | PAT for `bot-login`, used for one call: posting the approval. Needs `Pull requests: write` only |
| `github-token` | No | `${{ github.token }}` | Token used for every **read** (check runs, PR, reviews). The default is what makes this work on private repos — see [Prerequisites](#prerequisites) |
| `base-branch` | No | `main` | Base branch(es) PRs must target; a single branch or a comma-separated set (e.g. `develop,main`) |
| `rounds-threshold` | No | `3` | Copilot review rounds before approving regardless of inline comments |
| `rounds-by-type` | No | `''` | Per-Conventional-Commit-type rounds read from the PR title, e.g. `docs:1,chore:0,fix:3,default:3`. `0` means Copilot is not required for that type (approve on green CI). A type below the default only applies when every changed file matches `copilot-optional-paths`. Empty uses `rounds-threshold` for all PRs. See [Per-type rounds](#per-type-rounds) |
| `copilot-optional-paths` | No | `**/*.md,docs/**/*.md` | Globs; a type mapped below the default (`0` included) only applies when every changed file matches, otherwise the PR uses the default (`default` entry, else `rounds-threshold`). Stops a code change from borrowing a relaxed title |
| `request-copilot-review` | No | `false` | When `true`, the action requests the Copilot review itself and skips types set to `0` in `rounds-by-type`. Turn off the ruleset's automatic Copilot review first. Failures only warn |
| `copilot-error-retries` | No | `0` | Times to re-request Copilot's review on the same commit when its review errored ("unable to review this pull request"). Errored reviews never approve or count as rounds. `0` disables; failures only warn |
| `allow-no-checks` | No | `false` | When `true`, skip the "all checks must pass" gate when no external CI check runs exist for the head SHA (e.g. docs-only PRs) |
| `wait-for-copilot-seconds` | No | `0` | Seconds to wait for Copilot's review (its check run when it is the **last** check still running, or the review itself when no check run exists) instead of skipping. See [Copilot cannot re-trigger the workflow](#copilot-cannot-re-trigger-the-workflow). `0` disables |
| `sandbox-repos` | No | `''` | Comma-separated `owner/repo` list where bot-authored PRs are allowed (e2e only) |
| `test-copilot-logins` | No | `''` | Extra logins treated as Copilot in sandbox repos (e2e only) |
| `slack-channel` | No | `alert-pr-notifications` | Slack channel for notifications |
| `slack-bot-token` | No | `''` | Slack bot token (`xoxb-...`) with `chat:write` scope |

## Outputs

| Output | Description |
|---|---|
| `decision` | `approved`, `skip`, or `error` |
| `reason` | Human-readable explanation |

---

## Per-type rounds

`rounds-by-type` reads the Conventional Commit type from the **PR title** (the squash-merge title
release-please sees), so `docs` can need 1 round while `fix` needs 3:

```yaml
rounds-by-type: 'docs:1,chore:0,fix:3,default:3'
```

- `0` means Copilot is not required: the PR is approved once CI is green. A Copilot `CHANGES_REQUESTED` review still blocks.
- **Any type mapped below the default** (`0` or otherwise) applies only when **every changed file matches `copilot-optional-paths`** (default `**/*.md,docs/**/*.md`, Markdown only: a script or generated page under `docs/` is code and gets the normal review). Otherwise the PR gets the default threshold (the `default` entry, else `rounds-threshold`; a `0` is always gated, so `default:0` falls back to `rounds-threshold` for code) and the `reason` says so: `…; type 'docs' is relaxed to 1 round(s) but the PR touches files outside copilot-optional-paths, so the default 3 applies`. The title is author-controlled, so a code change titled `chore:` or `docs:` still gets the normal review. Types at or above the default are never gated and never list the PR's files.
- The gate is re-applied on every run: a `docs:1` approval earned on a docs-only diff is withdrawn once a later push adds a code file (the approval's stamp records the threshold it relied on).
- The changed files are listed for **exactly the head SHA under evaluation** (a `heads/<base>...<sha>` commit comparison, not the PR's live file list), so a force-push during the run cannot swap the diff behind the gate, and a tag named like the base branch cannot shadow it. The base branch and the title are re-read with the head before and after approving, and when the approval rests on that file list the comparison's **merge base** is re-read too, so a force-push of the base branch (same ref, different history) cannot swap the diff either; if anything changed, nothing is approved under the old inputs. If the listing itself fails (`403` without `contents: read`, `404` after a force-push), any earlier bot approval stamped with a relaxed threshold is withdrawn before the run reports the failure. That comparison needs `contents: read` on `github-token`, which the shipped caller template already grants. A PR touching 300 or more files cannot prove it is docs-only (the comparison's file list stops there) and gets the default rules.
- Unlisted types and non-conventional titles use `default`, else `rounds-threshold`.
- To also stop Copilot from reviewing those PRs, disable the ruleset's "Automatically request Copilot code review" and set `request-copilot-review: 'true'`. GitHub cannot filter automatic reviews by title.
- When a retitle raises the required rounds above what an earlier approval relied on, the action **dismisses** that approval. It tries the bot token first and, if GitHub refuses it (401/403), retries with the workflow's `GITHUB_TOKEN`, so keep `pull-requests: write` in the caller's job permissions. If neither can dismiss it, the run fails (`decision=error`).
- Add `edited` to `pull_request_target.types` in your caller so a retitle re-evaluates the PR; otherwise a `feat:` PR renamed `docs:` keeps its old decision until the next push.

---

## Troubleshooting

Not approving? Every run logs a `reason` (also the `reason` output). The common ones:

| `reason` | Cause / fix |
|---|---|
| `no Copilot review yet` | Copilot hasn't reviewed the PR. Enable **automatic Copilot code review** (see [Prerequisites](#prerequisites)). |
| `latest Copilot review requested changes` | Copilot posted `CHANGES_REQUESTED` — this always blocks. Address the feedback and push. |
| `latest Copilot review has N comments` | Copilot left inline comments and the round count is below `rounds-threshold` (default 3). Resolve them, or let more rounds accrue. |
| `latest Copilot review has N suppressed comment(s)` | Copilot's summary looked clean but it hid findings in a collapsed suppressed-comments block in the review body. Open the review, expand the collapsed section, and act on it (or let more rounds accrue). |
| `no Copilot review yet (its last attempt errored; …)` | Copilot's run failed ("unable to review this pull request"); that review is ignored, not counted as clean. The text after `;` says whether the action re-requested it (`copilot-error-retries`), ran out of retries, or you should re-request it by hand. |
| `latest Copilot review is for an older commit (...)` | You pushed after Copilot reviewed, so its verdict predates the current head. Wait for Copilot to re-review the new commit — no action needed. |
| `latest Copilot review has no commit_id...` | The review carries no commit, so it can't be tied to the head. Unexpected from real Copilot reviews — check the reviewer really is Copilot and not a synthetic review posted without a `commit_id`. |
| `check still running: <name>` / `no checks on head SHA yet` | CI hasn't finished. The action re-runs on `check_run` completion — no action needed. |
| `failing check: <name> (<conclusion>)` | That check didn't pass. Fix CI; approval requires all checks green. |
| `…; type '<type>' is relaxed to N round(s) but the PR touches files outside copilot-optional-paths, so the default M applies` | The title's type is mapped below the default in `rounds-by-type`, but the diff reaches outside `copilot-optional-paths`, so the PR is judged by the default rules. The text before the `;` is the ordinary reason under those rules. Expected for a code change with a relaxed title; otherwise widen the globs. |
| `head moved from … during evaluation` / `PR base changed from … during evaluation` / `PR title changed during evaluation…` | The PR's head, base branch or title changed while the run was evaluating it, so nothing was approved under the stale inputs. The next run (push, retarget or `edited` event) re-evaluates. Expected and rare. |
| `PR head, base or title changed while approving; approval withdrawn` | Same race, but it landed between the final re-read and the approval. The approval was posted and immediately dismissed; the next run re-evaluates. |
| `evaluation failed: 403 … /compare/…` or `evaluation failed: 404 … /compare/…` | The changed-files listing for a relaxed `rounds-by-type` type failed. A `403` means the **read** token lacks `contents: read`; the shipped template grants it, so restore it in the caller's job permissions. A `404` means the evaluated head SHA is no longer on the PR (a force-push landed mid-run); the next run re-evaluates the new head. Either way any earlier bot approval stamped with a relaxed threshold is **withdrawn first** (`Withdrawn: the changed files of … could not be listed …`), so the failure never leaves a relaxed approval standing. |
| `could not list the PR's reviews, so an earlier approval stamped with a relaxed rounds-by-type threshold cannot be found and withdrawn: …` | The job fails on purpose (`decision=error`). Listing the reviews is how the action finds and withdraws an earlier relaxed approval; when that listing fails, a skip would leave such an approval standing unseen. Usually transient (rate limit, 5xx): re-run the job. A persistent `403` means the **read** token cannot read pull requests. |
| `base <branch> was rewritten (merge base … -> …) during evaluation` / `… while approving; approval withdrawn` | The base branch was force-pushed while the run was evaluating a relaxed type, so the diff the path gate judged is no longer the PR's diff. Nothing is approved (or the approval is dismissed); the next run re-evaluates. A base that merely moved on through unrelated merges keeps its merge base and does not trigger this. |
| `evaluation failed: 403 … /check-runs` | The **read** token can't list check runs. Reads must use the workflow's `GITHUB_TOKEN` (the `github-token` input, default) and the caller must grant `checks: read` — a fine-grained PAT cannot be given the `Checks` permission at all. This fails **only on private repositories**: check runs are readable without that permission on public ones, so it works everywhere you'd think to test it. |
| `bot-login is empty: set the PR_AUTO_APPROVE_BOT_LOGIN repository variable…` | The job fails on purpose. `bot-login` came through blank, which also disables the caller's `github.actor != vars.PR_AUTO_APPROVE_BOT_LOGIN` loop guard, so each approval would re-trigger the workflow. Set the variable (Settings → Secrets and variables → Actions → Variables) or hard-code the login in both places. |
| `triggered by the bot's own review` | The run was started by the bot's approval and exits without evaluating. Expected; if you see many of these, the `if:` loop guard does not match `bot-login`. |
| `PR author is the bot itself` | The bot can't approve its own PR (except in `sandbox-repos`). Expected. |
| `check_run: PR base ref '...' not in [...]` | The PR targets a branch outside `base-branch`. Align the [3 base-branch sync points](#usage). |
| Nothing runs at all | Confirm `BOT_GITHUB_TOKEN` belongs to `bot-login` (with write access), and that `vars.PR_AUTO_APPROVE_BOT_LOGIN` is set so the review-loop guard works. |

---

## Responsible use

This action rubber-stamps **Copilot's** verdict — it is not a substitute for human judgment where that matters. Keep required human reviewers (branch protection, `CODEOWNERS`) on sensitive paths; the bot's approval fills a review slot but shouldn't be your only gate. Treat `BOT_GITHUB_TOKEN` like any write-scoped credential: keep it in secrets, give it **`Pull requests: write` and nothing more** — that is genuinely all the action uses it for — and rotate it periodically.

---

## Versioning

Releases follow [semver](https://semver.org/) and are tagged `vX.Y.Z` via [release-please](https://github.com/googleapis/release-please) on every merge to `main`. The moving `@v1` tag always points at the latest `v1.x` release, so pinning `@v1` (as the snippet above does) receives patches and backward-compatible features automatically. Pin an exact `@vX.Y.Z` if you prefer to upgrade manually.

---

## Development

```bash
npm install
npm test            # 175 unit tests, no external dependencies
npm run test:coverage  # same tests + coverage gate (80% line / 70% branch)
npm run lint        # actionlint (workflows) + shellcheck (e2e scripts) + issue-form schema
```

`npm run lint` shells out to `actionlint`, `shellcheck` and `python3` — install those
separately. The unit tests need none of them.

### Project layout

```
action.yml                           # composite Action entry point
scripts/pr-auto-approve/
  decide.js        # decision logic — all approval rules live here
  decide.test.js   # unit tests (Node native test runner)
  skills.test.js   # guards skills/ against drifting from action.yml
  docs.test.js     # guards this README against drifting from action.yml
scripts/
  validate-issue-forms.py      # GitHub drops a malformed issue form silently
.github/ISSUE_TEMPLATE/        # bug report + feature request forms, and config.yml
.github/workflows/
  auto-approve.yml             # this repo running the action on itself
  pr-auto-approve.yml          # reusable workflow (deprecated, kept for compat)
  test-pr-auto-approve.yml     # CI: tests + actionlint + shellcheck + issue forms
  release-please.yml           # semver tagging on main
  sync-marketplace-pin.yml     # moves the skills pin in SteerSpec/.claude on release
  dependabot.yml               # keeps the SHA-pinned actions and dev deps current
templates/
  pr-auto-approve.yml          # copy-paste starter for caller repos
skills/
  pr-auto-approve-setup/       # Claude Code skills, published via SteerSpec/.claude
  pr-auto-approve-diagnose/
  pr-caller-sync/
e2e/pr-auto-approve/
  run.sh     # end-to-end harness against a real sandbox repo
  README.md  # e2e setup guide
```

### Running e2e tests

See [`e2e/pr-auto-approve/README.md`](e2e/pr-auto-approve/README.md).

---

## Contributing

Follow [Conventional Commits](https://www.conventionalcommits.org/) — the commit hook enforces it.
Branch from `develop` and open your PR against `develop`; `main` only receives release promotions.

- [Contribution guide](https://github.com/SteerSpec/.github/blob/main/CONTRIBUTING.md)
- [Code of conduct](https://github.com/SteerSpec/.github/blob/main/CODE_OF_CONDUCT.md)
- [Security policy](https://github.com/SteerSpec/strspc-pr-review/security/policy) — report vulnerabilities privately, never as a public issue

## License

Apache License 2.0 — see [LICENSE](LICENSE).
