# Per-type rounds

Back to the [README](../README.md).

## Per-type rounds

`rounds-by-type` reads the Conventional Commit type from the **PR title**, the squash-merge title
release-please sees, so `docs` can need 1 round while `fix` needs 3:

```yaml
rounds-by-type: 'docs:1,chore:0,fix:3,default:3'
```

- **`0` means Copilot isn't required.** The PR is approved once CI is green. A Copilot
  `CHANGES_REQUESTED` review still blocks.
- **Unlisted types and non-conventional titles** use `default`, else `rounds-threshold`.
- **Add `edited` to `pull_request_target.types`** in your caller so a retitle re-evaluates the PR.
  Otherwise a `feat:` PR renamed `docs:` keeps its old decision until the next push.
- **To also stop Copilot reviewing those PRs**, disable the ruleset's "Automatically request Copilot
  code review" and set `request-copilot-review: 'true'`. GitHub can't filter automatic reviews by
  title.

### The path gate

The title is author-controlled, so a type mapped below the default (`0` or otherwise) applies only
when **every changed file matches `copilot-optional-paths`**. The default is
`**/*.md,docs/**/*.md`, Markdown only, because a script or generated page under `docs/` is code.
Otherwise the PR gets the default threshold (the `default` entry, else `rounds-threshold`; a `0` is
always gated, so `default:0` falls back to `rounds-threshold` for code), and the `reason` says so:

```text
…; type 'docs' is relaxed to 1 round(s) but the PR touches files outside copilot-optional-paths, so the default 3 applies
```

Types at or above the default are never gated and never list the PR's files. A PR touching 300 or more
files can't prove it's docs-only, because the comparison's file list stops there, and gets the
default rules.

The file list is read so that a force-push during the run doesn't change it:

- It's listed for **exactly the head SHA under evaluation**, through a `heads/<base>...<sha>` commit
  comparison rather than the PR's live file list. A force-push during the run can't swap the diff
  behind the gate, and a tag named like the base branch can't shadow it. This needs `contents: read`
  on `github-token`, which the template grants.
- The base branch and title are re-read with the head before and after approving. When the approval
  rests on the file list, the comparison's **merge base** is re-read too, so a force-push of the base
  branch can't swap the diff either. If anything changed, nothing is approved under the old inputs.

### Withdrawn approvals

The gate is re-applied on every run. An approval's stamp records the threshold it relied on, so a
`docs:1` approval earned on a docs-only diff is withdrawn once a later push adds a code file, and a
retitle that raises the required rounds above the stamp withdraws it too.

- Dismissal tries the bot token first. If GitHub refuses it (401 or 403), it retries with the
  workflow's `GITHUB_TOKEN`, so keep `pull-requests: write` in the caller's job permissions. If
  neither can dismiss it, the run fails (`decision=error`).
- If the file listing itself fails (`403` without `contents: read`, `404` after a force-push), any
  earlier bot approval stamped with a relaxed threshold is withdrawn before the run reports the
  failure.
