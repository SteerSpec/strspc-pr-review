# Usage

The caller workflow, organization-wide configuration, and the triggers it needs. Back to the
[README](../README.md).

## Usage

[`templates/pr-auto-approve.yml`](../templates/pr-auto-approve.yml) is the full caller. Copy it rather
than writing your own: its job `if:` and `concurrency` group are load-bearing, and its comments explain
each trap. The shape of it:

```yaml
on:
  pull_request_target:   # NOT pull_request, see the security note below
    types: [opened, ready_for_review, synchronize, reopened, edited]
  pull_request_review:
    types: [submitted]
  check_run:             # third-party app checks only
    types: [completed]
  workflow_run:          # required if your CI is GitHub Actions
    workflows: ['CI']
    types: [completed]
  schedule:              # the sweep, see below
    - cron: '23 * * * *'
  workflow_dispatch:     # a sweep on demand

jobs:
  auto-approve:
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write
      contents: read
      checks: read
    # concurrency and if: omitted here, keep them from the template
    steps:
      - uses: SteerSpec/strspc-pr-review@v1
        with:
          bot-login: ${{ vars.STRSPC_PR_AUTO_APPROVE_BOT_LOGIN || vars.PR_AUTO_APPROVE_BOT_LOGIN }}
          bot-github-token: ${{ secrets.BOT_GITHUB_TOKEN }}
          base-branch: ${{ vars.STRSPC_PR_AUTO_APPROVE_BASE_BRANCH }}
          rounds-threshold: ${{ vars.STRSPC_PR_AUTO_APPROVE_ROUNDS_THRESHOLD }}
          # ...one line per setting, see Organization-wide configuration below
          # slack-bot-token: ${{ secrets.SLACK_BOT_TOKEN }}
```

### Tokens

Two tokens do different jobs, and the split matters:

| Token | Used for | Needs |
| ----- | -------- | ----- |
| `bot-github-token` | Posting the approval, and dismissing the bot's own approval | `Pull requests: write` |
| [`github-token`](inputs.md#tokens), default `GITHUB_TOKEN` | Every read: check runs, the PR, its reviews, changed files | `checks: read`, `contents: read`, and `pull-requests: write` for the review request and the dismissal fallback |

Listing check runs needs the **`Checks`** permission, and fine-grained PATs can't be granted it. A PAT
doing the reading works on public repositories, where check runs are readable without it, and fails
with `403` on private ones, on every run. Keep `checks: read` in your caller's job permissions.

### Organization-wide configuration

The template reads every setting from an Actions variable named `STRSPC_PR_AUTO_APPROVE_<INPUT>`. Set
values once at the organization level (Settings → Secrets and variables → Actions → Variables, or
`gh variable set NAME --org <org> --body <value>`), and override them in a repository with a
repository variable of the same name.

| Variable | Input |
| -------- | ----- |
| `STRSPC_PR_AUTO_APPROVE_BOT_LOGIN` | `bot-login` (required; `PR_AUTO_APPROVE_BOT_LOGIN` still works as a fallback) |
| `STRSPC_PR_AUTO_APPROVE_BASE_BRANCH` | `base-branch` (also drives the job `if:`) |
| `STRSPC_PR_AUTO_APPROVE_ROUNDS_THRESHOLD` | `rounds-threshold` |
| `STRSPC_PR_AUTO_APPROVE_ROUNDS_BY_TYPE` | `rounds-by-type` |
| `STRSPC_PR_AUTO_APPROVE_COPILOT_OPTIONAL_PATHS` | `copilot-optional-paths` |
| `STRSPC_PR_AUTO_APPROVE_PROTECTED_PATHS` | `protected-paths` |
| `STRSPC_PR_AUTO_APPROVE_PROTECTED_PATHS_MODE` | `protected-paths-mode` |
| `STRSPC_PR_AUTO_APPROVE_PROTECTED_PATHS_ALLOWED` | `protected-paths-allowed` |
| `STRSPC_PR_AUTO_APPROVE_COPILOT_CLEAN_ON` | `copilot-clean-on` |
| `STRSPC_PR_AUTO_APPROVE_PROMOTION_BRANCHES` | `promotion-branches` |
| `STRSPC_PR_AUTO_APPROVE_RELEASE_BRANCHES` | `release-branches` |
| `STRSPC_PR_AUTO_APPROVE_RELEASE_AUTHOR` | `release-author` |
| `STRSPC_PR_AUTO_APPROVE_ALLOW_NO_CHECKS` | `allow-no-checks` |
| `STRSPC_PR_AUTO_APPROVE_REQUEST_COPILOT_REVIEW` | `request-copilot-review` |
| `STRSPC_PR_AUTO_APPROVE_WAIT_FOR_COPILOT_SECONDS` | `wait-for-copilot-seconds` |
| `STRSPC_PR_AUTO_APPROVE_COPILOT_ERROR_RETRIES` | `copilot-error-retries` |
| `STRSPC_PR_AUTO_APPROVE_SLACK_CHANNEL` | `slack-channel` |

Precedence, highest first: a literal in the caller's `with:`, the repository variable, the
organization variable, the action's default.

> [!IMPORTANT]
> `base-branch` is the exception to that order. The job `if:` reads the variable as well, before the
> action runs, so a literal `base-branch` must also be written into the `if:` (replacing
> `vars.STRSPC_PR_AUTO_APPROVE_BASE_BRANCH || 'main'`), or PRs to that branch are skipped.

- **Overrides replace the whole value.** A repository that wants `fix:` PRs at 2 rounds writes the
  full `rounds-by-type` string (`docs:1,chore:0,fix:2,default:3`), not just `fix:2`.
- **An unset variable means "use the default".** It reaches the action as an empty string, which
  every input treats as its default.
- **To go back to the default in one repository, write the default value explicitly.** GitHub doesn't
  allow an empty variable, so a repo can't "unset" an org value.
- **Org variables have a repository-access policy** (all, private, or selected repositories). A
  variable not granted to a repository reads as unset there.
- **Secrets work the same way.** `BOT_GITHUB_TOKEN` and `SLACK_BOT_TOKEN` can be organization secrets.
- **Existing callers don't pick this up until re-synced**, because the template is copied, not
  referenced. The [`pr-caller-sync`](../skills/pr-caller-sync/SKILL.md) skill does that. Create the org
  variables first, or a synced repo runs on the action's defaults (for `base-branch`, that's `main`).
  The deprecated reusable workflow (`.github/workflows/pr-auto-approve.yml`) doesn't read these
  variables.

**Base branches.** `base-branch` takes one branch or a comma-separated set such as `develop,main`, and
whitespace-only falls back to `main`. The template uses `STRSPC_PR_AUTO_APPROVE_BASE_BRANCH` in two
places, the input and the job `if:`, and has no `branches:` filter on the trigger because `on:` can't
read variables. The `if:` check is a substring pre-filter that only saves a runner. It always lets
`main` through, because a whitespace- or comma-only value means `main` to the action, which the `if:`
can't detect. The action enforces the exact set for every event.

### Why `pull_request_target`, not `pull_request`

This workflow holds a bot PAT. For a **same-repo** PR, the `pull_request` event runs the workflow
definition from the PR's **head commit** with your secrets in scope, so anyone who can push a branch
could edit the workflow in their own PR and exfiltrate the token. That token can approve PRs, so
leaking it means self-approving arbitrary changes. `pull_request_target` instead *"runs in the context
of the **default branch of the base repository**"* ([GitHub's `pull_request_target`
documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request_target)),
so the definition is never PR-controlled. That's
the **default** branch, not the PR's base branch, and they differ whenever a PR targets a non-default
branch.

> [!CAUTION]
> The usual `pull_request_target` warning is about checking out and executing PR code with secrets in
> scope. This action never checks anything out, it only calls the GitHub API, so that risk doesn't
> apply to it. **If you add a checkout step, that reasoning no longer holds.** The same goes for
> `pull_request_review`, whose `GITHUB_REF` is the PR **merge ref**: a `checkout` step in that job
> would pull PR code with secrets in scope.

Two consequences:

- **The fork guard becomes load-bearing.** `head.repo.full_name == github.repository` is what stops
  `pull_request_target` running with secrets for a fork-associated PR. Keep it.
- **The bootstrap PR can't approve itself.** The definition comes from the base branch, which doesn't
  have the workflow yet, so the PR that *adds* this file needs a human approval or an admin bypass.
  Every PR after it is handled automatically.

### If your CI is GitHub Actions, you need `workflow_run`

`check_run` alone isn't enough, and the failure is silent. GitHub Actions creates its check runs with
`GITHUB_TOKEN`, and events generated by `GITHUB_TOKEN` never start a new workflow run: that's GitHub's
recursion guard. So `check_run: completed` never fires for your own Actions jobs. It only catches
checks posted by third-party apps.

If Copilot's review lands **before** CI finishes, the review-triggered run skips with `check still
running`, and nothing re-evaluates the PR afterwards. It sits unapproved with no error anywhere. The
`workflow_run` trigger supplies the missing "CI is green now" signal.

Set `workflows:` to the `name:` of **every** workflow that gates PRs. Whichever finishes last is the
run that sees all other checks complete, so one left out is a PR that never gets re-evaluated. Find
them by reading `.github/workflows/`, not by watching what ran on the PR that adds this file: that PR
usually touches only `.github/workflows/`, so a path-filtered workflow stays silent on it and looks
like it doesn't exist. Watch for the array form (`on: [push, pull_request]`) too. The
[`pr-auto-approve-setup`](../skills/pr-auto-approve-setup/SKILL.md) skill has the enumeration command.

The template ships all three pieces wired up. Keep both the `workflow_run` branch in the job `if:` and
`github.event.workflow_run.pull_requests[0].number ||` in the concurrency group. The `if:` branch's
`pull_requests[0] != null` check matters: `workflow_run` fires for every completed run of the named
workflow, including non-PR runs such as a push to main, which have an empty `pull_requests` array.
Without the guard those trigger a wasted job run and a noisy "skipped" Slack notification.

### Copilot cannot re-trigger the workflow

`workflow_run` fixes the case where Copilot reviews **before** CI. The mirror case, Copilot reviewing
**after** CI, is the common one, and no trigger can fix it because every signal Copilot could send is
suppressed:

| Signal | Why it never runs the job |
| ------ | ------------------------- |
| `check_run` | Copilot's check run, where it registers one, is created with `GITHUB_TOKEN` (recursion guard) |
| `pull_request_review` | The run **is** created, then held at `action_required` pending manual approval |
| `workflow_run` from Copilot's own review workflow | Same actor, so same approval gate |

For the second row, the investigation in
[#41](https://github.com/SteerSpec/strspc-pr-review/pull/41)
([merge commit](https://github.com/SteerSpec/strspc-pr-review/commit/538c735f09f1c3f157dc6e8639a330e8d69a22bc))
found no configuration mistake that the maintainers could identify. The same workflow, event and actor ran normally in July 2026 and were
later held at `action_required`, with no enterprise policy, no enabled org Actions policy, and an
unchanged fork-PR approval tier. One of the two runs is
[public](https://github.com/SteerSpec/strspc-pr-review/actions/runs/30169448476).

So the wait has to happen inside a run that a non-gated actor started. Set
`wait-for-copilot-seconds`, and a run started by a non-gated actor, such as **CI completing**, polls
until Copilot's check finishes rather than skipping with `check still running`:

```yaml
      - uses: SteerSpec/strspc-pr-review@v1
        with:
          bot-login: ${{ vars.STRSPC_PR_AUTO_APPROVE_BOT_LOGIN || vars.PR_AUTO_APPROVE_BOT_LOGIN }}
          bot-github-token: ${{ secrets.BOT_GITHUB_TOKEN }}
          wait-for-copilot-seconds: '600'   # or set STRSPC_PR_AUTO_APPROVE_WAIT_FOR_COPILOT_SECONDS
```

Copilot no longer registers a check run on the head, according to the `wait-for-copilot-seconds`
description in
[`action.yml` at v1.10.3](https://github.com/SteerSpec/strspc-pr-review/blob/v1.10.3/action.yml). The
same budget therefore also polls the PR's reviews until Copilot has reviewed the current head, or enough
rounds exist for `rounds-threshold`. A run that starts seconds before the review lands waits for it
instead of skipping with `no Copilot review yet`. After a wait the check runs are fetched again and the
CI gates re-applied, so a rerun or a late check still blocks.

The run that waits is not only the one started by CI completing. Any run that finds Copilot's check
pending waits, and it also waits through every other check still running, CI included, even when
Copilot finishes first. A failed check ends the wait at once. This matters because CI's `workflow_run`
can fail to arrive. On [#198](https://github.com/SteerSpec/strspc-pr-review/issues/198), the only run
started when `PR title` completed, skipped while CI ran, and nothing evaluated the PR again. A later
run, such as CI's, cancels the waiting one through the concurrency group and takes over. On a private
repo that means a run can bill minutes from the first completed workflow until CI finishes.

It's opt-in (`0` by default) because waiting consumes billable Actions minutes on private repos, and
it's free on public ones. Use `600`. In a sample of 422 Copilot reviews on 241 PRs across public and non-public
SteerSpec repositories ([#158](https://github.com/SteerSpec/strspc-pr-review/pull/158),
[merge commit](https://github.com/SteerSpec/strspc-pr-review/commit/a25804c7bcaca82872747e81dc2e979de85745ad),
merged 2026-11-02), Copilot
finished a median 111s after the last CI check, but more than 300s after it on 11% of them and more than
600s after on 3%. The wait ends as soon as Copilot and the checks it waits on finish, so the larger
budget costs minutes only when the review or a check is slow or never comes.

No budget covers a review that starts long after CI, such as a re-requested review or one Copilot
picks up late: the sweep below or the next push re-evaluates the PR.

Both waits share one `wait-for-copilot-seconds` budget:

- The check-run wait starts only while Copilot's check is pending. Once started, it also waits for
  every other pending check, so a slow or hung job can use up the budget. A failed check ends it at
  once.
- The review wait only starts once every check has completed, and it gets whatever budget the
  check-run wait left. It ends as soon as Copilot has reviewed the current head.

On expiry the action logs a warning and skips as before. A Copilot check that finishes red is still
caught by the normal failing-check gate, and the gates are re-applied after the review wait.

### The sweep: a fallback for an event that never arrives

Every rule above depends on an event of the PR starting a run at the right moment, and GitHub does not
always deliver one. CI's `workflow_run` can fail to arrive (#198). A run that Copilot's review starts is
held at `action_required`. A review that lands after every budget has run out has nothing left to wake
the action. Each leaves the PR unapproved until someone pushes.

The template's `schedule:` and `workflow_dispatch:` triggers start a sweep. A run started by either
event carries no PR, so the action lists the open PRs and evaluates each one that the job `if:` would
admit, meaning its base is in `base-branch`, it is not a draft, and its head is in this repository. Each
gets the same rules as a run started by its own event. The sweep differs in four ways:

- It never waits for Copilot, whatever `wait-for-copilot-seconds` says. It evaluates one PR after
  another, and a PR still in progress has events to come.
- It evaluates the 30 most recently opened PRs at most, and warns when there are more.
- Its outputs sum up the sweep. `decision` is `approved` when it approved at least one PR, `reason`
  names each approved PR with its own reason, and the `pr_*` outputs describe the first. Each PR still
  logs its own `pr-auto-approve pr=<n> decision=…` line.
- It notifies Slack only when it approves or fails, because a PR parked for a human would otherwise
  post the same skip on every tick.

Sweeps share one concurrency group, `pr-auto-approve-<repo>-sweep`, and are never cancelled. A sweep
never cancels a PR's own run, which may be waiting for Copilot. If a sweep and a PR's own run
evaluate the same head at the same moment, the worst case is two bot approvals of that head. Each
run checks first whether the bot has already approved it.

Cost: one short run per tick, about a minute billed on a private repo, or some 720 minutes a month at
the template's hourly cron. Each open PR adds a dozen or so API calls. GitHub runs schedules only from
the default branch's copy of the workflow, can start them late, and disables them in a public repo
with no activity for 60 days. To keep only the manual run, delete `schedule:`. Start one with
`gh workflow run <caller>.yml`.
