# e2e harness — pr-auto-approve

End-to-end tests for the `pr-auto-approve` action, run against a sandbox repository in the
`testbed-multi-org` organization.

## Layout

| File | Role |
|---|---|
| `scenarios.json` | **The suite.** Each scenario's profile, expected decision and reason, and the inputs it covers. |
| `run.sh` | **Synthetic tier.** Sets the scene for each scenario. Fakes Copilot via `test-copilot-logins`. Deterministic. |
| `lib.sh` | Shared helpers: PR lifecycle, decision and approval polling. Sourced, not executed. |
| `sandbox.sh` | Keeps the sandbox in a known shape, as code. Puts a SHA under test. `--real` does the same for the real-Copilot testbed. |
| `testbed/` | The library the real-Copilot testbed holds on `main`, for Copilot to review fixture diffs against. |
| `copilot.sh` | **Real-Copilot tier.** Pushes fixtures, lets Copilot review them, and judges what the action did. See [Real-Copilot tier](#real-copilot-tier). |
| `copilot-scenarios.json` | The real tier's scenarios: the fixture steps each one pushes and the outcome it is meant for. |
| `oracle.jq` | The real tier's format probe and decision oracle. `scripts/pr-auto-approve/oracle.test.js` holds it against `decide.js`. |
| `fixtures/real/` | The files each real-tier step commits, in one commit. |
| `fixtures/captured/` | Review bodies real Copilot posted, kept so the oracle's agreement test covers them. |
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
It does the same for the `APPROVE` rules: each scenario lists the rules it proves in `rules`, and a rule with
no scenario needs an entry in `rule_exemptions`. A rule in state `I` must be cited by a scenario, so Implemented
means proven here. The `E2E` rules in `rules/` state these requirements.

## Setup

The sandbox is `testbed-multi-org/strspc-pr-review-sandbox`. Its repo secret `BOT_TOKEN_SANDBOX` is what
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

### Real-Copilot testbed

`testbed-multi-org/strspc-pr-review-copilot` is where Copilot reviews for real. It is set up and synced the
same way, with `--real`:

```bash
e2e/pr-auto-approve/sandbox.sh --real setup
e2e/pr-auto-approve/sandbox.sh --real sync "$(git rev-parse HEAD)"
```

It differs from the sandbox on purpose:

- Its caller is the template as a production repo copies it, with only the pin and the secret changed. It
  has no `test-copilot-logins` and no `sandbox-repos`, so only Copilot counts as Copilot and the self-approval
  guard stays live.
- A `pr-copilot` ruleset makes Copilot review every push. Each review costs a premium request.
- `WAIT_FOR_COPILOT_SECONDS` is 600. The run that CI starts is the only one that can approve, because the run
  Copilot's review would start is held at `action_required` or never starts.
- Its CI runs the tests of the library in `testbed/`, which `sync` keeps on `main`.
- The bot approves with `BOT_TOKEN_COPILOT`, a fine-grained token of the approver limited to this repo, with
  Pull requests read and write only. It posts and dismisses the bot's approval; the action reads everything
  else with the workflow's `github-token`.
- It has only `main`.

`setup` gives an empty repo its first commit through the contents API, which leaves it unsigned, so it must run
as the enterprise owner. `sync` refuses to run if an org variable would show through, as for the sandbox.

## Run

Needs Bash 4+ (on macOS, `brew install bash`), `gh` authenticated as the reviewer, and `jq`. The reviewer
must be the enterprise owner, because `run.sh` calls `sandbox.sh reset`.

```bash
export E2E_REPO=testbed-multi-org/strspc-pr-review-sandbox
export E2E_REVIEWER_LOGIN=pleberre E2E_APPROVER_LOGIN=cnslr-bt

e2e/pr-auto-approve/run.sh                 # every scenario
e2e/pr-auto-approve/run.sh copilot-clean   # just these
e2e/pr-auto-approve/run.sh --group release # one group: core, types, clean-on, promotion or release
```

Every scenario belongs to a group in `scenarios.json`. A new scenario needs one, and `e2e.test.js` fails
without it.

## CI

`.github/workflows/e2e.yml` runs the suite against the commit under test, on every PR into `main` and on
dispatch. It doesn't run on PRs into `develop`, because it takes too long. To check a branch first:

```bash
gh workflow run e2e.yml --ref my-branch                                    # every scenario
gh workflow run e2e.yml --ref my-branch -f scenarios="draft release-clean"  # just these
```

Each group runs as its own job, one after another, and a final `e2e` job reports them as one check. That
check is the one `main` requires. When a group fails, **Re-run failed jobs** repeats only that group, not the
whole suite of about 34 minutes. Each group syncs the sandbox first, which adds about a minute per group.

Runs share the sandbox, so each group waits until no run that started earlier is still going. That is the
start of the latest attempt, so a re-run waits for a run that began after the first attempt. It doesn't use a
`concurrency:` group, which would cancel a displaced run, and `decide.js` counts a cancelled check as passed.

Both secrets are fine-grained tokens limited to the e2e repos:

| Secret | Stored on | Owner | Permissions |
|---|---|---|---|
| `E2E_ADMIN_TOKEN` | `SteerSpec/strspc-pr-review` | The enterprise owner, on the sandbox and the real-Copilot testbed | Contents, Pull requests, Variables and Workflows read and write; Actions and Secrets read |
| `BOT_TOKEN_SANDBOX` | `SteerSpec/strspc-pr-review` and the sandbox | The approver | Contents and Pull requests read and write |

**The sandbox's caller approves with `BOT_TOKEN_SANDBOX`, never an org secret.** It runs the commit under
test, so a PR's action code can read that token. If it reached production, a PR could approve itself.

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
| `E2E_GRACE` | `15` | Seconds to wait before asserting no approval. The expected decision has already been seen by then |
| `E2E_GH_RETRIES` | `3` | Retries of a `gh` call that hits a transient GitHub error: a 5xx, GraphQL's "Something went wrong", or a dropped connection. Nothing else is retried |
| `E2E_GH_RETRY_DELAY` | `10` | Seconds before the first retry. Each later retry waits that much longer |
| `E2E_NUDGE_AFTER` | `120` | Seconds with no CI check on a PR before it is closed and reopened, once, to trigger CI again |
| `E2E_POLL_INTERVAL` | `10` | Seconds between polls |
| `E2E_APPROVE_CHECK_PATTERN` | `auto-approve` | Check name substring to exclude from CI polling |
| `E2E_CALLER_WORKFLOW` | `pr-auto-approve.yml` | The sandbox's caller workflow file |

## Scenarios

`scenarios.json` is the list. The `routes` profiles set `RELEASE_AUTHOR` to the reviewer login, because the
harness authors the release PRs. Those scenarios merge to `develop` and `main`, so each starts from a reset
of the sandbox. Setup merges run as the reviewer. The last merge of `promotion-clean` and `release-clean`
runs as the bot, which has no bypass, so it needs `E2E_BOT_TOKEN`. `request-copilot` asks for a real Copilot review, so it spends one, and the
sandbox must not have the automatic Copilot review ruleset or its docs half cannot pass.

## Real-Copilot tier

`copilot.sh` runs the scenarios in `copilot-scenarios.json` against the [real-Copilot testbed](#real-copilot-testbed).
Each step commits a fixture from `fixtures/real/` in one commit, so one step is one Copilot review, and one
premium request. The three scenarios push four times in all. Run it on demand and before a release, never on a
schedule.

`.github/workflows/e2e-copilot.yml` runs it in CI, with the action pinned to the commit under test. It runs on a
promotion PR (`develop` into `main`), the release candidate, and on dispatch. It skips release-please's PRs,
whose code `main` already holds. Runs take turns on the testbed as in `e2e.yml`. Its check, `e2e-copilot`, is
required on `main` by the `e2e-main` ruleset, as `e2e` is, so a promotion PR cannot merge until it passes. On
release-please's PRs the job is skipped, and GitHub counts a skipped job as passing.

```bash
gh workflow run e2e-copilot.yml --ref my-branch                        # every scenario
gh workflow run e2e-copilot.yml --ref my-branch -f scenarios=real-clean # just these
```

It uses `E2E_ADMIN_TOKEN`, which must cover the testbed too. Secrets read is for the check that
`BOT_TOKEN_COPILOT` is set, so a run with no approval token fails before it spends a review. The testbed keeps
whichever commit was tested last.

```bash
e2e/pr-auto-approve/sandbox.sh --real sync "$(git rev-parse HEAD)"
e2e/pr-auto-approve/copilot.sh               # every scenario
e2e/pr-auto-approve/copilot.sh real-clean    # just these
```

`gh` must be authenticated as the enterprise owner, who authors the PRs and resets the testbed.

Copilot's verdict is not deterministic, so a scenario states the outcome it is meant for, not the decision it
must get. After each push, `copilot.sh` waits for Copilot's review and for the caller's runs to finish, then
checks three things:

| Check | What it asserts | On a miss |
|---|---|---|
| Probe | Every Copilot review is in a shape Copilot is known to post: a `ccr-overview` body with a known verdict heading, an open-issues statement and known sections, or one of the reviews of nothing. Reviewer logins and Copilot check names are known ones. | **Fails.** Copilot's output changed. The body is printed. |
| Oracle | The action's decision is the one `oracle.jq` computes from the checks, reviews and inline comment counts. | **Fails.** The action misjudged real data. |
| Intent | The clean fixture was approved and the buggy one skipped. | Warns. Copilot judged the fixture differently. |

The probe is what catches drift. An oracle that knows the same shapes as `decide.js` would agree with it about a
body neither understands, and both would just skip. The oracle is jq so that it does not load `decide.js` and test
the implementation against itself. `oracle.test.js` holds the two against each other on every body in `fixtures/`.

The summary table says which run approved and whether it waited for Copilot's review. That is the proof for
`wait-for-copilot-seconds`: when Copilot reviewed after CI finished, only a run that waited could approve, so
`real-clean` fails if the approval came without one. When Copilot was first, the run started by CI's completion
usually approves without waiting, and the table says the wait was not needed. An earlier run can still have
waited through CI (#198), but CI's run normally cancels it first. It also says when no review reached `copilot-clean`, because then the approval
path went untested against real Copilot.

The probe accepts a finding's own collapsed block nested inside a section, recognised by its severity icon.

The buggy fixture's tests pass, on purpose. A bug they caught would fail CI, and the action would skip on the
check before reading Copilot's review.

When Copilot posts a new shape, save the body under `fixtures/captured/` and teach both `decide.js` and
`oracle.jq` to read it. `oracle.test.js` fails until they agree on it.

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
- `base-near-match` creates and deletes a base branch named `mai`, so that name is reserved for the
  harness: the scenario refuses to start while it exists, and `sandbox.sh reset` deletes it.
- `changes-requested` opens its PR as the bot, because GitHub refuses REQUEST_CHANGES from a PR's author.
- Timeouts apply per assertion. Adjust `E2E_TIMEOUT` for slow CI environments.
