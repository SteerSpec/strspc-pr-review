# e2e harness — pr-auto-approve

End-to-end tests for the `pr-auto-approve` action, run against a sandbox repository in the
`testbed-multi-org` organization.

## Layout

| File | Role |
|---|---|
| `scenarios.json` | **The suite.** Each scenario's profile, expected decision and reason, and the inputs it covers. |
| `run.sh` | **Synthetic tier.** Sets the scene for each scenario. Fakes Copilot via `test-copilot-logins`. Deterministic. |
| `lib.sh` | Shared helpers: PR lifecycle, decision and approval polling. Sourced, not executed. |
| `sandbox.sh` | Keeps the sandbox in a known shape, as code. Puts a SHA under test. |
| `sandbox-vars.sh` | Tests org/repo variable precedence, which needs `admin:org`. See [Variable precedence](#variable-precedence). |

The synthetic tier is deliberately not a real-Copilot test: it posts the reviews itself, so every
scenario is reproducible and can gate CI. It cannot tell you whether Copilot's own output format has
changed underneath the action.

## How it works

For each scenario, `run.sh`:

1. Applies the scenario's profile: the repo variables in `scenarios.json`
2. Opens a PR from an `e2e/` branch
3. Posts synthetic "Copilot" reviews as the reviewer identity, if the scenario needs them
4. Asserts the outcome in `scenarios.json`
5. Closes the PR and deletes the branch, however the scenario ended

A failure is recorded and the run carries on. It ends with a pass/fail table, also written to
`$GITHUB_STEP_SUMMARY`, and exits non-zero if anything failed.

**A scenario asserts what the action decided, not just that no approval appeared.** A crash, a wrong
token and a skipped job all look like a correct refusal. So `expect_outcome` reads the line every
evaluation logs, and matches its decision and reason against `scenarios.json`:

```
pr-auto-approve pr=42 decision=skip reason=latest Copilot review has 1 comments
```

The `pr=` field is the only way to tie a run to a PR: `workflow_run` events carry the default branch,
whichever PR they judged. A decision of `none` means the caller's job `if:` must have stopped the PR
before the action ran.

**Adding a behaviour or an input? Add its scenario in the same PR.** `scripts/pr-auto-approve/e2e.test.js`
fails if an `action.yml` input has neither a scenario nor an entry in `exemptions` saying why.

## Setup

The sandbox is `testbed-multi-org/strspc-pr-review-sandbox`. Its org secret `BOT_GITHUB_TOKEN` is what
the caller approves with.

```bash
# Once, as a repo admin: the bot gets write and the rulesets are created.
e2e/pr-auto-approve/sandbox.sh setup

# Put a commit under test. It must be pushed. Safe to re-run.
e2e/pr-auto-approve/sandbox.sh sync "$(git rev-parse HEAD)"

e2e/pr-auto-approve/sandbox.sh status   # what is under test
e2e/pr-auto-approve/sandbox.sh reset    # close PRs, restore the fixture files, put develop on main
```

`sync` renders the caller from the template at that SHA and pins `uses:` to it, so no checkout runs
under `pull_request_target`.

`main` only moves forward: the enterprise `Compliance` ruleset forbids a force-push to the default
branch, even for its owner. So `reset` repairs `main` with a new commit, then force-moves `develop` onto it.

The rulesets match production's, with one difference: the enterprise owner may bypass them, because
`sync` and `reset` commit to `main` and force-move `develop`. So both must run as the enterprise owner. The bot has no bypass, so a merge it makes proves the rules were met.

`sync` refuses to run if an `STRSPC_PR_AUTO_APPROVE_*` org variable is visible to the sandbox. A profile
unsets a value by deleting the repo variable, so an org value would show through. If one is left from
`sandbox-vars.sh`, run `sandbox-vars.sh down` first.

## Run

Needs Bash 4+ (on macOS, `brew install bash`), `gh` authenticated as the reviewer, and `jq`.

```bash
export E2E_REPO=testbed-multi-org/strspc-pr-review-sandbox
export E2E_REVIEWER_LOGIN=pleberre E2E_APPROVER_LOGIN=cnslr-bt

e2e/pr-auto-approve/run.sh                 # every scenario
e2e/pr-auto-approve/run.sh copilot-clean   # just these
```

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `E2E_REPO` | — | Full name of the repo under test. Preferred over `E2E_SANDBOX_REPO`. |
| `E2E_SANDBOX_REPO` | `owner/sandbox-repo` | Fallback for `E2E_REPO`, kept for existing invocations |
| `E2E_REVIEWER_LOGIN` | `my-bot` | `gh` auth identity posting synthetic reviews |
| `E2E_APPROVER_LOGIN` | `my-bot` | Login expected to post the APPROVED review |
| `E2E_BOT_TOKEN` | — | Token for the approver. Keep it scoped to the sandbox. A scenario that needs it fails without it |
| `E2E_BASE_BRANCH` | `main` | Base branch PRs target |
| `E2E_TIMEOUT` | `180` | Seconds to wait per assertion |
| `E2E_GRACE` | `60` | Seconds to wait before asserting no approval |
| `E2E_APPROVE_CHECK_PATTERN` | `auto-approve` | Check name substring to exclude from CI polling |
| `E2E_CALLER_WORKFLOW` | `pr-auto-approve.yml` | The sandbox's caller workflow file |

## Scenarios

`scenarios.json` is the list. The `routes` profiles set `RELEASE_AUTHOR` to the reviewer login, because the
harness authors the release PRs. Those scenarios merge to `develop` and `main`, so each starts from a reset
of the sandbox. Setup merges run as the reviewer. The last merge of `promotion-clean` and `release-clean`
runs as the bot, which has no bypass, so it needs `E2E_BOT_TOKEN`. `request-copilot` asks for a real Copilot review, so it spends one, and the
sandbox must not have the automatic Copilot review ruleset or its docs half cannot pass.

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

- Scenarios are sequential, because a profile changes repo variables and one sandbox serves them all.
- `changes-requested` opens its PR as the bot, because GitHub refuses REQUEST_CHANGES from a PR's author.
- Timeouts apply per assertion. Adjust `E2E_TIMEOUT` for slow CI environments.
