# PR Auto-Approve (Copilot)

> Merge faster. Let Copilot drive.

[![GitHub Marketplace](https://img.shields.io/badge/Marketplace-PR%20Auto--Approve-blue?logo=github)](https://github.com/marketplace/actions/pr-auto-approve-copilot)
[![CI](https://github.com/SteerSpec/strspc-pr-review/actions/workflows/test-pr-auto-approve.yml/badge.svg)](https://github.com/SteerSpec/strspc-pr-review/actions/workflows/test-pr-auto-approve.yml)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-green.svg)](.nvmrc)

A GitHub Action that automatically approves pull requests once GitHub Copilot signals the code is ready — no human click required for the rubber-stamp.

---

## How it works

When a PR is opened or updated, the action checks two things:

```
All CI checks passed?  ──No──▶  skip
        │
       Yes
        │
Copilot reviewed?  ──No──▶  skip
        │
       Yes
        ├── Latest review has 0 comments?  ──Yes──▶  approve ✓
        │
        └── ≥ N rounds of Copilot review?  ──Yes──▶  approve ✓
                                                      (default N = 3)
```

`CHANGES_REQUESTED` always blocks, regardless of round count. Approvals are idempotent — if the bot already holds an active `APPROVED` review, the action exits cleanly.

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
    types: [opened, ready_for_review, synchronize, reopened, review_requested]
  pull_request_review:
    types: [submitted]
  check_run:
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
          github.run_id
        }}
      cancel-in-progress: true
    if: >-
      (
        github.event.pull_request != null &&
        github.event.pull_request.base.ref == 'main' &&
        github.event.pull_request.draft == false &&
        github.event.pull_request.head.repo.full_name == github.repository
      ) || (
        github.event_name == 'check_run' &&
        github.event.check_run.name != 'auto-approve'
      )
    steps:
      - uses: SteerSpec/strspc-pr-review@v1.0.0
        with:
          bot-login: ${{ vars.PR_AUTO_APPROVE_BOT_LOGIN }}
          bot-github-token: ${{ secrets.BOT_GITHUB_TOKEN }}
          # slack-bot-token: ${{ secrets.SLACK_BOT_TOKEN }}
```

---

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `bot-login` | **Yes** | — | GitHub login of the bot that posts the approval |
| `bot-github-token` | **Yes** | — | PAT for `bot-login` with `repo` scope |
| `base-branch` | No | `main` | Base branch PRs must target |
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

## Versioning

Releases follow [semver](https://semver.org/) and are tagged `vX.Y.Z` via [release-please](https://github.com/googleapis/release-please) on every merge to `main`.

---

## Development

```bash
npm install
npm test        # 42 unit tests, no external dependencies
npm run lint    # actionlint (workflows) + shellcheck (e2e scripts)
```

### Project layout

```
action.yml                           # composite Action entry point
scripts/pr-auto-approve/
  decide.js        # decision logic — all approval rules live here
  decide.test.js   # 42 unit tests (Node native test runner)
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
