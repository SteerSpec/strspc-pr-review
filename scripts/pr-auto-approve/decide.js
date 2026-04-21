// SPDX-License-Identifier: Apache-2.0
// Decision logic for the pr-auto-approve reusable workflow.
// Extracted into a module so it can be unit-tested with `node --test`.
//
// Configuration (via environment variables, set by the caller workflow):
//   AUTO_APPROVE_BOT_LOGIN    — login of the bot that posts approval reviews (required)
//   AUTO_APPROVE_BASE_BRANCH  — base branch PRs must target (default: main)
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
]);

function getBotLogin() { return process.env.AUTO_APPROVE_BOT_LOGIN || ''; }
function getBaseBranch() { return process.env.AUTO_APPROVE_BASE_BRANCH || 'main'; }
function getSandboxRepos() {
  const raw = process.env.AUTO_APPROVE_SANDBOX_REPOS || '';
  return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
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

async function decide(args) {
  try {
    return await decideInner(args);
  } catch (err) {
    // Any unexpected API error (bad/empty token, 403, rate limit, network)
    // is converted to a clean skip so the workflow never flips a required
    // check to red for reasons unrelated to the review state.
    const { core } = args;
    const reason = `evaluation failed: ${err.status || ''} ${err.message || err}`.trim();
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

async function decideInner({ github, context, core }) {
  const BOT_LOGIN = getBotLogin();
  const BASE_BRANCH = getBaseBranch();
  const SANDBOX_REPOS = getSandboxRepos();

  let pr = context.payload.pull_request;

  const setDecision = async (decision, reason) => {
    core.info(`pr-auto-approve decision=${decision} reason=${reason}`);
    core.setOutput('decision', decision);
    core.setOutput('reason', reason);
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
    if (!fetchedPr.base || fetchedPr.base.ref !== BASE_BRANCH) {
      return setDecision('skip', `check_run: PR base ref is not ${BASE_BRANCH}`);
    }
    if (fetchedPr.draft) {
      return setDecision('skip', 'check_run: PR is draft');
    }
    if (!fetchedPr.head || !fetchedPr.head.repo || fetchedPr.head.repo.full_name !== `${o}/${r}`) {
      return setDecision('skip', 'check_run: PR head repo does not match current repo');
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

  // Check runs: paginate, filter out this workflow's own run, dedupe by (name, app.id)
  // keeping the latest attempt. Prevents the self-pending trap and rerun staleness.
  const headSha = pr.head.sha;
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
  const notSelf = validCheckRuns.filter(
    (cr) => !(cr.details_url && selfRunRe.test(cr.details_url)),
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
  const checkRuns = [...latestByKey.values()];

  if (checkRuns.length === 0) {
    return setDecision('skip', 'no checks on head SHA yet');
  }

  const badCheck = checkRuns.find(
    (cr) =>
      cr.status === 'completed' &&
      !['success', 'neutral', 'skipped', 'cancelled', 'stale'].includes(cr.conclusion),
  );
  if (badCheck) {
    return setDecision(
      'skip',
      `failing check: ${badCheck.name} (${badCheck.conclusion})`,
    );
  }
  const pending = checkRuns.find((cr) => cr.status !== 'completed');
  if (pending) {
    return setDecision('skip', `check still running: ${pending.name}`);
  }

  const reviews = await github.paginate(github.rest.pulls.listReviews, {
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  });

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
  const alreadyApproved = latestBotReview && latestBotReview.state === 'APPROVED';
  if (alreadyApproved) {
    return setDecision('skip', 'bot already approved this PR');
  }

  const testLogins = parseTestLogins(
    process.env,
    context.repo,
    typeof core.warning === 'function' ? core.warning.bind(core) : undefined,
  );
  const copilotMatches = makeIsCopilot(testLogins);
  const copilotReviews = reviews
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

  if (copilotReviews.length === 0) {
    return setDecision('skip', 'no Copilot review yet');
  }

  // Always honor the latest Copilot signal: if the most recent non-dismissed
  // review is CHANGES_REQUESTED, never approve — even under the 3-rounds rule.
  const latest = copilotReviews[copilotReviews.length - 1];
  if (latest.state === 'CHANGES_REQUESTED') {
    return setDecision('skip', 'latest Copilot review requested changes');
  }

  let reason = '';
  if (copilotReviews.length >= 3) {
    reason = `3-rounds (${copilotReviews.length} Copilot reviews)`;
  } else {
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
    reason = `copilot-clean (review ${latest.id}, state=${latest.state})`;
  }

  try {
    await github.rest.pulls.createReview({
      owner,
      repo,
      pull_number: prNumber,
      event: 'APPROVE',
      body: `Auto-approved: ${reason}.`,
    });
    return setDecision('approved', reason);
  } catch (err) {
    return setDecision(
      'skip',
      `approval API call failed: ${err.status || ''} ${err.message || err}`.trim(),
    );
  }
}

module.exports = decide;
module.exports.isCopilot = isCopilot;
module.exports.makeIsCopilot = makeIsCopilot;
module.exports.parseTestLogins = parseTestLogins;
