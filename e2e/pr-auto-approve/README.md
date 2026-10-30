# e2e harness — pr-auto-approve

End-to-end tests for the reusable `pr-auto-approve.yml` workflow.

## Layout

| File | Role |
|---|---|
| `lib.sh` | Shared helpers — PR lifecycle, CI polling, approval polling. Sourced, not executed. |
| `run.sh` | **Synthetic tier.** Fakes Copilot via `test-copilot-logins`. Deterministic and fast. |
| `sandbox-vars.sh` | Puts the sandbox on the variable-driven caller (`STRSPC_PR_AUTO_APPROVE_*`) and back. See [Variable precedence](#variable-precedence). |

The synthetic tier is deliberately not a real-Copilot test: it posts the reviews itself, so
every scenario is reproducible and can gate CI. It cannot tell you whether Copilot's own output
format has changed underneath the action.

## How it works

- Uses a sandbox repository with a default branch and a base branch.
- The sandbox's caller workflow sets `test-copilot-logins: <reviewer-login>` and
  `sandbox-repos: <owner/sandbox-repo>`, so reviews posted by the reviewer are
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
  bot-login: your-bot-login
  base-branch: main
  test-copilot-logins: your-bot-login   # treat bot reviews as Copilot in sandbox
  sandbox-repos: your-org/pr-auto-approve-sandbox
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
| `E2E_REPO` | — | Full name of the repo under test. Preferred over `E2E_SANDBOX_REPO`. |
| `E2E_SANDBOX_REPO` | `owner/sandbox-repo` | Fallback for `E2E_REPO`, kept for existing invocations |
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
| `suppressed-comments` | Skip (0 line comments, but the review body carries a suppressed-comments block) |
| `three-rounds` | Approved (3+ Copilot reviews regardless of comments) |
| `changes-requested` | Skip (latest review is CHANGES_REQUESTED, even with 3 rounds) |
| `draft` | Skip (workflow is skipped by `if:` guard on draft PRs) |
| `type-zero-docs` | Approved with **no** Copilot review (`chore:` title, docs-only diff) |
| `type-zero-code` | Skip (`chore:` title, but the diff touches a file outside `copilot-optional-paths`) |
| `retitle-approves` | Approved only after `feat:` → `chore:` retitle (proves the `edited` trigger) |
| `retitle-withdraws` | Approval dismissed after `chore:` → `feat:` retitle (proves the bot can dismiss) |

The last four are **opt-in** (not in the default run) because they need extra sandbox setup: the
caller must set `rounds-by-type: 'chore:0'` and list `edited` in `pull_request_target.types`, and CI
must run on a docs-only change (a path-filtered workflow would leave `wait_for_ci` with no checks).
`retitle-withdraws` also needs a bot token that may dismiss reviews.

| Scenario (opt-in) | Expected |
|---|---|
| `request-copilot` | Copilot is requested on a `feat:` PR and not on a `docs:` PR, which is approved without it |

`request-copilot` needs a sandbox **without** the automatic Copilot code review ruleset (otherwise
Copilot reviews every PR and the docs half cannot pass), a caller with `request-copilot-review: 'true'`
and `rounds-by-type: 'docs:0,default:3'`, and it spends one real Copilot review. Point `E2E_REPO` at
that sandbox.

```bash
# Run the default six scenarios
./e2e/pr-auto-approve/run.sh

# Run a single scenario
./e2e/pr-auto-approve/run.sh copilot-clean

# Run the per-type scenarios
./e2e/pr-auto-approve/run.sh type-zero-docs type-zero-code retitle-approves retitle-withdraws
```

## Variable precedence

`sandbox-vars.sh` tests the org-level configuration end to end with the existing scenarios. It
needs an org admin of the sandbox's org (`gh auth refresh -h github.com -s admin:org,workflow`).

```bash
e2e/pr-auto-approve/sandbox-vars.sh up      # back up, then migrate the sandbox
e2e/pr-auto-approve/sandbox-vars.sh status  # effective org/repo variables and caller pin
e2e/pr-auto-approve/sandbox-vars.sh down    # restore everything from the backup
```

`up` saves the sandbox's caller, `ci.yml` and variables under `~/.cache/strspc-e2e/`, then:

- sets `STRSPC_PR_AUTO_APPROVE_{BOT_LOGIN,BASE_BRANCH,ROUNDS_BY_TYPE,WAIT_FOR_COPILOT_SECONDS}` as
  org variables visible to the sandbox only, with `ROUNDS_BY_TYPE=default:3`;
- overrides `ROUNDS_BY_TYPE=chore:0,default:3` at repo level and deletes the old
  `PR_AUTO_APPROVE_BOT_LOGIN`, so each value has exactly one possible source;
- regenerates the caller from the template at `ACTION_SHA` (pinned there, so an unreleased
  `develop` build can be tested) and widens `ci.yml` to PRs against `develop`, creating it.

It then prints the matrix: the default scenarios prove the org variables arrive; `type-zero-docs`
and `type-zero-code` pass only if the repo override wins, because the org value has no `chore:0`;
a repo `BASE_BRANCH=develop` with `E2E_BASE_BRANCH=develop` proves the base branch comes from the
variable; and a whitespace-only `BASE_BRANCH` proves `main` still passes the job `if:`.
`ORG`, `REPO_NAME`, `ACTION_SHA`, `BOT_LOGIN` and `REVIEWER_LOGIN` override the defaults.

## Notes

- Scenarios are sequential; each opens a fresh PR to avoid state pollution.
- The `changes-requested` scenario is automatically skipped if the reviewer
  and PR author are the same identity (GitHub blocks self-REQUEST_CHANGES).
- Timeout applies per scenario. Adjust `E2E_TIMEOUT` for slow CI environments.
