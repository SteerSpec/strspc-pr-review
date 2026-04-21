# strspc-pr-review

> Reusable GitHub Actions workflows for automated PR review — open source, Apache 2.0.

[![CI](https://github.com/SteerSpec/strspc-pr-review/actions/workflows/test-pr-auto-approve.yml/badge.svg)](https://github.com/SteerSpec/strspc-pr-review/actions/workflows/test-pr-auto-approve.yml)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-green.svg)](.nvmrc)

---

## Workflows

| Workflow | Description |
|---|---|
| [`pr-auto-approve`](#pr-auto-approve) | Auto-approves PRs when GitHub Copilot's review is clean or after 3 review rounds |

---

## pr-auto-approve

Automatically approves pull requests when GitHub Copilot signals the code is ready — either because its latest review has zero inline comments, or because it has reviewed the PR three or more times.

### How it works

A PR is approved when **all** of the following hold:

- Targets the configured base branch (default: `main`)
- Is not a draft
- Is not authored by the bot account
- All CI checks on the head SHA have passed (success, neutral, skipped, cancelled, or stale)
- **One of:**
  - The latest Copilot review has 0 inline comments and is not `CHANGES_REQUESTED`
  - Copilot has submitted ≥ 3 non-dismissed reviews (the 3-rounds rule)

Approvals are **idempotent** — if the bot already holds an active `APPROVED` review, the workflow skips cleanly without error.

### Quick start

**1. Copy the template into your repository**

```bash
curl -o .github/workflows/pr-auto-approve.yml \
  https://raw.githubusercontent.com/SteerSpec/strspc-pr-review/main/templates/pr-auto-approve.yml
```

**2. Set a repository variable**

```
PR_AUTO_APPROVE_BOT_LOGIN = <your-bot-login>
```

**3. Add a repository secret**

```
BOT_GITHUB_TOKEN = <PAT for the bot with `repo` scope>
```

**4. Optionally add Slack notifications**

```
SLACK_BOT_TOKEN = <xoxb-... token with chat:write scope>
```

That's it. Open a PR targeting your base branch and Copilot will drive the approval.

### Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `bot_login` | **Yes** | — | GitHub login of the bot that posts the approval |
| `base_branch` | No | `main` | Base branch PRs must target |
| `sandbox_repos` | No | `''` | Comma-separated `owner/repo` list where bot-authored PRs are allowed (e2e use only) |
| `test_copilot_logins` | No | `''` | Extra logins treated as Copilot in sandbox repos |
| `slack_channel` | No | `alert-pr-notifications` | Slack channel for notifications |
| `pr_review_ref` | No | `develop` | Git ref of this repo to check out for `decide.js` — pin to a release tag for stability |

### Secrets

| Secret | Required | Description |
|---|---|---|
| `BOT_GITHUB_TOKEN` | **Yes** | PAT for `bot_login` with `repo` scope |
| `SLACK_BOT_TOKEN` | No | Slack bot token (`xoxb-...`) with `chat:write` scope |

### Pinning to a release

```yaml
uses: steerspec/strspc-pr-review/.github/workflows/pr-auto-approve.yml@pr-auto-approve-v1.0.0
with:
  bot_login: ${{ vars.PR_AUTO_APPROVE_BOT_LOGIN }}
  pr_review_ref: pr-auto-approve-v1.0.0   # pin decide.js to the same tag
secrets:
  BOT_GITHUB_TOKEN: ${{ secrets.BOT_GITHUB_TOKEN }}
```

### Versioning

The `pr-auto-approve` workflow is versioned independently with tags in the format `pr-auto-approve-vX.Y.Z`. Tags are created automatically on every push to `main` that changes the workflow or its decision logic.

---

## Development

```bash
npm install
npm test        # 37 unit tests, no external dependencies
npm run lint    # actionlint (workflows) + shellcheck (e2e scripts)
```

### Project layout

```
scripts/pr-auto-approve/
  decide.js        # decision logic — all approval rules live here
  decide.test.js   # 37 unit tests (Node native test runner)
.github/workflows/
  pr-auto-approve.yml          # reusable workflow (consumers call this)
  test-pr-auto-approve.yml     # CI: tests + actionlint + shellcheck
  release-pr-auto-approve.yml  # semver tagging on main
  release-please.yml           # package versioning
templates/
  pr-auto-approve.yml          # copy-paste starter for consumer repos
e2e/pr-auto-approve/
  run.sh     # end-to-end harness against a real sandbox repo
  README.md  # e2e setup guide
```

### Running e2e tests

See [`e2e/pr-auto-approve/README.md`](e2e/pr-auto-approve/README.md) for how to run the five end-to-end scenarios against a real sandbox repository.

---

## Contributing

Contributions are welcome. Please follow [Conventional Commits](https://www.conventionalcommits.org/) — the commit hook will remind you if needed.

## License

Apache License 2.0 — see [LICENSE](LICENSE).
