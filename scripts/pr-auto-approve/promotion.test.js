// SPDX-License-Identifier: Apache-2.0
// Unit tests for the promotion path: the helpers in promotion.js, and the route
// through decide.js. Run with: node --test scripts/pr-auto-approve/

const { test } = require('node:test');
const assert = require('node:assert/strict');
const decide = require('./decide.js');
const {
  getPromotionPairs,
  findPromotionPair,
  promotionTitleBlocker,
  hasStandingApproval,
  checkProvenance,
  MAX_LISTED_COMMITS,
} = require('./promotion.js');

process.env.AUTO_APPROVE_BOT_LOGIN = 'approver-bot';
process.env.AUTO_APPROVE_SANDBOX_REPOS = '';
process.env.AUTO_APPROVE_BASE_BRANCH = 'develop,main';
process.env.AUTO_APPROVE_ROUNDS_THRESHOLD = '3';

const HEAD = 'cafe0002';
const FULL_NAME = 'acme/widgets';
const CHECK_OK = { name: 'ci', status: 'completed', conclusion: 'success', app: { id: 1 } };
const MERGED_AT = '2026-10-01T11:00:00Z';
const source = (number, overrides = {}) => ({
  number, merged_at: MERGED_AT, head: { sha: `h${number}` }, base: { ref: 'develop' }, ...overrides,
});
// A source PR's review, in the shape SOURCE_REVIEWS_QUERY returns.
const approval = (number, overrides = {}) => ({
  state: 'APPROVED',
  submittedAt: '2026-10-01T10:00:00Z',
  authorCanPushToRepository: true,
  author: { login: 'someone' },
  commit: { oid: `h${number}` },
  ...overrides,
});

// A repo with commits c1 (from PR 11) and HEAD (from PR 12) on develop, both
// approved. Each test overrides the one fact it is about.
function makeRepo({
  tip = HEAD,
  commits = [{ sha: 'cafe0001' }, { sha: HEAD }],
  associated = { cafe0001: [source(11)], [HEAD]: [source(12)] },
  reviews = { 11: [approval(11)], 12: [approval(12)] },
  checkRuns = [CHECK_OK],
  current,
  reviewDecision = null,
  truncated = [],
} = {}) {
  const calls = { createReview: [], dismiss: [], reviewers: [], listCommits: 0, sourceReviews: 0 };
  const github = {
    paginate: async (fn, params) => (await fn(params)).data,
    graphql: async (query, { number }) => {
      if (!query.includes('authorCanPushToRepository')) {
        return { repository: { pullRequest: { reviewDecision } } };
      }
      calls.sourceReviews += 1;
      const page = { nodes: reviews[number] || [], pageInfo: { hasNextPage: truncated.includes(number) } };
      return { repository: { pullRequest: { reviews: page } } };
    },
    rest: {
      checks: { listForRef: async () => ({ data: { total_count: checkRuns.length, check_runs: checkRuns } }) },
      git: { getRef: async () => ({ data: { object: { sha: tip } } }) },
      repos: {
        listPullRequestsAssociatedWithCommit: async ({ commit_sha }) => ({ data: associated[commit_sha] || [] }),
      },
      pulls: {
        get: async () => ({ data: current || promotionPr() }),
        listCommits: async () => {
          calls.listCommits += 1;
          return { data: commits };
        },
        listReviews: async ({ pull_number }) => ({
          data: (reviews[pull_number] || []).map((r) => (
            calls.dismiss.some((d) => d.review_id === r.id) ? { ...r, state: 'DISMISSED' } : r
          )),
        }),
        listCommentsForReview: async () => ({ data: [] }),
        createReview: async (args) => {
          calls.createReview.push(args);
          return { data: { id: 999 } };
        },
        dismissReview: async (args) => {
          calls.dismiss.push(args);
          return { data: {} };
        },
        requestReviewers: async (args) => {
          calls.reviewers.push(args);
          return { data: {} };
        },
      },
    },
  };
  return { github, calls };
}

function promotionPr(overrides = {}) {
  return {
    number: 171,
    draft: false,
    title: 'chore: promote develop to main',
    user: { login: 'someone' },
    head: { ref: 'develop', sha: HEAD, repo: { full_name: FULL_NAME } },
    base: { ref: 'main' },
    ...overrides,
  };
}

const makeContext = (pr = promotionPr()) => ({
  runId: 1,
  repo: { owner: 'acme', repo: 'widgets' },
  payload: { pull_request: pr },
});

function makeCore() {
  const warnings = [];
  return {
    warnings,
    outputs: {},
    setOutput(k, v) { this.outputs[k] = v; },
    info: () => {},
    error: () => {},
    warning: (m) => warnings.push(m),
    setFailed: () => {},
    summary: { addRaw() { return this; }, async write() {} },
  };
}

// Runs decide with the promotion path configured, and restores the env after.
async function run({ repo = makeRepo(), pr = promotionPr(), branches = 'develop:main', env = {}, sleep } = {}) {
  const overrides = { AUTO_APPROVE_PROMOTION_BRANCHES: branches, ...env };
  const saved = Object.keys(overrides).map((k) => [k, process.env[k]]);
  Object.assign(process.env, overrides);
  try {
    const result = await decide({ github: repo.github, context: makeContext(pr), core: makeCore(), sleep });
    return { ...result, calls: repo.calls };
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// -- Configuration ---------------------------------------------------------

test('getPromotionPairs: reads comma-separated head:base pairs', () => {
  const env = { AUTO_APPROVE_PROMOTION_BRANCHES: ' develop:main , next : stable ' };
  assert.deepEqual(getPromotionPairs(env), [
    { head: 'develop', base: 'main' },
    { head: 'next', base: 'stable' },
  ]);
});

test('getPromotionPairs: blank means off, without a warning', () => {
  const warned = [];
  assert.deepEqual(getPromotionPairs({ AUTO_APPROVE_PROMOTION_BRANCHES: '  ' }, (m) => warned.push(m)), []);
  assert.deepEqual(getPromotionPairs({}, (m) => warned.push(m)), []);
  assert.deepEqual(warned, []);
});

test('getPromotionPairs: a malformed entry is dropped with a warning', () => {
  const warned = [];
  const env = { AUTO_APPROVE_PROMOTION_BRANCHES: 'develop,a:b:c,:main,develop:,next:stable' };
  assert.deepEqual(getPromotionPairs(env, (m) => warned.push(m)), [{ head: 'next', base: 'stable' }]);
  assert.equal(warned.length, 4);
  assert.match(warned[1], /'a:b:c'/);
});

test('findPromotionPair: needs both refs to match exactly', () => {
  const pairs = [{ head: 'develop', base: 'main' }];
  const pr = (head, base) => ({ head: { ref: head }, base: { ref: base } });
  assert.deepEqual(findPromotionPair(pr('develop', 'main'), pairs), pairs[0]);
  assert.equal(findPromotionPair(pr('develop', 'stable'), pairs), null);
  assert.equal(findPromotionPair(pr('develop-2', 'main'), pairs), null);
  assert.equal(findPromotionPair(pr('main', 'develop'), pairs), null);
  assert.equal(findPromotionPair({}, pairs), null);
});

test('promotionTitleBlocker: only a plain chore title passes', () => {
  assert.equal(promotionTitleBlocker('chore: promote develop to main'), null);
  assert.equal(promotionTitleBlocker('chore(release): 1.2.0'), null);
  assert.match(promotionTitleBlocker('feat: promote'), /type 'feat'/);
  assert.match(promotionTitleBlocker('fix(api): promote'), /type 'fix'/);
  assert.match(promotionTitleBlocker('chore!: promote'), /breaking/);
  assert.match(promotionTitleBlocker('promote develop'), /not a Conventional Commit/);
  assert.match(promotionTitleBlocker(undefined), /not a Conventional Commit/);
});

// -- Provenance ------------------------------------------------------------

const FACTS = { headSha: 'h1', mergedAt: MERGED_AT };
const standing = (reviews, facts = FACTS) => hasStandingApproval(reviews, facts);
const review = (state, submittedAt = '2026-10-01T10:00:00Z', overrides = {}) =>
  approval(1, { state, submittedAt, ...overrides });

test('hasStandingApproval: a reviewer\'s latest decisive review counts', () => {
  assert.equal(standing([]), false);
  assert.equal(standing([review('COMMENTED')]), false);
  assert.equal(standing([review('APPROVED')]), true);
  assert.equal(standing([review('DISMISSED')]), false);
  assert.equal(standing([review('APPROVED'), review('COMMENTED', '2026-10-01T10:30:00Z')]), true);
  assert.equal(standing([review('APPROVED'), review('DISMISSED', '2026-10-01T10:30:00Z')]), false);
  assert.equal(standing([
    review('CHANGES_REQUESTED', '2026-10-01T10:30:00Z'),
    review('APPROVED'),
  ]), false, 'order comes from submitted_at, not from the list');
  assert.equal(standing([review('APPROVED', '2026-10-01T10:00:00Z', { author: null })]), false);
});

test('hasStandingApproval: an approval must name the commit that merged', () => {
  assert.equal(standing([review('APPROVED', '2026-10-01T10:00:00Z', { commit: { oid: 'older' } })]), false);
  assert.equal(standing([review('APPROVED', '2026-10-01T10:00:00Z', { commit: null })]), false);
});

test('hasStandingApproval: an approval after the merge does not count', () => {
  assert.equal(standing([review('APPROVED', '2026-10-01T11:00:01Z')]), false);
  assert.equal(standing([review('APPROVED', MERGED_AT)]), false, 'a tie cannot be shown to precede the merge');
  assert.equal(standing([review('APPROVED', '2026-10-01T10:00:00Z')], { ...FACTS, mergedAt: undefined }), false);
});

test('hasStandingApproval: no head to compare against proves nothing', () => {
  const noOid = review('APPROVED', '2026-10-01T10:00:00Z', { commit: {} });
  assert.equal(standing([noOid], { ...FACTS, headSha: undefined }), false);
});

test('hasStandingApproval: another reviewer\'s open change request blocks', () => {
  assert.equal(standing([
    review('APPROVED'),
    review('CHANGES_REQUESTED', '2026-10-01T10:30:00Z', { author: { login: 'other' } }),
  ]), false);
});

test('hasStandingApproval: a reviewer who cannot push does not count', () => {
  const noPush = { authorCanPushToRepository: false };
  assert.equal(standing([review('APPROVED', '2026-10-01T10:00:00Z', noPush)]), false);
  assert.equal(standing([
    review('APPROVED', '2026-10-01T10:00:00Z', noPush),
    review('APPROVED', '2026-10-01T10:00:00Z', { author: { login: 'other' } }),
  ]), true);
});

const provenance = (repo) => checkProvenance({
  github: repo.github, owner: 'acme', repo: 'widgets', prNumber: 171, headRef: 'develop', headSha: HEAD,
});

test('checkProvenance: every commit from an approved PR passes', async () => {
  assert.deepEqual(await provenance(makeRepo()), { ok: true, commits: 2, prs: 2 });
});

test('checkProvenance: two commits of one PR read its reviews once', async () => {
  const repo = makeRepo({ associated: { cafe0001: [source(11)], [HEAD]: [source(11)] } });
  assert.deepEqual(await provenance(repo), { ok: true, commits: 2, prs: 1 });
  assert.equal(repo.calls.sourceReviews, 1);
});

test('checkProvenance: more reviews than one page cannot be judged, so it fails', async () => {
  const out = await provenance(makeRepo({ truncated: [12] }));
  assert.match(out.reason, /came from #12, which has no standing approval/);
});

test('checkProvenance: a commit with no PR fails and names the commit', async () => {
  const out = await provenance(makeRepo({ associated: { [HEAD]: [source(12)] } }));
  assert.equal(out.ok, false);
  assert.match(out.reason, /commit cafe0001 has no merged PR into develop/);
});

test('checkProvenance: a PR that is open, or merged elsewhere, does not count', async () => {
  const out = await provenance(makeRepo({
    associated: {
      cafe0001: [source(20, { merged_at: null }), source(21, { base: { ref: 'main' } })],
    },
  }));
  assert.match(out.reason, /commit cafe0001 has no merged PR into develop/);
});

test('checkProvenance: a PR with no approval fails and names both', async () => {
  const out = await provenance(makeRepo({ reviews: { 11: [approval(11)], 12: [] } }));
  assert.equal(out.ok, false);
  assert.match(out.reason, new RegExp(`commit ${HEAD} came from #12, which has no standing approval`));
});

test('checkProvenance: an approval of an earlier commit of the PR fails', async () => {
  const out = await provenance(makeRepo({
    reviews: { 11: [approval(11)], 12: [approval(12, { commit: { oid: 'earlier' } })] },
  }));
  assert.match(out.reason, /came from #12, which has no standing approval/);
});

test('checkProvenance: a missing source head fails rather than matching nothing to nothing', async () => {
  const out = await provenance(makeRepo({
    associated: { cafe0001: [source(11, { head: null })], [HEAD]: [source(12)] },
    reviews: { 11: [approval(11, { commit: null })], 12: [approval(12)] },
  }));
  assert.match(out.reason, /came from #11, which has no standing approval/);
});

test('checkProvenance: every associated merged PR must be approved', async () => {
  const associated = { cafe0001: [source(11), source(13)], [HEAD]: [source(12)] };
  const stacked = await provenance(makeRepo({
    associated, reviews: { 11: [], 12: [approval(12)], 13: [approval(13)] },
  }));
  assert.match(stacked.reason, /commit cafe0001 came from #11/);
  const both = await provenance(makeRepo({
    associated, reviews: { 11: [approval(11)], 12: [approval(12)], 13: [approval(13)] },
  }));
  assert.equal(both.ok, true);
});

test('checkProvenance: a full commit list may be partial, so it fails', async () => {
  const commits = Array.from({ length: MAX_LISTED_COMMITS }, (_, i) => ({ sha: `s${i}` }));
  const out = await provenance(makeRepo({ commits }));
  assert.equal(out.ok, false);
  assert.match(out.reason, /250 commits or more/);
});

test('checkProvenance: a list without the evaluated head fails', async () => {
  const out = await provenance(makeRepo({ commits: [{ sha: 'cafe0001' }] }));
  assert.equal(out.ok, false);
  assert.match(out.reason, /does not include the evaluated head/);
});

// -- Through decide --------------------------------------------------------

test('unset: a promotion PR takes the Copilot path as before', async () => {
  const out = await run({ branches: '' });
  assert.equal(out.decision, 'skip');
  assert.equal(out.reason, 'no Copilot review yet');
  assert.equal(out.calls.listCommits, 0);
});

test('approve: a passing promotion needs no Copilot review and no wait', async () => {
  let slept = 0;
  const out = await run({
    env: { AUTO_APPROVE_COPILOT_WAIT_SECONDS: '300' },
    sleep: async () => { slept += 1; },
  });
  assert.equal(out.decision, 'approved', out.reason);
  assert.equal(out.reason, 'promotion (develop to main, 2 commit(s) from 2 approved PR(s))');
  assert.equal(slept, 0);
  assert.equal(out.calls.createReview.length, 1);
  assert.equal(out.calls.createReview[0].commit_id, HEAD);
  assert.match(out.calls.createReview[0].body, /<!-- pr-auto-approve:threshold=0 -->/);
});

test('a PR that matches no pair takes the Copilot path', async () => {
  const pr = promotionPr({ head: { ref: 'feature', sha: HEAD, repo: { full_name: FULL_NAME } } });
  const out = await run({ pr, repo: makeRepo({ current: pr }) });
  assert.equal(out.reason, 'no Copilot review yet');
  assert.equal(out.calls.listCommits, 0);
});

test('skip: a fork head named develop', async () => {
  const pr = promotionPr({ head: { ref: 'develop', sha: HEAD, repo: { full_name: 'someone/widgets' } } });
  const out = await run({ pr });
  assert.equal(out.decision, 'skip');
  assert.match(out.reason, /head repo does not match/);
  assert.equal(out.calls.createReview.length, 0);
});

test('skip: the pair\'s base must also be in base-branch', async () => {
  const out = await run({ env: { AUTO_APPROVE_BASE_BRANCH: 'develop' } });
  assert.equal(out.decision, 'skip');
  assert.match(out.reason, /PR base ref 'main' not in/);
});

test('skip: a stale head is not the branch tip', async () => {
  const out = await run({ repo: makeRepo({ tip: 'cafe0009' }) });
  assert.equal(out.decision, 'skip');
  assert.equal(out.reason, `head ${HEAD} is not the tip of develop (cafe0009); the next run re-evaluates it`);
  assert.equal(out.calls.createReview.length, 0);
});

test('skip: a failing check', async () => {
  const out = await run({
    repo: makeRepo({ checkRuns: [{ ...CHECK_OK, conclusion: 'failure', details_url: 'u' }] }),
  });
  assert.equal(out.decision, 'skip');
  assert.match(out.reason, /failing check: ci/);
  assert.equal(out.calls.listCommits, 0, 'provenance waits for the cheaper gates');
});

test('skip: a check still running', async () => {
  const out = await run({ repo: makeRepo({ checkRuns: [{ name: 'ci', status: 'in_progress', app: { id: 1 } }] }) });
  assert.equal(out.decision, 'skip');
  assert.match(out.reason, /check still running: ci/);
});

test('a pending Copilot check does not hold a promotion', async () => {
  const pending = { name: 'copilot-pull-request-reviewer', status: 'in_progress', app: { id: 1 } };
  const out = await run({ repo: makeRepo({ checkRuns: [CHECK_OK, pending] }) });
  assert.equal(out.decision, 'approved', out.reason);
});

test('skip: a feat title', async () => {
  const pr = promotionPr({ title: 'feat: promote develop to main' });
  const out = await run({ pr, repo: makeRepo({ current: pr }) });
  assert.equal(out.decision, 'skip');
  assert.match(out.reason, /title type 'feat' would be counted twice/);
  assert.equal(out.calls.createReview.length, 0);
});

test('skip: a commit with no PR', async () => {
  const out = await run({ repo: makeRepo({ associated: { [HEAD]: [source(12)] } }) });
  assert.equal(out.decision, 'skip');
  assert.match(out.reason, /commit cafe0001 has no merged PR into develop/);
  assert.equal(out.calls.createReview.length, 0);
});

test('skip: a PR with no approval', async () => {
  const out = await run({ repo: makeRepo({ reviews: { 11: [], 12: [approval(12)] } }) });
  assert.equal(out.decision, 'skip');
  assert.match(out.reason, /came from #11, which has no standing approval/);
});

test('approve: the bot\'s own approval counts for provenance', async () => {
  const bot = { author: { login: 'approver-bot' } };
  const out = await run({
    repo: makeRepo({ reviews: { 11: [approval(11, bot)], 12: [approval(12, bot)] } }),
  });
  assert.equal(out.decision, 'approved', out.reason);
});

test('a push also withdraws an unstamped bot approval of an older head', async () => {
  const unstamped = { ...STAMPED, body: 'Auto-approved: copilot-clean.' };
  const out = await run({
    repo: makeRepo({ reviewDecision: 'APPROVED', reviews: { 11: [], 12: [approval(12)], 171: [unstamped] } }),
  });
  assert.equal(out.decision, 'skip');
  assert.match(out.reason, /came from #11/);
  assert.equal(out.calls.dismiss.length, 1);
});

test('a human approval of an older head is not the bot\'s to withdraw', async () => {
  const human = { ...STAMPED, user: { login: 'someone' } };
  const out = await run({ repo: makeRepo({ reviews: { 11: [approval(11)], 12: [approval(12)], 171: [human] } }) });
  assert.equal(out.decision, 'approved', out.reason);
  assert.equal(out.calls.dismiss.length, 0);
});

test('skip: 250 commits or more', async () => {
  const commits = Array.from({ length: 251 }, (_, i) => ({ sha: `s${i}` }));
  const out = await run({ repo: makeRepo({ commits }) });
  assert.equal(out.decision, 'skip');
  assert.match(out.reason, /250 commits or more/);
});

const STAMPED = {
  id: 5,
  state: 'APPROVED',
  commit_id: 'cafe0000',
  user: { login: 'approver-bot' },
  submitted_at: '2026-10-01T09:00:00Z',
  body: 'Auto-approved: promotion.\n\n<!-- pr-auto-approve:threshold=0 -->',
};

test('a push re-evaluates: the older approval goes and the new head is approved', async () => {
  const out = await run({
    repo: makeRepo({ reviews: { 11: [approval(11)], 12: [approval(12)], 171: [STAMPED] } }),
  });
  assert.equal(out.decision, 'approved', out.reason);
  assert.equal(out.calls.dismiss[0].review_id, 5);
  assert.match(out.calls.dismiss[0].message, /is a new head/);
  assert.equal(out.calls.createReview[0].commit_id, HEAD);
});

// A repo without dismiss_stale_reviews_on_push still reads APPROVED after a push.
test('a push that fails provenance is not hidden by reviewDecision=APPROVED', async () => {
  const out = await run({
    repo: makeRepo({
      reviewDecision: 'APPROVED',
      reviews: { 11: [], 12: [approval(12)], 171: [STAMPED] },
    }),
  });
  assert.equal(out.decision, 'skip');
  assert.match(out.reason, /came from #11/);
  assert.equal(out.calls.dismiss.length, 1);
});

test('a push with a failing check still withdraws the older approval', async () => {
  const out = await run({
    repo: makeRepo({
      checkRuns: [{ ...CHECK_OK, conclusion: 'failure', details_url: 'u' }],
      reviews: { 171: [STAMPED] },
    }),
  });
  assert.match(out.reason, /failing check: ci/);
  assert.equal(out.calls.dismiss.length, 1);
});

test('an approval of the current head is left alone and not proven again', async () => {
  const out = await run({ repo: makeRepo({ reviews: { 171: [{ ...STAMPED, commit_id: HEAD }] } }) });
  assert.equal(out.decision, 'skip');
  assert.match(out.reason, /bot already approved head/);
  assert.equal(out.calls.dismiss.length, 0);
  assert.equal(out.calls.listCommits, 0);
});

test('a retitle that fails the title gate withdraws the earlier approval', async () => {
  const pr = promotionPr({ title: 'feat: promote' });
  const out = await run({
    pr,
    repo: makeRepo({ current: pr, reviews: { 171: [{ ...STAMPED, commit_id: HEAD }] } }),
  });
  assert.equal(out.decision, 'skip');
  assert.equal(out.calls.dismiss.length, 1);
});

test('a failed withdrawal of an older approval is an error, not a skip', async () => {
  const repo = makeRepo({ reviews: { 171: [STAMPED] } });
  repo.github.rest.pulls.dismissReview = async () => {
    throw Object.assign(new Error('nope'), { status: 500 });
  };
  const out = await run({ repo });
  assert.equal(out.decision, 'error');
  assert.match(out.reason, /could not withdraw the stale approval/);
});

test('a stale head leaves the approval alone: the event may simply be old', async () => {
  const out = await run({ repo: makeRepo({ tip: 'cafe0009', reviews: { 171: [STAMPED] } }) });
  assert.equal(out.decision, 'skip');
  assert.equal(out.calls.dismiss.length, 0);
});

// The approval here names HEAD but stopped being idempotent: a later COMMENT from
// the bot supersedes it, so the run reaches provenance with the approval standing.
const SUPERSEDED = [
  { ...STAMPED, commit_id: HEAD },
  {
    id: 6, state: 'COMMENTED', commit_id: HEAD, user: { login: 'approver-bot' }, submitted_at: '2026-10-01T09:30:00Z',
  },
];

test('a provenance read that fails withdraws, then reports the failure', async () => {
  const repo = makeRepo({ reviews: { 171: SUPERSEDED } });
  repo.github.rest.pulls.listCommits = async () => {
    throw Object.assign(new Error('boom'), { status: 502 });
  };
  const out = await run({ repo });
  assert.equal(out.decision, 'skip');
  assert.match(out.reason, /^evaluation failed: 502 boom/);
  assert.equal(repo.calls.dismiss.length, 1);
  assert.match(repo.calls.dismiss[0].message, /could not be proven \(502 boom\)/);
});

test('a branch tip read that fails withdraws, then reports the failure', async () => {
  const repo = makeRepo({ reviews: { 171: [STAMPED] } });
  repo.github.rest.git.getRef = async () => {
    throw Object.assign(new Error('boom'), { status: 403 });
  };
  const out = await run({ repo });
  assert.equal(out.decision, 'skip');
  assert.match(out.reason, /^evaluation failed: 403 boom/);
  assert.match(repo.calls.dismiss[0].message, /the tip of develop could not be read \(403 boom\)/);
});

test('a branch tip read that fails and an approval that cannot be withdrawn is an error', async () => {
  const repo = makeRepo({ reviews: { 171: [STAMPED] } });
  repo.github.rest.git.getRef = async () => {
    throw Object.assign(new Error('boom'), { status: 403 });
  };
  repo.github.rest.pulls.dismissReview = async () => {
    throw Object.assign(new Error('nope'), { status: 500 });
  };
  const out = await run({ repo });
  assert.equal(out.decision, 'error');
});

test('a Copilot CHANGES_REQUESTED still blocks a promotion', async () => {
  const copilot = {
    id: 8,
    state: 'CHANGES_REQUESTED',
    commit_id: HEAD,
    user: { login: 'copilot-pull-request-reviewer[bot]' },
    submitted_at: '2026-10-01T09:30:00Z',
  };
  const out = await run({ repo: makeRepo({ reviews: { 11: [approval(11)], 12: [approval(12)], 171: [copilot] } }) });
  assert.equal(out.decision, 'skip');
  assert.equal(out.reason, 'latest Copilot review requested changes');
});

test('a provenance read that fails and an approval that cannot be withdrawn is an error', async () => {
  const repo = makeRepo({ reviews: { 171: SUPERSEDED } });
  repo.github.rest.pulls.listCommits = async () => {
    throw Object.assign(new Error('boom'), { status: 502 });
  };
  repo.github.rest.pulls.dismissReview = async () => {
    throw Object.assign(new Error('nope'), { status: 500 });
  };
  const out = await run({ repo });
  assert.equal(out.decision, 'error');
  assert.match(out.reason, /could not withdraw the stale approval/);
});

test('provenance failing on the same head withdraws a standing approval', async () => {
  const out = await run({ repo: makeRepo({ reviews: { 11: [], 12: [approval(12)], 171: SUPERSEDED } }) });
  assert.equal(out.decision, 'skip');
  assert.match(out.reason, /came from #11/);
  assert.match(out.calls.dismiss[0].message, /^Withdrawn: .*#11/);
});

test('requestCopilotReview: never requests one for a promotion', async () => {
  const repo = makeRepo();
  const env = { AUTO_APPROVE_PROMOTION_BRANCHES: 'develop:main', AUTO_APPROVE_ROUNDS_THRESHOLD: '3' };
  const out = await decide.requestCopilotReview({
    github: repo.github, context: makeContext(), core: makeCore(), env,
  });
  assert.equal(out, 'skipped');
  assert.equal(repo.calls.reviewers.length, 0);
});

test('requestCopilotReview: unset, a promotion gets its request as before', async () => {
  const repo = makeRepo();
  const out = await decide.requestCopilotReview({
    github: repo.github, context: makeContext(), core: makeCore(), env: { AUTO_APPROVE_ROUNDS_THRESHOLD: '3' },
  });
  assert.equal(out, 'requested');
  assert.equal(repo.calls.reviewers.length, 1);
});
