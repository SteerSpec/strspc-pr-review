# Responsible use

Back to the [README](../README.md).

## Responsible use

This action rubber-stamps **Copilot's** verdict, or mechanical proof that a promotion or release PR
holds nothing new to review, and it isn't a substitute for human judgment where that matters.

- **Keep required human reviewers** (branch protection, `CODEOWNERS`) on sensitive paths. The bot's
  approval fills a review slot but shouldn't be your only gate.
- **Make any check that must block a merge a required status check** in your branch protection or
  ruleset. When a check fails on a commit the bot already approved, such as a PR title check after a
  retitle or a re-run, the action withdraws its approval, but only once it runs again. The caller
  template re-runs it when a workflow in its `workflow_run` list fails, and a check from a third-party
  app re-runs it through `check_run`. A workflow missing from that list, or a caller still on the old
  template that re-runs only on success, leaves the approval in place until something else re-runs
  the action. A required status check blocks the merge at once.
- **Treat `BOT_GITHUB_TOKEN` like any write-scoped credential.** Keep it in secrets, give it
  **`Pull requests: write` and nothing more**, and rotate it periodically.
