# e2e harness — pr-auto-approve

End-to-end tests for the reusable `pr-auto-approve.yml` workflow.

## How it works

- Uses a sandbox repository with a default branch and a base branch.
- The sandbox's caller workflow sets `test_copilot_logins: <reviewer-login>` and
  `sandbox_repos: <owner/sandbox-repo>`, so reviews posted by the reviewer are
  treated as Copilot reviews.
- The harness drives scenarios via `gh`:
  1. Create a branch + trivial change
  2. Open a PR against the base branch
  3. Post synthetic "Copilot" reviews as the reviewer identity
  4. Poll for the approver's APPROVED review on the PR
  5. Assert the observed decision matches expectation
  6. Close PR + delete branch

## Setup

### 1. Create a sandbox repository

Create a repository (e.g. `your-org/pr-auto-approve-sandbox`) with:
- A default branch (e.g. `main`)
- A base branch to target PRs against (e.g. `main`)

### 2. Add the caller workflow to the sandbox repo

Copy `templates/pr-auto-approve.yml` to the sandbox repo's
`.github/workflows/pr-auto-approve.yml` and set:

```yaml
with:
  bot_login: your-bot-login
  base_branch: main
  test_copilot_logins: your-bot-login   # treat bot reviews as Copilot in sandbox
  sandbox_repos: your-org/pr-auto-approve-sandbox
```

### 3. Authenticate `gh` as the bot

```bash
gh auth login   # or gh auth switch if you have multiple accounts
gh api user -q .login   # verify
```

### 4. Run

```bash
E2E_SANDBOX_REPO=your-org/pr-auto-approve-sandbox \
E2E_REVIEWER_LOGIN=your-bot-login \
E2E_APPROVER_LOGIN=your-bot-login \
./e2e/pr-auto-approve/run.sh
```

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `E2E_SANDBOX_REPO` | `owner/sandbox-repo` | Full name of the sandbox repo |
| `E2E_REVIEWER_LOGIN` | `my-bot` | `gh` auth identity posting synthetic reviews |
| `E2E_APPROVER_LOGIN` | `my-bot` | Login expected to post the APPROVED review |
| `E2E_BASE_BRANCH` | `main` | Base branch PRs target |
| `E2E_TIMEOUT` | `180` | Seconds to wait per approval scenario |
| `E2E_GRACE` | `60` | Seconds to wait before asserting no approval |
| `E2E_APPROVE_CHECK_PATTERN` | `Auto-approve if Copilot conditions met` | Check name substring to exclude from CI polling |

## Scenarios

| Scenario | Expected outcome |
|---|---|
| `copilot-clean` | Approved (0-comment Copilot review) |
| `copilot-with-comments` | Skip (latest review has line comments) |
| `three-rounds` | Approved (3+ Copilot reviews regardless of comments) |
| `changes-requested` | Skip (latest review is CHANGES_REQUESTED, even with 3 rounds) |
| `draft` | Skip (workflow is skipped by `if:` guard on draft PRs) |

```bash
# Run all scenarios
./e2e/pr-auto-approve/run.sh

# Run a single scenario
./e2e/pr-auto-approve/run.sh copilot-clean
```

## Notes

- Scenarios are sequential; each opens a fresh PR to avoid state pollution.
- The `changes-requested` scenario is automatically skipped if the reviewer
  and PR author are the same identity (GitHub blocks self-REQUEST_CHANGES).
- Timeout applies per scenario. Adjust `E2E_TIMEOUT` for slow CI environments.
