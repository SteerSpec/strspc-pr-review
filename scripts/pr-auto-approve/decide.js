// SPDX-License-Identifier: Apache-2.0
// Decision logic for the pr-auto-approve reusable workflow.
// Extracted into a module so it can be unit-tested with `node --test`.
//
// Configuration (via environment variables, set by the caller workflow):
//   AUTO_APPROVE_BOT_LOGIN    — login of the bot that posts approval reviews (required)
//   AUTO_APPROVE_BASE_BRANCH  — comma-separated set of base branches PRs must
//                               target to be eligible (default: main)
//   AUTO_APPROVE_SANDBOX_REPOS — comma-separated repo full names where bot-authored
//                               PRs are allowed (for e2e testing); production repos
//                               must not appear here
//
// Usage (from actions/github-script):
//   const decide = require('./scripts/pr-auto-approve/decide.js');
//   await decide({ github, context, core });

// Production Copilot reviewer identities. Strict allowlist of known logins
// — a substring-match fallback could be spoofed by any third-party bot with
// "copilot" in its login. If GitHub publishes a new Copilot bot identity,
// add it here explicitly after verification.
const COPILOT_LOGINS = new Set([
  'copilot-pull-request-reviewer[bot]',
  'github-copilot[bot]',
]);

// Check-run names for Copilot's review, derived from the logins above so the
// two can't drift: GitHub names the check after the bot minus the "[bot]"
// suffix (verified: login 'copilot-pull-request-reviewer[bot]' produces check
// run 'copilot-pull-request-reviewer').
const COPILOT_CHECK_NAMES = new Set(
  [...COPILOT_LOGINS].map((login) => login.replace(/\[bot\]$/, '')),
);

// Copilot withholds some findings into a collapsed block inside the review BODY
// instead of posting them as inline review comments. Those comments are absent
// from pulls.listCommentsForReview (verified 0 against real reviews), so
// scanning the body is the only way to see them.
//
// GitHub has shipped two wordings for that block, and BOTH must match — the
// first replacement went undetected here and silently disabled this gate:
//
//   pre-2026-08  "<summary>Comments suppressed due to low confidence (N)</summary>"
//   2026-08      "<summary>Suppressed comments (N)</summary>", with the findings
//                subtitled by why they were withheld, e.g.
//                "**Previously missed (N)** — in code that hasn't changed since
//                the last review."
//
// Note the second wording drops "low confidence" entirely: "previously missed"
// is a different reason for withholding. The gate does not care why — it exists
// to catch findings the comments API hides, whatever the stated cause.
//
// Treat this as unstable and expect a third wording. Nothing here re-checks the
// markup against live reviews yet — the unit tests only assert these fixtures,
// so a third wording would again pass CI and fail in production. A real-Copilot
// e2e tier that catches that is planned but not yet built.
const SUPPRESSED_PHRASE =
  String.raw`(?:Comments? suppressed due to low confidence|Suppressed comments?)`;

// The phrase alone is too weak to key on. Review bodies discuss their own
// diffs and Copilot quotes the offending snippet back, so in THIS repo — whose
// code and tests are full of the words and of counted fixtures like
// "SUPPRESSED COMMENTS (5)" — a body routinely contains the phrase as ordinary
// text. Counting those blocks a PR that has no hidden findings at all.
//
// Three defences, narrowest first:
//
//   0. drop fenced code blocks before matching. This is the realistic vector:
//      Copilot quotes the offending lines back inside ``` fences, so a PR that
//      merely touches this file would otherwise fail its own gate.
//   1. the phrase as the collapsed block's <summary> heading — the real thing.
//      The count is optional, so a heading that stops printing "(N)" still
//      matches.
//   2. failing that, the phrase at the START OF A LINE carrying an explicit
//      "(N)". That is the shape a heading takes if GitHub drops
//      <details>/<summary> ("**Suppressed comments (2)**"), while mid-sentence
//      prose — "no suppressed comments (3) were found" — never reaches it.
//
// Pass 2 is deliberately kept rather than anchoring to <summary> alone: it
// makes a future markup change degrade to a false SKIP rather than to silence.
// Silence is the failure that auto-approves a PR with hidden findings, and it
// is the one that already shipped once. A false skip is visible and a human
// clears it; silence is not.
// The count is captured only when it is numeric, but a NON-numeric one still
// has to match: presence is what gates the approval, and parseInt's failure
// falls through to `|| 1`. Requiring digits would make "(N)" or "(many)" read
// as no block at all — silence, the one failure direction this gate exists to
// prevent.
const COUNT = String.raw`\((?:(\d+)|[^)]*)\)`;
const FENCED_CODE_RE = /```[\s\S]*?```/g;
const SUPPRESSED_IN_SUMMARY_RE = new RegExp(
  String.raw`<summary>\s*(?:\*\*)?\s*${SUPPRESSED_PHRASE}\s*(?:${COUNT})?\s*(?:\*\*)?\s*</summary>`,
  'i',
);
// Anchored at BOTH ends of the line. The anchors, not the count, are what
// separate a heading from prose: "Suppressed comments (5) are documented below"
// fails the trailing anchor, and "No suppressed comments were found" fails the
// leading one. That lets the count stay OPTIONAL here, so a heading stripped of
// both its <details> wrapper and its count still registers instead of going
// silent. A whole line consisting of nothing but the phrase is a heading.
const SUPPRESSED_HEADING_RE = new RegExp(
  String.raw`^[>\s]*(?:#{1,6}\s*)?(?:\*\*|__)?\s*${SUPPRESSED_PHRASE}\s*(?:${COUNT})?\s*(?:\*\*|__)?\s*$`,
  'im',
);

// Number of suppressed comments in a review body; 0 when there is no such block.
// A matched block with an unparseable count still returns 1 — presence is what
// gates the approval, the number is only for the human-readable reason string.
function countSuppressedComments(body) {
  const text = String(body || '').replace(FENCED_CODE_RE, '');
  const m = SUPPRESSED_IN_SUMMARY_RE.exec(text) || SUPPRESSED_HEADING_RE.exec(text);
  if (!m) return 0;
  return parseInt(m[1], 10) || 1;
}

// Trimmed so a whitespace-only value counts as empty, not as a (bogus) login.
function getBotLogin() { return (process.env.AUTO_APPROVE_BOT_LOGIN || '').trim(); }
// Comma-separated set of base branches a PR must target to be eligible.
// Whitespace-only/empty falls back to the default so a blank input never makes
// every PR ineligible. Accepts an env override for direct unit testing.
function getBaseBranches(env = process.env) {
  const raw = (env && env.AUTO_APPROVE_BASE_BRANCH) || '';
  const branches = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return new Set(branches.length ? branches : ['main']);
}
// Conventional Commit type of a PR title ("fix(api)!: x" -> "fix"), lowercased;
// null when the title is not conventional. The title, not the commits, is the
// source of truth: squash-merge uses it and release-please reads it.
function parseCommitType(title) {
  const m = /^\s*([A-Za-z]+)(?:\([^)]*\))?!?:/.exec(String(title || ''));
  return m ? m[1].toLowerCase() : null;
}

// "docs:1,chore:1,default:3" -> Map(type -> rounds). Unlike rounds-threshold,
// 0 is a valid value here: Copilot is not required for that type. Malformed
// entries are dropped rather than throwing, so a typo never wedges every PR.
function parseRoundsByType(raw) {
  const map = new Map();
  for (const entry of String(raw || '').split(',')) {
    const parts = entry.split(':').map((s) => s.trim());
    // Exactly two fields: "docs:0:oops" must not quietly select the no-Copilot path.
    if (parts.length !== 2 || !parts[0] || !/^\d+$/.test(parts[1])) continue;
    const [type, count] = parts;
    map.set(type.toLowerCase(), parseInt(count, 10));
  }
  return map;
}

// Rounds threshold for one PR title: the type's entry, else `default`, else
// the plain rounds-threshold input. Accepts an env override for unit tests.
function resolveThreshold(title, env = process.env) {
  const type = parseCommitType(title);
  const byType = parseRoundsByType(env.AUTO_APPROVE_ROUNDS_BY_TYPE);
  const fallback = Math.max(1, parseInt(env.AUTO_APPROVE_ROUNDS_THRESHOLD, 10) || 3);
  if (type !== null && byType.has(type)) return { threshold: byType.get(type), type };
  if (byType.has('default')) return { threshold: byType.get('default'), type };
  return { threshold: fallback, type };
}

// Paths a PR may touch for threshold 0 to apply. The title is author-controlled,
// so on its own it must never remove the review gate: a `chore:0` PR that also
// edits code falls back to the normal rules.
// GitHub's list-files endpoint stops at 3000 files, so a list that long may be
// truncated and cannot prove the PR is docs-only. null means "cannot tell".
const MAX_LISTED_FILES = 3000;
function changedFileNames(changed) {
  if (changed.length >= MAX_LISTED_FILES) return null;
  return changed.flatMap((f) => [f.filename, f.previous_filename]).filter(Boolean);
}

// Stamps the threshold an approval relied on (0 = no Copilot review; N = the
// rounds rule), so a later run can withdraw it if a retitle raises the bar. A
// copilot-clean approval is threshold-independent and carries no stamp.
const THRESHOLD_MARKER_RE = /<!-- pr-auto-approve:threshold=(\d+) -->/;
const LEGACY_OPTIONAL_MARKER = '<!-- pr-auto-approve:copilot-optional -->';
const thresholdMarker = (n) => `<!-- pr-auto-approve:threshold=${n} -->`;

function getOptionalPaths(env = process.env) {
  const list = String(env.AUTO_APPROVE_COPILOT_OPTIONAL_PATHS || '**/*.md,docs/**')
    .split(',').map((x) => x.trim()).filter(Boolean);
  return list;
}

function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
    } else if (c === '*') {
      re += '[^/]*';
    } else {
      re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

// True when every changed file matches one of the globs. An empty file list
// proves nothing, so it does not qualify.
function filesMatchPaths(filenames, globs) {
  if (!filenames || !filenames.length || !globs.length) return false;
  const res = globs.map(globToRegExp);
  return filenames.every((f) => res.some((re) => re.test(f)));
}

function getSandboxRepos() {
  const raw = process.env.AUTO_APPROVE_SANDBOX_REPOS || '';
  return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
}
function getAllowNoChecks() { return (process.env.AUTO_APPROVE_ALLOW_NO_CHECKS || '').toLowerCase() === 'true'; }
// Seconds to wait for Copilot's review check to finish before giving up.
// 0 (the default) preserves the historical behaviour of skipping immediately.
// Opt-in because waiting consumes billable Actions minutes on private repos.
function getCopilotWaitSeconds() {
  return Math.max(0, parseInt(process.env.AUTO_APPROVE_COPILOT_WAIT_SECONDS, 10) || 0);
}
// Poll interval while waiting. Not an action input — only the tests override it,
// so they don't have to sleep in real time.
function getCopilotPollMs() {
  return Math.max(1, parseInt(process.env.AUTO_APPROVE_COPILOT_POLL_MS, 10) || 15000);
}

function isCopilot(u) {
  if (!u) return false;
  return COPILOT_LOGINS.has(u.login);
}

// Test-only: the e2e harness can opt in to treat additional reviewer
// logins as "Copilot" by setting AUTO_APPROVE_COPILOT_TEST_LOGINS to a
// comma-separated list. The input is only honored when the CALLER repo is
// on the sandbox allowlist — so a production consumer that accidentally
// (or intentionally) passes test_copilot_logins cannot bypass the Copilot
// gate. Add a repo to AUTO_APPROVE_SANDBOX_REPOS only after deliberate review.

// Valid GitHub login shape (alphanumerics + hyphens, optional [bot] suffix).
// Anything else is silently dropped with a warning — a malformed test login
// can never match a real reviewer, so without validation the e2e harness
// would degrade to "no Copilot review yet" and time out later.
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/;

function parseTestLogins(env, contextRepo, warn) {
  const raw = (env && env.AUTO_APPROVE_COPILOT_TEST_LOGINS) || '';
  if (!raw) return new Set();
  const fullName = contextRepo
    ? `${contextRepo.owner}/${contextRepo.repo}`
    : '';
  if (!getSandboxRepos().has(fullName)) {
    // Silently ignore outside sandbox — matches "disabled" behavior so
    // a misconfigured consumer gets the production code path.
    return new Set();
  }
  const accepted = new Set();
  for (const candidate of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (LOGIN_RE.test(candidate)) {
      accepted.add(candidate);
    } else if (typeof warn === 'function') {
      warn(`ignored invalid login in AUTO_APPROVE_COPILOT_TEST_LOGINS: ${JSON.stringify(candidate)}`);
    }
  }
  return accepted;
}

function makeIsCopilot(testLogins) {
  if (!testLogins || testLogins.size === 0) return isCopilot;
  return (u) => {
    if (!u) return false;
    if (testLogins.has(u.login)) return true;
    return isCopilot(u);
  };
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Drop the API host so the reason string stays readable in a Slack message and
// a check summary; the path is the part that identifies the call.
const stripApiHost = (url) => String(url).replace(/^https?:\/\/[^/]+/, '');

// A completed check that blocks approval. Shared by the failing-check gate and
// by the Copilot wait, so the two can never drift into disagreeing about what
// counts as a failure.
const CHECK_OK_CONCLUSIONS = ['success', 'neutral', 'skipped', 'cancelled', 'stale'];
const isFailedCheck = (cr) =>
  cr.status === 'completed' && !CHECK_OK_CONCLUSIONS.includes(cr.conclusion);

// Check runs for a SHA: paginate, drop this workflow's own run, dedupe by
// (name, app.id) keeping the latest attempt. Prevents the self-pending trap
// (this job waiting on its own check) and rerun staleness.
async function fetchCheckRuns({ github, context, owner, repo, headSha }) {
  // Direct call (not paginate): 100 per page covers all practical repos; loop pages if needed.
  const allCheckRuns = [];
  let page = 1;
  while (true) {
    const { data } = await github.rest.checks.listForRef({
      owner, repo, ref: headSha, per_page: 100, page,
    });
    const runs = data.check_runs || [];
    allCheckRuns.push(...runs);
    if (allCheckRuns.length >= data.total_count || runs.length === 0) break;
    page++;
  }
  const selfRunId = String(context.runId);
  // Bounded match: `/runs/111` must not match `/runs/1111`. Accept the id
  // only when followed by `/` (job path) or end-of-string.
  const selfRunRe = new RegExp(`/runs/${selfRunId}(/|$)`);
  const validCheckRuns = allCheckRuns.filter((cr) => cr != null);
  // Sibling runs of this same job (an earlier pull_request_target run being
  // cancelled by the concurrency group, say) report a check with the job's name
  // and are not CI either. Waiting on one stalls a PR that nothing re-triggers,
  // e.g. a type-0 PR, which posts no review to wake the workflow again.
  const selfJobNames = new Set(['auto-approve', context.job].filter(Boolean));
  const notSelf = validCheckRuns.filter(
    (cr) => !(cr.details_url && selfRunRe.test(cr.details_url)) &&
      // Only an UNFINISHED sibling is ignored: a completed (say failing) check that
      // happens to share the name is still a real result and keeps counting.
      !(selfJobNames.has(cr.name) && cr.status !== 'completed'),
  );
  // Dedupe by (name, app.id) keeping the most-recently-started run.
  const latestByKey = new Map();
  for (const cr of notSelf) {
    const key = `${cr.name}::${cr.app && cr.app.id}`;
    const ts = Date.parse(cr.started_at || cr.completed_at || '') || 0;
    const prev = latestByKey.get(key);
    const isNewer =
      !prev ||
      ts > prev._ts ||
      (ts === prev._ts && (cr.id || 0) > (prev.id || 0));
    if (isNewer) {
      latestByKey.set(key, Object.assign({}, cr, { _ts: ts }));
    }
  }
  return [...latestByKey.values()];
}

// Poll until Copilot's review check completes or the deadline passes, and
// return the freshest check-run list — the caller re-applies the failing and
// pending gates to whatever comes back, so a Copilot check that ends in failure
// is still caught.
//
// Deliberately narrow: it waits only while Copilot's check is the LAST one
// outstanding. If anything else is still running, CI completing will re-trigger
// this workflow anyway, so waiting here would burn minutes to reach the same
// place. That also stops an unrelated slow or hung job from consuming the
// entire timeout.
async function waitForCopilotCheck({
  github, context, core, owner, repo, headSha, checkRuns, waitSeconds, sleep,
}) {
  const deadline = Date.now() + waitSeconds * 1000;
  let current = checkRuns;
  while (true) {
    // A check has already failed, so approval is impossible whatever Copilot
    // says. Return now rather than spending the timeout to reach the same skip.
    if (current.some(isFailedCheck)) return current;
    const pending = current.filter((cr) => cr.status !== 'completed');
    if (pending.length !== 1 || !COPILOT_CHECK_NAMES.has(pending[0].name)) return current;
    if (Date.now() >= deadline) {
      core.warning(
        `pr-auto-approve: gave up waiting for ${pending[0].name} after ${waitSeconds}s`,
      );
      return current;
    }
    await sleep(Math.min(getCopilotPollMs(), Math.max(0, deadline - Date.now())));
    current = await fetchCheckRuns({ github, context, owner, repo, headSha });
  }
}

// A Copilot review "covers" the head when it names the head commit, or when
// enough rounds exist for the threshold rule to decide without freshness.
// Dismissing needs write access, not the bot's identity. The bot PAT that can
// post an approval is refused (403) on some setups, so retry once with the
// workflow's own token, which carries the caller job's `pull-requests: write`.
async function dismissReview({ github, botGithub, params }) {
  try {
    return await botGithub.rest.pulls.dismissReview(params);
  } catch (err) {
    if (botGithub === github || ![401, 403].includes(err.status)) throw err;
    return github.rest.pulls.dismissReview(params);
  }
}

function copilotHasReviewedHead(copilotReviews, headSha, threshold) {
  if (copilotReviews.length === 0) return false;
  if (copilotReviews.length >= threshold) return true;
  const latest = copilotReviews[copilotReviews.length - 1];
  return latest.commit_id === headSha;
}

// Poll the PR's reviews until Copilot has reviewed the head or the deadline
// passes. Returns the latest Copilot review list either way; the caller then
// applies the usual rules to it.
async function waitForCopilotReview({
  core, headSha, threshold, deadline, sleep, initial, load,
}) {
  let current = initial;
  let polled = false;
  while (!copilotHasReviewedHead(current, headSha, threshold)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      core.warning(
        `pr-auto-approve: gave up waiting for a Copilot review of ${headSha} after the wait budget`,
      );
      return { reviews: current, polled };
    }
    core.info(`pr-auto-approve: waiting for Copilot to review ${headSha} (${Math.ceil(remaining / 1000)}s left)`);
    await sleep(Math.min(getCopilotPollMs(), remaining));
    current = await load();
    polled = true;
  }
  return { reviews: current, polled };
}

// Reviewer login accepted by the REST requested_reviewers endpoint; the review
// then shows up as `Copilot` in the PR timeline. Verified on a ruleset-free repo.
const COPILOT_REVIEWER = 'copilot-pull-request-reviewer[bot]';

// Requests the Copilot review unless the PR's type needs none (threshold 0 and
// every changed file optional). Best-effort: requesting is a convenience and
// must never turn the check red, so errors only warn. The title is read from
// the event payload, never interpolated into a script. Returns 'requested',
// 'skipped' or 'error' so callers and tests can tell the outcomes apart.
async function requestCopilotReview({ github, context, core, env = process.env }) {
  try {
    const { owner, repo } = context.repo;
    const pr = context.payload.pull_request;
    const { threshold, type } = resolveThreshold(pr.title, env);
    if (threshold === 0) {
      const changed = await github.paginate(github.rest.pulls.listFiles, {
        owner, repo, pull_number: pr.number, per_page: 100,
      });
      if (filesMatchPaths(changedFileNames(changed), getOptionalPaths(env))) {
        core.info(`pr-auto-approve: type '${type}' does not need Copilot; not requesting a review`);
        return 'skipped';
      }
    }
    await github.rest.pulls.requestReviewers({
      owner, repo, pull_number: pr.number, reviewers: [COPILOT_REVIEWER],
    });
    return 'requested';
  } catch (err) {
    core.warning(
      `pr-auto-approve: could not request a Copilot review: ${err.status || ''} ${err.message || err}`.trim(),
    );
    return 'error';
  }
}

async function decide(args) {
  try {
    return await decideInner(args);
  } catch (err) {
    // Any unexpected API error (bad/empty token, 403, rate limit, network)
    // is converted to a clean skip so the workflow never flips a required
    // check to red for reasons unrelated to the review state.
    const { core } = args;
    // Name the request that failed. Without it, every failure reads the same --
    // "403 Resource not accessible by personal access token" -- and isolating
    // which of five endpoints was refused took hours the first time.
    const req = err.request || {};
    // Joined rather than interpolated: a missing status used to leave a double
    // space ("evaluation failed:  socket hang up"), and adding the request made
    // that worse.
    let reason = ['evaluation failed:', err.status || '',
      req.url ? `${req.method || 'GET'} ${stripApiHost(req.url)}` : '',
      err.message || err]
      .filter((part) => part !== '' && part !== undefined && part !== null)
      .join(' ');
    // One targeted hint, for the one misconfiguration that cannot be fixed by
    // granting a permission: fine-grained PATs cannot hold `Checks` at all, so
    // a PAT reading check runs on a private repo is permanently broken. Scoped
    // narrowly so it stays a signal rather than noise on unrelated 403s.
    if (err.status === 403 && /\/check-runs/.test(req.url || '')) {
      reason +=
        ' — reading check runs needs the Checks permission, which fine-grained' +
        ' PATs cannot be granted. Reads should use the workflow GITHUB_TOKEN' +
        ' (the github-token input, default); check the caller grants `checks: read`.';
    }
    core.error(`pr-auto-approve ${reason}`);
    core.setOutput('decision', 'skip');
    core.setOutput('reason', reason);
    if (core.summary && typeof core.summary.addRaw === 'function') {
      try {
        await core.summary.addRaw(`**Decision:** skip\n**Reason:** ${reason}\n`).write();
      } catch { /* best-effort */ }
    }
    return { decision: 'skip', reason };
  }
}

async function decideInner({ github, botGithub = github, context, core, sleep = defaultSleep }) {
  const BOT_LOGIN = getBotLogin();
  const BASE_BRANCHES = getBaseBranches();
  const SANDBOX_REPOS = getSandboxRepos();

  let pr = context.payload.pull_request;

  const setDecision = async (decision, reason) => {
    core.info(`pr-auto-approve decision=${decision} reason=${reason}`);
    core.setOutput('decision', decision);
    core.setOutput('reason', reason);
    // check_run/workflow_run-triggered runs carry no github.event.pull_request,
    // so the caller's Slack notification steps fall back to these outputs for
    // the PR link/number/title/author instead of emitting an empty/malformed
    // message. `pr` is whatever this closure's outer scope has resolved by
    // the time setDecision runs — null for the handful of skip reasons that
    // fire before a PR is ever resolved (e.g. "no associated PRs").
    core.setOutput('pr_url', pr ? pr.html_url || '' : '');
    core.setOutput('pr_number', pr ? String(pr.number) : '');
    core.setOutput('pr_title', pr ? pr.title || '' : '');
    core.setOutput('pr_author', pr && pr.user ? pr.user.login : '');
    // Summary write is best-effort: a rare I/O failure here must NOT bubble
    // up to the top-level try/catch and flip a successful approval into an
    // "evaluation failed" skip.
    if (core.summary && typeof core.summary.addRaw === 'function') {
      try {
        const prUrl = pr ? pr.html_url : '';
        await core.summary
          .addRaw(`**Decision:** ${decision}\n**Reason:** ${reason}\n**PR:** ${prUrl}\n`)
          .write();
      } catch { /* best-effort */ }
    }
    return { decision, reason };
  };

  // An empty bot login is a misconfiguration, not a skip: the caller's loop
  // guard (`github.actor != vars.PR_AUTO_APPROVE_BOT_LOGIN`) is then always
  // true too, so each approval re-triggers this workflow. That ran away to 17
  // approvals in three minutes once. Fail the job so it cannot pass unnoticed.
  if (!BOT_LOGIN) {
    const reason = 'bot-login is empty: set the PR_AUTO_APPROVE_BOT_LOGIN repository variable ' +
      '(the caller passes it as bot-login and uses it in the job `if:` loop guard)';
    core.error(`pr-auto-approve ${reason}`);
    if (typeof core.setFailed === 'function') core.setFailed(reason);
    return setDecision('error', reason);
  }

  // Backstop for a loop guard that does not match bot-login (e.g. a literal
  // hard-coded in one place only): never evaluate in response to our own review.
  const triggeringReview = context.payload.review;
  if (triggeringReview && triggeringReview.user && triggeringReview.user.login === BOT_LOGIN) {
    return setDecision('skip', 'triggered by the bot\'s own review');
  }

  // check_run events don't carry pull_request directly; extract from associated PRs.
  if (!pr && context.payload.check_run) {
    const prs = context.payload.check_run.pull_requests || [];
    if (prs.length === 0) {
      return setDecision('skip', 'check_run: no associated PRs');
    }
    const associatedPrNumber = prs[0] && prs[0].number;
    if (!Number.isInteger(associatedPrNumber) || associatedPrNumber <= 0) {
      return setDecision('skip', 'check_run: associated PR missing valid number');
    }
    const { owner: o, repo: r } = context.repo;
    const { data: fetchedPr } = await github.rest.pulls.get({
      owner: o, repo: r, pull_number: associatedPrNumber,
    });
    if (!fetchedPr.base || !BASE_BRANCHES.has(fetchedPr.base.ref)) {
      return setDecision(
        'skip',
        `check_run: PR base ref '${fetchedPr.base ? fetchedPr.base.ref : ''}' not in [${[...BASE_BRANCHES].join(', ')}]`,
      );
    }
    if (fetchedPr.draft) {
      return setDecision('skip', 'check_run: PR is draft');
    }
    if (!fetchedPr.head || !fetchedPr.head.repo || fetchedPr.head.repo.full_name !== `${o}/${r}`) {
      return setDecision('skip', 'check_run: PR head repo does not match current repo');
    }
    pr = fetchedPr;
  }

  // workflow_run events (for callers whose gating CI reports completion via a
  // separate workflow rather than check_run) don't carry pull_request either;
  // extract from the associated PRs, same shape as the check_run path above.
  if (!pr && context.payload.workflow_run) {
    const wr = context.payload.workflow_run;
    if (wr.conclusion !== 'success') {
      return setDecision('skip', `workflow_run: conclusion is ${wr.conclusion}`);
    }
    const prs = wr.pull_requests || [];
    if (prs.length === 0) {
      return setDecision('skip', 'workflow_run: no associated PRs');
    }
    const associatedPrNumber = prs[0] && prs[0].number;
    if (!Number.isInteger(associatedPrNumber) || associatedPrNumber <= 0) {
      return setDecision('skip', 'workflow_run: associated PR missing valid number');
    }
    const { owner: o, repo: r } = context.repo;
    if (!wr.head_repository || wr.head_repository.full_name !== `${o}/${r}`) {
      return setDecision('skip', 'workflow_run: head repo does not match current repo');
    }
    const { data: fetchedPr } = await github.rest.pulls.get({
      owner: o, repo: r, pull_number: associatedPrNumber,
    });
    if (!fetchedPr.base || !BASE_BRANCHES.has(fetchedPr.base.ref)) {
      return setDecision(
        'skip',
        `workflow_run: PR base ref '${fetchedPr.base ? fetchedPr.base.ref : ''}' not in [${[...BASE_BRANCHES].join(', ')}]`,
      );
    }
    if (fetchedPr.draft) {
      return setDecision('skip', 'workflow_run: PR is draft');
    }
    if (!fetchedPr.head || !fetchedPr.head.repo || fetchedPr.head.repo.full_name !== `${o}/${r}`) {
      return setDecision('skip', 'workflow_run: PR head repo does not match current repo');
    }
    pr = fetchedPr;
  }

  if (!pr) return setDecision('skip', 'no pull_request in event');

  const { owner, repo } = context.repo;
  const prNumber = pr.number;

  // Never self-approve — GitHub blocks it anyway, and in prod this guard
  // is load-bearing. Exception: inside sandbox repos the e2e harness runs
  // as both PR author and synthetic reviewer, so without this bypass the
  // harness can never reach the approval path.
  const inSandbox = SANDBOX_REPOS.has(`${owner}/${repo}`);
  if (BOT_LOGIN && pr.user && pr.user.login === BOT_LOGIN && !inSandbox) {
    return setDecision('skip', 'PR author is the bot itself');
  }

  // Threshold 0 means Copilot is not required for this PR's type: nothing to
  // wait for, and the review rules below are bypassed.
  let { threshold, type: commitType } = resolveThreshold(pr.title);
  if (threshold === 0) {
    const changed = await github.paginate(github.rest.pulls.listFiles, {
      owner, repo, pull_number: prNumber, per_page: 100,
    });
    const names = changedFileNames(changed);
    if (!filesMatchPaths(names, getOptionalPaths())) {
      core.info(`pr-auto-approve: type '${commitType}' allows no Copilot review, but the PR touches files outside copilot-optional-paths; using the normal rules`);
      threshold = Math.max(1, parseInt(process.env.AUTO_APPROVE_ROUNDS_THRESHOLD, 10) || 3);
    }
  }
  const copilotOptional = threshold === 0;

  const loadReviews = () => github.paginate(github.rest.pulls.listReviews, {
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  });
  let reviews = null;

  // A no-Copilot approval was earned by the title at the time. If the title has
  // since changed to a type that needs a review, the approval no longer stands:
  // withdraw it and evaluate the PR under the current rules. This runs before
  // every other gate (CI, the Copilot waits, reviewDecision), because those
  // return early and would otherwise leave the stale approval in place.
  let withdrew = false;
  if (BOT_LOGIN && !copilotOptional) {
    reviews = await loadReviews();
    const stale = reviews.filter((r) => {
      if (!r.user || r.user.login !== BOT_LOGIN || r.state !== 'APPROVED') return false;
      const body = String(r.body || '');
      const m = THRESHOLD_MARKER_RE.exec(body);
      // The first marker form (pre-3085536) meant "no Copilot review", i.e. 0.
      const stamped = m ? parseInt(m[1], 10) : (body.includes(LEGACY_OPTIONAL_MARKER) ? 0 : null);
      return stamped !== null && stamped < threshold;
    });
    for (const r of stale) {
      try {
        await dismissReview({
          github,
          botGithub,
          params: {
            owner,
            repo,
            pull_number: prNumber,
            review_id: r.id,
            message: `Withdrawn: the PR title (type ${commitType || 'none'}) now needs ${threshold} Copilot review round(s).`,
          },
        });
        withdrew = true;
      } catch (err) {
        // Fail closed and loudly: the stale approval still stands, so this must
        // not read as an ordinary skip. Neither the bot token nor the workflow token could dismiss.
        const reason = `could not withdraw the stale approval (review ${r.id}): ${err.status || ''} ${err.message || err}`.trim();
        core.error(`pr-auto-approve ${reason}`);
        if (typeof core.setFailed === 'function') core.setFailed(reason);
        return setDecision('error', reason);
      }
    }
    if (withdrew) reviews = null;
  }

  const headSha = pr.head.sha;
  let checkRuns = await fetchCheckRuns({ github, context, owner, repo, headSha });

  // Copilot finishing its review is the signal this gate needs, but Copilot
  // cannot deliver it. Its check run is created with GITHUB_TOKEN, and
  // GITHUB_TOKEN-generated events never start a new workflow run (the recursion
  // guard) — the check_run event is emitted, it just cannot start us. GitHub
  // now also holds any run Copilot itself triggers at
  // `action_required` pending manual approval (verified 2026-08-18: the same
  // workflow, event and actor ran clean on 2026-07-25 and is gated now). That
  // leaves this run — started by CI completing, so owned by an ungated actor —
  // as the only place the wait can happen. Opt-in: see getCopilotWaitSeconds.
  const waitSeconds = getCopilotWaitSeconds();
  // One budget for both waits below: the check-run wait (when Copilot still
  // registers a check) and the review wait (when it does not).
  const waitDeadline = Date.now() + waitSeconds * 1000;
  if (waitSeconds > 0 && !copilotOptional) {
    checkRuns = await waitForCopilotCheck({
      github, context, core, owner, repo, headSha, checkRuns, waitSeconds, sleep,
    });
  }

  // The CI gates, applied here and again after any review wait below: a
  // rerun or a late-registered check can change the picture while we poll.
  const checkGate = (allRuns) => {
    // When Copilot is not required, its own check run (pending while an automatic
    // review is still running, or non-success) is not CI and must not hold the PR.
    // Unfinished only: Copilot's check is a github-actions check like any CI job
    // (verified: same app id), so the name cannot prove it is Copilot's, and a
    // completed check with that name must keep counting.
    const runs = copilotOptional
      ? allRuns.filter((cr) => !(COPILOT_CHECK_NAMES.has(cr.name) && cr.status !== 'completed'))
      : allRuns;
    if (runs.length === 0) {
      if (!getAllowNoChecks()) {
        return setDecision('skip', 'no checks on head SHA yet');
      }
      core.warning('pr-auto-approve: no external checks found; proceeding because allow-no-checks=true');
    }
    const badCheck = runs.find(isFailedCheck);
    if (badCheck) {
      return setDecision(
        'skip',
        `failing check: ${badCheck.name} (${badCheck.conclusion})`,
      );
    }
    const pending = runs.find((cr) => cr.status !== 'completed');
    if (pending) {
      return setDecision('skip', `check still running: ${pending.name}`);
    }
    return null;
  };
  const gated = checkGate(checkRuns);
  if (gated) return gated;

  reviews = reviews || await loadReviews();

  // GraphQL reviewDecision gate: GitHub's authoritative "is this PR already
  // approved overall?" signal. It reflects branch-protection dismissals — a
  // stale approval invalidated by a new push reads as REVIEW_REQUIRED, not
  // APPROVED — so it pairs with the head-SHA REST guard instead of masking a
  // needed re-approval. Best-effort: a GraphQL-specific failure is logged and
  // we fall through to the REST review checks, so a GraphQL outage never
  // disables auto-approval.
  let reviewDecision;
  try {
    const gql = await github.graphql(
      `query ($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $number) { reviewDecision }
        }
      }`,
      { owner, repo, number: prNumber },
    );
    reviewDecision = gql?.repository?.pullRequest?.reviewDecision;
  } catch (err) {
    core.warning(
      `pr-auto-approve: reviewDecision query failed, falling through to REST: ${err.status || ''} ${err.message || err}`.trim(),
    );
  }
  if (reviewDecision === 'APPROVED' && !withdrew) {
    return setDecision('skip', 'PR already approved (reviewDecision=APPROVED)');
  }

  // Idempotency: only skip if the bot's LATEST non-dismissed review is APPROVED.
  // A historical approval superseded by COMMENT/CHANGES_REQUESTED must NOT block
  // a fresh approval.
  const botReviews = BOT_LOGIN
    ? reviews
        .filter(
          (r) =>
            r.user &&
            r.user.login === BOT_LOGIN &&
            r.state !== 'DISMISSED' &&
            r.state !== 'PENDING' &&
            r.submitted_at,
        )
        .sort((a, b) => {
          const at = Date.parse(a.submitted_at) || a.id;
          const bt = Date.parse(b.submitted_at) || b.id;
          return at - bt;
        })
    : [];
  const latestBotReview = botReviews[botReviews.length - 1];
  // Bind idempotency to the head SHA: only skip if the bot already approved
  // THIS commit. A stale approval of an earlier commit (e.g. a push has since
  // moved the head, dismissing it under branch protection) must NOT block a
  // fresh approval of the new head. If commit_id is somehow absent, the guard
  // is false and we re-approve — the safe direction.
  const alreadyApproved =
    latestBotReview &&
    latestBotReview.state === 'APPROVED' &&
    latestBotReview.commit_id === headSha;
  if (alreadyApproved) {
    return setDecision('skip', `bot already approved head ${headSha}`);
  }

  const testLogins = parseTestLogins(
    process.env,
    context.repo,
    typeof core.warning === 'function' ? core.warning.bind(core) : undefined,
  );
  const copilotMatches = makeIsCopilot(testLogins);
  const selectCopilotReviews = (rs) => rs
    .filter(
      (r) =>
        copilotMatches(r.user) &&
        r.state !== 'DISMISSED' &&
        r.state !== 'PENDING' &&
        r.submitted_at,
    )
    .sort((a, b) => {
      const at = a.submitted_at ? Date.parse(a.submitted_at) : a.id;
      const bt = b.submitted_at ? Date.parse(b.submitted_at) : b.id;
      return at - bt;
    });
  let copilotReviews = selectCopilotReviews(reviews);

  // Copilot stopped registering a check run on the head SHA (verified
  // 2026-10-20: the head's check-runs list holds only the repo's own jobs
  // while Copilot posts its review from a `dynamic` workflow), so the wait
  // above never engages and the run started by CI completing used to skip
  // with "no Copilot review yet" seconds before the review landed. Spend the
  // same budget polling the reviews themselves until Copilot has reviewed
  // this head (or enough rounds exist for the threshold to decide).
  if (waitSeconds > 0 && !copilotOptional) {
    const waited = await waitForCopilotReview({
      core,
      headSha,
      threshold,
      deadline: waitDeadline,
      sleep,
      initial: copilotReviews,
      load: async () => selectCopilotReviews(await loadReviews()),
    });
    copilotReviews = waited.reviews;
    if (waited.polled) {
      // Minutes may have passed: a rerun on this head or a check registered
      // late must still block approval.
      checkRuns = await fetchCheckRuns({ github, context, owner, repo, headSha });
      const regated = checkGate(checkRuns);
      if (regated) return regated;
    }
  }

  core.info(`pr-auto-approve: found ${copilotReviews.length} Copilot review(s) for PR #${prNumber}`);

  if (copilotReviews.length === 0 && !copilotOptional) {
    return setDecision('skip', 'no Copilot review yet');
  }

  // Always honor the latest Copilot signal: if the most recent non-dismissed
  // review is CHANGES_REQUESTED, never approve — even under the 3-rounds rule.
  const latest = copilotReviews[copilotReviews.length - 1];
  if (latest) {
    core.info(`pr-auto-approve: latest Copilot review id=${latest.id} state=${latest.state}`);
    if (latest.state === 'CHANGES_REQUESTED') {
      return setDecision('skip', 'latest Copilot review requested changes');
    }
  }

  let reason = '';
  if (copilotOptional) {
    reason = `copilot-optional (type ${commitType || 'none'}, rounds-by-type 0)`;
  } else if (copilotReviews.length >= threshold) {
    reason = `${threshold}-rounds (${copilotReviews.length} Copilot reviews)`;
  } else {
    // A COMMENTED review is NOT dismissed when a push invalidates approvals, so
    // once `dismiss_stale_reviews_on_push` fires, Copilot's review of the PREVIOUS
    // commit is still the latest one here. Approving on it would clear the gate
    // for code Copilot never read. Require the review to name the current head.
    // An absent commit_id can't prove freshness either, so it skips too — the safe
    // direction, and the rounds threshold above still rescues a PR that somehow
    // never matches.
    if (latest.commit_id !== headSha) {
      // Distinguish the two failure modes: a review of a different commit is
      // routine (you pushed), whereas a review with no commit at all is
      // anomalous. Reporting both as "older commit (unknown)" would send
      // someone hunting for a SHA that was never there.
      const detail = latest.commit_id
        ? `is for an older commit (${String(latest.commit_id).slice(0, 8)})`
        : 'has no commit_id, so its freshness cannot be verified';
      return setDecision(
        'skip',
        `latest Copilot review ${detail}, waiting for re-review`,
      );
    }
    const comments = await github.paginate(
      github.rest.pulls.listCommentsForReview,
      { owner, repo, pull_number: prNumber, review_id: latest.id, per_page: 100 },
    );
    if (comments.length !== 0) {
      return setDecision(
        'skip',
        `latest Copilot review has ${comments.length} comments`,
      );
    }
    // A clean-looking summary plus a suppressed block means Copilot DID produce
    // feedback, it just withheld it from the inline comments. Treat it exactly
    // like inline comments and leave the PR for a human. Note this gate is
    // deliberately absent from the rounds-threshold branch above: that branch is
    // the escape hatch, so a block that never clears can't wedge the PR.
    const suppressed = countSuppressedComments(latest.body);
    if (suppressed !== 0) {
      return setDecision(
        'skip',
        `latest Copilot review has ${suppressed} suppressed comment(s)`,
      );
    }
    reason = `copilot-clean (review ${latest.id}, state=${latest.state})`;
  }

  // The path allowlist was read from the live PR while headSha came from the
  // event, so a push in between would leave them describing different commits.
  // Only the no-review path rests on that list, so only it pays for the re-read.
  // Also compared: the title, which chose the threshold. A retitle that lands
  // while this run is in flight would otherwise be approved under the old type
  // (cancel-in-progress is not atomic).
  const { data: current } = await github.rest.pulls.get({ owner, repo, pull_number: prNumber });
  if (current.head.sha !== headSha) {
    return setDecision('skip', `head moved from ${headSha.slice(0, 8)} to ${current.head.sha.slice(0, 8)} during evaluation`);
  }
  if ((current.title || '') !== (pr.title || '')) {
    return setDecision('skip', 'PR title changed during evaluation; the next run re-evaluates it');
  }

  // Only approvals that lean on the threshold are stamped: the optional (0) path
  // and the rounds rule. A clean current-head review holds under any threshold.
  const approvalStamp = copilotOptional || reason.includes('-rounds ')
    ? `\n\n${thresholdMarker(threshold)}`
    : '';
  let created;
  try {
    // botGithub, not github: this is the ONE call that must come from the bot
    // account rather than the workflow. Everything above reads through
    // `github`, which is the workflow's own GITHUB_TOKEN — listing check runs
    // needs the `Checks` permission, and a fine-grained PAT cannot be granted
    // it, so PAT-based reads work on public repos and 403 forever on private
    // ones. Defaults to `github` so a caller passing one client still works.
    ({ data: created } = await botGithub.rest.pulls.createReview({
      owner,
      repo,
      pull_number: prNumber,
      commit_id: headSha,
      event: 'APPROVE',
      body: `Auto-approved: ${reason}.${approvalStamp}`,
    }));
  } catch (err) {
    // No approval exists, so an ordinary skip is accurate here.
    return setDecision(
      'skip',
      `approval API call failed: ${err.status || ''} ${err.message || err}`.trim(),
    );
  }

  // From here an approval exists, so nothing below may fall back to a plain
  // skip. The pre-approval re-read leaves a window: a retitle or push can land
  // between it and the review. Look again and take the approval back; if the
  // look itself fails, withdraw as a precaution.
  let changedWhileApproving;
  try {
    const { data: after } = await github.rest.pulls.get({ owner, repo, pull_number: prNumber });
    changedWhileApproving = after.head.sha !== headSha || (after.title || '') !== (pr.title || '')
      ? 'PR head or title changed while approving'
      : '';
  } catch (err) {
    changedWhileApproving = `could not re-read the PR after approving (${err.status || ''} ${err.message || err})`.trim();
  }
  if (changedWhileApproving) {
    try {
      await dismissReview({
        github,
        botGithub,
        params: {
          owner,
          repo,
          pull_number: prNumber,
          review_id: created.id,
          message: `Withdrawn: ${changedWhileApproving}.`,
        },
      });
    } catch (err) {
      const failure = `approved, then ${changedWhileApproving}, and the approval could not be withdrawn (review ${created.id}): ${err.status || ''} ${err.message || err}`.trim();
      core.error(`pr-auto-approve ${failure}`);
      if (typeof core.setFailed === 'function') core.setFailed(failure);
      return setDecision('error', failure);
    }
    return setDecision('skip', `${changedWhileApproving}; approval withdrawn`);
  }
  return setDecision('approved', reason);
}

module.exports = decide;
module.exports.isCopilot = isCopilot;
module.exports.makeIsCopilot = makeIsCopilot;
module.exports.parseTestLogins = parseTestLogins;
module.exports.countSuppressedComments = countSuppressedComments;
module.exports.getBaseBranches = getBaseBranches;
module.exports.parseCommitType = parseCommitType;
module.exports.parseRoundsByType = parseRoundsByType;
module.exports.resolveThreshold = resolveThreshold;
module.exports.getOptionalPaths = getOptionalPaths;
module.exports.filesMatchPaths = filesMatchPaths;
module.exports.changedFileNames = changedFileNames;
module.exports.requestCopilotReview = requestCopilotReview;
