# strspc-pr-review

Reusable GitHub Actions workflows for automated PR review, published under Apache 2.0.

## pr-auto-approve

Automatically approves a pull request when GitHub Copilot's review is clean (zero line comments) or after Copilot has reviewed the PR three or more times.

### Approval criteria

All of the following must hold:

- PR targets the configured base branch (default: `main`)
- PR is not a draft
- PR is not authored by the bot itself (unless the repo is in `sandbox_repos`)
- All CI check runs on the head SHA are green (success / neutral / skipped / cancelled / stale)
- **Either:**
  - The latest Copilot review has 0 line comments and is not `CHANGES_REQUESTED`
  - **Or:** Copilot has submitted ≥ 3 non-dismissed reviews on the PR

Approvals are idempotent: if the bot already holds an active `APPROVED` review, the workflow skips cleanly.

### Quick start

1. Copy [`templates/pr-auto-approve.yml`](templates/pr-auto-approve.yml) to `.github/workflows/pr-auto-approve.yml` in your repository.
2. Set a repo variable `PR_AUTO_APPROVE_BOT_LOGIN` to the GitHub login of the bot that will approve PRs.
3. Add a repo secret `BOT_GITHUB_TOKEN` — a PAT for that bot with `repo` scope.
4. Optionally add `SLACK_BOT_TOKEN` for approval/skip/error notifications.

### Workflow inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `bot_login` | Yes | — | GitHub login of the approving bot |
| `base_branch` | No | `main` | Base branch PRs must target |
| `sandbox_repos` | No | `''` | Comma-separated repos where bot-authored PRs are allowed (e2e testing) |
| `test_copilot_logins` | No | `''` | Extra logins to treat as Copilot (sandbox only) |
| `slack_channel` | No | `alert-pr-notifications` | Slack channel for notifications |
| `pr_review_ref` | No | `main` | Git ref of this repo to check out for `decide.js` |

### Pinning to a release

```yaml
uses: steerspec/strspc-pr-review/.github/workflows/pr-auto-approve.yml@pr-auto-approve-v1.0.0
with:
  bot_login: ${{ vars.PR_AUTO_APPROVE_BOT_LOGIN }}
  pr_review_ref: pr-auto-approve-v1.0.0   # locks decide.js to the same tag
```

### Versioning

The `pr-auto-approve` feature is versioned independently via tags in the format `pr-auto-approve-vX.Y.Z`. The release workflow (`release-pr-auto-approve.yml`) creates tags automatically on push to `main` when the workflow or decision script changes.

## Development

```bash
npm install
npm test          # runs all unit tests (Node.js native test runner, no deps)
```

Unit tests live in `scripts/pr-auto-approve/decide.test.js` — 37 cases covering approval logic, idempotency, check-run filtering, Copilot identity strictness, sandbox overrides, and error handling.

## E2E testing

See [`e2e/pr-auto-approve/README.md`](e2e/pr-auto-approve/README.md) for running end-to-end scenarios against a real sandbox repository.

## License

Apache License 2.0 — see [LICENSE](LICENSE).
