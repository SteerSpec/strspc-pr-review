# Reference: inputs and outputs

Every input of the action, its default, and its outputs. Back to the [README](../README.md).

## Inputs

### Required

| Input | Default | Description |
| ----- | ------- | ----------- |
| `bot-login` | | GitHub login of the bot that posts the approval |
| `bot-github-token` | | PAT for `bot-login`, used to post the approval. Needs `Pull requests: write` only |

### Approval rules

| Input | Default | Description |
| ----- | ------- | ----------- |
| `base-branch` | `main` | Base branch(es) PRs must target: one branch or a comma-separated set such as `develop,main` |
| `rounds-threshold` | `3` | Copilot review rounds before approving regardless of inline comments |
| `rounds-by-type` | `''` | Rounds per Conventional Commit type, read from the PR title, such as `docs:1,chore:0,fix:3,default:3`. `0` means Copilot isn't required for that type (approve on green CI). A type below the default applies only when every changed file matches `copilot-optional-paths`. Empty uses `rounds-threshold` for all PRs. See [Per-type rounds](per-type-rounds.md) |
| `copilot-optional-paths` | `**/*.md,docs/**/*.md` | Globs. A type mapped below the default (`0` included) applies only when every changed file matches, otherwise the PR uses the default (`default` entry, else `rounds-threshold`). Stops a code change from borrowing a relaxed title |
| `protected-paths` | `''` | Comma-separated globs, such as `rules/**,.strspc/**`. A PR changing a matching file is handled by `protected-paths-mode` before every other rule. Empty turns this off. See [Protected paths](protected-paths.md) |
| `protected-paths-mode` | `manual` | `manual` waits for a human, `allowlist` applies the normal rules only when every party is on `protected-paths-allowed`, `approve` always applies them. An empty or unknown value means `manual` |
| `protected-paths-allowed` | `''` | Comma-separated logins, without `@`, for `allowlist`. Empty allows nobody |
| `copilot-clean-on` | `verdict` | Which verdicts in Copilot's review overview can pass as clean. `verdict` passes only `Approval recommended`. `no-open-issues` also passes `Needs a closer look` when the body states `No open issues`. An unrecognised value reads as `verdict` and logs a warning. See [Passing Needs a closer look](how-it-works.md#passing-needs-a-closer-look) |
| `promotion-branches` | `''` | Comma-separated `head:base` pairs approved without a Copilot review, such as `develop:main`. Each base must also be in `base-branch`. A malformed entry is ignored with a warning. Empty turns this off. See [Promotion PRs](how-it-works.md#promotion-prs) |
| `release-branches` | `''` | Comma-separated `source:base` pairs whose release-please PRs are approved without a Copilot review, such as `develop:main`, or a bare base for a repo with no source branch. Needs `release-author`, and each base must also be in `base-branch`. A malformed entry is ignored with a warning. Empty turns this off. See [Release PRs](how-it-works.md#release-prs) |
| `release-author` | `''` | Login that must have authored a release PR and all its commits, such as `my-release-app[bot]`. Without it, `release-branches` refuses every release PR |
| `allow-no-checks` | `false` | When `true`, skip the "all checks must pass" gate when no external CI check runs exist for the head SHA, such as docs-only PRs |

### Copilot

| Input | Default | Description |
| ----- | ------- | ----------- |
| `request-copilot-review` | `false` | When `true`, the action requests the Copilot review itself and skips types set to `0` in `rounds-by-type`. Turn off the ruleset's automatic Copilot review first. Needs `pull_request_target` with the `edited` type in the caller. Failures only warn |
| `copilot-error-retries` | `0` | Times to re-request Copilot's review on the same commit when Copilot reviewed nothing because its run errored or the requester was out of quota. Such reviews never approve or count as rounds. `0` disables, and failures only warn |
| `wait-for-copilot-seconds` | `0` | Seconds to wait for Copilot's review (its check run when it's the **last** check still running, or the review itself when no check run exists) instead of skipping. `0` disables. See [Copilot cannot re-trigger the workflow](usage.md#copilot-cannot-re-trigger-the-workflow) |

### Tokens

| Input | Default | Description |
| ----- | ------- | ----------- |
| `github-token` | `${{ github.token }}` | Token used for every **read**: check runs, the PR, its reviews. The default is what makes this work on private repos, see [Prerequisites](../README.md#prerequisites) |

### Slack

| Input | Default | Description |
| ----- | ------- | ----------- |
| `slack-channel` | `alert-pr-notifications` | Slack channel for notifications |
| `slack-bot-token` | `''` | Slack bot token (`xoxb-...`) with `chat:write` scope |

### Testing only

| Input | Default | Description |
| ----- | ------- | ----------- |
| `sandbox-repos` | `''` | Comma-separated `owner/repo` list where bot-authored PRs are allowed (e2e only) |
| `test-copilot-logins` | `''` | Extra logins treated as Copilot in sandbox repos (e2e only) |

## Outputs

| Output | Description |
| ------ | ----------- |
| `decision` | `approved`, `skip`, or `error` |
| `reason` | Human-readable explanation |
