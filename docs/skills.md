# Claude Code skills

Back to the [README](../README.md).

## Claude Code skills

If you use [Claude Code](https://claude.com/claude-code), this repo ships skills that automate the
setup and the debugging. Both lines are needed: adding the marketplace registers it, and the skills
live in their own cross-linked plugin resolved from this repository at its release tag.

```text
/plugin marketplace add SteerSpec/.claude
/plugin install strspc-pr-review-skills@steerspec
```

| Skill | Use it when |
| ----- | ----------- |
| `pr-auto-approve-setup` | Adding the action to a repo: it walks the prerequisites and the traps in the [usage guide](usage.md) |
| `pr-auto-approve-diagnose` | A PR isn't being approved and you need the `reason` behind it |
| `pr-caller-sync` | The action changed and caller repos need matching updates |

The skills live in [`skills/`](../skills/) and are pinned by release tag in the marketplace, so an
installed skill always matches a released version of the action. They're a convenience, not a
requirement: everything they do is documented in this repository.
