# Troubleshooting

Back to the [README](../README.md).

## Troubleshooting

Not approving? Every run logs a `reason`, also available as the `reason` output.

### Waiting on Copilot

| `reason` | Cause and fix |
| -------- | ------------- |
| `no Copilot review yet` | Copilot hasn't reviewed the PR. Enable **automatic Copilot code review**, see [Prerequisites](../README.md#prerequisites) |
| `no Copilot review yet (its last attempt errored; …)`<br>`… hit the requester's quota; …` | Copilot reviewed nothing: its run failed, or the person who requested the review ran out of Copilot quota. That review is ignored, not counted as clean or as a round. The text after `;` says whether the action re-requested it (`copilot-error-retries`), ran out of retries, or you should re-request it by hand |
| `latest Copilot review says it could not review any files` | Every changed file is excluded from Copilot review, so no review of this PR can come out clean, and it doesn't count as a round. Have a human approve it |
| `latest Copilot review requested changes` | Copilot posted `CHANGES_REQUESTED`, which always blocks. Address the feedback and push |
| `latest Copilot review has N comments` | Copilot left inline comments and the round count is below `rounds-threshold` (default 3). Resolve them, or let more rounds accrue |
| `latest Copilot review has N suppressed comment(s)` | Copilot's summary looked clean but it hid findings in a collapsed suppressed-comments block in the review body. Open the review, expand the section, and act on it, or let more rounds accrue |
| `latest Copilot review has verdict '…'`<br>`lists N open issue(s)`<br>`lists a previously missed issue`<br>`has section '…'`<br>`does not state no open issues` | The review's overview doesn't show it as clean, even with no new inline comments. Read the review body, fix or resolve what it lists, and push for a new review, or let more rounds accrue. `Needs a closer look` often leaves nothing to fix: read the sentence under the verdict, then have a human approve, or see [Passing Needs a closer look](how-it-works.md#passing-needs-a-closer-look). A verdict or section you don't recognise may mean Copilot changed its wording |
| `latest Copilot review has no verdict overview` | The review body isn't in the overview format the action reads, so it can't prove the review clean. Check that the reviewer really is Copilot, or let more rounds accrue |
| `latest Copilot review is for an older commit (...)` | You pushed after Copilot reviewed, so its verdict predates the current head. Wait for Copilot to re-review the new commit |
| `latest Copilot review has no commit_id...` | The review carries no commit, so it can't be tied to the head. This is unexpected from real Copilot reviews, so check the reviewer really is Copilot and not a synthetic review posted without a `commit_id` |

### Promotions that skip

| `reason` | Cause and fix |
| -------- | ------------- |
| `promotion title type '…' would be counted twice…`<br>`promotion title is marked breaking…`<br>`promotion title is not a Conventional Commit…` | Retitle the PR `chore: promote develop to main` |
| `head … is not the tip of …` | The head branch has moved. The `synchronize` run re-evaluates the new head, so there's nothing to do |
| `commit … has no merged PR into …` | The commit reached the head branch without a PR. Review it, then have a human approve the promotion |
| `commit … came from #N, which has no standing approval` | That PR merged without a [standing approval](how-it-works.md#promotion-prs): none at all, a dismissed one, one given after the merge, or one of an earlier commit. Have a human review what it changed and approve the promotion |
| `promotion has 250 commits or more…` | The commit list may be partial, so nothing can be proven. Promote more often, or have a human approve this one |
| `commit list does not include the evaluated head …` | The head was force-pushed during the run. The next run re-evaluates it |

### Release PRs that skip

| `reason` | Cause and fix |
| -------- | ------------- |
| `release-author is not set…` | `release-branches` needs `STRSPC_PR_AUTO_APPROVE_RELEASE_AUTHOR`. Set it to the login on your release PRs |
| `release PR author … is not release-author`<br>`commit … is not by release-author` | Someone other than release-please wrote this. Check `release-author`, including the `[bot]` suffix, then have a human review what changed |
| `cannot read release-please-config.json at …`<br>`… is not valid JSON`<br>`… has no packages` | The action needs that file on the base branch to know what release-please owns. Add it, or have a human approve |
| `release PR changes …, which release-please does not own` | A file outside the changelog, manifest and configured version files. If it's a version file, add it to `version-file` or `extra-files`. Otherwise have a human review it |
| `release PR changes 300 files or more…`<br>`release PR has 250 commits or more…`<br>`the comparison reported no merge base…` | Nothing can be proven from what the API returned. Have a human review it |
| `… has N unpromoted commit(s): …; promote first`<br>`… commits ahead of …; promote first` | Those commits would be lost from this release. Merge the promotion, and release-please updates this PR, which re-evaluates it |
| `cannot compare … with … (404)…` | The source branch doesn't exist. Use a bare base in `release-branches` |

### Waiting on CI

| `reason` | Cause and fix |
| -------- | ------------- |
| `check still running: <name>`<br>`no checks on head SHA yet` | CI hasn't finished. The action re-runs when it completes: through `workflow_run` for GitHub Actions CI, or `check_run` for third-party checks. If it never re-runs, see [If your CI is GitHub Actions](usage.md#if-your-ci-is-github-actions-you-need-workflow_run) |
| `failing check: <name> (<conclusion>)` | That check didn't pass. Fix CI: approval requires all checks green. An earlier bot approval of the PR is withdrawn |

### The PR changed during the run

| `reason` | Cause and fix |
| -------- | ------------- |
| `head moved from … during evaluation`<br>`PR base changed from … during evaluation`<br>`PR title changed during evaluation…` | The PR's head, base branch or title changed while the run evaluated it, so nothing was approved under the stale inputs. The next run (push, retarget or `edited` event) re-evaluates, so nothing needs fixing unless it repeats on every run |
| `PR converted to draft during evaluation` | The PR became a draft during the run, so no approval was posted. Mark it ready for review, and the template re-evaluates on `ready_for_review` |
| `PR head, base, title or draft state changed while approving; approval withdrawn` | The same race, landing between the final re-read and the approval. The approval was posted and immediately dismissed, along with any second bot approval of the same head that a retried approval request left, and the next run re-evaluates |
| `base <branch> was rewritten (merge base … -> …) during evaluation`<br>`… while approving; approval withdrawn` | The base branch was force-pushed while the run evaluated a relaxed type, so the diff the path gate judged is no longer the PR's diff. Nothing is approved, or the approval is dismissed, and the next run re-evaluates. A base that merely moved on through unrelated merges keeps its merge base and doesn't trigger this |

### Relaxed types

| `reason` | Cause and fix |
| -------- | ------------- |
| `…; type '<type>' is relaxed to N round(s) but the PR touches files outside copilot-optional-paths, so the default M applies` | The title's type is below the default in `rounds-by-type`, but the diff reaches outside `copilot-optional-paths`, so the default rules apply. The text before `;` is the ordinary reason under those rules. Expected for a code change with a relaxed title, otherwise widen the globs |
| `evaluation failed: 403 … /compare/…`<br>`evaluation failed: 404 … /compare/…` | The changed-files listing for a relaxed type failed. A `403` means the **read** token lacks `contents: read`, so restore it in the caller's job permissions. A `404` means the evaluated head SHA is no longer on the PR after a force-push, and the next run re-evaluates the new head. Either way any earlier bot approval stamped with a relaxed threshold is **withdrawn first** (`Withdrawn: the changed files of … could not be listed …`) |
| `could not list the PR's reviews, so an earlier approval stamped with a relaxed rounds-by-type threshold cannot be found and withdrawn: …` | The job fails on purpose (`decision=error`): a skip would leave such an approval standing unseen. The action already retries a 5xx or a dropped connection 3 times (1 s, 4 s and 9 s apart), so this means the outage outlasted those retries or a rate limit hit. Re-run the job once GitHub recovers. A persistent `403` means the **read** token can't read pull requests |

### Tokens and configuration

| `reason` | Cause and fix |
| -------- | ------------- |
| `evaluation failed: 403 … /check-runs` | The **read** token can't list check runs. Reads must use the workflow's `GITHUB_TOKEN` (the `github-token` input, default) and the caller must grant `checks: read`, because a fine-grained PAT can't be given the `Checks` permission. This fails **only on private repositories**, so it works everywhere you'd think to test it |
| `bot-login is empty: set the STRSPC_PR_AUTO_APPROVE_BOT_LOGIN organization or repository variable…` | The job fails on purpose. A blank `bot-login` also disables the caller's `github.actor != (vars.STRSPC_PR_AUTO_APPROVE_BOT_LOGIN \|\| …)` loop guard, so each approval would re-trigger the workflow. Set the variable at org or repo level, check an org variable's repository access, or hard-code the login in both places |
| `PR base ref '...' not in [...]`, optionally prefixed `check_run:` or `workflow_run:` | The PR targets a branch outside `base-branch`. Check `STRSPC_PR_AUTO_APPROVE_BASE_BRANCH` at repo and org level, see [Organization-wide configuration](usage.md#organization-wide-configuration) |
| Nothing runs at all | Confirm `BOT_GITHUB_TOKEN` belongs to `bot-login` with write access, and that `STRSPC_PR_AUTO_APPROVE_BOT_LOGIN` (or the older `PR_AUTO_APPROVE_BOT_LOGIN`) is set so the review-loop guard works. If the PR's base branch isn't in `STRSPC_PR_AUTO_APPROVE_BASE_BRANCH` (default `main`), the job `if:` skips it |

### Expected skips

| `reason` | Cause and fix |
| -------- | ------------- |
| `triggered by the bot's own review` | The run was started by the bot's approval and exits without evaluating. If you see many of these, the `if:` loop guard doesn't match `bot-login` |
| `PR author is the bot itself` | The bot can't approve its own PR, except in `sandbox-repos` |
