# PR Auto-Approve (Copilot)

> Merge faster. Let Copilot drive.

[![GitHub Marketplace](https://img.shields.io/badge/Marketplace-PR%20Auto--Approve-blue?logo=github)](https://github.com/marketplace/actions/pr-auto-approve-copilot)
[![CI](https://github.com/SteerSpec/strspc-pr-review/actions/workflows/test-pr-auto-approve.yml/badge.svg)](https://github.com/SteerSpec/strspc-pr-review/actions/workflows/test-pr-auto-approve.yml)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-green.svg)](.nvmrc)

A GitHub Action that automatically approves pull requests once GitHub Copilot signals the code is ready — no human click required for the rubber-stamp.

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

A review is only "clean" when Copilot left no inline comments **and** its body carries no `Comments suppressed due to low confidence` block. Copilot writes "generated no new comments" in its summary even when it has tucked findings into that collapsed block, and those comments are absent from the review-comments API — so a body scan is the only way to see them.

The review must also name the **current head commit**. A push dismisses the bot's approval under branch protection, but leaves Copilot's `COMMENTED` review in place — those aren't dismissed — so without this check the new commit would inherit a verdict on the old one. A review that carries no commit at all can't prove freshness either, and is treated the same way.

The rounds threshold is unaffected by both rules: it remains an unconditional escape hatch, so neither a suppressed block that never clears nor a missing re-review can wedge a PR forever.

> **Configuration tradeoff.** That escape hatch is what `rounds-threshold` tunes, so setting it to `1` makes *every* Copilot review satisfy it immediately — the clean, suppressed-comment, and freshness rules are then never evaluated, and the action degrades to "approve as soon as Copilot has reviewed at all, on whatever commit". Keep it at 2 or higher unless that is genuinely what you want.

Only PRs targeting the configured base branch(es) are eligible; draft PRs, fork PRs, and PRs the bot itself authored are skipped. The base-branch, draft, and fork gates are enforced by the caller workflow's `if:` (see [Usage](#usage)) for `pull_request`/`pull_request_review` events, and re-applied by the action itself when it re-hydrates a PR from a `check_run`/`workflow_run` event — so if you write your own caller `if:` instead of the template, keep those conditions. The bot never approves its own PR (except in test `sandbox-repos`). `CHANGES_REQUESTED` always blocks, regardless of round count. Approvals are idempotent and bound to the head commit — once the bot holds an `APPROVED` review for the current SHA the action exits cleanly, and a new push re-triggers evaluation.

Every run records a one-line `reason` (also exposed as the [`reason` output](#outputs)) explaining what it did — see [Troubleshooting](#troubleshooting).

---

## Prerequisites

Before the action can approve anything, three things must be in place:

- **GitHub Copilot code review, set to review PRs automatically** for the repo (or org). The action reads Copilot's verdict — it does *not* trigger Copilot itself, so if Copilot never reviews, every run simply skips with `no Copilot review yet`. Enable it under **Settings → Code review → Copilot** (or an org/repo ruleset that requests Copilot on PRs).
- **A dedicated bot GitHub account** — *not* your own. GitHub blocks self-approval, so the account that posts the approval must differ from PR authors. Add it to the repo as a **collaborator with write access**. Its login is what you pass as `bot-login`.
- **A Personal Access Token for that bot account** with `repo` scope, stored as the `BOT_GITHUB_TOKEN` secret. The same token requests the review *and* posts the approval, so it must belong to `bot-login`.

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
BOT_GITHUB_TOKEN = <PAT for the bot with `repo` scope>
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
  pull_request:
    branches: [main]
    types: [opened, ready_for_review, synchronize, reopened]
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
          github.event_name == 'pull_request' ||
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
must list the same branches**: the `on.pull_request.branches:` filter, the job `if:`
`base.ref` check, and the `base-branch` input. For multiple branches, set
`branches: [main, develop]` and change the `base.ref` line to
`contains(fromJSON('["main","develop"]'), github.event.pull_request.base.ref)`.

**If your CI is GitHub Actions, you need the `workflow_run` trigger.** `check_run`
alone is not enough, and the failure is silent. GitHub Actions creates its check
runs with `GITHUB_TOKEN`, and events generated by `GITHUB_TOKEN` never start a new
workflow run — that's GitHub's recursion guard. So `check_run: completed` never
fires for your own Actions jobs; it only catches checks posted by third-party apps.

Why that matters: if Copilot's review lands **before** CI finishes, the
review-triggered run skips with `check still running`, and nothing re-evaluates the
PR afterwards. It sits unapproved with no error anywhere. The `workflow_run`
trigger supplies the missing "CI is green now" signal.

Set `workflows:` to the `name:` of your gating workflow, and keep both the
`workflow_run` branch in the job `if:` and
`github.event.workflow_run.pull_requests[0].number ||` in the concurrency group —
[`templates/pr-auto-approve.yml`](templates/pr-auto-approve.yml) ships all three
wired up. The `if:` branch's `pull_requests[0] != null` check matters: `workflow_run`
fires for every completed run of the named workflow, including non-PR runs (e.g. a
push to main), which have an empty `pull_requests` array — without the guard those
trigger a wasted job run and a noisy "skipped" Slack notification.

---

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `bot-login` | **Yes** | — | GitHub login of the bot that posts the approval |
| `bot-github-token` | **Yes** | — | PAT for `bot-login` with `repo` scope |
| `base-branch` | No | `main` | Base branch(es) PRs must target; a single branch or a comma-separated set (e.g. `develop,main`) |
| `rounds-threshold` | No | `3` | Copilot review rounds before approving regardless of inline comments |
| `allow-no-checks` | No | `false` | When `true`, skip the "all checks must pass" gate when no external CI check runs exist for the head SHA (e.g. docs-only PRs) |
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

## Troubleshooting

Not approving? Every run logs a `reason` (also the `reason` output). The common ones:

| `reason` | Cause / fix |
|---|---|
| `no Copilot review yet` | Copilot hasn't reviewed the PR. Enable **automatic Copilot code review** (see [Prerequisites](#prerequisites)). |
| `latest Copilot review requested changes` | Copilot posted `CHANGES_REQUESTED` — this always blocks. Address the feedback and push. |
| `latest Copilot review has N comments` | Copilot left inline comments and the round count is below `rounds-threshold` (default 3). Resolve them, or let more rounds accrue. |
| `latest Copilot review has N suppressed low-confidence comment(s)` | Copilot said "generated no new comments" but hid findings in a `Comments suppressed due to low confidence` block in the review body. Open the review, read the collapsed section, and act on it (or let more rounds accrue). |
| `latest Copilot review is for an older commit (...)` | You pushed after Copilot reviewed, so its verdict predates the current head. Wait for Copilot to re-review the new commit — no action needed. |
| `latest Copilot review has no commit_id...` | The review carries no commit, so it can't be tied to the head. Unexpected from real Copilot reviews — check the reviewer really is Copilot and not a synthetic review posted without a `commit_id`. |
| `check still running: <name>` / `no checks on head SHA yet` | CI hasn't finished. The action re-runs on `check_run` completion — no action needed. |
| `failing check: <name> (<conclusion>)` | That check didn't pass. Fix CI; approval requires all checks green. |
| `PR author is the bot itself` | The bot can't approve its own PR (except in `sandbox-repos`). Expected. |
| `check_run: PR base ref '...' not in [...]` | The PR targets a branch outside `base-branch`. Align the [3 base-branch sync points](#usage). |
| Nothing runs at all | Confirm `BOT_GITHUB_TOKEN` belongs to `bot-login` (with write access), and that `vars.PR_AUTO_APPROVE_BOT_LOGIN` is set so the review-loop guard works. |

---

## Responsible use

This action rubber-stamps **Copilot's** verdict — it is not a substitute for human judgment where that matters. Keep required human reviewers (branch protection, `CODEOWNERS`) on sensitive paths; the bot's approval fills a review slot but shouldn't be your only gate. Treat `BOT_GITHUB_TOKEN` like any write-scoped credential: keep it in secrets, scope it to `repo`, and rotate it periodically.

---

## Versioning

Releases follow [semver](https://semver.org/) and are tagged `vX.Y.Z` via [release-please](https://github.com/googleapis/release-please) on every merge to `main`. The moving `@v1` tag always points at the latest `v1.x` release, so pinning `@v1` (as the snippet above does) receives patches and backward-compatible features automatically. Pin an exact `@vX.Y.Z` if you prefer to upgrade manually.

---

## Development

```bash
npm install
npm test            # 62 unit tests, no external dependencies
npm run test:coverage  # same tests + coverage gate (80% line / 70% branch)
npm run lint        # actionlint (workflows) + shellcheck (e2e scripts)
```

### Project layout

```
action.yml                           # composite Action entry point
scripts/pr-auto-approve/
  decide.js        # decision logic — all approval rules live here
  decide.test.js   # 62 unit tests (Node native test runner)
.github/workflows/
  pr-auto-approve.yml          # reusable workflow (deprecated, kept for compat)
  test-pr-auto-approve.yml     # CI: tests + actionlint + shellcheck
  release-please.yml           # semver tagging on main
templates/
  pr-auto-approve.yml          # copy-paste starter for caller repos
e2e/pr-auto-approve/
  run.sh     # end-to-end harness against a real sandbox repo
  README.md  # e2e setup guide
```

### Running e2e tests

See [`e2e/pr-auto-approve/README.md`](e2e/pr-auto-approve/README.md).

---

## Contributing

Follow [Conventional Commits](https://www.conventionalcommits.org/) — the commit hook enforces it.

## License

Apache License 2.0 — see [LICENSE](LICENSE).
