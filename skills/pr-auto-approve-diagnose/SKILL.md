---
name: pr-auto-approve-diagnose
description: Use when a PR is not being auto-approved by the pr-auto-approve action, or when investigating why the bot approved, skipped, or never ran — "why isn't my PR approved", "the bot didn't approve", "auto-approve did nothing", a PR stuck as BLOCKED, or a run whose decision needs explaining.
---

# Diagnosing pr-auto-approve

Every run logs exactly one `decision=` line with a `reason`. Find that line first — it answers the
question in almost every case, and guessing without it wastes time.

## 1. Find the decision

```bash
gh run list --workflow=auto-approve.yml --limit 10 \
  --json databaseId,event,status,conclusion,createdAt,headBranch
gh run view <id> --log | grep 'decision='
```

**`gh run list --branch <pr-branch>` will not show the runs that matter.** `workflow_run`-triggered
runs carry `headBranch` = the **default branch**, not the PR's branch — so filtering by branch
silently hides the exact runs that do the approving. Query the workflow instead.

## 2. Read the reason

### Nothing ran at all

| Symptom | Cause |
|---|---|
| No run for the event | The `if:` excluded it — check `base.ref`, `draft`, and the fork guard |
| A `pull_request_review` run with `conclusion: action_required` | GitHub is holding it for approval, **not** a failure. Runs triggered by an actor with no repo membership (notably `Copilot`) are gated this way |
| No run after Copilot reviewed | Expected. Copilot cannot trigger this workflow — use `wait-for-copilot-seconds` |

### The action ran and skipped

| `reason` | What it means |
|---|---|
| `no Copilot review yet` | Copilot hasn't reviewed. Confirm automatic Copilot review is enabled |
| `no checks on head SHA yet` | No check runs exist. Either CI hasn't started, or the repo has no PR-time CI at all |
| `check still running: <name>` | Waiting on that check. If it's `copilot-pull-request-reviewer` and never resolves, set `wait-for-copilot-seconds` |
| `failing check: <name> (<conclusion>)` | That check didn't pass. Approval requires all green. If `<name>` is `copilot-pull-request-reviewer`, see [§2a](#2a-copilots-check-is-red-but-its-review-is-clean) — the review can be clean and the check still red |
| `latest Copilot review requested changes` | `CHANGES_REQUESTED` always blocks, regardless of round count |
| `latest Copilot review has N comments` | Inline comments present and round count below `rounds-threshold` |
| `latest Copilot review has N suppressed comment(s)` | Copilot's summary looked clean but it hid findings in a collapsed block in the review **body**. Open the review and expand it |
| `latest Copilot review is for an older commit (…)` | You pushed after Copilot reviewed. Wait for re-review — no action needed |
| `latest Copilot review has no commit_id…` | Freshness can't be proven. Check the reviewer really is Copilot |
| `PR author is the bot itself` | Self-approval is blocked by GitHub. Expected |
| `PR already approved (reviewDecision=APPROVED)` / `bot already approved head <sha>` | Idempotent no-op. Already done |
| `check_run:` / `workflow_run:` prefixed skips | The event carried no usable PR — draft, fork, wrong base, or a non-PR run |
| `evaluation failed: …` | An API error, deliberately converted to a skip so it never reds a required check. The status code is in the message |

## 2a. Copilot's check is red but its review is clean

Copilot's **review** and Copilot's **check run** succeed or fail independently. The gate reads the
check, so a clean review sitting in the UI does not mean the check passed:

```
pr-auto-approve decision=skip reason=failing check: copilot-pull-request-reviewer (failure)
```

The action is right to refuse — a red check is a red check, and approving past one would hollow out
the whole gate. But the cause is often GitHub-side and transient: Copilot finishes its analysis,
posts the review, then fails to report results back to its own backend.

Confirm by reading the Copilot job log:

```bash
gh run view <copilot-run-id> --log | grep -E 'resultCount=|sweagentd|CAPI proxy'
```

`resultCount=1` followed by `Error reporting results to sweagentd … CAPI proxy POST … fetch failed`
is the transient shape — the review was produced and delivered; only the status report died. A
genuine failure looks different, and the review will be missing rather than present.

**Nothing recovers it automatically.** All three obvious routes are dead ends:

| Attempt | Result |
|---|---|
| Re-run the Copilot run | `This workflow run cannot be retried` — it is a dynamic run |
| Re-request Copilot as a reviewer | `422 Reviews may only be requested from collaborators` |
| Wait for Copilot's review to re-trigger the action | Its review submission produces no workflow run at all |

**Recovery: push a new commit.** Only a new head SHA re-runs Copilot. Make it a real change rather
than an empty one if the branch is going to be reviewed by a human afterwards.

## 2b. The check is green and the PR still says REVIEW_REQUIRED

If `auto-approve` reports **success** but the PR was never approved, and the log has **no
`decision=` line at all**, the evaluation threw. API errors are deliberately converted to a skip so
an outage never reds a required check — which means a permanent misconfiguration looks exactly like
a healthy run.

```bash
gh run view <id> --log | grep 'evaluation failed'
```

The message names the request that was refused:

```
evaluation failed: 403 GET /repos/o/r/commits/<sha>/check-runs — Resource not accessible…
```

A `403` on `/check-runs` has one cause worth knowing: reading check runs needs the **`Checks`**
permission, and **fine-grained PATs cannot be granted it**. Reads must go through the workflow's
`GITHUB_TOKEN` (the `github-token` input, which defaults to it) and the caller must grant
`checks: read`. This fails *only on private repositories* — check runs are readable without the
permission on public ones — so it will have worked everywhere you tested.

## 3. Tools that will mislead you

These cost real debugging time — prefer the right-hand column.

| Don't trust | Use instead | Why |
|---|---|---|
| `gh pr view --json reviews` | `gh api repos/{o}/{r}/pulls/{n}/reviews` | It **omits Copilot's review entirely**, making a reviewed PR look unreviewed |
| `gh pr checks` | `gh run view <id> --json status,conclusion` | Serves stale data — shows `pending` for runs that finished |
| The Copilot **workflow run** status | The **check run** on the head SHA | The workflow run can read `in_progress` long after the check completed |
| Copilot's **review** in the PR UI | The **check run** conclusion | They fail independently. A clean review can sit above a red check, and the gate reads the check — see [§2a](#2a-copilots-check-is-red-but-its-review-is-clean) |
| `gh run list --branch <pr-branch>` | `gh run list --workflow=auto-approve.yml` | `workflow_run` runs are attributed to the default branch |

Copilot's check on a commit:

```bash
gh api repos/{owner}/{repo}/commits/<head-sha>/check-runs \
  --jq '.check_runs[] | select(.name=="copilot-pull-request-reviewer") | "\(.status)/\(.conclusion)"'
```

Copilot's review, including its `commit_id` (which drives the freshness rule):

```bash
gh api repos/{owner}/{repo}/pulls/<n>/reviews \
  --jq '.[] | "\(.user.login) \(.state) \(.commit_id[0:8])"'
```

## 4. Confirming the wait actually worked

When `wait-for-copilot-seconds` is doing its job, the approving run stays alive for minutes rather
than seconds:

```bash
gh run view <id> --json attempt,startedAt,updatedAt,conclusion
```

`attempt: 1` with a multi-minute span between `startedAt` and `updatedAt` means it waited and
approved unattended. `attempt: 2` means a human re-ran it — the gap isn't closed yet.

On timeout the run logs `gave up waiting for copilot-pull-request-reviewer after Ns` and skips
exactly as before.

## 5. PR merged but still shows REVIEW_REQUIRED

The bot never approved; it was merged by a bypass. Check:

```bash
gh pr view <n> --json reviewDecision,mergeStateStatus
```

Common causes: it was the bootstrap PR that added the workflow (which cannot approve itself under
`pull_request_target`), or an unresolved review thread is blocking while the ruleset requires thread
resolution.
