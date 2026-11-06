# Protected paths

Back to the [README](../README.md).

## Protected paths

Some files decide a repository's own policy, such as the rules `strspc check` enforces. A PR that
changes them shouldn't be approved just because Copilot found nothing to say. List them in
`protected-paths` and pick what happens in `protected-paths-mode`:

```yaml
protected-paths: 'rules/**,.strspc/**'
protected-paths-mode: 'manual'
```

| Mode | Every party allowed | Any party not allowed |
| ---- | ------------------- | --------------------- |
| `approve` | Normal rules | Normal rules |
| `manual` (default) | Wait for a human | Wait for a human |
| `allowlist` | Normal rules | Wait for a human |

Set them through `STRSPC_PR_AUTO_APPROVE_PROTECTED_PATHS`, `STRSPC_PR_AUTO_APPROVE_PROTECTED_PATHS_MODE`
and `STRSPC_PR_AUTO_APPROVE_PROTECTED_PATHS_ALLOWED`.

- **A refusal comes first.** It beats the rounds threshold and `rounds-by-type`, `0` included.
- **Waiting withdraws.** Any bot approval of the PR is withdrawn, stamped or not. Human approvals are
  left alone.
- **Not knowing means waiting.** A PR of 300 or more files, or a comparison with no merge base, waits in
  `manual` and `allowlist`, because its file list can't be shown to be complete.
- **Being allowed skips nothing.** An allowed PR still needs green CI and a clean Copilot review, or
  enough rounds.
- **Promotion and release PRs aren't gated.** They carry changes already gated one PR at a time into
  their head branch.

The parties are the PR author and every commit's author and committer, matched by login without `@`
and ignoring case. A commit with no linked GitHub account isn't allowed, and `web-flow` as committer
(GitHub signing a web or merge commit) isn't counted. A PR of more than 250 commits waits.

Know the limits:

- **Agents that commit as your account count as you.** Allowing that account allows every agent using
  it. To tell agents apart, have each commit under its own account or GitHub App.
- **This covers accidents, not someone deliberately bypassing it.** Commit identity can be faked, and a
  PR can edit its own caller workflow.
- **A caller without the new `with:` lines never passes these inputs, and nothing reports it.** An
  organization variable can look active while protecting nothing, so sync each caller to the template.
