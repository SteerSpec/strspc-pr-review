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
} = {}) {
  const calls = { createReview: [] };

  const paginate = async (fn, params, mapper) => {
    const pages = await fn(params);
    if (mapper) return mapper(pages);
    return pages.data;
  };

  const github = {
    paginate,
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
        listReviews: async () => ({ data: reviews }),
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
    process.env.AUTO_APPROVE_ALLOW_NO_CHECKS = original;
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
        user: { login: 'axeptio-bot' },
      },
    ],
  });
  const result = await decide({ github, context: makeContext(), core });
  assert.equal(result.decision, 'skip');
  assert.match(result.reason, /already approved/);
  assert.equal(calls.createReview.length, 0);
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
  assert.match(result.reason, /base ref is not/);
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
