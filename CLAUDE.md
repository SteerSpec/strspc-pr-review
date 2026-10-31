# Agent Instructions

This project uses **bd** (beads) for issue tracking. Run `bd prime` for full workflow context.

## Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work atomically
bd close <id>         # Complete work
bd dolt push          # Push beads data to remote
```

## Non-Interactive Shell Commands

**ALWAYS use non-interactive flags** with file operations to avoid hanging on confirmation prompts.

Shell commands like `cp`, `mv`, and `rm` may be aliased to include `-i` (interactive) mode on some systems, causing the agent to hang indefinitely waiting for y/n input.

**Use these forms instead:**
```bash
# Force overwrite without prompting
cp -f source dest           # NOT: cp source dest
mv -f source dest           # NOT: mv source dest
rm -f file                  # NOT: rm file

# For recursive operations
rm -rf directory            # NOT: rm -r directory
cp -rf source dest          # NOT: cp -r source dest
```

**Other commands that may prompt:**
- `scp` - use `-o BatchMode=yes` for non-interactive
- `ssh` - use `-o BatchMode=yes` to fail instead of prompting
- `apt-get` - use `-y` flag
- `brew` - use `HOMEBREW_NO_AUTO_UPDATE=1` env var

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:ca08a54f -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd dolt push
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
<!-- END BEADS INTEGRATION -->


## Build & Test

Node 22 (`.nvmrc`). The unit tests use the native test runner and need no external tools.

```bash
npm install
npm test               # unit tests: scripts/pr-auto-approve/*.test.js
npm run test:coverage  # same tests + coverage gate (80% line / 70% branch); this is what CI runs
npm run lint           # actionlint (workflows) + shellcheck (e2e scripts) + issue-form schema
```

`npm run lint` shells out to `actionlint`, `shellcheck` and `python3` — install them separately.
End-to-end tests run against a sandbox repo; see `e2e/pr-auto-approve/README.md`.

## Architecture Overview

A composite GitHub Action (`action.yml`) that approves a PR, as a bot account, once GitHub
Copilot's review is clean or after N review rounds (default 3). Everything is API calls; the action
never checks out PR code.

- `action.yml` — the composite entry point: inputs, outputs, and the steps that gather PR state.
- `scripts/pr-auto-approve/decide.js` — all approval rules. CI passed, Copilot reviewed the current
  head, zero inline comments and no suppressed-comments block, or the rounds threshold reached;
  `CHANGES_REQUESTED` always blocks. Every run emits a one-line `reason`.
- `templates/pr-auto-approve.yml` — the caller workflow repos copy. Its `if:` pre-filters the base-branch,
  draft and fork gates that `decide.js` also enforces, so changes to the trigger set must be mirrored
  there and in callers.
- `.github/workflows/pr-auto-approve.yml` — the older reusable workflow, deprecated but kept for
  compatibility.
- `skills/` — Claude Code skills (setup, diagnose, caller-sync), published through the
  `SteerSpec/.claude` marketplace at this repo's release tag.
- `.github/workflows/sync-marketplace-pin.yml` — after a release, opens the PR in `SteerSpec/.claude`
  that moves that pin. It selects the marketplace entry by `source.url`, not by name.
- `e2e/pr-auto-approve/` — synthetic end-to-end harness (`run.sh`, `lib.sh`) against a sandbox repo.
- `rules/` — the `dev.steerspec.prreview` realm. `APPROVE` states what the approval logic must
  guarantee, so a behaviour change in `decide.js` goes with a rule change. Edit it only through the
  `strspc` CLI, and use a `chore(rules):` title: `feat:` or `fix:` would release the action.

## Conventions & Patterns

- Branch from `develop` and open PRs against `develop`; `main` only receives release promotions.
  release-please tags `vX.Y.Z` on merge to `main` and moves the `@v1` tag.
- Merge methods are enforced by rulesets: squash only into `develop` (`merge-method-develop`), merge
  commit only into `main` (`merge-method-main`), so release-please sees each commit from `develop`.
  The squash commit takes the PR title when a PR has several commits, and the commit's own subject
  when it has one (`squash_merge_commit_title` is `COMMIT_OR_PR_TITLE`), so CI requires a one-commit
  PR's title to match that subject.
- Conventional Commits (`@commitlint/config-conventional`), enforced by the husky `commit-msg`
  hook, and for PR titles by the `commits` CI job (120 characters at most). Use `docs:`/`chore:` for
  non-code changes so release-please does not cut a release for them.
- Docs are tested against the code: `docs.test.js` fails if `README.md`'s Inputs/Outputs tables
  drift from `action.yml`; `skills.test.js` only checks that every input named in a
  `skills/*/SKILL.md` YAML snippet exists in `action.yml` (it does not cover outputs or require
  every input to be documented). When you change an input or output, update all three in the
  same PR.
- `AGENTS.md` is a symlink to this file. `CLAUDE.md` must stay a regular file: SteerSpec Sync rewrites it in place, and a symlink makes the sync PR commit the whole file as the link target, which breaks checkout.
- Workflow files carry long comments explaining non-obvious choices (why `pull_request_target`,
  why `workflow_run` is the re-entry point, why BOT_TOKEN rather than GITHUB_TOKEN). Read them
  before changing a trigger, and keep the comment true when you do.
