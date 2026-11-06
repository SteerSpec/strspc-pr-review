<div align="center">

<img src="https://steerspec.dev/assets/logo.svg" alt="SteerSpec logo" width="96" height="96">

# PR Auto-Approve (Copilot)

**A GitHub Action that approves a pull request, as a bot account, once CI is green and GitHub Copilot's review is clean, for maintainers whose rulesets require an approving review that nobody is available to give.**

[![GitHub Marketplace](https://img.shields.io/badge/Marketplace-PR%20Auto--Approve-161B22?labelColor=161B22&logo=github&logoColor=3FB950)](https://github.com/marketplace/actions/pr-auto-approve-copilot)
[![CI](https://github.com/SteerSpec/strspc-pr-review/actions/workflows/test-pr-auto-approve.yml/badge.svg)](https://github.com/SteerSpec/strspc-pr-review/actions/workflows/test-pr-auto-approve.yml)
[![Release](https://img.shields.io/github/v/release/SteerSpec/strspc-pr-review?labelColor=161B22&color=161B22)](https://github.com/SteerSpec/strspc-pr-review/releases)
[![License](https://img.shields.io/badge/License-Apache%202.0-161B22.svg?labelColor=161B22)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-161B22.svg?labelColor=161B22)](.nvmrc)

</div>

## What it will and won't do

It approves without a human click. It skips when the review is stale, when Copilot hid findings from the
inline comments, when a check fails, or when the commit changed.

It approves on Copilot's verdict, or, for promotion and release PRs, when its gates find no commit or
file that wasn't already reviewed or owned by release-please. Neither is a human reviewer. It never
merges. For where to keep human review, see [Responsible use](docs/responsible-use.md).

## Install

### Prerequisites

| You need | Details |
| -------- | ------- |
| **Copilot code review, set to review PRs automatically** | By default the action reads Copilot's verdict and doesn't trigger Copilot itself, so if Copilot never reviews, every run skips with `no Copilot review yet`. Enable it under **Settings → Code review → Copilot**, or with an org or repo ruleset that requests Copilot on PRs. To have the action request the review instead, set [`request-copilot-review`](docs/inputs.md#copilot) |
| **A dedicated bot GitHub account** | Not your own: GitHub blocks self-approval, so the approving account must differ from PR authors. Add it to the repo as a **collaborator with write access**. Its login is `bot-login` |
| **A fine-grained PAT for that account** | Stored as the `BOT_GITHUB_TOKEN` secret, with **`Pull requests: write` and nothing else**. It posts the approval, which must come from an account that isn't the PR author. The classic-PAT equivalent is `repo`, which also works but grants far more than this action can use |

There's nothing to install: the action runs on `github-script` (Node) inside the Action itself.

Which token does what, and the permissions the caller needs: [Tokens](docs/usage.md#tokens).

### Quick start

**1. Copy the workflow template**

```bash
curl -o .github/workflows/pr-auto-approve.yml \
  https://raw.githubusercontent.com/SteerSpec/strspc-pr-review/v1/templates/pr-auto-approve.yml
```

**2. Set the bot login** as an organization or repository variable

```text
STRSPC_PR_AUTO_APPROVE_BOT_LOGIN = <your-bot-account-login>
```

**3. Add the bot token** as an organization or repository secret

```text
BOT_GITHUB_TOKEN = <PAT for the bot, with Pull requests: write>
```

**4. Optionally, add Slack notifications**

```text
SLACK_BOT_TOKEN = <xoxb-... token with chat:write scope>
```

Then open a PR targeting your base branch. Every other setting is optional and also comes from a
variable, see [Organization-wide configuration](docs/usage.md#organization-wide-configuration).

## Where to go next

| I want to | Read |
| --------- | ---- |
| Know when the action approves and when it skips | [How it works](docs/how-it-works.md) |
| Write the caller workflow and set org-wide variables | [Usage](docs/usage.md) |
| Look up an input, its default or an output | [Inputs and outputs](docs/inputs.md) |
| Ask for fewer review rounds on docs or chores | [Per-type rounds](docs/per-type-rounds.md) |
| Hold changes to policy files for a human | [Protected paths](docs/protected-paths.md) |
| Find out why a PR wasn't approved | [Troubleshooting](docs/troubleshooting.md) |
| Set up or debug with Claude Code | [Claude Code skills](docs/skills.md) |
| Decide where not to use it | [Responsible use](docs/responsible-use.md) |
| Understand branches, releases and the `@v1` tag | [Branching and releases](docs/releases.md) |
| Run the tests or change the code | [Development](docs/development.md) |

## Governance

Open source software by Consulare. See [NOTICE](NOTICE) for the copyright holder.

Licensed under Apache 2.0, see [LICENSE](LICENSE).

This repository is the `dev.steerspec.prreview` realm. [`rules/APPROVE.json`](rules/APPROVE.json)
states what the approval logic must guarantee, so a behaviour change in `decide.js` goes with a rule
change. [`rules/E2E.json`](rules/E2E.json) states what the end-to-end suite must cover and when it
gates a merge into `main`. All rules are Draft today.

Edit them only through the [`strspc` CLI](https://github.com/SteerSpec/strspc-CLI), never by hand, so
versions and hashes stay consistent. Use a `chore(rules):` title for a rule-only PR.

## Security

Report a vulnerability privately through **Security → Report a vulnerability** on this repository, and
never as a public issue. See the
[security policy](https://github.com/SteerSpec/strspc-pr-review/security/policy).

## Community

Follow [Conventional Commits](https://www.conventionalcommits.org/), which the commit hook enforces.
Branch from `develop` and open your PR against `develop`, because `main` only receives release
promotions.

- [Contribution guide](https://github.com/SteerSpec/.github/blob/main/CONTRIBUTING.md)
- [Code of conduct](https://github.com/SteerSpec/.github/blob/main/CODE_OF_CONDUCT.md)
