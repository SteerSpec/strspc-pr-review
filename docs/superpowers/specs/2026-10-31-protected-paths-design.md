# Protected paths design

Status: awaiting owner approval. Tracks issue #125 and, for this repository, bead `strspc-pr-review-0np`.

## Why

The action can auto-approve any path, including the files that define a repository's own policy. In
SteerSpec repositories `rules/` and `.strspc/config.yaml` decide what `strspc check` enforces, so this
has to be settled before any `APPROVE` rule reaches Implemented.

The owner's target is agent-based development, with the human role disappearing. So this is a policy
with a mode per repository, not a fixed "a human must look at this". The repository chooses what
happens when a PR touches a protected path.

This is a generic feature of a public Marketplace action. Nothing in it may assume SteerSpec.

## Goals

- A repository can list globs that trigger a policy, and pick that policy through an input.
- A PR that matches and isn't allowed through is never auto-approved, on any event.
- A bot approval is taken back if a later push makes the PR match.
- Every failure to tell whether a PR matches ends in no approval.
- With the inputs unset, behaviour and API calls are exactly what they are today.

## Non-goals

These are deferred, each with its own bead:

- Closing a PR automatically (`strspc-pr-review-kwh`).
- A denied list, and so APPROVE-019 (`strspc-pr-review-e1p`). It stays Draft, which leaves one "done
  when" item of #125 unmet by this work.
- Defending against someone with write access deliberately bypassing the gate (`strspc-pr-review-7q7`).
  This design covers accidents. It doesn't defend against a PR editing its own caller workflow, and
  commit identity can be faked. No documentation may claim otherwise.
- The optional Copilot instructions template from #125 (`strspc-pr-review-8tt`).
- The deprecated reusable workflow. It gets no new inputs, and unset variables leave the feature off
  there.

## Anti-goals

- A failed API call must never approve a PR.
- Setting `protected-paths` and forgetting the mode must never approve a matching PR.
- Being on the allowed list must never skip CI or the Copilot gates. It only lets normal rules apply.

## Inputs

| Input | Value | Default | Variable |
|---|---|---|---|
| `protected-paths` | Comma-separated globs | Empty, feature off | `STRSPC_PR_AUTO_APPROVE_PROTECTED_PATHS` |
| `protected-paths-mode` | `approve`, `manual` or `allowlist` | `manual` | `STRSPC_PR_AUTO_APPROVE_PROTECTED_PATHS_MODE` |
| `protected-paths-allowed` | Comma-separated logins | Empty, nobody allowed | `STRSPC_PR_AUTO_APPROVE_PROTECTED_PATHS_ALLOWED` |

The issue's name, `human-review-paths`, is dropped because a human may no longer be involved.

A caller using an unset variable passes an empty string, so `decide.js` must treat an empty mode as
`manual`. An unrecognised mode also means `manual`, with a `core.warning`.

## Behaviour

| Mode | PR touches a protected path, every party allowed | PR touches a protected path, any party not allowed |
|---|---|---|
| `approve` | Normal rules | Normal rules |
| `manual` | Wait for a human | Wait for a human |
| `allowlist` | Normal rules | Wait for a human |

"Normal rules" means the existing evaluation, unchanged. "Wait for a human" means: withdraw any bot
approval on the PR, then finish with `decision=skip` and a reason naming the first matching path and
the mode. A skip doesn't turn a check red.

A protected-path refusal beats the rounds threshold and `rounds-by-type`, including `0`.

`approve` needs no file list, so it makes no extra API call. A PR that matches nothing gets normal
rules in every mode.

## Evaluation

The check runs in `decideInner` on every event, after the draft, fork and bot-author checks and before
`applyPathGate`. It is the first gate that can act on the PR's contents, so CI, the Copilot waits and
`reviewDecision`, which all return early, can't leave a stale approval standing.

1. **List the files.** Use `compareHead`, so the list belongs to the evaluated head SHA. It already
   returns `null` for a list of 300 or more entries. Renames count through `previous_filename`.
2. **Match.** Any changed file matching any glob is a match, using `globToRegExp`. Existing
   `filesMatchPaths` requires every file to match, so a new any-match helper is needed. Empty globs
   are dropped.
3. **Stop on "can't tell".** A `null` list, no merge base, or a thrown comparison means wait for a
   human in `manual` and in `allowlist`. This comes before the party check, so an allowed party can't
   pass a PR whose files aren't fully known. An allowed agent's PR of 300 or more files therefore
   waits. An empty file list isn't a match.
4. **Decide.** In `allowlist` mode, resolve the parties below. Then apply the table above.
5. **Hold the result to the approval.** Every result that used the comparison rests on it: no match,
   and an `allowlist` pass, whose commit list comes from the same comparison. The merge base must be
   re-verified before and after approving, as `gate.mergeBase` already is for relaxed thresholds.
   Without this, a rewritten base could change the diff or the parties unnoticed.

If `applyPathGate` has also listed files, avoid a second identical request where that's simple.

### Parties, for `allowlist`

The parties are the PR author, plus the author and committer of every commit on the PR.

- Commits come from the same SHA-addressed comparison, `compareCommitsWithBasehead`, paginated. It uses
  `author.login` and `committer.login` on each commit. `pulls.listCommits` isn't used, because it
  describes whatever the head is when it's called.
- `total_commits` over 250, or fewer commits returned than `total_commits`, means not allowed.
- A commit with no linked GitHub account, so a null `author` or `committer`, means not allowed.
- `web-flow` as a committer is ignored, because it is GitHub signing a web or merge commit rather than
  a party. It still counts if a repository lists it, which has no effect, and as an author it counts
  as a party.
- Logins compare case-insensitively and exactly. `Co-Authored-By` lines are not read, because an agent
  writes those itself.
- The list is checked only in `allowlist` mode, and only for a PR that matches.

Agents currently commit as the owner's account, so allowing that account allows every agent. Telling
agents apart needs each one to commit under its own account or App. The README must say so.

## Withdrawal

Any non-dismissed `APPROVED` review by `bot-login` is dismissed when the outcome is "wait for a human",
whether or not it carries a threshold stamp. Unstamped approvals are the copilot-clean ones. #125 left
those open, and withdrawing them is simpler than deciding which still hold. It also doesn't depend on
the repository dismissing stale reviews. Human approvals are never touched.

Reuse the existing mechanics: `dismissReview` with its token fallback, and `failClosed` when reviews
can't be listed or a dismissal fails. A withdrawal failure fails the job, as APPROVE-014 requires. The
current `withdrawStampedApprovals` only sees stamped approvals, so it needs generalising or a sibling.

When the comparison itself throws, withdraw and then rethrow, so the top-level catch reports the failed
request as it does for `applyPathGate`.

## Rules

Add one rule to the `APPROVE` entity through `strspc rule add`, Draft, revision 0, one sentence:

> Unless protected-paths-mode is approve, the action MUST NOT approve a pull request whose changed
> files cannot be completely listed, or one that changes a file matching protected-paths unless
> protected-paths-mode is allowlist and every party to the pull request is on
> protected-paths-allowed, and MUST withdraw any bot approval from such a pull request.

The rule must be added once. If its text changes before the PR merges, rebuild it so it reaches the PR
at revision 0. Never hand-edit the JSON. APPROVE-019 is not touched.

## Documentation

- `action.yml`: the three inputs, and all three environment variables on the "Evaluate and approve"
  step.
- `README.md`: the Inputs table, a section on the modes, a troubleshooting row for the new skip reason,
  the agent-identity limit, and the unit test count that `docs.test.js` enforces.
- `skills/`: the setup and diagnose skills.
- `templates/pr-auto-approve.yml`: the three inputs reading their variables.
- The header comment of `decide.js`.

`pull_request_review` is described as safe in `auto-approve.yml` and the template. GitHub's docs don't
support that. Leave those comments alone in this PR, and don't repeat the claim. `strspc-pr-review-7q7`
owns it.

## Rollout

1. `feat:` PR into `develop` with the code, tests, rule and docs. It adds the template inputs but not
   the `with:` lines in `.github/workflows/auto-approve.yml`, because that file uses `@v1`, which
   wouldn't know them yet.
2. Promote and release.
3. A follow-up PR syncs `auto-approve.yml` to the template with the `pr-caller-sync` skill.
4. The owner sets `rules/**,.strspc/**` and mode `manual` as repository variables here.

A caller without the new `with:` lines never passes the inputs, and nothing reports an error, so an
org-level variable would look active while protecting nothing. This design covers this repository
only. `strspc-pr-review-0np` applies to every realm repository, so it stays open until those callers
are synced, which is separate work.

## Tests

Each of these fails alone with a specific reason:

- Inputs unset: no extra API calls.
- `approve`: no extra API calls, and normal rules apply.
- `manual`: a matching file is refused, a non-matching file gets normal rules, and a rename out of a
  protected path matches.
- `allowlist`: all parties allowed, PR author not allowed, commit author not allowed, committer not
  allowed, null author, `web-flow` committer, login case, and over 250 commits.
- A 300-file list, no merge base, and a thrown comparison each fail towards a human, in `manual` and
  in `allowlist` with every party allowed.
- A refusal beats 3-rounds and `rounds-by-type: 0`.
- A stamped and an unstamped bot approval are both dismissed, and a human approval isn't.
- A review listing failure and a dismissal failure each fail the job.
- A base rewritten during evaluation doesn't approve, for a no-match result and an `allowlist` pass.
- An empty or unknown mode behaves as `manual`.

## Left to the builder

- Function names and how the helpers are arranged.
- How the comparison result is shared between this check and `applyPathGate`.
- Exact reason strings, apart from naming the path and mode.
