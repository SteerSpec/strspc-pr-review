# Protected Paths Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a repository list globs that stop auto-approval, with a mode choosing what happens when a PR touches them.

**Architecture:** One new gate in `decideInner`, placed after the bot-author check and before `applyPathGate`. It lists files through the existing SHA-addressed `compareHead`, shares that comparison with `applyPathGate`, and feeds its merge base into the existing re-verification around the approval. A refusal withdraws every bot approval and skips.

**Tech Stack:** Node 22, `node:test`, composite GitHub Action, `strspc` CLI.

**Spec:** `docs/superpowers/specs/2026-10-31-protected-paths-design.md`

## Global Constraints

- Inputs: `protected-paths` (default `''`), `protected-paths-mode` (default `manual`), `protected-paths-allowed` (default `''`).
- Variables: `STRSPC_PR_AUTO_APPROVE_PROTECTED_PATHS`, `..._PROTECTED_PATHS_MODE`, `..._PROTECTED_PATHS_ALLOWED`.
- Environment: `AUTO_APPROVE_PROTECTED_PATHS`, `AUTO_APPROVE_PROTECTED_PATHS_MODE`, `AUTO_APPROVE_PROTECTED_PATHS_ALLOWED`.
- With `protected-paths` unset, API calls are exactly what they are today.
- `approve` makes no extra API call.
- `total_commits` over 250, fewer commits than `total_commits`, or a null `author` or `committer` means not allowed.
- `web-flow` is ignored as a committer only.
- Do not change `.github/workflows/auto-approve.yml` or `.github/workflows/pr-auto-approve.yml`.
- Do not repeat the `pull_request_review` "safe" claim, and leave the existing comments alone.
- Docs must say this covers accidents, not someone deliberately bypassing it.
- Never hand-edit rule JSON. Commits are signed and conventional. Agents open PRs and never merge them.
- `ANTHROPIC_API_KEY` is not passed to the check.
- Every task that adds tests sets the README's `N unit tests` to the new total in the same commit, or `docs.test.js` fails.
- Check exit codes. Never pipe a gate through `tail`.

## Review Focus

Each line has its test in the owning task.

1. A dotted or look-alike path: `.strspc/config.yaml` matches `.strspc/**`, and `rulesets/a.json` doesn't match `rules/**`. Task 1.
2. A rename into a protected path: matched through `filename`. Task 2.
3. A mode written `' Allowlist '` or `APPROVE`: read as that mode. Task 1.
4. An allowed list written ` Alice, ,bob`, or with `@alice`, and a PR with no author account: spacing and case are forgiven, `@alice` doesn't match, and no author means not allowed. Tasks 1 and 4.
5. A comparison response with no `files` key: "can't tell", not "no files changed". This tightens `compareHead`, which reads a missing list as empty today. Task 2.

---

### Task 1: Configuration readers and the comparison result

**Files:**
- Modify: `scripts/pr-auto-approve/decide.js`
- Test: `scripts/pr-auto-approve/decide.test.js`, `README.md` (count)

**Interfaces:**
- Produces, exported from `decide.js`:
  - `getProtectedPaths(env = process.env): string[]`, trimmed with empties dropped.
  - `getProtectedPathsMode(env = process.env, warn = () => {}): 'approve'|'manual'|'allowlist'`, trimmed and lowercased. Empty gives `manual` silently. Unknown gives `manual` and calls `warn` once.
  - `getProtectedPathsAllowed(env = process.env): Set<string>`, trimmed and lowercased.
  - `firstProtectedMatch(filenames: string[], globs: string[]): string|null`, first filename matching any glob.
- Produces, internal: `compareHead` also returns `totalCommits`, and `names` is `null` when `data.files` isn't an array.
- Produces, test helpers in `decide.test.js`:
  - `makeFakeGithub({ commits = [], totalCommits = commits.length })`. The fake compare slices `commits` by `page` and `per_page` and returns `total_commits`.
  - `calls.dismiss`, recorded by a default `dismissReview`.
  - `makeCore()` collects `core.warnings`.
  - `withEnv(vars, fn)`, modelled on `withRoundsByType`, restoring each variable.

- [ ] **Step 1: Add the test helpers and write the failing tests**

```js
test('getProtectedPaths trims and drops empty globs', () => {
  assert.deepEqual(decide.getProtectedPaths({ AUTO_APPROVE_PROTECTED_PATHS: ' rules/** , ,.strspc/**,' }), ['rules/**', '.strspc/**']);
  assert.deepEqual(decide.getProtectedPaths({}), []);
});

test('getProtectedPathsMode: empty means manual without a warning', () => {
  const warned = [];
  assert.equal(decide.getProtectedPathsMode({ AUTO_APPROVE_PROTECTED_PATHS_MODE: '' }, (m) => warned.push(m)), 'manual');
  assert.equal(warned.length, 0);
});

test('getProtectedPathsMode: an unknown mode means manual with a warning', () => {
  const warned = [];
  assert.equal(decide.getProtectedPathsMode({ AUTO_APPROVE_PROTECTED_PATHS_MODE: 'yolo' }, (m) => warned.push(m)), 'manual');
  assert.equal(warned.length, 1);
  assert.match(warned[0], /yolo/);
});

test('getProtectedPathsMode: spacing and case do not change the mode', () => {
  assert.equal(decide.getProtectedPathsMode({ AUTO_APPROVE_PROTECTED_PATHS_MODE: ' Allowlist ' }), 'allowlist');
  assert.equal(decide.getProtectedPathsMode({ AUTO_APPROVE_PROTECTED_PATHS_MODE: 'APPROVE' }), 'approve');
});

test('getProtectedPathsAllowed: spacing and case are forgiven, @ is not', () => {
  assert.deepEqual([...decide.getProtectedPathsAllowed({ AUTO_APPROVE_PROTECTED_PATHS_ALLOWED: ' Alice, ,bob,@carol' })], ['alice', 'bob', '@carol']);
});

test('firstProtectedMatch returns the first match, or null', () => {
  const globs = ['rules/**', '.strspc/**'];
  assert.equal(decide.firstProtectedMatch(['src/a.js', 'rules/APPROVE.json'], globs), 'rules/APPROVE.json');
  assert.equal(decide.firstProtectedMatch(['.strspc/config.yaml'], globs), '.strspc/config.yaml');
  assert.equal(decide.firstProtectedMatch(['rulesets/a.json', 'src/rules/a.json'], globs), null);
  assert.equal(decide.firstProtectedMatch([], globs), null);
  assert.equal(decide.firstProtectedMatch(['rules/a.json'], []), null);
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `npm test`
Expected: FAIL with `getProtectedPaths is not a function`, and the same for the other helpers.

- [ ] **Step 3: Implement the four readers and change `compareHead`**

`firstProtectedMatch` uses `globToRegExp`. `filesMatchPaths` stays as it is, because it needs every file to match. Export the four functions.

- [ ] **Step 4: Set the README count, then run the suite**

Run: `npm test`
Expected: exit 0. Existing relaxed-path tests still pass, because `filesMatchPaths(null, …)` and `filesMatchPaths([], …)` are both false.

- [ ] **Step 5: Commit**

```bash
git add scripts/pr-auto-approve/decide.js scripts/pr-auto-approve/decide.test.js README.md
git commit -m "feat: read the protected-paths inputs"
```

### Task 2: The gate, in `approve` and `manual`

**Files:**
- Modify: `scripts/pr-auto-approve/decide.js`
- Test: `scripts/pr-auto-approve/decide.test.js`, `README.md` (count)

**Interfaces:**
- Consumes: Task 1's readers and test helpers.
- Produces:
  - `evaluateProtectedPaths({ github, owner, repo, pr, warn, env = process.env }): Promise<{ outcome: 'normal'|'wait', reason: string, mergeBase: string|null, compared: object|null }>`. `compared` is the `compareHead` result. `mergeBase` is set on every `normal` that used the comparison.
  - `applyPathGate` takes an optional `compared`, used in place of its own `compareHead` call.
  - A `heldMergeBase` in `decideInner`, `protection.mergeBase || gate.mergeBase`. `mergeBaseMoved` reads it instead of `gate.mergeBase`.

Exact reasons, where `<path>` is the first match and `<mode>` is the mode:

```text
protected path '<path>' changed; protected-paths-mode is <mode>
changed files cannot be completely listed; protected-paths-mode is <mode>
the comparison reported no merge base, so the changed files cannot be re-verified; protected-paths-mode is <mode>
```

- [ ] **Step 1: Write the failing tests**

Define these once, next to the tests:

```js
const PROTECTED = { AUTO_APPROVE_PROTECTED_PATHS: 'rules/**,.strspc/**' };
const MANUAL_REFUSAL = "protected path 'rules/APPROVE.json' changed; protected-paths-mode is manual";
```

`makeApprovableGithub` gains `(opts = {})`, spread into `makeFakeGithub`, so fixtures below set `changedFiles` and the rest through it. Every test below runs inside `withEnv` and calls `decide({ github, core, context: makeContext() })` unless it says otherwise.

| Test name | Environment | Fixture | Assertions |
|---|---|---|---|
| `protected paths: unset makes no comparison` | none | `changedFiles: ['rules/APPROVE.json']` | `approved`, `calls.compare.length === 0` |
| `protected paths: approve makes no comparison` | `PROTECTED`, mode `approve` | same | `approved`, `calls.compare.length === 0` |
| `protected paths: manual refuses a matching file` | `PROTECTED`, mode `manual` | same | `skip`, reason `MANUAL_REFUSAL`, no `createReview` |
| `protected paths: an empty mode behaves as manual` | `PROTECTED`, mode `''` | same | reason `MANUAL_REFUSAL`, `core.warnings.length === 0` |
| `protected paths: an unknown mode behaves as manual and warns` | `PROTECTED`, mode `yolo` | same | reason `MANUAL_REFUSAL`, `core.warnings.length === 1` |
| `protected paths: a file outside the globs gets normal rules` | `PROTECTED` | `changedFiles: ['src/a.js']` | `approved` |
| `protected paths: an empty file list is not a match` | `PROTECTED` | `changedFiles: []` | `approved` |
| `protected paths: a rename out of a protected path matches` | `PROTECTED` | compare returns `{ filename: 'src/a.js', previous_filename: 'rules/old.json' }` | reason names `rules/old.json` |
| `protected paths: a rename into a protected path matches` | `PROTECTED` | compare returns `{ filename: 'rules/new.json', previous_filename: 'src/a.js' }` | reason names `rules/new.json` |
| `protected paths: a 300-file list waits` | `PROTECTED` | 300 `src/n.js` files | reason `changed files cannot be completely listed; protected-paths-mode is manual` |
| `protected paths: a response with no files waits` | `PROTECTED` | compare returns `{ merge_base_commit: { sha: 'mb000001' } }` | same reason |
| `protected paths: no merge base waits` | `PROTECTED` | compare returns `{ files: [{ filename: 'src/a.js' }] }` | no-merge-base reason, mode `manual` |
| `protected paths: a refusal beats 3-rounds` | `PROTECTED` | three Copilot reviews with comments, matching file | `skip` with `MANUAL_REFUSAL`, no `createReview` |
| `protected paths: a refusal beats rounds-by-type 0` | `PROTECTED`, `AUTO_APPROVE_ROUNDS_BY_TYPE: 'chore:0'`, `AUTO_APPROVE_COPILOT_OPTIONAL_PATHS: 'rules/**'` | title `chore: x`, matching file, `reviews: []` | `skip` with `MANUAL_REFUSAL`, no `createReview` |
| `protected paths: a base rewritten before approving does not approve a no-match` | `PROTECTED` | compare gives `mb000001`, then `mb000002`; `src/a.js` | exact reason `base develop was rewritten (merge base mb000001 -> mb000002) during evaluation; the next run re-evaluates the diff` |
| `protected paths: a base rewritten while approving withdraws a no-match approval` | `PROTECTED` | compare gives `mb000001` twice, then `mb000002`; `src/a.js` | one `createReview`, `calls.dismiss[0].review_id === 999`, reason ends `while approving; approval withdrawn` |
| `protected paths: a relaxed type reuses the comparison` | `PROTECTED`, `AUTO_APPROVE_ROUNDS_BY_TYPE: 'docs:0'` | title `docs: x`, `README.md`, `reviews: []`, `getPrImpl: getPrWithTitle('docs: x')` | `approved`, `calls.compare.length === 3` (one shared listing, two re-verifications) |

- [ ] **Step 2: Run them and confirm they fail**

Run: `npm test`
Expected: FAIL. The `unset`, `no match` and `empty list` tests pass already. The refusal tests fail with `decision` `approved` where `skip` is expected.

- [ ] **Step 3: Implement `evaluateProtectedPaths` for `approve` and `manual`, and wire it in**

Order inside the function:

1. No globs, or mode `approve`: return `normal` with no call.
2. `compareHead`.
3. `names === null` gives `wait`.
4. No `mergeBase` gives `wait`.
5. No match gives `normal`.
6. `manual` gives `wait`.

For now `allowlist` also gives `wait`. Task 4 replaces that.

In `decideInner`, call it after the bot-author guard and before `applyPathGate`. On `wait`, return `setDecision('skip', reason)`. Task 3 adds the withdrawal. Pass `warn: (m) => core.warning(m)`, and pass `compared` to `applyPathGate`. The `requestCopilotReview` call to `applyPathGate` doesn't change.

- [ ] **Step 4: Set the README count, then run the suite**

Run: `npm test`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add scripts/pr-auto-approve/decide.js scripts/pr-auto-approve/decide.test.js README.md
git commit -m "feat: refuse protected paths in manual mode"
```

### Task 3: Withdraw bot approvals

**Files:**
- Modify: `scripts/pr-auto-approve/decide.js`
- Test: `scripts/pr-auto-approve/decide.test.js`, `README.md` (count)

**Interfaces:**
- Consumes: `evaluateProtectedPaths` from Task 2.
- Produces, inside `decideInner`:
  - `withdrawApprovals(select: (review) => boolean, message: string, unfound: string): Promise<decision|null>`. It keeps the current body: it stores `reviews`, resets it after a dismissal, and calls `failClosed` on either failure.
  - `withdrawStampedApprovals(isStale, message)` stays as a wrapper with the same behaviour and messages.
  - `withdrawBotApprovals(message)` selects `state === 'APPROVED'` reviews by `BOT_LOGIN`, stamped or not.

Exact text:

```text
could not list the PR's reviews, so a bot approval on a protected path cannot be found and withdrawn: <status> <message>
Withdrawn: <refusal reason>.
Withdrawn: the changed files of <sha8> could not be checked against protected-paths (<status> <message>).
```

- [ ] **Step 1: Write the failing tests**

| Test name | Fixture | Assertions |
|---|---|---|
| `protected paths: a refusal withdraws stamped and unstamped bot approvals only` | `manual`, matching file. Reviews: 70 unstamped bot `APPROVED`, 71 stamped bot `APPROVED`, 72 bot `DISMISSED`, 73 human `APPROVED` | `calls.dismiss` ids `[70, 71]`, message `` `Withdrawn: ${MANUAL_REFUSAL}.` ``, `skip` |
| `protected paths: normal rules leave a bot approval alone` | `manual`, `src/a.js`, bot approval present | `calls.dismiss.length === 0` |
| `protected paths: a failed comparison withdraws and then reports` | `manual`, compare throws 403 with `request`, reviews 70 and 71 as above | ids `[70, 71]`, first message is the exact "could not be checked" text, `skip`, reason matches `/^evaluation failed: 403 GET /` |
| `protected paths: a failed review listing fails the job` | `manual`, matching file, `listReviews` throws 500, `core.setFailed` recorded | `error`, the exact "could not list" reason, one failure, no `createReview` |
| `protected paths: a failed dismissal fails the job` | `manual`, matching file, bot approval, `dismissReview` throws 500 | `error`, reason matches `/^could not withdraw the stale approval \(review 70\): 500 boom$/`, one failure |
| `protected paths: a refused dismissal falls back to the workflow token` | `manual`, matching file, bot approval, `botGithub` throws 403, `github` records | `skip`, one dismissal through `github` |

- [ ] **Step 2: Run them and confirm they fail**

Run: `npm test`
Expected: FAIL, with no dismissal recorded and `calls.dismiss` empty.

- [ ] **Step 3: Generalise the withdrawal and call it**

On `wait`, call `withdrawBotApprovals(`Withdrawn: ${reason}.`)`, return a failure if there is one, then skip. Wrap `evaluateProtectedPaths` in `try`/`catch`: withdraw with the "could not be checked" message, return a failure if there is one, then rethrow so the top-level catch reports the request. Reuse the `detail` format from the existing `applyPathGate` catch.

- [ ] **Step 4: Set the README count, then run the suite**

Run: `npm test`
Expected: exit 0, and the existing `stale approval` tests keep their exact messages.

- [ ] **Step 5: Commit**

```bash
git add scripts/pr-auto-approve/decide.js scripts/pr-auto-approve/decide.test.js README.md
git commit -m "feat: withdraw bot approvals from refused protected paths"
```

### Task 4: `allowlist`

**Files:**
- Modify: `scripts/pr-auto-approve/decide.js`
- Test: `scripts/pr-auto-approve/decide.test.js`, `README.md` (count)

**Interfaces:**
- Consumes: `getProtectedPathsAllowed`, `compared.totalCommits`, `evaluateProtectedPaths`.
- Produces:
  - `const MAX_COMPARED_COMMITS = 250`.
  - `commitParties(commits): { logins: string[], unlinkedSha: string|null }`, reading the top-level `author.login` and `committer.login`, not `commit.author`. It ignores `web-flow` as a committer, case-insensitively.
  - `listCompareCommits({ github, owner, repo, baseRef, headSha, totalCommits }): Promise<object[]>`, a `page` loop over `compareCommitsWithBasehead` with `per_page: 100`, stopping at `totalCommits` or an empty page. Don't use `github.paginate`, because the response is one object.
  - `partyBlocker({ pr, commits, totalCommits, allowed }): string`, empty when every party is allowed. The PR author is checked first.

Each blocker is appended to the refusal after ` and `:

```text
protected path '<path>' changed; protected-paths-mode is allowlist and party '<login>' is not on protected-paths-allowed
protected path '<path>' changed; protected-paths-mode is allowlist and the PR has no author account
protected path '<path>' changed; protected-paths-mode is allowlist and commit <sha8> has an author or committer with no GitHub account
protected path '<path>' changed; protected-paths-mode is allowlist and the PR has <n> commits, more than the 250 that can be checked
protected path '<path>' changed; protected-paths-mode is allowlist and the comparison returned <m> of <n> commits
```

- [ ] **Step 1: Write the failing tests**

Fixtures: the default PR author is `someone`. `commit(sha, author, committer = author)` builds `{ sha, author: author && { login: author }, committer: committer && { login: committer } }`. The environment is `PROTECTED`, mode `allowlist`, and `AUTO_APPROVE_PROTECTED_PATHS_ALLOWED` as listed. The file is `rules/APPROVE.json` unless stated.

| Test name | Allowed | Commits or fixture | Assertions |
|---|---|---|---|
| `allowlist: every party allowed gets normal rules` | `someone,alice` | `commit('a1', 'alice')` | `approved` |
| `allowlist: a PR author not allowed waits` | `alice` | `commit('a1', 'alice')` | party `someone` reason |
| `allowlist: a commit author not allowed waits` | `someone` | `commit('a1', 'bob', 'someone')` | party `bob` reason |
| `allowlist: a committer not allowed waits` | `someone,alice` | `commit('a1', 'alice', 'bob')` | party `bob` reason |
| `allowlist: a null author waits` | `someone` | `commit('abcdef012', null, 'someone')` | commit `abcdef01` reason |
| `allowlist: a null committer waits` | `someone` | `commit('abcdef012', 'someone', null)` | commit `abcdef01` reason |
| `allowlist: a web-flow committer is ignored` | `someone,alice` | `commit('a1', 'alice', 'web-flow')` | `approved` |
| `allowlist: a web-flow author is a party` | `someone` | `commit('a1', 'web-flow', 'someone')` | party `web-flow` reason |
| `allowlist: logins compare case-insensitively` | `SOMEONE,ALICE` | `commit('a1', 'Alice')` | `approved` |
| `allowlist: an @ in the list does not match` | `@someone` | none | party `someone` reason |
| `allowlist: an empty list allows nobody` | `''` | none | party `someone` reason |
| `allowlist: a PR with no author account waits` | `someone` | `prOverrides: { user: null }` | no-author reason |
| `allowlist: over 250 commits waits without paging` | `someone` | `totalCommits: 251` | 251 reason, no compare call with `per_page: 100` |
| `allowlist: 250 commits are read across pages` | `someone` | 250 by `someone` | `approved`, pages 1, 2 and 3 requested |
| `allowlist: a short commit list waits` | `someone` | 3 commits, `totalCommits: 5` | `3 of 5` reason |
| `allowlist: a file outside the globs reads no commits` | `alice` | `src/a.js` | `approved`, no compare call with `per_page: 100` |
| `allowlist: a 300-file list waits with every party allowed` | `someone` | 300 files | can't-list reason with `allowlist` |
| `allowlist: no merge base waits with every party allowed` | `someone` | no `merge_base_commit` | no-merge-base reason with `allowlist` |
| `allowlist: a failed comparison reports with every party allowed` | `someone` | compare throws 403 | `/^evaluation failed: 403/`, no `createReview` |
| `allowlist: a failed commit page withdraws and then reports` | `someone` | bot approval, compare throws on the `per_page: 100` call | one dismissal, `/^evaluation failed:/`, no `createReview` |
| `allowlist: a base rewritten before approving does not approve` | `someone` | first compare `mb000001`, every later one `mb000002` | exact `during evaluation` reason, no `createReview` |
| `allowlist: a pass still needs the normal rules` | `someone` | matching file, CI failing | `skip`, reason `failing check: …` |

- [ ] **Step 2: Run them and confirm they fail**

Run: `npm test`
Expected: FAIL. Every pass-expecting test skips with `protected-paths-mode is allowlist`, because Task 2 treats `allowlist` as `wait`.

- [ ] **Step 3: Implement the three helpers and the `allowlist` branch**

Check `totalCommits` against `MAX_COMPARED_COMMITS` before listing any page. A non-number `totalCommits` is treated as the short-list case with `0` returned. Build the merge-base-carrying `normal` result as the no-match path does.

- [ ] **Step 4: Set the README count, then run the suite**

Run: `npm test`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add scripts/pr-auto-approve/decide.js scripts/pr-auto-approve/decide.test.js README.md
git commit -m "feat: let allowed parties through protected paths"
```

### Task 5: Inputs, template and documentation

**Files:**
- Modify: `action.yml`, `templates/pr-auto-approve.yml`, `README.md`, `skills/pr-auto-approve-setup/SKILL.md`, `skills/pr-auto-approve-diagnose/SKILL.md`, `scripts/pr-auto-approve/decide.js` (header comment only)

**Interfaces:**
- Consumes: the environment names and reasons from Tasks 1 to 4.

- [ ] **Step 1: Add the three inputs and three `env:` lines to `action.yml`**

Put the inputs after `copilot-optional-paths`. Put the environment lines on "Evaluate and approve" only. Extend the `contents: read` sentence in the `github-token` description to cover `protected-paths`. The `protected-paths-mode` description must say an empty or unknown value means `manual`.

- [ ] **Step 2: Run the drift tests and confirm they fail**

Run: `npm test`
Expected: FAIL in `template.test.js` with `inputs not read from their variable` and in `docs.test.js` with `undocumented inputs`.

- [ ] **Step 3: Wire the template and the README**

Template: three `with:` lines after `copilot-optional-paths`, each reading its variable, with a short comment. Add no claim about `pull_request_review`.

`README.md`:
- Three Inputs rows.
- A `## Protected paths` section before Troubleshooting. It holds the spec's behaviour table, the three variables in backticks, a `rules/**,.strspc/**` example, and these facts:
  - a refusal beats the rounds threshold, including `0`;
  - any bot approval is withdrawn, but human approvals are not;
  - 300 or more files, or an unknown merge base, waits in `manual` and `allowlist`;
  - being allowed never skips CI or the Copilot gates.
- These limits, plainly:
  - Parties are the PR author and every commit's author and committer.
  - Agents committing as the owner's account all count as that account, so telling them apart needs each to commit under its own account or App.
  - Commit identity can be faked and a PR can edit its own caller workflow, so this covers accidents, not someone deliberately bypassing it.
  - A caller without the new `with:` lines never passes the inputs, and nothing reports an error, so an org-level variable can look active while protecting nothing.
- Logins go in the allowed list without `@`.
- Troubleshooting rows for the `protected path '…' changed`, `changed files cannot be completely listed`, and no-merge-base reasons.

- [ ] **Step 4: Update the skills and the header comment**

Setup skill: add `..._PROTECTED_PATHS`, `..._PROTECTED_PATHS_MODE` and `..._PROTECTED_PATHS_ALLOWED` to the variable list, plus one line saying a synced caller is needed first. Diagnose skill: one reason row. `decide.js` header: the three environment variables.

- [ ] **Step 5: Run the suite and the linters**

Run: `npm run test:coverage`, then `npm run lint`
Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
git add action.yml templates/pr-auto-approve.yml README.md skills scripts/pr-auto-approve/decide.js
git commit -m "feat: add the protected-paths inputs and docs"
```

### Task 6: The rule

**Files:**
- Modify: `rules/APPROVE.json`, through the CLI only

- [ ] **Step 1: Add the rule once**

```bash
strspc rule add APPROVE --dir rules --added-by "@pleberre" --body "Unless protected-paths-mode is approve, the action MUST NOT approve a pull request whose changed files cannot be completely listed, or one that changes a file matching protected-paths unless protected-paths-mode is allowlist and every party to the pull request is on protected-paths-allowed, and MUST withdraw any bot approval from such a pull request."
```

Expected: `APPROVE-021`, Draft. If the text must change before merge, remove the commit and add it again, so it reaches the PR at revision 0.

- [ ] **Step 2: Verify it**

Run: `strspc lint rules/`, then `strspc diff --base origin/develop rules/`, then `git grep -n -A6 '"id": "APPROVE-021"' -- rules/APPROVE.json`
Expected: both CLI commands exit 0, and the rule shows revision 0. APPROVE-019 is unchanged.

- [ ] **Step 3: Commit**

```bash
git add rules/APPROVE.json
git commit -m "chore(rules): add the protected-paths rule"
```

### Task 7: Open the PR

**Files:** none

- [ ] **Step 1: Update and run every gate**

Run: `git fetch origin`, `git rebase origin/develop`, `npm run test:coverage`, `npm run lint`, `strspc lint rules/`, `strspc diff --base origin/develop rules/`
Expected: each exits 0.

- [ ] **Step 2: Push**

Run: `git push --force-with-lease origin feat/protected-paths`
Expected: the branch moves. The lease is needed because this branch was rebased.

- [ ] **Step 3: Open the PR into `develop`**

Title: `feat: add protected paths to the approval gate`. Use the repository's PR template. Reference #125, `strspc-pr-review-0np` and the rollout order from the spec. State that APPROVE-019 stays Draft, so one "done when" item of #125 is unmet, and that `strspc-pr-review-0np` stays open.

- [ ] **Step 4: Follow the reviews**

Read every Copilot review body, not just its threads. Agents never merge this PR.
