// SPDX-License-Identifier: Apache-2.0
// Unit tests for the pr-auto-approve decision logic.
// Run with: node --test scripts/pr-auto-approve/

const { test } = require('node:test');
const assert = require('node:assert/strict');
const decide = require('./decide.js');

// Configure module-level env so all tests share the same bot/sandbox/branch
// defaults — override per-test as needed.
process.env.AUTO_APPROVE_BOT_LOGIN = 'axeptio-bot';
process.env.AUTO_APPROVE_SANDBOX_REPOS = 'axeptio/test-only-repo,axeptio/tech-scripts';
process.env.AUTO_APPROVE_BASE_BRANCH = 'develop';
process.env.AUTO_APPROVE_ROUNDS_THRESHOLD = '3';

// -- Test helpers ---------------------------------------------------------

// Default check-runs fixture: one completed successful CI check so tests
// focused on review logic don't trip over the empty-checks guard.
const DEFAULT_CHECK_RUNS = [
  {
    name: 'ci',
    status: 'completed',
    conclusion: 'success',
    started_at: '2026-04-15T10:00:00Z',
    app: { id: 1 },
    details_url: 'https://github.com/x/y/actions/runs/777',
  },
];

function makeFakeGithub({
  checkRuns = DEFAULT_CHECK_RUNS,
  reviews = [],
  reviewComments = {},
  createReviewImpl,
  getPrImpl,
  reviewDecision = null,
  graphqlImpl,
} = {}) {
  const calls = { createReview: [], graphql: [] };

  const paginate = async (fn, params, mapper) => {
    const pages = await fn(params);
    if (mapper) return mapper(pages);
    return pages.data;
  };

  const github = {
    paginate,
    graphql: async (query, vars) => {
      calls.graphql.push({ query, vars });
      if (graphqlImpl) return graphqlImpl(query, vars);
      return { repository: { pullRequest: { reviewDecision } } };
    },
    rest: {
      checks: {
        listForRef: async () => ({ data: { total_count: checkRuns.length, check_runs: checkRuns } }),
      },
      pulls: {
        get: async ({ pull_number }) => {
          if (getPrImpl) return getPrImpl(pull_number);
          return {
            data: {
              number: pull_number,
              draft: false,
              user: { login: 'someone' },
              head: { sha: 'deadbeef', repo: { full_name: 'axeptio/test-only-repo' } },
              base: { ref: 'develop' },
              html_url: `https://github.com/axeptio/test-only-repo/pull/${pull_number}`,
            },
          };
        },
        // Reviews default to naming the head SHA — in production Copilot's latest
        // review normally IS of the current commit, so "fresh" is the right default
        // for the many fixtures that aren't about freshness. Tests that exercise the
        // staleness guard set commit_id explicitly (including `commit_id: undefined`
        // to represent a review that carries no commit at all).
        listReviews: async () => ({
          data: reviews.map((r) =>
            r && typeof r === 'object' && !('commit_id' in r)
              ? { ...r, commit_id: 'deadbeef' }
              : r,
          ),
        }),
        listCommentsForReview: async ({ review_id }) => ({
          data: reviewComments[review_id] || [],
        }),
        createReview: async (args) => {
          calls.createReview.push(args);
          if (createReviewImpl) return createReviewImpl(args);
          return { data: { id: 999, state: 'APPROVED' } };
        },
      },
    },
  };

  return { github, calls };
}

function makeCore() {
  const outputs = {};
  const summaryBuffer = [];
  return {
    outputs,
    summaryBuffer,
    setOutput: (k, v) => {
      outputs[k] = v;
    },
    info: () => {},
    error: () => {},
    warning: () => {},
    summary: {
      addRaw(s) {
        summaryBuffer.push(s);
        return this;
      },
      async write() {
        /* no-op for tests */
      },
    },
  };
}

function makeContext({
  prOverrides = {},
  runId = 111,
  owner = 'axeptio',
  // Default to the sandbox repo so test-login-override tests work without
  // per-test plumbing. Production-path tests that care about the sandbox
  // gate (e.g. "override ignored outside sandbox") pass an explicit repo.
  repo = 'test-only-repo',
} = {}) {
  const pr = {
    number: 42,
    draft: false,
    html_url: 'https://github.com/axeptio/test-repo/pull/42',
    user: { login: 'someone' },
    head: { sha: 'deadbeef', repo: { full_name: `${owner}/${repo}` } },
    base: { ref: 'develop' },
    ...prOverrides,
  };
  return {
    runId,
    repo: { owner, repo },
    payload: { pull_request: pr },
  };
}

// -- Tests ---------------------------------------------------------------

test('skip: no pull_request payload', async () => {
  const core = makeCore();
  const ctx = { runId: 1, repo: { owner: 'o', repo: 'r' }, payload: {} };
  const { github } = makeFakeGithub();
  const result = await decide({ github, context: ctx, core });
  assert.equal(result.decision, 'skip');
  assert.match(result.reason, /no pull_request/);
});

test('skip: PR author is the bot (in production repo)', async () => {
  const core = makeCore();
  const ctx = makeContext({
    owner: 'axeptio',
    repo: 'script-runner', // NOT a sandbox repo
    prOverrides: { user: { login: 'axeptio-bot' } },
  });
  const { github } = makeFakeGithub();
  const result = await decide({ github, context: ctx, core });
  assert.equal(result.decision, 'skip');
  assert.match(result.reason, /author is the bot/);
});

test('sandbox repo: bot-authored PR is NOT skipped (e2e harness path)', async () => {
  // Default makeContext repo is 'test-only-repo' — a sandbox.
  const core = makeCore();
  const cp = { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' };
  const ctx = makeContext({
    prOverrides: { user: { login: 'axeptio-bot' } },
  });
  const { github, calls } = makeFakeGithub({
    reviews: [
      { id: 1, state: 'COMMENTED', submitted_at: '2026-04-16T10:00:00Z', user: cp },
    ],
    reviewComments: { 1: [] },
  });
  const result = await decide({ github, context: ctx, core });
  assert.equal(result.decision, 'approved', `got skip: ${result.reason}`);
  assert.equal(calls.createReview.length, 1);
});

test('skip: no check runs on head SHA (CI not started yet)', async () => {
  const core = makeCore();
  const { github, calls } = makeFakeGithub({ checkRuns: [] });
  const result = await decide({ github, context: makeContext(), core });
  assert.equal(result.decision, 'skip');
  assert.match(result.reason, /no checks on head SHA/);
  assert.equal(calls.createReview.length, 0);
});

test('skip: no checks and allow-no-checks not set (default strict)', async () => {
  const core = makeCore();
  const { github } = makeFakeGithub({ checkRuns: [] });
  const result = await decide({ github, context: makeContext(), core });
  assert.equal(result.decision, 'skip');
  assert.match(result.reason, /no checks on head SHA/);
});

test('approve: no checks but allow-no-checks=true and copilot-clean', async () => {
  const core = makeCore();
  const cp = { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' };
  const original = process.env.AUTO_APPROVE_ALLOW_NO_CHECKS;
  process.env.AUTO_APPROVE_ALLOW_NO_CHECKS = 'true';
  try {
    const { github, calls } = makeFakeGithub({
      checkRuns: [],
      reviews: [
        {
          id: 7,
          state: 'COMMENTED',
          submitted_at: '2026-04-15T10:00:00Z',
          user: cp,
        },
      ],
      reviewComments: { 7: [] },
    });
    const result = await decide({ github, context: makeContext(), core });
    assert.equal(result.decision, 'approved', `got skip: ${result.reason}`);
    assert.match(result.reason, /copilot-clean/);
    assert.equal(calls.createReview.length, 1);
  } finally {
    if (original == null) {
      delete process.env.AUTO_APPROVE_ALLOW_NO_CHECKS;
    } else {
      process.env.AUTO_APPROVE_ALLOW_NO_CHECKS = original;
    }
  }
});

test('skip: failing check run', async () => {
  const core = makeCore();
  const { github } = makeFakeGithub({
    checkRuns: [
      {
        name: 'build',
        status: 'completed',
        conclusion: 'failure',
        started_at: '2026-04-15T10:00:00Z',
        app: { id: 1 },
        details_url: 'https://x/runs/999',
      },
    ],
  });
  const result = await decide({ github, context: makeContext(), core: core });
  assert.equal(result.decision, 'skip');
  assert.match(result.reason, /failing check: build/);
});

test('self-pending filter: current workflow run is ignored', async () => {
  const core = makeCore();
  const ctx = makeContext({ runId: 12345 });
  const { github } = makeFakeGithub({
    checkRuns: [
      {
        // current workflow's own check — should be filtered out by runId match
        name: 'Auto-approve if Copilot conditions met',
        status: 'in_progress',
        conclusion: null,
        started_at: '2026-04-15T10:00:00Z',
        app: { id: 15368 },
        details_url: 'https://github.com/x/y/actions/runs/12345/job/99',
      },
      {
        // a regular CI check that passed — so we don't trip the empty guard
        name: 'ci',
        status: 'completed',
        conclusion: 'success',
        started_at: '2026-04-15T10:05:00Z',
        app: { id: 1 },
        details_url: 'https://github.com/x/y/actions/runs/777',
      },
    ],
    reviews: [
      {
        id: 1,
        state: 'COMMENTED',
        submitted_at: '2026-04-15T09:00:00Z',
        user: { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' },
      },
    ],
    reviewComments: { 1: [] },
  });
  const result = await decide({ github, context: ctx, core });
  assert.equal(result.decision, 'approved', `got skip: ${result.reason}`);
});

test('self-filter is bounded: /runs/111 must not match /runs/1111', async () => {
  const core = makeCore();
  // runId is 111; another workflow's check has details_url /runs/1111.
  // If the filter were a loose .includes(), the non-self check would be
  // dropped and the empty-checks guard would skip approval.
  const ctx = makeContext({ runId: 111 });
  const { github, calls } = makeFakeGithub({
    checkRuns: [
      {
        name: 'unrelated-ci',
        status: 'completed',
        conclusion: 'success',
        started_at: '2026-04-15T10:00:00Z',
        app: { id: 1 },
        details_url: 'https://github.com/x/y/actions/runs/1111', // different run!
      },
    ],
    reviews: [
      {
        id: 1,
        state: 'COMMENTED',
        submitted_at: '2026-04-15T09:00:00Z',
        user: { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' },
      },
    ],
    reviewComments: { 1: [] },
  });
  const result = await decide({ github, context: ctx, core });
  assert.equal(result.decision, 'approved', `got skip: ${result.reason}`);
  assert.equal(calls.createReview.length, 1);
});

test('rerun dedupe: old failure replaced by newer success', async () => {
  const core = makeCore();
  const { github } = makeFakeGithub({
    checkRuns: [
      {
        name: 'lint',
        status: 'completed',
        conclusion: 'failure',
        started_at: '2026-04-15T09:00:00Z',
        app: { id: 7 },
        details_url: 'https://x/runs/1',
      },
      {
        name: 'lint',
        status: 'completed',
        conclusion: 'success',
        started_at: '2026-04-15T10:00:00Z',
        app: { id: 7 },
        details_url: 'https://x/runs/2',
      },
    ],
    reviews: [
      {
        id: 1,
        state: 'COMMENTED',
        submitted_at: '2026-04-15T10:30:00Z',
        user: { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' },
      },
    ],
    reviewComments: { 1: [] },
  });
  const result = await decide({ github, context: makeContext(), core });
  assert.equal(result.decision, 'approved');
});

test('cancelled check conclusion is non-blocking', async () => {
  const core = makeCore();
  const cp = { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' };
  const { github } = makeFakeGithub({
    checkRuns: [
      {
        name: 'ci',
        status: 'completed',
        conclusion: 'cancelled',
        started_at: '2026-04-15T10:00:00Z',
        app: { id: 1 },
        details_url: 'https://x/runs/999',
      },
    ],
    reviews: [
      { id: 1, state: 'COMMENTED', submitted_at: '2026-04-15T10:30:00Z', user: cp },
    ],
    reviewComments: { 1: [] },
  });
  const result = await decide({ github, context: makeContext(), core });
  assert.equal(result.decision, 'approved', `got skip: ${result.reason}`);
});

test('stale check conclusion is non-blocking', async () => {
  const core = makeCore();
  const cp = { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' };
  const { github } = makeFakeGithub({
    checkRuns: [
      {
        name: 'ci',
        status: 'completed',
        conclusion: 'stale',
        started_at: '2026-04-15T10:00:00Z',
        app: { id: 1 },
        details_url: 'https://x/runs/999',
      },
    ],
    reviews: [
      { id: 1, state: 'COMMENTED', submitted_at: '2026-04-15T10:30:00Z', user: cp },
    ],
    reviewComments: { 1: [] },
  });
  const result = await decide({ github, context: makeContext(), core });
  assert.equal(result.decision, 'approved', `got skip: ${result.reason}`);
});

test('failure/timed_out conclusions still block approval', async () => {
  for (const conclusion of ['failure', 'timed_out', 'action_required']) {
    const core = makeCore();
    const { github } = makeFakeGithub({
      checkRuns: [
        {
          name: 'ci',
          status: 'completed',
          conclusion,
          started_at: '2026-04-15T10:00:00Z',
          app: { id: 1 },
          details_url: 'https://x/runs/999',
        },
      ],
    });
    const result = await decide({ github, context: makeContext(), core });
    assert.equal(result.decision, 'skip', `expected skip for ${conclusion}`);
    assert.match(result.reason, /failing check/, `expected failing-check reason for ${conclusion}`);
  }
});

test('skip: pending non-self check', async () => {
  const core = makeCore();
  const { github } = makeFakeGithub({
    checkRuns: [
      {
        name: 'integration-tests',
        status: 'in_progress',
        conclusion: null,
        started_at: '2026-04-15T10:00:00Z',
        app: { id: 42 },
        details_url: 'https://x/runs/888',
      },
    ],
  });
  const result = await decide({ github, context: makeContext(), core });
  assert.equal(result.decision, 'skip');
  assert.match(result.reason, /integration-tests/);
});

test('idempotent: skip when latest bot review is APPROVED', async () => {
  const core = makeCore();
  const { github, calls } = makeFakeGithub({
    reviews: [
      {
        id: 10,
        state: 'APPROVED',
        submitted_at: '2026-04-15T10:00:00Z',
        commit_id: 'deadbeef', // approved the current head → idempotent skip
        user: { login: 'axeptio-bot' },
      },
    ],
  });
  const result = await decide({ github, context: makeContext(), core });
  assert.equal(result.decision, 'skip');
  assert.match(result.reason, /already approved/);
  assert.equal(calls.createReview.length, 0);
});

test('idempotency: stale APPROVED for an old commit does NOT block re-approval of the new head', async () => {
  // The bot approved a PRIOR commit; a new push has since moved the head to
  // 'deadbeef'. The stale approval must NOT short-circuit — under branch
  // protection the bot has to re-approve the new head SHA.
  const core = makeCore();
  const cp = { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' };
  const { github, calls } = makeFakeGithub({
    reviews: [
      {
        id: 10,
        state: 'APPROVED',
        submitted_at: '2026-04-15T09:00:00Z',
        commit_id: 'oldsha0000', // approved an earlier commit, not the current head
        user: { login: 'axeptio-bot' },
      },
      {
        id: 11,
        state: 'COMMENTED',
        submitted_at: '2026-04-15T10:00:00Z',
        user: cp,
      },
    ],
    reviewComments: { 11: [] },
  });
  const result = await decide({ github, context: makeContext(), core });
  assert.equal(result.decision, 'approved', `got skip: ${result.reason}`);
  assert.equal(calls.createReview.length, 1);
});

test('idempotency: bot approval superseded by a later COMMENT review is NOT idempotent', async () => {
  // Historical approval exists but the latest bot review is a plain COMMENT,
  // so we should NOT short-circuit — we can approve again.
  const core = makeCore();
  const cp = { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' };
  const { github, calls } = makeFakeGithub({
    reviews: [
      {
        id: 10,
        state: 'APPROVED',
        submitted_at: '2026-04-15T09:00:00Z',
        user: { login: 'axeptio-bot' },
      },
      {
        id: 11,
        state: 'COMMENTED',
        submitted_at: '2026-04-15T09:30:00Z',
        user: { login: 'axeptio-bot' },
      },
      {
        id: 12,
        state: 'COMMENTED',
        submitted_at: '2026-04-15T10:00:00Z',
        user: cp,
      },
    ],
    reviewComments: { 12: [] },
  });
  const result = await decide({ github, context: makeContext(), core });
  assert.equal(result.decision, 'approved');
  assert.equal(calls.createReview.length, 1);
});

test('idempotency: DISMISSED bot approvals do not block a fresh approval', async () => {
  const core = makeCore();
  const cp = { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' };
  const { github, calls } = makeFakeGithub({
    reviews: [
      {
        id: 10,
        state: 'DISMISSED',
        submitted_at: '2026-04-15T09:00:00Z',
        user: { login: 'axeptio-bot' },
      },
      {
        id: 11,
        state: 'COMMENTED',
        submitted_at: '2026-04-15T10:00:00Z',
        user: cp,
      },
    ],
    reviewComments: { 11: [] },
  });
  const result = await decide({ github, context: makeContext(), core });
  assert.equal(result.decision, 'approved');
  assert.equal(calls.createReview.length, 1);
});

test('gate: reviewDecision=APPROVED skips before the REST review checks', async () => {
  const core = makeCore();
  const cp = { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' };
  // A clean Copilot review would normally approve — the GraphQL gate must
  // short-circuit first because the PR is already APPROVED overall.
  const { github, calls } = makeFakeGithub({
    reviewDecision: 'APPROVED',
    reviews: [
      { id: 7, state: 'COMMENTED', submitted_at: '2026-04-15T10:00:00Z', user: cp },
    ],
    reviewComments: { 7: [] },
  });
  const result = await decide({ github, context: makeContext(), core });
  assert.equal(result.decision, 'skip');
  assert.match(result.reason, /reviewDecision=APPROVED/);
  assert.equal(calls.graphql.length, 1);
  assert.equal(calls.createReview.length, 0);
});

test('gate: reviewDecision=REVIEW_REQUIRED does not gate; still approves when clean', async () => {
  const core = makeCore();
  const cp = { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' };
  const { github, calls } = makeFakeGithub({
    reviewDecision: 'REVIEW_REQUIRED',
    reviews: [
      { id: 7, state: 'COMMENTED', submitted_at: '2026-04-15T10:00:00Z', user: cp },
    ],
    reviewComments: { 7: [] },
  });
  const result = await decide({ github, context: makeContext(), core });
  assert.equal(result.decision, 'approved', `got skip: ${result.reason}`);
  assert.equal(calls.graphql.length, 1);
  assert.equal(calls.createReview.length, 1);
});

test('gate: partial GraphQL response is handled by optional chaining (no gate, no crash)', async () => {
  const core = makeCore();
  const cp = { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' };
  const { github, calls } = makeFakeGithub({
    graphqlImpl: () => ({}), // no repository field → reviewDecision resolves to undefined
    reviews: [
      { id: 7, state: 'COMMENTED', submitted_at: '2026-04-15T10:00:00Z', user: cp },
    ],
    reviewComments: { 7: [] },
  });
  const result = await decide({ github, context: makeContext(), core });
  assert.equal(result.decision, 'approved', `got skip: ${result.reason}`);
  assert.equal(calls.graphql.length, 1);
});

test('gate: GraphQL error falls through to REST checks (best-effort)', async () => {
  const core = makeCore();
  const cp = { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' };
  const err = new Error('GraphQL: something went wrong');
  err.status = 502;
  const { github, calls } = makeFakeGithub({
    graphqlImpl: () => {
      throw err;
    },
    reviews: [
      { id: 7, state: 'COMMENTED', submitted_at: '2026-04-15T10:00:00Z', user: cp },
    ],
    reviewComments: { 7: [] },
  });
  const result = await decide({ github, context: makeContext(), core });
  assert.equal(result.decision, 'approved', `got skip: ${result.reason}`);
  assert.equal(calls.graphql.length, 1);
});

test('skip: no Copilot review yet', async () => {
  const core = makeCore();
  const { github } = makeFakeGithub({ reviews: [] });
  const result = await decide({ github, context: makeContext(), core });
  assert.equal(result.decision, 'skip');
  assert.match(result.reason, /no Copilot review/);
});

test('approve: copilot-clean (0 comments, COMMENTED state)', async () => {
  const core = makeCore();
  const { github, calls } = makeFakeGithub({
    reviews: [
      {
        id: 7,
        state: 'COMMENTED',
        submitted_at: '2026-04-15T10:00:00Z',
        user: { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' },
      },
    ],
    reviewComments: { 7: [] },
  });
  const result = await decide({ github, context: makeContext(), core });
  assert.equal(result.decision, 'approved');
  assert.match(result.reason, /copilot-clean/);
  assert.equal(calls.createReview.length, 1);
  assert.equal(calls.createReview[0].event, 'APPROVE');
});

test('approve: copilot-clean with github-copilot[bot] identity', async () => {
  const core = makeCore();
  const { github, calls } = makeFakeGithub({
    reviews: [
      {
        id: 8,
        state: 'COMMENTED',
        submitted_at: '2026-04-15T10:00:00Z',
        user: { login: 'github-copilot[bot]', type: 'Bot' },
      },
    ],
    reviewComments: { 8: [] },
  });
  const result = await decide({ github, context: makeContext(), core });
  assert.equal(result.decision, 'approved', `got skip: ${result.reason}`);
  assert.match(result.reason, /copilot-clean/);
  assert.equal(calls.createReview.length, 1);
});

test('skip: latest Copilot review has comments', async () => {
  const core = makeCore();
  const { github, calls } = makeFakeGithub({
    reviews: [
      {
        id: 7,
        state: 'COMMENTED',
        submitted_at: '2026-04-15T10:00:00Z',
        user: { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' },
      },
    ],
    reviewComments: { 7: [{ id: 1, body: 'nit' }, { id: 2, body: 'nit2' }] },
  });
  const result = await decide({ github, context: makeContext(), core });
  assert.equal(result.decision, 'skip');
  assert.match(result.reason, /2 comments/);
  assert.equal(calls.createReview.length, 0);
});

// Real production body shape, copied from axeptio/caas-styleguide#3502 review
// 4774139942: Copilot claims "no new comments" in the summary line while the
// actual finding sits in a collapsed block. listCommentsForReview returns 0 for
// these, so `reviewComments` is deliberately empty in the tests below.
function suppressedBody(count, summaryLine = 'generated no new comments') {
  return [
    '## Pull request overview',
    '',
    `Copilot reviewed 3 out of 3 changed files in this pull request and ${summaryLine}.`,
    '',
    '<details>',
    `<summary>Comments suppressed due to low confidence (${count})</summary>`,
    '',
    '**lib/thing.js:302**',
    '* this would throw a 500 on repeated query params',
    '</details>',
  ].join('\n');
}

test('skip: latest Copilot review suppressed low-confidence comments', async () => {
  const core = makeCore();
  const { github, calls } = makeFakeGithub({
    reviews: [
      {
        id: 7,
        state: 'COMMENTED',
        submitted_at: '2026-04-15T10:00:00Z',
        user: { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' },
        body: suppressedBody(1),
      },
    ],
    reviewComments: { 7: [] },
  });
  const result = await decide({ github, context: makeContext(), core });
  assert.equal(result.decision, 'skip');
  assert.match(result.reason, /1 suppressed low-confidence comment/);
  assert.equal(calls.createReview.length, 0);
});

test('skip: suppressed count is reported (plural)', async () => {
  const core = makeCore();
  const { github, calls } = makeFakeGithub({
    reviews: [
      {
        id: 7,
        state: 'COMMENTED',
        submitted_at: '2026-04-15T10:00:00Z',
        user: { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' },
        body: suppressedBody(2),
      },
    ],
    reviewComments: { 7: [] },
  });
  const result = await decide({ github, context: makeContext(), core });
  assert.equal(result.decision, 'skip');
  assert.match(result.reason, /2 suppressed low-confidence comment/);
  assert.equal(calls.createReview.length, 0);
});

test('approve: absent review body does not block a clean approval', async () => {
  const core = makeCore();
  const { github, calls } = makeFakeGithub({
    reviews: [
      {
        id: 7,
        state: 'COMMENTED',
        submitted_at: '2026-04-15T10:00:00Z',
        user: { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' },
        body: null,
      },
    ],
    reviewComments: { 7: [] },
  });
  const result = await decide({ github, context: makeContext(), core });
  assert.equal(result.decision, 'approved', `got skip: ${result.reason}`);
  assert.match(result.reason, /copilot-clean/);
  assert.equal(calls.createReview.length, 1);
});

test('approve: clean body without a suppressed block is still copilot-clean', async () => {
  const core = makeCore();
  const { github, calls } = makeFakeGithub({
    reviews: [
      {
        id: 7,
        state: 'COMMENTED',
        submitted_at: '2026-04-15T10:00:00Z',
        user: { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' },
        body:
          '## Pull request overview\n\nCopilot reviewed 3 out of 3 changed files in '
          + 'this pull request and generated no new comments.',
      },
    ],
    reviewComments: { 7: [] },
  });
  const result = await decide({ github, context: makeContext(), core });
  assert.equal(result.decision, 'approved', `got skip: ${result.reason}`);
  assert.match(result.reason, /copilot-clean/);
  assert.equal(calls.createReview.length, 1);
});

test('skip: latest Copilot review is for an older commit', async () => {
  const core = makeCore();
  const { github, calls } = makeFakeGithub({
    reviews: [
      {
        id: 7,
        state: 'COMMENTED',
        submitted_at: '2026-04-15T10:00:00Z',
        commit_id: 'cafebabe', // makeContext() head.sha is 'deadbeef'
        user: { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' },
      },
    ],
    reviewComments: { 7: [] },
  });
  const result = await decide({ github, context: makeContext(), core });
  assert.equal(result.decision, 'skip');
  assert.match(result.reason, /older commit \(cafebabe\)/);
  assert.equal(calls.createReview.length, 0);
});

test('skip: latest Copilot review has no commit_id (cannot prove freshness)', async () => {
  const core = makeCore();
  const { github, calls } = makeFakeGithub({
    reviews: [
      {
        id: 7,
        state: 'COMMENTED',
        submitted_at: '2026-04-15T10:00:00Z',
        commit_id: undefined, // present-but-empty: opts out of the helper's fresh default
        user: { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' },
      },
    ],
    reviewComments: { 7: [] },
  });
  const result = await decide({ github, context: makeContext(), core });
  assert.equal(result.decision, 'skip');
  // Distinct from the stale-SHA wording: no SHA is reported, because there is none.
  assert.match(result.reason, /has no commit_id/);
  assert.doesNotMatch(result.reason, /older commit/);
  assert.equal(calls.createReview.length, 0);
});

test('approve: Copilot review matching the head SHA is fresh', async () => {
  const core = makeCore();
  const { github, calls } = makeFakeGithub({
    reviews: [
      {
        id: 7,
        state: 'COMMENTED',
        submitted_at: '2026-04-15T10:00:00Z',
        commit_id: 'deadbeef',
        user: { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' },
      },
    ],
    reviewComments: { 7: [] },
  });
  const result = await decide({ github, context: makeContext(), core });
  assert.equal(result.decision, 'approved', `got skip: ${result.reason}`);
  assert.match(result.reason, /copilot-clean/);
  assert.equal(calls.createReview.length, 1);
});

// Mirrors the CHANGES_REQUESTED and suppressed-comments scoping: the rounds
// threshold is the one path that must never be able to deadlock a PR.
test('3-rounds rule still approves on a stale Copilot review', async () => {
  const core = makeCore();
  const cp = { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' };
  const { github, calls } = makeFakeGithub({
    reviews: [
      { id: 1, state: 'COMMENTED', submitted_at: '2026-04-15T08:00:00Z', commit_id: 'cafebabe', user: cp },
      { id: 2, state: 'COMMENTED', submitted_at: '2026-04-15T09:00:00Z', commit_id: 'cafebabe', user: cp },
      { id: 3, state: 'COMMENTED', submitted_at: '2026-04-15T10:00:00Z', commit_id: 'cafebabe', user: cp },
    ],
  });
  const result = await decide({ github, context: makeContext(), core });
  assert.equal(result.decision, 'approved', `got skip: ${result.reason}`);
  assert.match(result.reason, /3-rounds \(3 Copilot reviews\)/);
  assert.equal(calls.createReview.length, 1);
});

test('skip: latest Copilot review requested changes', async () => {
  const core = makeCore();
  const { github } = makeFakeGithub({
    reviews: [
      {
        id: 7,
        state: 'CHANGES_REQUESTED',
        submitted_at: '2026-04-15T10:00:00Z',
        user: { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' },
      },
    ],
  });
  const result = await decide({ github, context: makeContext(), core });
  assert.equal(result.decision, 'skip');
  assert.match(result.reason, /requested changes/);
});

test('approve: 3 rounds of Copilot reviews (even with comments)', async () => {
  const core = makeCore();
  const cp = { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' };
  const { github, calls } = makeFakeGithub({
    reviews: [
      { id: 1, state: 'COMMENTED', submitted_at: '2026-04-15T08:00:00Z', user: cp },
      { id: 2, state: 'COMMENTED', submitted_at: '2026-04-15T09:00:00Z', user: cp },
      { id: 3, state: 'COMMENTED', submitted_at: '2026-04-15T10:00:00Z', user: cp },
    ],
    // No listCommentsForReview needed — 3-rounds bypasses the latest-clean check
  });
  const result = await decide({ github, context: makeContext(), core });
  assert.equal(result.decision, 'approved');
  assert.match(result.reason, /3-rounds \(3 Copilot reviews\)/);
  assert.equal(calls.createReview.length, 1);
});

test('approve: custom rounds_threshold of 2 approves after 2 reviews', async () => {
  const core = makeCore();
  const cp = { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' };
  const original = process.env.AUTO_APPROVE_ROUNDS_THRESHOLD;
  process.env.AUTO_APPROVE_ROUNDS_THRESHOLD = '2';
  try {
    const { github, calls } = makeFakeGithub({
      reviews: [
        { id: 1, state: 'COMMENTED', submitted_at: '2026-04-15T08:00:00Z', user: cp },
        { id: 2, state: 'COMMENTED', submitted_at: '2026-04-15T09:00:00Z', user: cp },
      ],
    });
    const result = await decide({ github, context: makeContext(), core });
    assert.equal(result.decision, 'approved');
    assert.match(result.reason, /2-rounds \(2 Copilot reviews\)/);
    assert.equal(calls.createReview.length, 1);
  } finally {
    process.env.AUTO_APPROVE_ROUNDS_THRESHOLD = original;
  }
});

test('skip: 2 reviews with threshold=3 does not trigger 3-rounds rule', async () => {
  const core = makeCore();
  const cp = { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' };
  const { github, calls } = makeFakeGithub({
    reviews: [
      { id: 1, state: 'COMMENTED', submitted_at: '2026-04-15T08:00:00Z', user: cp },
      { id: 2, state: 'COMMENTED', submitted_at: '2026-04-15T09:00:00Z', user: cp },
    ],
    reviewComments: { 2: [{ id: 1, body: 'nit' }] },
  });
  const result = await decide({ github, context: makeContext(), core });
  assert.equal(result.decision, 'skip');
  assert.match(result.reason, /1 comments/);
  assert.equal(calls.createReview.length, 0);
});

test('DISMISSED copilot reviews do not count toward rounds', async () => {
  const core = makeCore();
  const cp = { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' };
  const { github } = makeFakeGithub({
    reviews: [
      { id: 1, state: 'DISMISSED', submitted_at: '2026-04-15T08:00:00Z', user: cp },
      { id: 2, state: 'DISMISSED', submitted_at: '2026-04-15T09:00:00Z', user: cp },
      {
        id: 3,
        state: 'COMMENTED',
        submitted_at: '2026-04-15T10:00:00Z',
        user: cp,
      },
    ],
    reviewComments: { 3: [{ id: 1, body: 'nit' }] }, // latest has a comment → skip
  });
  const result = await decide({ github, context: makeContext(), core });
  assert.equal(result.decision, 'skip');
  assert.match(result.reason, /1 comments/);
});

test('createReview failure becomes a clean skip', async () => {
  const core = makeCore();
  const cp = { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' };
  const err = new Error('Resource not accessible by integration');
  err.status = 403;
  const { github, calls } = makeFakeGithub({
    reviews: [
      { id: 7, state: 'COMMENTED', submitted_at: '2026-04-15T10:00:00Z', user: cp },
    ],
    reviewComments: { 7: [] },
    createReviewImpl: () => {
      throw err;
    },
  });
  const result = await decide({ github, context: makeContext(), core });
  assert.equal(result.decision, 'skip');
  assert.match(result.reason, /approval API call failed: 403/);
  assert.equal(calls.createReview.length, 1);
});

test('PENDING copilot reviews are excluded from the count', async () => {
  const core = makeCore();
  const cp = { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' };
  const { github, calls } = makeFakeGithub({
    reviews: [
      // PENDING = draft review, has no submitted_at — must not count
      { id: 1, state: 'PENDING', submitted_at: null, user: cp },
      { id: 2, state: 'PENDING', submitted_at: null, user: cp },
      { id: 3, state: 'PENDING', submitted_at: null, user: cp },
    ],
  });
  const result = await decide({ github, context: makeContext(), core });
  assert.equal(result.decision, 'skip');
  assert.match(result.reason, /no Copilot review yet/);
  assert.equal(calls.createReview.length, 0);
});

test('3-rounds rule does NOT approve when latest review is CHANGES_REQUESTED', async () => {
  const core = makeCore();
  const cp = { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' };
  const { github, calls } = makeFakeGithub({
    reviews: [
      { id: 1, state: 'COMMENTED', submitted_at: '2026-04-15T08:00:00Z', user: cp },
      { id: 2, state: 'COMMENTED', submitted_at: '2026-04-15T09:00:00Z', user: cp },
      {
        id: 3,
        state: 'CHANGES_REQUESTED',
        submitted_at: '2026-04-15T10:00:00Z',
        user: cp,
      },
    ],
  });
  const result = await decide({ github, context: makeContext(), core });
  assert.equal(result.decision, 'skip');
  assert.match(result.reason, /requested changes/);
  assert.equal(calls.createReview.length, 0);
});

// The suppressed-comments gate lives on the copilot-clean path only. The
// rounds threshold stays an unconditional escape hatch — gating it too would
// leave a PR whose suppressed block never clears permanently unapprovable.
test('3-rounds rule still approves despite a suppressed-comments block', async () => {
  const core = makeCore();
  const cp = { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' };
  const { github, calls } = makeFakeGithub({
    reviews: [
      { id: 1, state: 'COMMENTED', submitted_at: '2026-04-15T08:00:00Z', user: cp },
      { id: 2, state: 'COMMENTED', submitted_at: '2026-04-15T09:00:00Z', user: cp },
      {
        id: 3,
        state: 'COMMENTED',
        submitted_at: '2026-04-15T10:00:00Z',
        user: cp,
        body: suppressedBody(1),
      },
    ],
  });
  const result = await decide({ github, context: makeContext(), core });
  assert.equal(result.decision, 'approved', `got skip: ${result.reason}`);
  assert.match(result.reason, /3-rounds \(3 Copilot reviews\)/);
  assert.equal(calls.createReview.length, 1);
});

test('top-level try/catch: checks.listForRef throws → clean skip', async () => {
  const core = makeCore();
  const err = new Error('Bad credentials');
  err.status = 401;
  const { github } = makeFakeGithub();
  github.rest.checks.listForRef = async () => {
    throw err;
  };
  const result = await decide({ github, context: makeContext(), core });
  assert.equal(result.decision, 'skip');
  assert.match(result.reason, /evaluation failed: 401 Bad credentials/);
});

test('top-level try/catch: pulls.listReviews throws → clean skip', async () => {
  const core = makeCore();
  const err = new Error('rate limit exceeded');
  err.status = 403;
  // Default (green) check runs so we reach listReviews, which then throws.
  const { github } = makeFakeGithub();
  github.rest.pulls.listReviews = async () => {
    throw err;
  };
  const result = await decide({ github, context: makeContext(), core });
  assert.equal(result.decision, 'skip');
  assert.match(result.reason, /evaluation failed: 403 rate limit/);
});

test('test-login override: AUTO_APPROVE_COPILOT_TEST_LOGINS treats listed users as Copilot', async () => {
  const core = makeCore();
  const original = process.env.AUTO_APPROVE_COPILOT_TEST_LOGINS;
  process.env.AUTO_APPROVE_COPILOT_TEST_LOGINS = 'axeptio-bot, some-other-test-user';
  try {
    const { github, calls } = makeFakeGithub({
      reviews: [
        {
          id: 77,
          state: 'COMMENTED',
          submitted_at: '2026-04-16T10:00:00Z',
          user: { login: 'axeptio-bot', type: 'User' },
        },
      ],
      reviewComments: { 77: [] },
    });
    const result = await decide({ github, context: makeContext(), core });
    assert.equal(result.decision, 'approved');
    assert.match(result.reason, /copilot-clean/);
    assert.equal(calls.createReview.length, 1);
  } finally {
    if (original === undefined) delete process.env.AUTO_APPROVE_COPILOT_TEST_LOGINS;
    else process.env.AUTO_APPROVE_COPILOT_TEST_LOGINS = original;
  }
});

test('test-login override: unset env means default behavior (axeptio-bot review ignored)', async () => {
  const core = makeCore();
  // Make sure the env is unset for this test
  const original = process.env.AUTO_APPROVE_COPILOT_TEST_LOGINS;
  delete process.env.AUTO_APPROVE_COPILOT_TEST_LOGINS;
  try {
    const { github, calls } = makeFakeGithub({
      reviews: [
        {
          id: 77,
          state: 'COMMENTED',
          submitted_at: '2026-04-16T10:00:00Z',
          user: { login: 'axeptio-bot', type: 'User' },
        },
      ],
    });
    const result = await decide({ github, context: makeContext(), core });
    assert.equal(result.decision, 'skip');
    assert.match(result.reason, /no Copilot review yet/);
    assert.equal(calls.createReview.length, 0);
  } finally {
    if (original !== undefined) process.env.AUTO_APPROVE_COPILOT_TEST_LOGINS = original;
  }
});

test('parseTestLogins: honors value only inside the sandbox allowlist', () => {
  const env = { AUTO_APPROVE_COPILOT_TEST_LOGINS: 'axeptio-bot, some-test-user' };
  // Inside sandbox → parsed.
  assert.deepEqual(
    [...decide.parseTestLogins(env, { owner: 'axeptio', repo: 'test-only-repo' })],
    ['axeptio-bot', 'some-test-user'],
  );
  // Outside sandbox → ignored, empty set.
  assert.equal(
    decide.parseTestLogins(env, { owner: 'axeptio', repo: 'script-runner' }).size,
    0,
  );
  assert.equal(
    decide.parseTestLogins(env, { owner: 'malicious', repo: 'pwn' }).size,
    0,
  );
  // Empty input → empty set regardless of caller.
  assert.equal(
    decide.parseTestLogins({}, { owner: 'axeptio', repo: 'test-only-repo' }).size,
    0,
  );
});

test('parseTestLogins: malformed logins are dropped with a warning', () => {
  const warnings = [];
  const warn = (msg) => warnings.push(msg);
  const env = {
    AUTO_APPROVE_COPILOT_TEST_LOGINS: 'valid-user, foo bar, , $$$bad, ok[bot]',
  };
  const result = decide.parseTestLogins(
    env,
    { owner: 'axeptio', repo: 'test-only-repo' },
    warn,
  );
  assert.deepEqual([...result], ['valid-user', 'ok[bot]']);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /foo bar/);
  assert.match(warnings[1], /\$\$\$bad/);
});

test('test-login override is IGNORED outside the sandbox allowlist', async () => {
  // Simulates a malicious/misconfigured consumer setting test_copilot_logins
  // in a production repo. decide.js must not honor it.
  const core = makeCore();
  const original = process.env.AUTO_APPROVE_COPILOT_TEST_LOGINS;
  process.env.AUTO_APPROVE_COPILOT_TEST_LOGINS = 'axeptio-bot';
  try {
    const { github, calls } = makeFakeGithub({
      reviews: [
        {
          id: 77,
          state: 'COMMENTED',
          submitted_at: '2026-04-16T10:00:00Z',
          user: { login: 'axeptio-bot', type: 'User' },
        },
      ],
      reviewComments: { 77: [] },
    });
    // Production-like repo (not on allowlist)
    const ctx = makeContext({ owner: 'axeptio', repo: 'script-runner' });
    const result = await decide({ github, context: ctx, core });
    assert.equal(result.decision, 'skip');
    assert.match(result.reason, /no Copilot review yet/);
    assert.equal(calls.createReview.length, 0);
  } finally {
    if (original === undefined) delete process.env.AUTO_APPROVE_COPILOT_TEST_LOGINS;
    else process.env.AUTO_APPROVE_COPILOT_TEST_LOGINS = original;
  }
});

test('isCopilot helper: strict allowlist (no substring fallback)', () => {
  assert.equal(
    decide.isCopilot({ login: 'copilot-pull-request-reviewer[bot]' }),
    true,
  );
  // No regex fallback: a third-party bot with "copilot" in its login is
  // NOT treated as Copilot (could be spoofed). Must be on the allowlist.
  assert.equal(
    decide.isCopilot({ login: 'some-copilot-clone[bot]', type: 'Bot' }),
    false,
  );
  assert.equal(decide.isCopilot({ login: 'alice', type: 'User' }), false);
  assert.equal(decide.isCopilot(null), false);
});

test('countSuppressedComments: parses the real Copilot markup', () => {
  // Exact strings observed in production (axeptio/caas-api#2280,
  // axeptio/caas-styleguide#3502/#3501/#3496/#3493).
  assert.equal(
    decide.countSuppressedComments(
      '<summary>Comments suppressed due to low confidence (1)</summary>',
    ),
    1,
  );
  assert.equal(
    decide.countSuppressedComments(
      '<summary>Comments suppressed due to low confidence (2)</summary>',
    ),
    2,
  );
  // Wording drift tolerance: singular noun, no parenthesised count, odd casing.
  assert.equal(decide.countSuppressedComments('Comment suppressed due to low confidence'), 1);
  assert.equal(decide.countSuppressedComments('COMMENTS SUPPRESSED DUE TO LOW CONFIDENCE (3)'), 3);
  // Clean bodies and missing bodies must read as zero.
  assert.equal(
    decide.countSuppressedComments(
      'Copilot reviewed 3 out of 3 changed files and generated no new comments.',
    ),
    0,
  );
  assert.equal(decide.countSuppressedComments(''), 0);
  assert.equal(decide.countSuppressedComments(null), 0);
  assert.equal(decide.countSuppressedComments(undefined), 0);
});

test('getBaseBranches: comma-separated value parses to a trimmed Set', () => {
  assert.deepEqual(
    [...decide.getBaseBranches({ AUTO_APPROVE_BASE_BRANCH: 'develop, staging ,main' })],
    ['develop', 'staging', 'main'],
  );
});

test('getBaseBranches: single value parses to a one-element Set', () => {
  assert.deepEqual(
    [...decide.getBaseBranches({ AUTO_APPROVE_BASE_BRANCH: 'main' })],
    ['main'],
  );
});

test('getBaseBranches: whitespace-only / empty / unset falls back to {main}', () => {
  assert.deepEqual([...decide.getBaseBranches({ AUTO_APPROVE_BASE_BRANCH: '   ' })], ['main']);
  assert.deepEqual([...decide.getBaseBranches({ AUTO_APPROVE_BASE_BRANCH: '' })], ['main']);
  assert.deepEqual([...decide.getBaseBranches({ AUTO_APPROVE_BASE_BRANCH: ' , , ' })], ['main']);
  assert.deepEqual([...decide.getBaseBranches({})], ['main']);
});

// -- check_run event tests ---------------------------------------------------

// Returns a context shaped like a check_run:completed event (no pull_request).
function makeCheckRunContext({ prNumber = 42, checkRunName = 'ci' } = {}) {
  return {
    runId: 111,
    repo: { owner: 'axeptio', repo: 'test-only-repo' },
    payload: {
      check_run: {
        name: checkRunName,
        pull_requests: prNumber != null ? [{ number: prNumber }] : [],
      },
    },
  };
}

test('check_run event: extracts PR and approves on 3-rounds', async () => {
  const core = makeCore();
  const cp = { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' };
  const threeReviews = [
    { id: 1, state: 'COMMENTED', submitted_at: '2026-04-20T07:35:00Z', user: cp },
    { id: 2, state: 'COMMENTED', submitted_at: '2026-04-20T07:49:00Z', user: cp },
    { id: 3, state: 'COMMENTED', submitted_at: '2026-04-20T08:05:00Z', user: cp },
  ];
  const { github, calls } = makeFakeGithub({ reviews: threeReviews });
  const result = await decide({ github, context: makeCheckRunContext(), core });
  assert.equal(result.decision, 'approved', `got skip: ${result.reason}`);
  assert.match(result.reason, /3-rounds/);
  assert.equal(calls.createReview.length, 1);
});

test('check_run event: outputs pr_url/pr_number/pr_author for the caller Slack fallback', async () => {
  const core = makeCore();
  const cp = { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' };
  const { github } = makeFakeGithub({
    reviews: [{ id: 1, state: 'COMMENTED', submitted_at: '2026-04-20T08:00:00Z', user: cp }],
    reviewComments: { 1: [] },
  });
  const result = await decide({ github, context: makeCheckRunContext({ prNumber: 77 }), core });
  assert.equal(result.decision, 'approved', `got skip: ${result.reason}`);
  assert.equal(core.outputs.pr_url, 'https://github.com/axeptio/test-only-repo/pull/77');
  assert.equal(core.outputs.pr_number, '77');
  assert.equal(core.outputs.pr_author, 'someone');
  // The default fixture sets no title, so it must fall back to an empty
  // string rather than 'undefined' leaking into a Slack message.
  assert.equal(core.outputs.pr_title, '');
});

test('no pull_request in event: pr_* outputs stay empty (no PR was ever resolved)', async () => {
  const core = makeCore();
  const { github } = makeFakeGithub();
  const result = await decide({
    github,
    context: { runId: 1, repo: { owner: 'axeptio', repo: 'test-only-repo' }, payload: {} },
    core,
  });
  assert.equal(result.decision, 'skip');
  assert.equal(core.outputs.pr_url, '');
  assert.equal(core.outputs.pr_number, '');
  assert.equal(core.outputs.pr_author, '');
});

test('check_run event: no associated PRs → skip', async () => {
  const core = makeCore();
  const { github } = makeFakeGithub();
  const result = await decide({
    github,
    context: makeCheckRunContext({ prNumber: null }),
    core,
  });
  assert.equal(result.decision, 'skip');
  assert.match(result.reason, /no associated PRs/);
});

test('check_run event: invalid PR number → skip', async () => {
  const core = makeCore();
  const { github } = makeFakeGithub();
  const ctx = {
    runId: 111,
    repo: { owner: 'axeptio', repo: 'test-only-repo' },
    payload: { check_run: { name: 'ci', pull_requests: [{ number: 'bad' }] } },
  };
  const result = await decide({ github, context: ctx, core });
  assert.equal(result.decision, 'skip');
  assert.match(result.reason, /missing valid number/);
});

test('check_run event: PR targets non-develop branch → skip', async () => {
  const core = makeCore();
  const { github } = makeFakeGithub({
    getPrImpl: (pull_number) => ({
      data: {
        number: pull_number,
        draft: false,
        user: { login: 'someone' },
        head: { sha: 'deadbeef', repo: { full_name: 'axeptio/test-only-repo' } },
        base: { ref: 'main' },
        html_url: `https://github.com/axeptio/test-only-repo/pull/${pull_number}`,
      },
    }),
  });
  const result = await decide({ github, context: makeCheckRunContext(), core });
  assert.equal(result.decision, 'skip');
  assert.match(result.reason, /not in \[/);
});

test('check_run event: draft PR → skip with check_run: PR is draft', async () => {
  const core = makeCore();
  const { github } = makeFakeGithub({
    getPrImpl: (pull_number) => ({
      data: {
        number: pull_number,
        draft: true,
        user: { login: 'someone' },
        head: { sha: 'deadbeef', repo: { full_name: 'axeptio/test-only-repo' } },
        base: { ref: 'develop' },
        html_url: `https://github.com/axeptio/test-only-repo/pull/${pull_number}`,
      },
    }),
  });
  const result = await decide({ github, context: makeCheckRunContext(), core });
  assert.equal(result.decision, 'skip');
  assert.match(result.reason, /PR is draft/);
});

test('check_run event: PR base in the configured multi-branch set is eligible', async () => {
  const core = makeCore();
  const cp = { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' };
  const original = process.env.AUTO_APPROVE_BASE_BRANCH;
  process.env.AUTO_APPROVE_BASE_BRANCH = 'develop,staging';
  try {
    const { github, calls } = makeFakeGithub({
      getPrImpl: (pull_number) => ({
        data: {
          number: pull_number,
          draft: false,
          user: { login: 'someone' },
          head: { sha: 'deadbeef', repo: { full_name: 'axeptio/test-only-repo' } },
          base: { ref: 'staging' }, // in the set → eligible
          html_url: `https://github.com/axeptio/test-only-repo/pull/${pull_number}`,
        },
      }),
      reviews: [
        { id: 1, state: 'COMMENTED', submitted_at: '2026-04-20T08:00:00Z', user: cp },
      ],
      reviewComments: { 1: [] },
    });
    const result = await decide({ github, context: makeCheckRunContext(), core });
    assert.equal(result.decision, 'approved', `got skip: ${result.reason}`);
    assert.equal(calls.createReview.length, 1);
  } finally {
    if (original == null) delete process.env.AUTO_APPROVE_BASE_BRANCH;
    else process.env.AUTO_APPROVE_BASE_BRANCH = original;
  }
});

test('check_run event: PR base outside the configured multi-branch set → skip', async () => {
  const core = makeCore();
  const original = process.env.AUTO_APPROVE_BASE_BRANCH;
  process.env.AUTO_APPROVE_BASE_BRANCH = 'develop,staging';
  try {
    const { github } = makeFakeGithub({
      getPrImpl: (pull_number) => ({
        data: {
          number: pull_number,
          draft: false,
          user: { login: 'someone' },
          head: { sha: 'deadbeef', repo: { full_name: 'axeptio/test-only-repo' } },
          base: { ref: 'main' }, // not in {develop, staging}
          html_url: `https://github.com/axeptio/test-only-repo/pull/${pull_number}`,
        },
      }),
    });
    const result = await decide({ github, context: makeCheckRunContext(), core });
    assert.equal(result.decision, 'skip');
    assert.match(result.reason, /not in \[/);
  } finally {
    if (original == null) delete process.env.AUTO_APPROVE_BASE_BRANCH;
    else process.env.AUTO_APPROVE_BASE_BRANCH = original;
  }
});

// -- workflow_run event tests -------------------------------------------------

// Returns a context shaped like a workflow_run:completed event (no pull_request).
function makeWorkflowRunContext({
  prNumber = 42,
  conclusion = 'success',
  headRepoFullName = 'axeptio/test-only-repo',
} = {}) {
  return {
    runId: 111,
    repo: { owner: 'axeptio', repo: 'test-only-repo' },
    payload: {
      workflow_run: {
        conclusion,
        pull_requests: prNumber != null ? [{ number: prNumber }] : [],
        head_repository: headRepoFullName != null ? { full_name: headRepoFullName } : null,
      },
    },
  };
}

test('workflow_run event: extracts PR and approves on 3-rounds', async () => {
  const core = makeCore();
  const cp = { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' };
  const threeReviews = [
    { id: 1, state: 'COMMENTED', submitted_at: '2026-04-20T07:35:00Z', user: cp },
    { id: 2, state: 'COMMENTED', submitted_at: '2026-04-20T07:49:00Z', user: cp },
    { id: 3, state: 'COMMENTED', submitted_at: '2026-04-20T08:05:00Z', user: cp },
  ];
  const { github, calls } = makeFakeGithub({ reviews: threeReviews });
  const result = await decide({ github, context: makeWorkflowRunContext(), core });
  assert.equal(result.decision, 'approved', `got skip: ${result.reason}`);
  assert.match(result.reason, /3-rounds/);
  assert.equal(calls.createReview.length, 1);
});

test('workflow_run event: non-success conclusion → skip', async () => {
  const core = makeCore();
  const { github } = makeFakeGithub();
  const result = await decide({
    github,
    context: makeWorkflowRunContext({ conclusion: 'failure' }),
    core,
  });
  assert.equal(result.decision, 'skip');
  assert.match(result.reason, /conclusion is failure/);
});

test('workflow_run event: no associated PRs → skip', async () => {
  const core = makeCore();
  const { github } = makeFakeGithub();
  const result = await decide({
    github,
    context: makeWorkflowRunContext({ prNumber: null }),
    core,
  });
  assert.equal(result.decision, 'skip');
  assert.match(result.reason, /no associated PRs/);
});

test('workflow_run event: invalid PR number → skip', async () => {
  const core = makeCore();
  const { github } = makeFakeGithub();
  const ctx = {
    runId: 111,
    repo: { owner: 'axeptio', repo: 'test-only-repo' },
    payload: {
      workflow_run: {
        conclusion: 'success',
        pull_requests: [{ number: 'bad' }],
        head_repository: { full_name: 'axeptio/test-only-repo' },
      },
    },
  };
  const result = await decide({ github, context: ctx, core });
  assert.equal(result.decision, 'skip');
  assert.match(result.reason, /missing valid number/);
});

test('workflow_run event: head repo mismatch → skip', async () => {
  const core = makeCore();
  const { github } = makeFakeGithub();
  const result = await decide({
    github,
    context: makeWorkflowRunContext({ headRepoFullName: 'someone-else/fork' }),
    core,
  });
  assert.equal(result.decision, 'skip');
  assert.match(result.reason, /head repo does not match/);
});

test('workflow_run event: PR targets ineligible base branch → skip', async () => {
  const core = makeCore();
  const { github } = makeFakeGithub({
    getPrImpl: (pull_number) => ({
      data: {
        number: pull_number,
        draft: false,
        user: { login: 'someone' },
        head: { sha: 'deadbeef', repo: { full_name: 'axeptio/test-only-repo' } },
        base: { ref: 'main' },
        html_url: `https://github.com/axeptio/test-only-repo/pull/${pull_number}`,
      },
    }),
  });
  const result = await decide({ github, context: makeWorkflowRunContext(), core });
  assert.equal(result.decision, 'skip');
  assert.match(result.reason, /not in \[/);
});

test('workflow_run event: fetched PR head repo mismatch (fork) → skip', async () => {
  const core = makeCore();
  const { github } = makeFakeGithub({
    getPrImpl: (pull_number) => ({
      data: {
        number: pull_number,
        draft: false,
        user: { login: 'someone' },
        head: { sha: 'deadbeef', repo: { full_name: 'someone-else/fork' } },
        base: { ref: 'develop' },
        html_url: `https://github.com/axeptio/test-only-repo/pull/${pull_number}`,
      },
    }),
  });
  const result = await decide({ github, context: makeWorkflowRunContext(), core });
  assert.equal(result.decision, 'skip');
  assert.match(result.reason, /PR head repo does not match/);
});

test('workflow_run event: draft PR → skip with workflow_run: PR is draft', async () => {
  const core = makeCore();
  const { github } = makeFakeGithub({
    getPrImpl: (pull_number) => ({
      data: {
        number: pull_number,
        draft: true,
        user: { login: 'someone' },
        head: { sha: 'deadbeef', repo: { full_name: 'axeptio/test-only-repo' } },
        base: { ref: 'develop' },
        html_url: `https://github.com/axeptio/test-only-repo/pull/${pull_number}`,
      },
    }),
  });
  const result = await decide({ github, context: makeWorkflowRunContext(), core });
  assert.equal(result.decision, 'skip');
  assert.match(result.reason, /PR is draft/);
});

// -- Waiting for Copilot's review check -----------------------------------
//
// Copilot cannot re-trigger the workflow (its check run is GITHUB_TOKEN-created,
// and runs it triggers are held at action_required), so when its check is the
// last one outstanding the only way to reach a decision is to wait here.

const CI_OK = {
  name: 'ci',
  status: 'completed',
  conclusion: 'success',
  started_at: '2026-04-15T10:00:00Z',
  app: { id: 1 },
};
const copilotCheck = (status, conclusion = null) => ({
  name: 'copilot-pull-request-reviewer',
  status,
  conclusion,
  started_at: '2026-04-15T10:01:00Z',
  app: { id: 15368 },
});
const CLEAN_COPILOT_REVIEW = {
  id: 1,
  state: 'COMMENTED',
  submitted_at: '2026-04-16T10:00:00Z',
  commit_id: 'deadbeef',
  user: { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' },
};

// Returns a github fake whose listForRef walks `sequence`, holding on the last
// entry, plus a counter so tests can assert whether polling happened at all.
function makePollingGithub(sequence, opts = {}) {
  const { github, calls } = makeFakeGithub(opts);
  const state = { calls: 0 };
  github.rest.checks.listForRef = async () => {
    const runs = sequence[Math.min(state.calls, sequence.length - 1)];
    state.calls++;
    return { data: { total_count: runs.length, check_runs: runs } };
  };
  return { github, calls, state };
}

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('wait off by default: pending Copilot check skips immediately without polling', async () => {
  const core = makeCore();
  const { github, state } = makePollingGithub([[CI_OK, copilotCheck('in_progress')]]);
  const result = await decide({ github, context: makeContext(), core, sleep: realSleep });
  assert.equal(result.decision, 'skip');
  assert.match(result.reason, /check still running: copilot-pull-request-reviewer/);
  assert.equal(state.calls, 1, 'must not poll when the wait is not opted into');
});

test('wait on: Copilot check completing on a later poll leads to approval', async () => {
  process.env.AUTO_APPROVE_COPILOT_WAIT_SECONDS = '30';
  process.env.AUTO_APPROVE_COPILOT_POLL_MS = '5';
  try {
    const core = makeCore();
    const { github, calls, state } = makePollingGithub(
      [
        [CI_OK, copilotCheck('in_progress')],
        [CI_OK, copilotCheck('in_progress')],
        [CI_OK, copilotCheck('completed', 'success')],
      ],
      { reviews: [CLEAN_COPILOT_REVIEW], reviewComments: { 1: [] } },
    );
    const result = await decide({ github, context: makeContext(), core, sleep: realSleep });
    assert.equal(result.decision, 'approved', `got skip: ${result.reason}`);
    assert.equal(calls.createReview.length, 1);
    assert.ok(state.calls >= 3, `expected polling, saw ${state.calls} fetches`);
  } finally {
    delete process.env.AUTO_APPROVE_COPILOT_WAIT_SECONDS;
    delete process.env.AUTO_APPROVE_COPILOT_POLL_MS;
  }
});

test('wait on: Copilot check never finishing skips after the timeout, with a warning', async () => {
  process.env.AUTO_APPROVE_COPILOT_WAIT_SECONDS = '1';
  process.env.AUTO_APPROVE_COPILOT_POLL_MS = '400';
  try {
    const core = makeCore();
    const warnings = [];
    core.warning = (m) => warnings.push(m);
    const { github, state } = makePollingGithub([[CI_OK, copilotCheck('in_progress')]]);
    const result = await decide({ github, context: makeContext(), core, sleep: realSleep });
    assert.equal(result.decision, 'skip');
    assert.match(result.reason, /check still running: copilot-pull-request-reviewer/);
    assert.ok(state.calls > 1, 'should have polled before giving up');
    assert.ok(
      warnings.some((w) => /gave up waiting for copilot-pull-request-reviewer after 1s/.test(w)),
      `expected a give-up warning, got: ${JSON.stringify(warnings)}`,
    );
  } finally {
    delete process.env.AUTO_APPROVE_COPILOT_WAIT_SECONDS;
    delete process.env.AUTO_APPROVE_COPILOT_POLL_MS;
  }
});

test('wait on: another check still pending → no wait, CI will re-trigger us', async () => {
  process.env.AUTO_APPROVE_COPILOT_WAIT_SECONDS = '300';
  try {
    const core = makeCore();
    const { github, state } = makePollingGithub([
      [{ ...CI_OK, status: 'in_progress', conclusion: null }, copilotCheck('in_progress')],
    ]);
    const result = await decide({ github, context: makeContext(), core, sleep: realSleep });
    assert.equal(result.decision, 'skip');
    assert.equal(state.calls, 1, 'must not burn the timeout on an unrelated pending check');
  } finally {
    delete process.env.AUTO_APPROVE_COPILOT_WAIT_SECONDS;
  }
});

test('wait on: an already-failed check short-circuits the wait (no timeout burned)', async () => {
  process.env.AUTO_APPROVE_COPILOT_WAIT_SECONDS = '300';
  try {
    const core = makeCore();
    const { github, state } = makePollingGithub([
      [{ ...CI_OK, conclusion: 'failure' }, copilotCheck('in_progress')],
    ]);
    const result = await decide({ github, context: makeContext(), core, sleep: realSleep });
    assert.equal(result.decision, 'skip');
    assert.match(result.reason, /failing check: ci \(failure\)/);
    assert.equal(state.calls, 1, 'approval is already impossible — must not poll');
  } finally {
    delete process.env.AUTO_APPROVE_COPILOT_WAIT_SECONDS;
  }
});

test('wait on: Copilot check finishing red is still caught by the failing-check gate', async () => {
  process.env.AUTO_APPROVE_COPILOT_WAIT_SECONDS = '30';
  process.env.AUTO_APPROVE_COPILOT_POLL_MS = '5';
  try {
    const core = makeCore();
    const { github, calls } = makePollingGithub(
      [
        [CI_OK, copilotCheck('in_progress')],
        [CI_OK, copilotCheck('completed', 'failure')],
      ],
      { reviews: [CLEAN_COPILOT_REVIEW], reviewComments: { 1: [] } },
    );
    const result = await decide({ github, context: makeContext(), core, sleep: realSleep });
    assert.equal(result.decision, 'skip');
    assert.match(result.reason, /failing check: copilot-pull-request-reviewer \(failure\)/);
    assert.equal(calls.createReview.length, 0);
  } finally {
    delete process.env.AUTO_APPROVE_COPILOT_WAIT_SECONDS;
    delete process.env.AUTO_APPROVE_COPILOT_POLL_MS;
  }
});

// --- token split (t9w.16) ------------------------------------------------
//
// Reads go through `github` (the workflow's GITHUB_TOKEN, which can hold the
// Checks permission) and only the approval goes through `botGithub` (the bot
// PAT, which cannot). Getting this backwards is invisible on a public repo and
// breaks every private one, so it is pinned here rather than left to review.

test('token split: the approval goes to botGithub, never to github', async () => {
  const core = makeCore();
  const cp = { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' };
  const { github, calls } = makeFakeGithub({
    reviews: [{ id: 1, state: 'COMMENTED', submitted_at: '2026-04-16T10:00:00Z', user: cp }],
    reviewComments: { 1: [] },
  });

  const botCalls = [];
  const botGithub = {
    rest: {
      pulls: {
        createReview: async (args) => {
          botCalls.push(args);
          return { data: { id: 99 } };
        },
      },
    },
  };

  const result = await decide({ github, botGithub, context: makeContext(), core });

  assert.equal(result.decision, 'approved', `got skip: ${result.reason}`);
  assert.equal(botCalls.length, 1, 'approval must be posted by the bot client');
  assert.equal(botCalls[0].event, 'APPROVE');
  assert.equal(calls.createReview.length, 0, 'the read client must never post the approval');
});

test('token split: botGithub defaults to github, so one-client callers still work', async () => {
  const core = makeCore();
  const cp = { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' };
  const { github, calls } = makeFakeGithub({
    reviews: [{ id: 1, state: 'COMMENTED', submitted_at: '2026-04-16T10:00:00Z', user: cp }],
    reviewComments: { 1: [] },
  });

  const result = await decide({ github, context: makeContext(), core });

  assert.equal(result.decision, 'approved', `got skip: ${result.reason}`);
  assert.equal(calls.createReview.length, 1);
});

// --- diagnosable failures (t9w.16) ---------------------------------------

test('evaluation failure names the request that was refused', async () => {
  const core = makeCore();
  const { github } = makeFakeGithub();
  const err = new Error('Resource not accessible by personal access token');
  err.status = 403;
  err.request = { method: 'GET', url: 'https://api.github.com/repos/o/r/pulls/1/reviews' };
  // paginate, not pulls.get: on a pull_request event the PR comes from the
  // payload and pulls.get is never called, so overriding it proves nothing.
  github.paginate = async () => { throw err; };

  const result = await decide({ github, context: makeContext(), core });

  assert.equal(result.decision, 'skip');
  assert.match(result.reason, /^evaluation failed: 403 GET \/repos\/o\/r\/pulls\/1\/reviews /);
  // Unrelated 403s must not carry the Checks hint, or it stops meaning anything.
  assert.doesNotMatch(result.reason, /Checks permission/);
});

test('a 403 on check-runs explains that fine-grained PATs cannot read them', async () => {
  const core = makeCore();
  const { github } = makeFakeGithub();
  const err = new Error('Resource not accessible by personal access token');
  err.status = 403;
  err.request = {
    method: 'GET',
    url: 'https://api.github.com/repos/o/r/commits/abc123/check-runs',
  };
  github.rest.checks.listForRef = async () => { throw err; };

  const result = await decide({ github, context: makeContext(), core });

  assert.equal(result.decision, 'skip');
  assert.match(result.reason, /GET \/repos\/o\/r\/commits\/abc123\/check-runs/);
  assert.match(result.reason, /Checks permission, which fine-grained PATs cannot be granted/);
  assert.match(result.reason, /checks: read/);
});

test('an error with no request object still produces a usable reason', async () => {
  const core = makeCore();
  const { github } = makeFakeGithub();
  const err = new Error('socket hang up');
  github.rest.checks.listForRef = async () => { throw err; };

  const result = await decide({ github, context: makeContext(), core });

  assert.equal(result.decision, 'skip');
  assert.equal(result.reason, 'evaluation failed: socket hang up');
});
