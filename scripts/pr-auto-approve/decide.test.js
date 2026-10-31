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
  changedFiles = ['README.md'],
} = {}) {
  const calls = { createReview: [], graphql: [], compare: [] };

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
      repos: {
        // The compare endpoint puts the files on the first page only, capped at
        // 300: one object, not a paginated list.
        compareCommitsWithBasehead: async (args) => {
          calls.compare.push(args);
          return { data: { merge_base_commit: { sha: 'mb000001' }, files: changedFiles.map((filename) => ({ filename })) } };
        },
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

// Would be approved if the gate let it through: a clean Copilot review on green
// CI. Without one, the tests below would skip for the wrong reason and pass.
function makeApprovableGithub() {
  return makeFakeGithub({
    reviews: [{
      id: 1,
      state: 'COMMENTED',
      commit_id: 'deadbeef',
      submitted_at: '2026-04-16T10:00:00Z',
      user: { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' },
    }],
    reviewComments: { 1: [] },
  });
}

test('skip: draft PR in the event payload, without a caller guard', async () => {
  const core = makeCore();
  const { github, calls } = makeApprovableGithub();
  const ctx = makeContext({ prOverrides: { draft: true } });
  const result = await decide({ github, context: ctx, core });
  assert.equal(result.decision, 'skip');
  assert.match(result.reason, /PR is draft/);
  assert.equal(calls.createReview.length, 0);
});

test('skip: fork PR in the event payload, without a caller guard', async () => {
  const core = makeCore();
  const { github, calls } = makeApprovableGithub();
  const ctx = makeContext({
    prOverrides: { head: { sha: 'deadbeef', repo: { full_name: 'someone-else/fork' } } },
  });
  const result = await decide({ github, context: ctx, core });
  assert.equal(result.decision, 'skip');
  assert.match(result.reason, /head repo does not match/);
  assert.equal(calls.createReview.length, 0);
});

test('skip: PR whose head repo was deleted cannot be shown to be same-repo', async () => {
  const core = makeCore();
  const { github, calls } = makeApprovableGithub();
  const ctx = makeContext({ prOverrides: { head: { sha: 'deadbeef', repo: null } } });
  const result = await decide({ github, context: ctx, core });
  assert.equal(result.decision, 'skip');
  assert.match(result.reason, /head repo does not match/);
  assert.equal(calls.createReview.length, 0);
});

test('approve: same-repo non-draft PR in the event payload still reaches approval', async () => {
  const core = makeCore();
  const { github, calls } = makeApprovableGithub();
  const result = await decide({ github, context: makeContext(), core });
  assert.equal(result.decision, 'approved', `got skip: ${result.reason}`);
  assert.equal(calls.createReview.length, 1);
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

// The 2026-08 body, transcribed from testbed-multi-org/strspc-pr-review-testbed
// PR#1 review 4999980534. GitHub renamed the collapsed block and dropped the
// "low confidence" framing; keep both shapes covered so a fix for one wording
// can't silently regress the other.
function suppressedBodyV2(count) {
  return [
    '## Pull request overview',
    '',
    `Copilot reviewed 1 out of 1 changed files in this pull request and generated ${count} comment.`,
    '',
    '<details>',
    `<summary>Suppressed comments (${count})</summary>`,
    '',
    `**Previously missed (${count})** — in code that hasn't changed since the last review.`,
    '',
    '**src/stats.js:47**',
    '* Interpolating `userId` directly into the path lets `/`, `?`, or `#` alter the request route.',
    '</details>',
  ].join('\n');
}

test('skip: 2026-08 "Suppressed comments" block blocks approval', async () => {
  const core = makeCore();
  const { github, calls } = makeFakeGithub({
    reviews: [
      {
        id: 7,
        state: 'COMMENTED',
        submitted_at: '2026-08-22T10:00:00Z',
        user: { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' },
        body: suppressedBodyV2(1),
      },
    ],
    // Empty, exactly as the real API behaves: listCommentsForReview does not
    // return suppressed findings, which is why the body scan exists.
    reviewComments: { 7: [] },
  });
  const result = await decide({ github, context: makeContext(), core });
  assert.equal(result.decision, 'skip');
  assert.match(result.reason, /1 suppressed comment/);
  assert.equal(calls.createReview.length, 0);
});

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
  assert.match(result.reason, /1 suppressed comment/);
  assert.equal(calls.createReview.length, 0);
});

// Real production body, SteerSpec/strspc-rules#83: a failed Copilot run still
// posts a COMMENTED review with no inline comments.
const ERRORED_BODY =
  'Copilot encountered an error and was unable to review this pull request. '
  + 'You can try again by re-requesting a review.';
const COPILOT = { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' };

test('skip: errored Copilot review on the head is not copilot-clean', async () => {
  const core = makeCore();
  const { github, calls } = makeFakeGithub({
    reviews: [
      { id: 7, state: 'COMMENTED', submitted_at: '2026-10-29T10:00:00Z', user: COPILOT, body: ERRORED_BODY },
    ],
    reviewComments: { 7: [] },
  });
  const result = await decide({ github, context: makeContext(), core });
  assert.equal(result.decision, 'skip');
  assert.match(result.reason, /no Copilot review yet.*errored/);
  assert.equal(calls.createReview.length, 0);
});

test('skip: a CHANGES_REQUESTED review is not mistaken for an errored one', async () => {
  const core = makeCore();
  const { github, calls } = makeFakeGithub({
    reviews: [
      { id: 6, state: 'COMMENTED', submitted_at: '2026-10-29T09:00:00Z', user: COPILOT },
      { id: 7, state: 'CHANGES_REQUESTED', submitted_at: '2026-10-29T10:00:00Z', user: COPILOT, body: ERRORED_BODY },
    ],
    reviewComments: { 6: [], 7: [] },
  });
  const result = await decide({ github, context: makeContext(), core });
  assert.equal(result.decision, 'skip');
  assert.match(result.reason, /requested changes/);
  assert.equal(calls.createReview.length, 0);
});

test('approve: a COMMENTED review that only quotes the error text stays eligible', async () => {
  const core = makeCore();
  const { github, calls } = makeFakeGithub({
    reviews: [
      {
        id: 7,
        state: 'COMMENTED',
        submitted_at: '2026-10-29T10:00:00Z',
        user: COPILOT,
        body: `Generated no new comments.\n\n> ${ERRORED_BODY}`,
      },
    ],
    reviewComments: { 7: [] },
  });
  const result = await decide({ github, context: makeContext(), core });
  assert.equal(result.decision, 'approved', `got skip: ${result.reason}`);
  assert.match(result.reason, /copilot-clean \(review 7/);
  assert.equal(calls.createReview.length, 1);
});

// -- copilot-error-retries ----------------------------------------------

function erroredOnHead(id, hour, commit = 'deadbeef') {
  return {
    id, state: 'COMMENTED', submitted_at: `2026-10-29T${hour}:00:00Z`, commit_id: commit, user: COPILOT, body: ERRORED_BODY,
  };
}

async function runWithRetries(retries, reviews, requestImpl, pendingReviewers = []) {
  const prev = process.env.AUTO_APPROVE_COPILOT_ERROR_RETRIES;
  if (retries === undefined) delete process.env.AUTO_APPROVE_COPILOT_ERROR_RETRIES;
  else process.env.AUTO_APPROVE_COPILOT_ERROR_RETRIES = retries;
  try {
    const core = makeCore();
    const warnings = [];
    core.warning = (m) => warnings.push(m);
    const { github, calls } = makeFakeGithub({ reviews, reviewComments: {} });
    const requested = [];
    const originalGet = github.rest.pulls.get;
    github.rest.pulls.get = async (a) => {
      const out = await originalGet(a);
      return { ...out, data: { ...out.data, requested_reviewers: pendingReviewers } };
    };
    github.rest.pulls.requestReviewers = async (a) => {
      if (requestImpl) return requestImpl(a);
      requested.push(a);
      return { data: {} };
    };
    const result = await decide({ github, context: makeContext(), core });
    return { result, requested, warnings, calls };
  } finally {
    if (prev === undefined) delete process.env.AUTO_APPROVE_COPILOT_ERROR_RETRIES;
    else process.env.AUTO_APPROVE_COPILOT_ERROR_RETRIES = prev;
  }
}

test('retries off by default: errored review is not re-requested', async () => {
  const { result, requested } = await runWithRetries(undefined, [erroredOnHead(7, '10')]);
  assert.equal(result.decision, 'skip');
  assert.match(result.reason, /errored; re-request a review\)/);
  assert.equal(requested.length, 0);
});

test('retries=2: first errored review on the head is re-requested', async () => {
  const { result, requested, calls } = await runWithRetries('2', [erroredOnHead(7, '10')]);
  assert.equal(result.decision, 'skip');
  assert.match(result.reason, /re-requested, retry 1\/2/);
  assert.deepEqual(requested[0].reviewers, ['copilot-pull-request-reviewer[bot]']);
  assert.equal(requested[0].pull_number, 42);
  assert.equal(calls.createReview.length, 0);
});

test('retries=1: a second errored review on the head exhausts the budget', async () => {
  const { result, requested } = await runWithRetries('1', [erroredOnHead(7, '10'), erroredOnHead(8, '11')]);
  assert.equal(result.decision, 'skip');
  assert.match(result.reason, /errored 2 time\(s\) on this head; retries exhausted/);
  assert.equal(requested.length, 0);
});

test('retries: an errored review of an older commit neither spends nor triggers the budget', async () => {
  const { result, requested } = await runWithRetries('2', [erroredOnHead(7, '10', 'cafebabe')]);
  assert.equal(result.decision, 'skip');
  assert.equal(requested.length, 0);
});

test('retries: errored head attempt on top of a stale clean review is re-requested', async () => {
  const stale = { id: 6, state: 'COMMENTED', submitted_at: '2026-10-29T09:00:00Z', commit_id: 'cafebabe', user: COPILOT };
  const { result, requested } = await runWithRetries('2', [stale, erroredOnHead(7, '10')]);
  assert.equal(result.decision, 'skip');
  assert.match(result.reason, /older commit.*errored \(re-requested, retry 1\/2\)/);
  assert.equal(requested.length, 1);
});

test('retries: a stale review with retries off keeps the plain waiting reason plus the errored hint', async () => {
  const stale = { id: 6, state: 'COMMENTED', submitted_at: '2026-10-29T09:00:00Z', commit_id: 'cafebabe', user: COPILOT };
  const { requested, result } = await runWithRetries(undefined, [stale, erroredOnHead(7, '10')]);
  assert.match(result.reason, /waiting for re-review; its attempt on this head errored \(re-request a review\)/);
  assert.equal(requested.length, 0);
});

test('retries: a Copilot request already pending is not requested again', async () => {
  const { result, requested } = await runWithRetries(
    '2', [erroredOnHead(7, '10')], undefined, [{ login: 'Copilot' }],
  );
  assert.equal(result.decision, 'skip');
  assert.match(result.reason, /re-request already pending, retry 1\/2/);
  assert.equal(requested.length, 0);
});

test('retries: an unrelated reviewer with "copilot" in its login does not mask the retry', async () => {
  const { result, requested } = await runWithRetries(
    '2', [erroredOnHead(7, '10')], undefined, [{ login: 'copilot-helper' }],
  );
  assert.match(result.reason, /re-requested, retry 1\/2/);
  assert.equal(requested.length, 1);
});

test('retries: a re-request failure only warns and still skips', async () => {
  const { result, warnings } = await runWithRetries('2', [erroredOnHead(7, '10')], async () => {
    throw Object.assign(new Error('Validation Failed'), { status: 422 });
  });
  assert.equal(result.decision, 'skip');
  assert.match(result.reason, /automatic re-request failed/);
  assert.match(warnings.join('\n'), /could not re-request a Copilot review: 422/);
});

test('retries: a real review on the head means no re-request', async () => {
  const { result, requested } = await runWithRetries('2', [
    erroredOnHead(7, '10'),
    { id: 8, state: 'COMMENTED', submitted_at: '2026-10-29T10:05:00Z', commit_id: 'deadbeef', user: COPILOT },
  ]);
  assert.equal(requested.length, 0);
  assert.equal(result.decision, 'approved', `got skip: ${result.reason}`);
});

test('getErrorRetries: only a positive integer enables retries', () => {
  for (const [raw, want] of [[undefined, 0], ['', 0], ['0', 0], ['-1', 0], ['abc', 0], ['2', 2], [' 3 ', 3], ['2foo', 0], ['2.5', 0], ['1e3', 0]]) {
    assert.equal(decide.getErrorRetries({ AUTO_APPROVE_COPILOT_ERROR_RETRIES: raw }), want, String(raw));
  }
});

test('skip: errored reviews do not count toward the rounds threshold', async () => {
  const core = makeCore();
  const mk = (id, h) => ({
    id, state: 'COMMENTED', submitted_at: `2026-10-29T${h}:00:00Z`, commit_id: 'cafebabe', user: COPILOT, body: ERRORED_BODY,
  });
  const { github, calls } = makeFakeGithub({ reviews: [mk(1, '08'), mk(2, '09'), mk(3, '10')] });
  const result = await decide({ github, context: makeContext(), core });
  assert.equal(result.decision, 'skip');
  assert.equal(calls.createReview.length, 0);
});

test('approve: a real clean review after an errored one is copilot-clean', async () => {
  const core = makeCore();
  const { github, calls } = makeFakeGithub({
    reviews: [
      { id: 7, state: 'COMMENTED', submitted_at: '2026-10-29T10:00:00Z', user: COPILOT, body: ERRORED_BODY },
      { id: 8, state: 'COMMENTED', submitted_at: '2026-10-29T10:05:00Z', user: COPILOT },
    ],
    reviewComments: { 7: [], 8: [] },
  });
  const result = await decide({ github, context: makeContext(), core });
  assert.equal(result.decision, 'approved', `got skip: ${result.reason}`);
  assert.match(result.reason, /copilot-clean \(review 8/);
  assert.equal(calls.createReview.length, 1);
});

test('skip: errored review after a stale clean review does not approve', async () => {
  const core = makeCore();
  const { github, calls } = makeFakeGithub({
    reviews: [
      { id: 6, state: 'COMMENTED', submitted_at: '2026-10-29T09:00:00Z', commit_id: 'cafebabe', user: COPILOT },
      { id: 7, state: 'COMMENTED', submitted_at: '2026-10-29T10:00:00Z', user: COPILOT, body: ERRORED_BODY },
    ],
    reviewComments: { 6: [], 7: [] },
  });
  const result = await decide({ github, context: makeContext(), core });
  assert.equal(result.decision, 'skip');
  assert.match(result.reason, /older commit/);
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
  assert.match(result.reason, /2 suppressed comment/);
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

// Shape of the review bodies Copilot posts since 2026-10, trimmed from real
// reviews: SteerSpec/strspc-pr-review#127 and #128, SteerSpec/strspc-manager#177.
const NO_OPEN_ISSUES = '**No open issues** 🎉';
const OPEN_ISSUES = [
  '<details open>',
  '<summary><strong>1 open issue</strong></summary>',
  '',
  '- <picture><img alt="High severity"></picture> [Prevent approval before title checks finish](https://example.test/r1)',
  '</details>',
].join('\n');
const PREVIOUSLY_MISSED = [
  '<details>',
  '<summary><strong>1 previously missed issue</strong></summary>',
  '',
  'In code that hasn\'t changed since last review',
  '</details>',
].join('\n');
function overviewBody({ verdict = '🟢 Approval recommended', issues = NO_OPEN_ISSUES, extra = '' } = {}) {
  return [
    '<!-- ccr-overview-v2 -->',
    '',
    `### ${verdict}`,
    '',
    'The review summary sentence.',
    '',
    issues,
    '',
    extra,
    '',
    '<details>',
    '<summary><strong>What changed in this PR</strong></summary>',
    '',
    'This pull request changes things.',
    '</details>',
    '',
    '<sub>Review effort: Lite</sub>',
  ].join('\n');
}

async function decideOnBody(body) {
  const core = makeCore();
  const { github, calls } = makeFakeGithub({
    reviews: [
      {
        id: 7,
        state: 'COMMENTED',
        submitted_at: '2026-04-15T10:00:00Z',
        user: { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' },
        body,
      },
    ],
    reviewComments: { 7: [] },
  });
  const result = await decide({ github, context: makeContext(), core });
  return { result, calls };
}

test('approve: overview review with an approval verdict and no open issues', async () => {
  const { result, calls } = await decideOnBody(overviewBody());
  assert.equal(result.decision, 'approved', `got skip: ${result.reason}`);
  assert.match(result.reason, /copilot-clean/);
  assert.equal(calls.createReview.length, 1);
});

test('skip: overview review still lists an open issue', async () => {
  // Real case, #127: a green verdict over a High issue left from an earlier
  // round. The inline-comment count is 0 because the review added no new thread.
  const { result, calls } = await decideOnBody(overviewBody({ issues: OPEN_ISSUES }));
  assert.equal(result.decision, 'skip');
  assert.match(result.reason, /1 open issue/);
  assert.equal(calls.createReview.length, 0);
});

test('skip: overview review with a previously missed issue only in the body', async () => {
  const { result, calls } = await decideOnBody(overviewBody({ extra: PREVIOUSLY_MISSED }));
  assert.equal(result.decision, 'skip');
  assert.match(result.reason, /previously missed/);
  assert.equal(calls.createReview.length, 0);
});

test('skip: overview verdict is not an approval, even with no open issues', async () => {
  // Real case, strspc-manager#177.
  const { result, calls } = await decideOnBody(overviewBody({ verdict: '🔵 Needs a closer look' }));
  assert.equal(result.decision, 'skip');
  assert.match(result.reason, /Needs a closer look/);
  assert.equal(calls.createReview.length, 0);
});

test('skip: overview review with a verdict this code has never seen', async () => {
  const { result, calls } = await decideOnBody(overviewBody({ verdict: '🟣 Something new' }));
  assert.equal(result.decision, 'skip');
  assert.match(result.reason, /Something new/);
  assert.equal(calls.createReview.length, 0);
});

test('skip: overview review that stops saying it has no open issues', async () => {
  const { result, calls } = await decideOnBody(overviewBody({ issues: 'Nothing else to report.' }));
  assert.equal(result.decision, 'skip');
  assert.match(result.reason, /no open issues/i);
  assert.equal(calls.createReview.length, 0);
});

// The failure that already shipped twice is a format change reading as clean, so
// a later marker version and a dropped marker must both still be recognised.
test('skip: a later overview marker version keeps the same rules', async () => {
  const body = overviewBody({ verdict: '🟡 Changes recommended' })
    .replace('ccr-overview-v2', 'ccr-overview-v3');
  const { result, calls } = await decideOnBody(body);
  assert.equal(result.decision, 'skip');
  assert.equal(calls.createReview.length, 0);
});

test('skip: a verdict heading with the marker removed keeps the same rules', async () => {
  const body = overviewBody({ verdict: '🟡 Changes recommended' })
    .replace('<!-- ccr-overview-v2 -->', '');
  const { result, calls } = await decideOnBody(body);
  assert.equal(result.decision, 'skip');
  assert.equal(calls.createReview.length, 0);
});

test('approve: an overview quoted in a code fence is not a review verdict', async () => {
  const body = [
    '## Pull request overview',
    '',
    'Copilot reviewed 3 out of 3 changed files in this pull request and generated no new comments.',
    '',
    '```',
    overviewBody({ verdict: '🟡 Changes recommended', issues: OPEN_ISSUES }),
    '```',
  ].join('\n');
  const { result } = await decideOnBody(body);
  assert.equal(result.decision, 'approved', `got skip: ${result.reason}`);
});

test('approve: a resolved-issues section does not block an overview review', async () => {
  // Real case, #128's last round.
  const resolved = [
    '<details>',
    '<summary><strong>2 resolved since last review</strong></summary>',
    '',
    '- [Document both exceptions](https://example.test/r2)',
    '</details>',
  ].join('\n');
  const { result } = await decideOnBody(overviewBody({ extra: resolved }));
  assert.equal(result.decision, 'approved', `got skip: ${result.reason}`);
});

test('skip: overview review with a collapsed section this code has never seen', async () => {
  const section = [
    '<details>',
    '<summary><strong>2 deferred concerns</strong></summary>',
    '',
    'Something Copilot started reporting after this code was written.',
    '</details>',
  ].join('\n');
  const { result, calls } = await decideOnBody(overviewBody({ extra: section }));
  assert.equal(result.decision, 'skip');
  assert.match(result.reason, /2 deferred concerns/);
  assert.equal(calls.createReview.length, 0);
});

test('skip: a summary tag with attributes still counts as a section', async () => {
  const section = '<details>\n<summary class="x">1 previously missed issue</summary>\n</details>';
  const { result, calls } = await decideOnBody(overviewBody({ extra: section }));
  assert.equal(result.decision, 'skip');
  assert.match(result.reason, /previously missed/);
  assert.equal(calls.createReview.length, 0);
});

test('skip: a fence cannot hide an open issue inside an overview review', async () => {
  const fenced = ['```', OPEN_ISSUES, '```'].join('\n');
  const { result, calls } = await decideOnBody(overviewBody({ extra: fenced }));
  assert.equal(result.decision, 'skip');
  assert.equal(calls.createReview.length, 0);
});

test('skip: "No open issues" only counts before the collapsed sections', async () => {
  const quoted = ['<details>', '**No open issues**', '</details>'].join('\n');
  const { result, calls } = await decideOnBody(
    overviewBody({ issues: 'Nothing else to report.', extra: quoted }),
  );
  assert.equal(result.decision, 'skip');
  assert.match(result.reason, /no open issues/i);
  assert.equal(calls.createReview.length, 0);
});

test('skip: a marker that is not a plain version keeps the same rules', async () => {
  // An unknown verdict, so the marker alone has to identify the overview.
  const body = overviewBody({ verdict: '🟣 Something new' })
    .replace('ccr-overview-v2', 'ccr-overview-v3-beta');
  const { result, calls } = await decideOnBody(body);
  assert.equal(result.decision, 'skip');
  assert.equal(calls.createReview.length, 0);
});

test('skip: text before the overview marker does not hide the overview', async () => {
  const body = `A new preamble.\n\n${overviewBody({ verdict: '🟣 Something new' })}`;
  const { result, calls } = await decideOnBody(body);
  assert.equal(result.decision, 'skip');
  assert.equal(calls.createReview.length, 0);
});

test('skip: a fenced approval verdict is not the review verdict', async () => {
  const fence = ['```', '### 🟢 Approval recommended', '```'].join('\n');
  const body = overviewBody({ verdict: '🟡 Changes recommended' })
    .replace('<!-- ccr-overview-v2 -->', `<!-- ccr-overview-v2 -->\n\n${fence}`);
  const { result, calls } = await decideOnBody(body);
  assert.equal(result.decision, 'skip');
  assert.match(result.reason, /Changes recommended/);
  assert.equal(calls.createReview.length, 0);
});

test('skip: a fenced "No open issues" is not the statement', async () => {
  const fence = ['```', NO_OPEN_ISSUES, '```'].join('\n');
  const { result, calls } = await decideOnBody(overviewBody({ issues: fence }));
  assert.equal(result.decision, 'skip');
  assert.match(result.reason, /no open issues/i);
  assert.equal(calls.createReview.length, 0);
});

test('skip: a collapsed section with no summary is an unknown section', async () => {
  const section = ['<details>', 'Content with no label.', '</details>'].join('\n');
  const { result, calls } = await decideOnBody(overviewBody({ extra: section }));
  assert.equal(result.decision, 'skip');
  assert.equal(calls.createReview.length, 0);
});

// Same escape hatch as the suppressed block above.
test('3-rounds rule still approves despite an open issue in an overview review', async () => {
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
        body: overviewBody({ verdict: '🟡 Changes recommended', issues: OPEN_ISSUES }),
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

// Listing the reviews is the first thing a type that needs Copilot does, to
// find and withdraw an earlier relaxed approval. A failure THERE is an error,
// not a skip: a skip would leave an approval the run never found standing.
test('pulls.listReviews throwing before the stale-approval check is an error, not a skip', async () => {
  const core = makeCore();
  const failures = [];
  core.setFailed = (m) => failures.push(m);
  const err = new Error('rate limit exceeded');
  err.status = 403;
  const { github, calls } = makeFakeGithub();
  github.rest.pulls.listReviews = async () => {
    throw err;
  };
  const result = await decide({ github, context: makeContext(), core });
  assert.equal(result.decision, 'error');
  assert.equal(result.reason, "could not list the PR's reviews, so an earlier approval stamped with a relaxed rounds-by-type threshold cannot be found and withdrawn: 403 rate limit exceeded");
  assert.equal(failures.length, 1);
  assert.equal(calls.createReview.length, 0);
});

// Once the stale check is behind us (a type 0 PR runs none), the same failure
// is the ordinary "evaluation failed" skip: no approval can be hiding.
test('top-level try/catch: pulls.listReviews throws after the stale-approval check → clean skip', async () => {
  await withRoundsByType('docs:0', async () => {
    const core = makeCore();
    const { github, calls } = makeFakeGithub({ getPrImpl: getPrWithTitle('docs: x') });
    github.rest.pulls.listReviews = async () => {
      throw Object.assign(new Error('rate limit exceeded'), { status: 403 });
    };
    const result = await decide({ github, context: makeContext({ prOverrides: { title: 'docs: x' } }), core });
    assert.equal(result.decision, 'skip');
    assert.match(result.reason, /evaluation failed: 403 rate limit/);
    assert.equal(calls.createReview.length, 0);
  });
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
  // 2026-08 wording, observed live on testbed-multi-org/strspc-pr-review-testbed
  // PR#1 review 4999980534. GitHub replaced the phrase outright — the old
  // wording no longer appears at all, so matching only it reads every real
  // suppressed block as zero and auto-approves the PR.
  assert.equal(
    decide.countSuppressedComments('<summary>Suppressed comments (1)</summary>'),
    1,
  );
  assert.equal(
    decide.countSuppressedComments('<summary>Suppressed comments (4)</summary>'),
    4,
  );
  // The 2026-08 block subtitles the findings by *why* they were withheld, and
  // "previously missed" is not low confidence. The gate exists to catch
  // findings that listCommentsForReview hides, whatever the stated reason, so
  // this must still count.
  assert.equal(
    decide.countSuppressedComments(
      [
        '<details>',
        '<summary>Suppressed comments (1)</summary>',
        '',
        "**Previously missed (1)** — in code that hasn't changed since the last review.",
        '',
        '**src/stats.js:47**',
        '* interpolating userId into the path lets callers alter the route',
        '</details>',
      ].join('\n'),
    ),
    1,
  );
  // Wording drift tolerance: singular noun, odd casing, and a heading that
  // stops printing the count. These are summary headings, not bare phrases —
  // the bare phrase is deliberately not enough on its own (see below).
  assert.equal(
    decide.countSuppressedComments('<summary>Comment suppressed due to low confidence</summary>'),
    1,
  );
  assert.equal(
    decide.countSuppressedComments('<summary>SUPPRESSED COMMENTS (5)</summary>'),
    5,
  );
  assert.equal(decide.countSuppressedComments('<summary>Suppressed comment</summary>'), 1);
  // Second pass: a counted heading outside <summary>, so the gate survives
  // GitHub dropping <details>/<summary> rather than going silent.
  assert.equal(decide.countSuppressedComments('COMMENTS SUPPRESSED DUE TO LOW CONFIDENCE (3)'), 3);
  assert.equal(decide.countSuppressedComments('**Suppressed comments (2)**'), 2);
  assert.equal(decide.countSuppressedComments('### Suppressed comments (4)'), 4);

  // Ordinary prose must NOT count. Review bodies discuss their own diffs, so in
  // this repo especially the words show up as text. Counting those blocks a PR
  // that has no hidden findings at all.
  assert.equal(decide.countSuppressedComments('No suppressed comments were found'), 0);
  assert.equal(decide.countSuppressedComments('Copilot found no suppressed comments'), 0);
  assert.equal(decide.countSuppressedComments('a test for suppressed comment handling'), 0);
  // Counted prose mid-sentence: a count alone is not enough, the phrase has to
  // lead a line the way a heading does.
  assert.equal(decide.countSuppressedComments('No suppressed comments (3) were found'), 0);
  assert.equal(
    decide.countSuppressedComments('We assert Suppressed comments (5) is detected'),
    0,
  );
  // ...and it has to END the line too. A count on its own does not separate a
  // heading from a sentence that merely opens with the phrase.
  assert.equal(
    decide.countSuppressedComments('Suppressed comments (5) are documented below'),
    0,
  );

  // Fail-safe on the count itself: a block whose count is not a number is still
  // a block. Requiring digits would read it as no block at all — silence, which
  // is the failure direction that auto-approves hidden findings.
  assert.equal(decide.countSuppressedComments('<summary>Suppressed comments (N)</summary>'), 1);
  assert.equal(
    decide.countSuppressedComments('<summary>Suppressed comments (many)</summary>'),
    1,
  );
  assert.equal(decide.countSuppressedComments('**Suppressed comments (N)**'), 1);
  // ...and a heading stripped of BOTH its <details> wrapper and its count still
  // registers. The line anchors, not the count, are what exclude prose.
  assert.equal(decide.countSuppressedComments('**Suppressed comments**'), 1);
  assert.equal(
    decide.countSuppressedComments('Comments suppressed due to low confidence'),
    1,
  );

  // Fenced code is stripped before matching: Copilot quotes the offending lines
  // back, so a PR touching this very file must not trip its own gate.
  assert.equal(
    decide.countSuppressedComments(
      ['Here is the snippet under discussion:', '```', '<summary>Suppressed comments (9)</summary>', '```'].join('\n'),
    ),
    0,
  );
  // ...but a real block alongside a quoted one still counts, and reports the
  // REAL count rather than the quoted one.
  assert.equal(
    decide.countSuppressedComments(
      [
        '<details>',
        '<summary>Suppressed comments (1)</summary>',
        '',
        '```',
        '<summary>Suppressed comments (9)</summary>',
        '```',
        '</details>',
      ].join('\n'),
    ),
    1,
  );
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

// -- base-branch gate on payload events ---------------------------------------
// The template has no `branches:` filter (the set comes from a variable, which
// `on:` cannot read) and its job `if:` is only a substring pre-filter, so the
// action must enforce the exact set for pull_request_target/pull_request_review.

test('pull_request_target: PR base outside base-branch → skip, no approval', async () => {
  const core = makeCore();
  const { github, calls } = makeFakeGithub({});
  const result = await decide({
    github,
    context: makeContext({ prOverrides: { base: { ref: 'main' } } }), // env: develop
    core,
  });
  assert.equal(result.decision, 'skip');
  assert.equal(result.reason, "PR base ref 'main' not in [develop]");
  assert.equal(calls.createReview.length, 0);
});

test('pull_request_target: substring of a configured branch is not a match', async () => {
  // The caller's if: uses contains(), so 'dev' gets through it for 'develop'.
  const core = makeCore();
  const { github } = makeFakeGithub({});
  const result = await decide({
    github,
    context: makeContext({ prOverrides: { base: { ref: 'dev' } } }),
    core,
  });
  assert.equal(result.decision, 'skip');
  assert.equal(result.reason, "PR base ref 'dev' not in [develop]");
});

test('pull_request_target: PR without a base → skip rather than approve', async () => {
  const core = makeCore();
  const { github } = makeFakeGithub({});
  const result = await decide({
    github,
    context: makeContext({ prOverrides: { base: undefined } }),
    core,
  });
  assert.equal(result.decision, 'skip');
  assert.equal(result.reason, "PR base ref '' not in [develop]");
});

test('pull_request_target: base in a spaced multi-branch set is eligible', async () => {
  const core = makeCore();
  const original = process.env.AUTO_APPROVE_BASE_BRANCH;
  process.env.AUTO_APPROVE_BASE_BRANCH = 'develop, staging';
  try {
    const { github, calls } = makeFakeGithub({
      // The action re-reads the PR mid-evaluation; it must still target staging.
      getPrImpl: (pull_number) => ({
        data: {
          number: pull_number,
          draft: false,
          user: { login: 'someone' },
          head: { sha: 'deadbeef', repo: { full_name: 'axeptio/test-only-repo' } },
          base: { ref: 'staging' },
          html_url: `https://github.com/axeptio/test-only-repo/pull/${pull_number}`,
        },
      }),
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
    const result = await decide({
      github,
      context: makeContext({ prOverrides: { base: { ref: 'staging' } } }),
      core,
    });
    assert.equal(result.decision, 'approved', `got skip: ${result.reason}`);
    assert.equal(calls.createReview.length, 1);
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
  const { reviewSequence, ...rest } = opts;
  const { github, calls } = makeFakeGithub(rest);
  const state = { calls: 0, reviewCalls: 0 };
  github.rest.checks.listForRef = async () => {
    const runs = sequence[Math.min(state.calls, sequence.length - 1)];
    state.calls++;
    return { data: { total_count: runs.length, check_runs: runs } };
  };
  if (reviewSequence) {
    github.rest.pulls.listReviews = async () => {
      const rs = reviewSequence[Math.min(state.reviewCalls, reviewSequence.length - 1)];
      state.reviewCalls++;
      return { data: rs.map((r) => (r && !('commit_id' in r) ? { ...r, commit_id: 'deadbeef' } : r)) };
    };
  }
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

// Copilot no longer registers a check run on the head SHA, so the review
// itself is the only thing to wait for (strspc-pr-review#86).
test('wait on: Copilot review arriving on a later poll leads to approval', async () => {
  process.env.AUTO_APPROVE_COPILOT_WAIT_SECONDS = '30';
  process.env.AUTO_APPROVE_COPILOT_POLL_MS = '5';
  try {
    const core = makeCore();
    const { github, calls, state } = makePollingGithub([[CI_OK]], {
      reviewSequence: [[], [], [CLEAN_COPILOT_REVIEW]],
      reviewComments: { 1: [] },
    });
    const result = await decide({ github, context: makeContext(), core, sleep: realSleep });
    assert.equal(result.decision, 'approved', `got skip: ${result.reason}`);
    assert.equal(calls.createReview.length, 1);
    assert.ok(state.reviewCalls >= 3, `expected review polling, saw ${state.reviewCalls} fetches`);
  } finally {
    delete process.env.AUTO_APPROVE_COPILOT_WAIT_SECONDS;
    delete process.env.AUTO_APPROVE_COPILOT_POLL_MS;
  }
});

test('wait on: an errored review arriving during polling is named in the skip reason', async () => {
  process.env.AUTO_APPROVE_COPILOT_WAIT_SECONDS = '1';
  process.env.AUTO_APPROVE_COPILOT_POLL_MS = '400';
  try {
    const core = makeCore();
    const errored = {
      id: 9, state: 'COMMENTED', submitted_at: '2026-10-29T10:00:00Z', commit_id: 'deadbeef', user: COPILOT, body: ERRORED_BODY,
    };
    const { github, calls } = makePollingGithub([[CI_OK]], { reviewSequence: [[], [errored]] });
    const result = await decide({ github, context: makeContext(), core, sleep: realSleep });
    assert.equal(result.decision, 'skip');
    assert.match(result.reason, /no Copilot review yet.*errored/);
    assert.equal(calls.createReview.length, 0);
  } finally {
    delete process.env.AUTO_APPROVE_COPILOT_WAIT_SECONDS;
    delete process.env.AUTO_APPROVE_COPILOT_POLL_MS;
  }
});

test('wait on: Copilot review never arriving skips after the timeout, with a warning', async () => {
  process.env.AUTO_APPROVE_COPILOT_WAIT_SECONDS = '1';
  process.env.AUTO_APPROVE_COPILOT_POLL_MS = '400';
  try {
    const core = makeCore();
    const warnings = [];
    core.warning = (m) => warnings.push(m);
    const { github, state } = makePollingGithub([[CI_OK]], { reviewSequence: [[]] });
    const result = await decide({ github, context: makeContext(), core, sleep: realSleep });
    assert.equal(result.decision, 'skip');
    assert.match(result.reason, /no Copilot review yet/);
    assert.ok(state.reviewCalls > 1, 'should have polled the reviews before giving up');
    assert.ok(
      warnings.some((w) => /gave up waiting for a Copilot review of deadbeef/.test(w)),
      `expected a give-up warning, got: ${JSON.stringify(warnings)}`,
    );
  } finally {
    delete process.env.AUTO_APPROVE_COPILOT_WAIT_SECONDS;
    delete process.env.AUTO_APPROVE_COPILOT_POLL_MS;
  }
});

test('wait on: a stale Copilot review is re-polled until one names the head', async () => {
  process.env.AUTO_APPROVE_COPILOT_WAIT_SECONDS = '30';
  process.env.AUTO_APPROVE_COPILOT_POLL_MS = '5';
  try {
    const core = makeCore();
    const stale = { ...CLEAN_COPILOT_REVIEW, commit_id: 'cafebabe' };
    const fresh = { ...CLEAN_COPILOT_REVIEW, id: 2, submitted_at: '2026-04-16T10:05:00Z' };
    const { github, calls, state } = makePollingGithub([[CI_OK]], {
      reviewSequence: [[stale], [stale], [stale, fresh]],
      reviewComments: { 1: [], 2: [] },
    });
    const result = await decide({ github, context: makeContext(), core, sleep: realSleep });
    assert.equal(result.decision, 'approved', `got skip: ${result.reason}`);
    assert.equal(calls.createReview.length, 1);
    assert.ok(state.reviewCalls >= 3, `expected review polling, saw ${state.reviewCalls} fetches`);
  } finally {
    delete process.env.AUTO_APPROVE_COPILOT_WAIT_SECONDS;
    delete process.env.AUTO_APPROVE_COPILOT_POLL_MS;
  }
});

test('wait on: a check failing while polling for the review blocks approval', async () => {
  process.env.AUTO_APPROVE_COPILOT_WAIT_SECONDS = '30';
  process.env.AUTO_APPROVE_COPILOT_POLL_MS = '5';
  try {
    const core = makeCore();
    const { github, calls } = makePollingGithub(
      [[CI_OK], [{ ...CI_OK, conclusion: 'failure' }]],
      { reviewSequence: [[], [CLEAN_COPILOT_REVIEW]], reviewComments: { 1: [] } },
    );
    const result = await decide({ github, context: makeContext(), core, sleep: realSleep });
    assert.equal(result.decision, 'skip');
    assert.match(result.reason, /failing check: ci \(failure\)/);
    assert.equal(calls.createReview.length, 0, 'must not approve on stale CI results');
  } finally {
    delete process.env.AUTO_APPROVE_COPILOT_WAIT_SECONDS;
    delete process.env.AUTO_APPROVE_COPILOT_POLL_MS;
  }
});

test('wait on: a check going pending while polling for the review blocks approval', async () => {
  process.env.AUTO_APPROVE_COPILOT_WAIT_SECONDS = '30';
  process.env.AUTO_APPROVE_COPILOT_POLL_MS = '5';
  try {
    const core = makeCore();
    const { github, calls } = makePollingGithub(
      [[CI_OK], [CI_OK, { ...CI_OK, name: 'late-check', status: 'in_progress', conclusion: null }]],
      { reviewSequence: [[], [CLEAN_COPILOT_REVIEW]], reviewComments: { 1: [] } },
    );
    const result = await decide({ github, context: makeContext(), core, sleep: realSleep });
    assert.equal(result.decision, 'skip');
    assert.match(result.reason, /check still running: late-check/);
    assert.equal(calls.createReview.length, 0);
  } finally {
    delete process.env.AUTO_APPROVE_COPILOT_WAIT_SECONDS;
    delete process.env.AUTO_APPROVE_COPILOT_POLL_MS;
  }
});

test('wait on: check runs vanishing while polling for the review blocks approval', async () => {
  process.env.AUTO_APPROVE_COPILOT_WAIT_SECONDS = '30';
  process.env.AUTO_APPROVE_COPILOT_POLL_MS = '5';
  try {
    const core = makeCore();
    const { github, calls } = makePollingGithub(
      [[CI_OK], []],
      { reviewSequence: [[], [CLEAN_COPILOT_REVIEW]], reviewComments: { 1: [] } },
    );
    const result = await decide({ github, context: makeContext(), core, sleep: realSleep });
    assert.equal(result.decision, 'skip');
    assert.match(result.reason, /no checks on head SHA yet/);
    assert.equal(calls.createReview.length, 0);
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
  const cp = { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' };
  const { github } = makeFakeGithub({
    reviews: [{ id: 1, state: 'COMMENTED', submitted_at: '2026-04-15T08:00:00Z', user: cp }],
  });
  const err = new Error('Resource not accessible by personal access token');
  err.status = 403;
  err.request = { method: 'GET', url: 'https://api.github.com/repos/o/r/pulls/1/reviews/1/comments' };
  // The review-comments call, not the reviews one: listing the reviews fails
  // closed as an error (it is how a stale relaxed approval is found), and on a
  // pull_request event pulls.get is never called, so overriding it proves nothing.
  github.rest.pulls.listCommentsForReview = async () => { throw err; };

  const result = await decide({ github, context: makeContext(), core });

  assert.equal(result.decision, 'skip');
  assert.match(result.reason, /^evaluation failed: 403 GET \/repos\/o\/r\/pulls\/1\/reviews\/1\/comments /);
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

// -- Per-commit-type rounds (rounds-by-type) -------------------------------

test('parseCommitType: scope, breaking marker, case, non-conventional', () => {
  assert.equal(decide.parseCommitType('fix: x'), 'fix');
  assert.equal(decide.parseCommitType('feat(api)!: x'), 'feat');
  assert.equal(decide.parseCommitType('DOCS: x'), 'docs');
  assert.equal(decide.parseCommitType('  chore(deps): x'), 'chore');
  assert.equal(decide.parseCommitType('Update readme'), null);
  assert.equal(decide.parseCommitType(''), null);
  assert.equal(decide.parseCommitType(undefined), null);
});

test('parseRoundsByType: trims, lowercases, keeps 0, drops malformed entries', () => {
  const map = decide.parseRoundsByType(' Docs : 1, chore:0 ,bogus,fix:x,:2,default:3');
  assert.deepEqual([...map], [['docs', 1], ['chore', 0], ['default', 3]]);
  assert.equal(decide.parseRoundsByType('').size, 0);
});

test('resolveThreshold: type, default, then rounds-threshold fallback', () => {
  const env = { AUTO_APPROVE_ROUNDS_BY_TYPE: 'docs:1,default:2', AUTO_APPROVE_ROUNDS_THRESHOLD: '4' };
  assert.deepEqual(decide.resolveThreshold('docs: x', env), { threshold: 1, type: 'docs', defaultThreshold: 2, roundsThreshold: 4 });
  assert.deepEqual(decide.resolveThreshold('fix: x', env), { threshold: 2, type: 'fix', defaultThreshold: 2, roundsThreshold: 4 });
  assert.deepEqual(decide.resolveThreshold('no type', env), { threshold: 2, type: null, defaultThreshold: 2, roundsThreshold: 4 });
  const noDefault = { AUTO_APPROVE_ROUNDS_BY_TYPE: 'docs:1', AUTO_APPROVE_ROUNDS_THRESHOLD: '4' };
  assert.deepEqual(decide.resolveThreshold('fix: x', noDefault), { threshold: 4, type: 'fix', defaultThreshold: 4, roundsThreshold: 4 });
  assert.equal(decide.resolveThreshold('docs: x', noDefault).defaultThreshold, 4);
  assert.equal(decide.resolveThreshold('fix: x', {}).threshold, 3);
});

// pulls.get answering with the same title the event carried, as GitHub would.
function getPrWithTitle(title, sha = 'deadbeef') {
  return (num) => ({
    data: {
      number: num, draft: false, title, user: { login: 'someone' }, base: { ref: 'develop' },
      head: { sha, repo: { full_name: 'axeptio/test-only-repo' } },
    },
  });
}

async function withRoundsByType(value, fn) {
  const original = process.env.AUTO_APPROVE_ROUNDS_BY_TYPE;
  process.env.AUTO_APPROVE_ROUNDS_BY_TYPE = value;
  try {
    return await fn();
  } finally {
    if (original === undefined) delete process.env.AUTO_APPROVE_ROUNDS_BY_TYPE;
    else process.env.AUTO_APPROVE_ROUNDS_BY_TYPE = original;
  }
}

test('rounds-by-type: docs threshold 1 approves after a single commented review', async () => {
  await withRoundsByType('docs:1', async () => {
    const core = makeCore();
    const cp = { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' };
    const { github, calls } = makeFakeGithub({
      reviews: [{ id: 1, state: 'COMMENTED', submitted_at: '2026-04-15T08:00:00Z', user: cp }],
      getPrImpl: getPrWithTitle('docs: fix typo'),
    });
    const result = await decide({
      github, core, context: makeContext({ prOverrides: { title: 'docs: fix typo' } }),
    });
    assert.equal(result.decision, 'approved');
    assert.match(result.reason, /1-rounds \(1 Copilot reviews\)/);
    assert.equal(calls.createReview.length, 1);
  });
});

test('rounds-by-type: unmapped type keeps the global threshold', async () => {
  await withRoundsByType('docs:1', async () => {
    const core = makeCore();
    const cp = { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' };
    const { github } = makeFakeGithub({
      reviews: [{ id: 1, state: 'COMMENTED', submitted_at: '2026-04-15T08:00:00Z', user: cp }],
      reviewComments: { 1: [{ id: 10 }] },
    });
    const result = await decide({
      github, core, context: makeContext({ prOverrides: { title: 'fix: a bug' } }),
    });
    assert.equal(result.decision, 'skip');
    assert.match(result.reason, /1 comments/);
  });
});

test('rounds-by-type: threshold 0 approves with no Copilot review once CI is green', async () => {
  await withRoundsByType('chore:0', async () => {
    const core = makeCore();
    const { github, calls } = makeFakeGithub({
      reviews: [], getPrImpl: getPrWithTitle('chore(deps): bump x'),
    });
    const result = await decide({
      github, core, context: makeContext({ prOverrides: { title: 'chore(deps): bump x' } }),
    });
    assert.equal(result.decision, 'approved');
    assert.match(result.reason, /copilot-optional \(type chore/);
    assert.match(calls.createReview[0].body, /pr-auto-approve:threshold=0/);
    assert.equal(calls.createReview.length, 1);
  });
});

test('rounds-by-type: threshold 0 still requires green CI', async () => {
  await withRoundsByType('chore:0', async () => {
    const core = makeCore();
    const { github, calls } = makeFakeGithub({
      checkRuns: [{ ...DEFAULT_CHECK_RUNS[0], conclusion: 'failure' }],
    });
    const result = await decide({
      github, core, context: makeContext({ prOverrides: { title: 'chore: x' } }),
    });
    assert.equal(result.decision, 'skip');
    assert.match(result.reason, /failing check/);
    assert.equal(calls.createReview.length, 0);
  });
});

test('rounds-by-type: threshold 0 is blocked by a Copilot CHANGES_REQUESTED review', async () => {
  await withRoundsByType('chore:0', async () => {
    const core = makeCore();
    const cp = { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' };
    const { github, calls } = makeFakeGithub({
      reviews: [{ id: 1, state: 'CHANGES_REQUESTED', submitted_at: '2026-04-15T08:00:00Z', user: cp }],
    });
    const result = await decide({
      github, core, context: makeContext({ prOverrides: { title: 'chore: x' } }),
    });
    assert.equal(result.decision, 'skip');
    assert.match(result.reason, /requested changes/);
    assert.equal(calls.createReview.length, 0);
  });
});

test('filesMatchPaths: globs, nesting, empty list', () => {
  const g = ['**/*.md', 'docs/**'];
  assert.equal(decide.filesMatchPaths(['README.md', 'a/b/c.md', 'docs/x/y.png'], g), true);
  assert.equal(decide.filesMatchPaths(['README.md', 'src/a.js'], g), false);
  assert.equal(decide.filesMatchPaths(['a.mdx'], g), false);
  assert.equal(decide.filesMatchPaths([], g), false);
});

test('default copilot-optional-paths admits Markdown only, matching action.yml', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const actionYml = fs.readFileSync(path.join(__dirname, '..', '..', 'action.yml'), 'utf8');
  const declared = /copilot-optional-paths:\n(?:.*\n)*?\s+default: '([^']*)'/.exec(actionYml);
  assert.ok(declared, 'action.yml declares a copilot-optional-paths default');
  assert.equal(declared[1], decide.getOptionalPaths({}).join(','));
  const g = decide.getOptionalPaths({});
  assert.deepEqual(g, ['**/*.md', 'docs/**/*.md']);
  const cases = [
    { files: ['README.md', 'docs/guide.md', 'docs/a/b/c.md'], ok: true },
    { files: ['docs/build.js'], ok: false },
    { files: ['docs/index.html'], ok: false },
    { files: ['docs/x/y.png'], ok: false },
    { files: ['docs/README.MD'], ok: false },
    { files: ['docs/notes.md', 'docs/gen.py'], ok: false },
  ];
  for (const c of cases) {
    assert.equal(decide.filesMatchPaths(c.files, g), c.ok, c.files.join(','));
  }
  // A caller's explicit value is used as given.
  assert.deepEqual(decide.getOptionalPaths({ AUTO_APPROVE_COPILOT_OPTIONAL_PATHS: ' docs/** , *.txt ' }), ['docs/**', '*.txt']);
});

test('rounds-by-type: threshold 0 ignored when the PR touches code', async () => {
  await withRoundsByType('docs:0', async () => {
    const core = makeCore();
    const { github, calls } = makeFakeGithub({ reviews: [], changedFiles: ['README.md', 'src/a.js'] });
    const result = await decide({
      github, core, context: makeContext({ prOverrides: { title: 'docs: sneaky' } }),
    });
    assert.equal(result.decision, 'skip');
    assert.match(result.reason, /no Copilot review yet/);
    assert.equal(calls.createReview.length, 0);
  });
});

// A type mapped BELOW the default is relaxed by the title alone, and the title
// is the author's. The path gate that always covered 0 covers every relaxed
// type: outside copilot-optional-paths the default rules apply.
test('rounds-by-type: a relaxed type (docs:1) is honoured only for a docs-only diff', async () => {
  await withRoundsByType('docs:1,default:3', async () => {
    const cp = { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' };
    const reviews = [{ id: 1, state: 'COMMENTED', submitted_at: '2026-04-15T08:00:00Z', user: cp }];
    const cases = [
      { changedFiles: ['README.md', 'docs/guide.md'], decision: 'approved', reason: /^1-rounds \(1 Copilot reviews\)$/ },
      { changedFiles: ['README.md', 'src/a.js'], decision: 'skip',
        reason: /^latest Copilot review has 1 comments; type 'docs' is relaxed to 1 round\(s\) but the PR touches files outside copilot-optional-paths, so the default 3 applies$/ },
    ];
    for (const c of cases) {
      const core = makeCore();
      const { github, calls } = makeFakeGithub({
        reviews, reviewComments: { 1: [{ id: 10 }] }, changedFiles: c.changedFiles,
        getPrImpl: getPrWithTitle('docs: x'),
      });
      const result = await decide({ github, core, context: makeContext({ prOverrides: { title: 'docs: x' } }) });
      assert.equal(result.decision, c.decision, `${c.changedFiles}: ${result.reason}`);
      assert.match(result.reason, c.reason);
      assert.equal(core.outputs.reason, result.reason);
      assert.equal(calls.createReview.length, c.decision === 'approved' ? 1 : 0);
    }
  });
});

test('rounds-by-type: the path gate falls back to the default entry, not rounds-threshold', async () => {
  // rounds-threshold is 3 (module env); default:2 must win, exactly as for a `fix:` PR.
  await withRoundsByType('docs:0,default:2', async () => {
    const core = makeCore();
    const cp = { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' };
    const { github, calls } = makeFakeGithub({
      reviews: [1, 2].map((id) => ({ id, state: 'COMMENTED', submitted_at: `2026-04-15T0${id}:00:00Z`, user: cp })),
      reviewComments: { 1: [{ id: 10 }], 2: [{ id: 11 }] },
      changedFiles: ['README.md', 'src/a.js'],
      getPrImpl: getPrWithTitle('docs: x'),
    });
    const result = await decide({ github, core, context: makeContext({ prOverrides: { title: 'docs: x' } }) });
    assert.equal(result.decision, 'approved', result.reason);
    assert.match(result.reason, /^2-rounds \(2 Copilot reviews\); type 'docs' is relaxed to 0 round\(s\) .* the default 2 applies$/);
    // The approval body stays a plain reason; the stamp records the threshold actually used.
    assert.equal(calls.createReview[0].body, 'Auto-approved: 2-rounds (2 Copilot reviews).\n\n<!-- pr-auto-approve:threshold=2 -->');
  });
});

test('rounds-by-type: a type at or above the default never lists the changed files', async () => {
  await withRoundsByType('docs:1,fix:5,default:3', async () => {
    const cp = { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' };
    for (const title of ['fix: above', 'feat: at default', 'no type at all']) {
      const core = makeCore();
      const { github } = makeFakeGithub({
        reviews: [{ id: 1, state: 'COMMENTED', submitted_at: '2026-04-15T08:00:00Z', user: cp }],
        getPrImpl: getPrWithTitle(title),
      });
      github.rest.repos.compareCommitsWithBasehead = async () => { throw new Error(`listed files for ${title}`); };
      const result = await decide({ github, core, context: makeContext({ prOverrides: { title } }) });
      assert.equal(result.decision, 'approved', result.reason);
      assert.doesNotMatch(result.reason, /relaxed/);
    }
  });
});

// 0 is relaxed even when it IS the default: `default:0` must not waive Copilot
// for a code change, so it falls back to rounds-threshold exactly as 0 always did.
test('rounds-by-type: default:0 is still path-gated and falls back to rounds-threshold', async () => {
  await withRoundsByType('chore:0,default:0', async () => {
    const cases = [
      { title: 'fix: code', changedFiles: ['src/a.js'], decision: 'skip',
        reason: /^no Copilot review yet; type 'fix' is relaxed to 0 round\(s\) .* the default 3 applies$/ },
      { title: 'Update the thing', changedFiles: ['src/a.js'], decision: 'skip',
        reason: /^no Copilot review yet; type 'none' is relaxed to 0 round\(s\)/ },
      { title: 'fix: docs', changedFiles: ['README.md'], decision: 'approved', reason: /^copilot-optional \(type fix, rounds-by-type 0\)$/ },
    ];
    for (const c of cases) {
      const core = makeCore();
      const { github, calls } = makeFakeGithub({
        reviews: [], changedFiles: c.changedFiles, getPrImpl: getPrWithTitle(c.title),
      });
      const result = await decide({ github, core, context: makeContext({ prOverrides: { title: c.title } }) });
      assert.equal(result.decision, c.decision, `${c.title}: ${result.reason}`);
      assert.match(result.reason, c.reason);
      assert.equal(calls.createReview.length, c.decision === 'approved' ? 1 : 0);
    }
  });
});

test('rounds-by-type: 0 under rounds-threshold 1 with no default entry is still gated', async () => {
  const original = process.env.AUTO_APPROVE_ROUNDS_THRESHOLD;
  process.env.AUTO_APPROVE_ROUNDS_THRESHOLD = '1';
  try {
    await withRoundsByType('docs:0', async () => {
      const core = makeCore();
      const { github, calls } = makeFakeGithub({
        reviews: [], changedFiles: ['README.md', 'src/a.js'], getPrImpl: getPrWithTitle('docs: x'),
      });
      const result = await decide({ github, core, context: makeContext({ prOverrides: { title: 'docs: x' } }) });
      assert.equal(result.decision, 'skip');
      assert.match(result.reason, /^no Copilot review yet; type 'docs' is relaxed to 0 round\(s\) .* the default 1 applies$/);
      assert.equal(calls.createReview.length, 0);
    });
  } finally {
    process.env.AUTO_APPROVE_ROUNDS_THRESHOLD = original;
  }
});

test('a docs:1 approval of a docs-only diff is withdrawn once the PR touches code', async () => {
  await withRoundsByType('docs:1,default:3', async () => {
    const core = makeCore();
    const cp = { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' };
    const reviews = [
      { id: 1, state: 'COMMENTED', submitted_at: '2026-04-15T07:00:00Z', user: cp },
      { id: 77, state: 'APPROVED', submitted_at: '2026-04-15T08:00:00Z', user: { login: 'axeptio-bot' },
        body: 'Auto-approved: 1-rounds (1 Copilot reviews).\n\n<!-- pr-auto-approve:threshold=1 -->' },
    ];
    const { github, calls } = makeFakeGithub({
      reviewDecision: 'APPROVED', reviews, changedFiles: ['README.md', 'src/a.js'],
      reviewComments: { 1: [{ id: 10 }] }, getPrImpl: getPrWithTitle('docs: still says docs'),
    });
    const dismissed = [];
    github.rest.pulls.dismissReview = async (a) => { dismissed.push(a); reviews[1].state = 'DISMISSED'; return { data: {} }; };
    const result = await decide({ github, core, context: makeContext({ prOverrides: { title: 'docs: still says docs' } }) });
    assert.equal(dismissed.length, 1);
    assert.equal(dismissed[0].review_id, 77);
    assert.match(dismissed[0].message, /^Withdrawn: the PR \(type docs\) touches files outside copilot-optional-paths and needs 3 Copilot review round\(s\)\.$/);
    assert.equal(result.decision, 'skip');
    assert.match(result.reason, /^latest Copilot review has 1 comments; type 'docs' is relaxed/);
    assert.equal(calls.createReview.length, 0);
  });
});

test('rounds-by-type: threshold 0 aborts when the head moved during evaluation', async () => {
  await withRoundsByType('docs:0', async () => {
    const core = makeCore();
    const { github, calls } = makeFakeGithub({
      reviews: [],
      getPrImpl: (num) => ({
        data: {
          number: num, draft: false, user: { login: 'someone' }, base: { ref: 'develop' },
          head: { sha: 'cafef00d', repo: { full_name: 'axeptio/test-only-repo' } },
        },
      }),
    });
    const result = await decide({
      github, core, context: makeContext({ prOverrides: { title: 'docs: x' } }),
    });
    assert.equal(result.decision, 'skip');
    assert.match(result.reason, /head moved/);
    assert.equal(calls.createReview.length, 0);
  });
});

// The listing names the SHA under evaluation, so an A -> B -> A force-push
// between the listing and the pre-approval head re-read cannot hand the gate
// a different diff than the one approved.
test('the changed-files listing is pinned to the evaluated head SHA', async () => {
  await withRoundsByType('docs:0', async () => {
    const core = makeCore();
    const { github, calls } = makeFakeGithub({ reviews: [], getPrImpl: getPrWithTitle('docs: x') });
    const result = await decide({ github, core, context: makeContext({ prOverrides: { title: 'docs: x' } }) });
    assert.equal(result.decision, 'approved', result.reason);
    // Once for the gate, then once before and once after approving to prove the
    // merge base (hence the diff) did not move.
    assert.equal(calls.compare.length, 3);
    for (const c of calls.compare) {
      assert.equal(c.basehead, 'heads/develop...deadbeef');
      assert.equal(c.owner, 'axeptio');
      assert.equal(c.repo, 'test-only-repo');
    }
  });
});

test('a relaxed type that fell back to the default re-checks nothing: the approval does not rest on the diff', async () => {
  await withRoundsByType('docs:1,default:3', async () => {
    const core = makeCore();
    const cp = { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' };
    const { github, calls } = makeFakeGithub({
      reviews: [1, 2, 3].map((id) => ({ id, state: 'COMMENTED', submitted_at: `2026-04-15T0${id}:00:00Z`, user: cp })),
      changedFiles: ['README.md', 'src/a.js'], getPrImpl: getPrWithTitle('docs: x'),
    });
    const result = await decide({ github, core, context: makeContext({ prOverrides: { title: 'docs: x' } }) });
    assert.equal(result.decision, 'approved', result.reason);
    assert.match(result.reason, /^3-rounds \(3 Copilot reviews\); type 'docs' is relaxed/);
    assert.equal(calls.compare.length, 1);
  });
});

// A force-push of the base branch keeps base.ref and head.sha intact but can
// change the merge base, i.e. the diff the gate judged. Catch it both sides of
// the approval; a base that merely moved on keeps its merge base and passes.
test('base branch rewritten before approving: the relaxed approval is skipped', async () => {
  await withRoundsByType('docs:0', async () => {
    const core = makeCore();
    const { github, calls } = makeFakeGithub({ reviews: [], getPrImpl: getPrWithTitle('docs: x') });
    let compares = 0;
    github.rest.repos.compareCommitsWithBasehead = async () => ({
      data: { merge_base_commit: { sha: compares++ === 0 ? 'mb000001' : 'mb000002' }, files: [{ filename: 'README.md' }] },
    });
    const result = await decide({ github, core, context: makeContext({ prOverrides: { title: 'docs: x' } }) });
    assert.equal(result.decision, 'skip');
    assert.equal(result.reason, 'base develop was rewritten (merge base mb000001 -> mb000002) during evaluation; the next run re-evaluates the diff');
    assert.equal(calls.createReview.length, 0);
  });
});

test('base branch rewritten while approving: the relaxed approval is withdrawn', async () => {
  await withRoundsByType('docs:0', async () => {
    const core = makeCore();
    const { github, calls } = makeFakeGithub({ reviews: [], getPrImpl: getPrWithTitle('docs: x') });
    let compares = 0;
    github.rest.repos.compareCommitsWithBasehead = async () => ({
      data: { merge_base_commit: { sha: compares++ < 2 ? 'mb000001' : 'mb000002' }, files: [{ filename: 'README.md' }] },
    });
    const dismissed = [];
    github.rest.pulls.dismissReview = async (a) => { dismissed.push(a); return { data: {} }; };
    const result = await decide({ github, core, context: makeContext({ prOverrides: { title: 'docs: x' } }) });
    assert.equal(calls.createReview.length, 1);
    assert.equal(result.decision, 'skip');
    assert.equal(result.reason, 'base develop was rewritten (merge base mb000001 -> mb000002) while approving; approval withdrawn');
    assert.equal(dismissed[0].review_id, 999);
    assert.equal(dismissed[0].message, 'Withdrawn: base develop was rewritten (merge base mb000001 -> mb000002) while approving.');
  });
});

test('a comparison with no merge base cannot be re-verified, so the relaxation is not granted', async () => {
  await withRoundsByType('docs:0', async () => {
    const core = makeCore();
    const { github, calls } = makeFakeGithub({ reviews: [] });
    github.rest.repos.compareCommitsWithBasehead = async () => ({ data: { files: [{ filename: 'README.md' }] } });
    const result = await decide({ github, core, context: makeContext({ prOverrides: { title: 'docs: x' } }) });
    assert.equal(result.decision, 'skip');
    assert.equal(result.reason, "no Copilot review yet; type 'docs' is relaxed to 0 round(s) but the comparison reported no merge base, so the diff cannot be re-verified and the default 3 applies");
    assert.equal(calls.createReview.length, 0);
  });
});

// The gate runs before the stale-approval withdrawal, so a failed file listing
// used to leave an earlier relaxed approval standing behind an "evaluation
// failed" skip. Withdraw first, then report the failure.
test('a failed file listing withdraws every stamped bot approval before skipping', async () => {
  await withRoundsByType('docs:0', async () => {
    const core = makeCore();
    const reviews = [
      { id: 70, state: 'APPROVED', submitted_at: '2026-04-15T07:00:00Z', user: { login: 'axeptio-bot' },
        body: 'Auto-approved: copilot-clean (review 1, state=COMMENTED).' },
      { id: 71, state: 'APPROVED', submitted_at: '2026-04-15T08:00:00Z', user: { login: 'axeptio-bot' },
        body: 'Auto-approved: copilot-optional.\n\n<!-- pr-auto-approve:threshold=0 -->' },
      { id: 72, state: 'APPROVED', submitted_at: '2026-04-15T09:00:00Z', user: { login: 'axeptio-bot' },
        body: 'Auto-approved: 1-rounds (1 Copilot reviews).\n\n<!-- pr-auto-approve:threshold=1 -->' },
      { id: 73, state: 'APPROVED', submitted_at: '2026-04-15T10:00:00Z', user: { login: 'someone-else' },
        body: '<!-- pr-auto-approve:threshold=0 -->' },
    ];
    const { github, calls } = makeFakeGithub({ reviews });
    github.rest.repos.compareCommitsWithBasehead = async () => {
      throw Object.assign(new Error('Resource not accessible by integration'), {
        status: 403,
        request: { method: 'GET', url: 'https://api.github.com/repos/axeptio/test-only-repo/compare/heads%2Fdevelop...deadbeef' },
      });
    };
    const dismissed = [];
    github.rest.pulls.dismissReview = async (a) => { dismissed.push(a); return { data: {} }; };
    const result = await decide({ github, core, context: makeContext({ prOverrides: { title: 'docs: x' } }) });
    // Only the bot's STAMPED approvals: the clean one holds under any threshold,
    // and another user's review is not ours to dismiss.
    assert.deepEqual(dismissed.map((d) => d.review_id), [71, 72]);
    assert.equal(dismissed[0].message, 'Withdrawn: the changed files of deadbeef could not be listed (403 Resource not accessible by integration), so a relaxed approval cannot be verified.');
    assert.equal(result.decision, 'skip');
    assert.match(result.reason, /^evaluation failed: 403 GET \/repos\/axeptio\/test-only-repo\/compare\/heads%2Fdevelop\.\.\.deadbeef Resource not accessible/);
    assert.equal(calls.createReview.length, 0);
  });
});

test('a failed file listing followed by a failed review listing is an error, not a skip', async () => {
  await withRoundsByType('docs:0', async () => {
    const core = makeCore();
    const failures = [];
    core.setFailed = (m) => failures.push(m);
    const { github, calls } = makeFakeGithub();
    github.rest.repos.compareCommitsWithBasehead = async () => { throw Object.assign(new Error('Not Found'), { status: 404 }); };
    github.rest.pulls.listReviews = async () => { throw Object.assign(new Error('Server Error'), { status: 500 }); };
    const result = await decide({ github, core, context: makeContext({ prOverrides: { title: 'docs: x' } }) });
    assert.equal(result.decision, 'error');
    assert.equal(result.reason, "could not list the PR's reviews, so an earlier approval stamped with a relaxed rounds-by-type threshold cannot be found and withdrawn: 500 Server Error");
    assert.equal(failures.length, 1);
    assert.equal(calls.createReview.length, 0);
  });
});

test('a failed file listing whose withdrawal also fails is an error, not a skip', async () => {
  await withRoundsByType('docs:0', async () => {
    const core = makeCore();
    const failures = [];
    core.setFailed = (m) => failures.push(m);
    const { github } = makeFakeGithub({
      reviews: [{ id: 71, state: 'APPROVED', submitted_at: '2026-04-15T08:00:00Z', user: { login: 'axeptio-bot' },
        body: 'x\n\n<!-- pr-auto-approve:threshold=0 -->' }],
    });
    github.rest.repos.compareCommitsWithBasehead = async () => { throw Object.assign(new Error('Not Found'), { status: 404 }); };
    github.rest.pulls.dismissReview = async () => { throw Object.assign(new Error('boom'), { status: 500 }); };
    const result = await decide({ github, core, context: makeContext({ prOverrides: { title: 'docs: x' } }) });
    assert.equal(result.decision, 'error');
    assert.match(result.reason, /^could not withdraw the stale approval \(review 71\): 500 boom$/);
    assert.equal(failures.length, 1);
  });
});

// The path gate compared headSha against the event's base branch. A retarget
// mid-run changes that diff, so it is re-read next to the head and the title.
test('PR retargeted mid-run: approval is skipped, not granted against the old base', async () => {
  await withRoundsByType('docs:0', async () => {
    const core = makeCore();
    const { github, calls } = makeFakeGithub({
      reviews: [],
      getPrImpl: (num) => {
        const { data } = getPrWithTitle('docs: x')(num);
        return { data: { ...data, base: { ref: 'main' } } };
      },
    });
    const result = await decide({ github, core, context: makeContext({ prOverrides: { title: 'docs: x' } }) });
    assert.equal(result.decision, 'skip');
    assert.equal(result.reason, 'PR base changed from develop to main during evaluation');
    assert.equal(calls.createReview.length, 0);
  });
});

// The event snapshot said ready for review; a conversion to draft after that has
// to stop the approval the same way a push or a retarget does.
test('PR converted to draft mid-run: approval is skipped', async () => {
  await withRoundsByType('docs:0', async () => {
    const core = makeCore();
    const { github, calls } = makeFakeGithub({
      reviews: [],
      getPrImpl: (num) => {
        const { data } = getPrWithTitle('docs: x')(num);
        return { data: { ...data, draft: true } };
      },
    });
    const result = await decide({ github, core, context: makeContext({ prOverrides: { title: 'docs: x' } }) });
    assert.equal(result.decision, 'skip');
    assert.equal(result.reason, 'PR converted to draft during evaluation');
    assert.equal(calls.createReview.length, 0);
  });
});

test('approval is withdrawn if the PR is converted to draft right after it is posted', async () => {
  const core = makeCore();
  const cp = { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' };
  let gets = 0;
  const { github } = makeFakeGithub({
    reviews: [1, 2, 3].map((id) => ({ id, state: 'COMMENTED', submitted_at: `2026-04-15T0${id}:00:00Z`, user: cp })),
    getPrImpl: (num) => {
      const { data } = getPrWithTitle('docs: x')(num);
      return { data: { ...data, draft: gets++ !== 0 } };
    },
  });
  const dismissed = [];
  github.rest.pulls.dismissReview = async (a) => { dismissed.push(a); return { data: {} }; };
  const result = await decide({ github, core, context: makeContext({ prOverrides: { title: 'docs: x' } }) });
  assert.equal(result.decision, 'skip');
  assert.equal(result.reason, 'PR head, base, title or draft state changed while approving; approval withdrawn');
  assert.equal(dismissed[0].review_id, 999);
});

test('approval is withdrawn if the base changes right after it is posted', async () => {
  const core = makeCore();
  const cp = { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' };
  let gets = 0;
  const { github } = makeFakeGithub({
    reviews: [1, 2, 3].map((id) => ({ id, state: 'COMMENTED', submitted_at: `2026-04-15T0${id}:00:00Z`, user: cp })),
    getPrImpl: (num) => {
      const { data } = getPrWithTitle('docs: x')(num);
      return { data: { ...data, base: { ref: gets++ === 0 ? 'develop' : 'main' } } };
    },
  });
  const dismissed = [];
  github.rest.pulls.dismissReview = async (a) => { dismissed.push(a); return { data: {} }; };
  const result = await decide({ github, core, context: makeContext({ prOverrides: { title: 'docs: x' } }) });
  assert.equal(result.decision, 'skip');
  assert.equal(result.reason, 'PR head, base, title or draft state changed while approving; approval withdrawn');
  assert.equal(dismissed[0].review_id, 999);
  assert.match(dismissed[0].message, /^Withdrawn: PR head, base, title or draft state changed while approving\.$/);
});

test('a head SHA the compare endpoint no longer knows is a clean skip that names the request', async () => {
  await withRoundsByType('docs:0', async () => {
    const core = makeCore();
    const { github, calls } = makeFakeGithub({ reviews: [] });
    github.rest.repos.compareCommitsWithBasehead = async () => {
      throw Object.assign(new Error('Not Found'), {
        status: 404,
        request: { method: 'GET', url: 'https://api.github.com/repos/axeptio/test-only-repo/compare/develop...deadbeef' },
      });
    };
    const result = await decide({ github, core, context: makeContext({ prOverrides: { title: 'docs: x' } }) });
    assert.equal(result.decision, 'skip');
    assert.match(result.reason, /^evaluation failed: 404 GET \/repos\/axeptio\/test-only-repo\/compare\/develop\.\.\.deadbeef Not Found$/);
    assert.equal(calls.createReview.length, 0);
  });
});

test('a compare response without a files array is treated as an empty (unprovable) list', async () => {
  await withRoundsByType('docs:0', async () => {
    const core = makeCore();
    const { github, calls } = makeFakeGithub({ reviews: [] });
    github.rest.repos.compareCommitsWithBasehead = async () => ({ data: { status: 'identical' } });
    const result = await decide({ github, core, context: makeContext({ prOverrides: { title: 'docs: x' } }) });
    assert.equal(result.decision, 'skip');
    assert.match(result.reason, /^no Copilot review yet; type 'docs' is relaxed/);
    assert.equal(calls.createReview.length, 0);
  });
});

test('approval is pinned to the evaluated head commit', async () => {
  const core = makeCore();
  const cp = { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' };
  const { github, calls } = makeFakeGithub({
    reviews: [
      { id: 1, state: 'COMMENTED', submitted_at: '2026-04-15T08:00:00Z', user: cp },
      { id: 2, state: 'COMMENTED', submitted_at: '2026-04-15T09:00:00Z', user: cp },
      { id: 3, state: 'COMMENTED', submitted_at: '2026-04-15T10:00:00Z', user: cp },
    ],
  });
  await decide({ github, core, context: makeContext() });
  assert.equal(calls.createReview[0].commit_id, 'deadbeef');
});

test('parseRoundsByType: rejects entries with extra fields', () => {
  const map = decide.parseRoundsByType('docs:0:oops,chore:1');
  assert.deepEqual([...map], [['chore', 1]]);
});

test('changedFileNames: a list at the 300-file compare cap cannot prove docs-only', () => {
  const big = Array.from({ length: 300 }, (_, i) => ({ filename: `docs/${i}.md` }));
  assert.equal(decide.changedFileNames(big), null);
  assert.equal(decide.filesMatchPaths(decide.changedFileNames(big), ['docs/**']), false);
  assert.deepEqual(decide.changedFileNames([{ filename: 'b.md', previous_filename: 'a.md' }]), ['b.md', 'a.md']);
});

test('title edited mid-run: approval is skipped, not granted under the old type', async () => {
  const cp = { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' };
  await withRoundsByType('docs:1', async () => {
    const core = makeCore();
    const { github, calls } = makeFakeGithub({
      reviews: [{ id: 1, state: 'COMMENTED', submitted_at: '2026-04-15T08:00:00Z', user: cp }],
      getPrImpl: getPrWithTitle('fix: now a fix'),
    });
    const result = await decide({
      github, core, context: makeContext({ prOverrides: { title: 'docs: x' } }),
    });
    assert.equal(result.decision, 'skip');
    assert.match(result.reason, /title changed/);
    assert.equal(calls.createReview.length, 0);
  });
});

test('retitled to a stricter type: the earlier no-Copilot approval is withdrawn', async () => {
  await withRoundsByType('docs:0', async () => {
    const core = makeCore();
    const reviews = [{
      id: 77, state: 'APPROVED', submitted_at: '2026-04-15T08:00:00Z',
      user: { login: 'axeptio-bot' },
      body: 'Auto-approved: copilot-optional.\n\n<!-- pr-auto-approve:threshold=0 -->',
    }];
    const { github, calls } = makeFakeGithub({
      reviewDecision: 'APPROVED',
      reviews,
      getPrImpl: getPrWithTitle('fix: really code'),
    });
    const dismissed = [];
    github.rest.pulls.dismissReview = async (a) => {
      dismissed.push(a);
      reviews[0].state = 'DISMISSED';
      return { data: {} };
    };
    const result = await decide({
      github, core, context: makeContext({ prOverrides: { title: 'fix: really code' } }),
    });
    assert.equal(dismissed.length, 1);
    assert.equal(dismissed[0].review_id, 77);
    // Re-evaluated under the fix rules: no Copilot review yet, so no new approval.
    assert.equal(result.decision, 'skip');
    assert.match(result.reason, /no Copilot review yet/);
    assert.equal(calls.createReview.length, 0);
  });
});

test('an ordinary bot approval (no marker) is never withdrawn', async () => {
  const core = makeCore();
  const { github } = makeFakeGithub({
    reviewDecision: 'APPROVED',
    reviews: [{ id: 5, state: 'APPROVED', submitted_at: '2026-04-15T08:00:00Z', user: { login: 'axeptio-bot' }, body: 'Auto-approved: copilot-clean.' }],
  });
  github.rest.pulls.dismissReview = async () => { throw new Error('must not dismiss'); };
  const result = await decide({ github, core, context: makeContext() });
  assert.equal(result.decision, 'skip');
  assert.match(result.reason, /already approved/);
});

const MARKED_APPROVAL = () => [{
  id: 77, state: 'APPROVED', submitted_at: '2026-04-15T08:00:00Z',
  user: { login: 'axeptio-bot' },
  body: 'Auto-approved: copilot-optional.\n\n<!-- pr-auto-approve:threshold=0 -->',
}];

test('stale no-Copilot approval is withdrawn even when CI is failing', async () => {
  await withRoundsByType('docs:0', async () => {
    const core = makeCore();
    const reviews = MARKED_APPROVAL();
    const { github } = makeFakeGithub({
      reviews,
      checkRuns: [{ ...DEFAULT_CHECK_RUNS[0], conclusion: 'failure' }],
      getPrImpl: getPrWithTitle('fix: code'),
    });
    const dismissed = [];
    github.rest.pulls.dismissReview = async (a) => { dismissed.push(a); return { data: {} }; };
    const result = await decide({ github, core, context: makeContext({ prOverrides: { title: 'fix: code' } }) });
    assert.equal(dismissed.length, 1);
    assert.match(result.reason, /failing check/);
  });
});

test('withdrawal failure fails closed with an error decision', async () => {
  await withRoundsByType('docs:0', async () => {
    const core = makeCore();
    const failures = [];
    core.setFailed = (m) => failures.push(m);
    const { github, calls } = makeFakeGithub({ reviews: MARKED_APPROVAL(), getPrImpl: getPrWithTitle('fix: code') });
    github.rest.pulls.dismissReview = async () => { throw Object.assign(new Error('forbidden'), { status: 403 }); };
    const result = await decide({ github, core, context: makeContext({ prOverrides: { title: 'fix: code' } }) });
    assert.equal(result.decision, 'error');
    assert.match(result.reason, /could not withdraw/);
    assert.equal(failures.length, 1);
    assert.equal(calls.createReview.length, 0);
  });
});

test('withdrawal falls back to the workflow token when the bot token is refused', async () => {
  await withRoundsByType('docs:0', async () => {
    const core = makeCore();
    const { github } = makeFakeGithub({ reviews: MARKED_APPROVAL(), getPrImpl: getPrWithTitle('fix: code') });
    const dismissed = [];
    github.rest.pulls.dismissReview = async (a) => { dismissed.push(a); return { data: {} }; };
    const botTried = [];
    const botGithub = { rest: { pulls: {
      dismissReview: async (a) => { botTried.push(a); throw Object.assign(new Error('forbidden'), { status: 403 }); },
      createReview: async () => { throw new Error('must not approve'); },
    } } };
    const result = await decide({ github, botGithub, core, context: makeContext({ prOverrides: { title: 'fix: code' } }) });
    assert.equal(botTried.length, 1);
    assert.equal(dismissed.length, 1);
    assert.notEqual(result.decision, 'error');
  });
});

test('withdrawal does not fall back on a non-permission error', async () => {
  await withRoundsByType('docs:0', async () => {
    const core = makeCore();
    core.setFailed = () => {};
    const { github } = makeFakeGithub({ reviews: MARKED_APPROVAL(), getPrImpl: getPrWithTitle('fix: code') });
    github.rest.pulls.dismissReview = async () => { throw new Error('must not be retried'); };
    const botGithub = { rest: { pulls: {
      dismissReview: async () => { throw Object.assign(new Error('boom'), { status: 500 }); },
    } } };
    const result = await decide({ github, botGithub, core, context: makeContext({ prOverrides: { title: 'fix: code' } }) });
    assert.equal(result.decision, 'error');
    assert.match(result.reason, /could not withdraw/);
  });
});

test('approval is withdrawn if the title changes right after it is posted', async () => {
  const core = makeCore();
  const cp = { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' };
  let gets = 0;
  const { github } = makeFakeGithub({
    reviews: [1, 2, 3].map((id) => ({ id, state: 'COMMENTED', submitted_at: `2026-04-15T0${id}:00:00Z`, user: cp })),
    getPrImpl: (num) => getPrWithTitle(gets++ === 0 ? 'docs: x' : 'fix: y')(num),
  });
  const dismissed = [];
  github.rest.pulls.dismissReview = async (a) => { dismissed.push(a); return { data: {} }; };
  const result = await decide({ github, core, context: makeContext({ prOverrides: { title: 'docs: x' } }) });
  assert.equal(result.decision, 'skip');
  assert.match(result.reason, /approval withdrawn/);
  assert.equal(dismissed[0].review_id, 999);
});

test('re-read failing after approving withdraws the approval as a precaution', async () => {
  const core = makeCore();
  const cp = { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' };
  let gets = 0;
  const { github } = makeFakeGithub({
    reviews: [1, 2, 3].map((id) => ({ id, state: 'COMMENTED', submitted_at: `2026-04-15T0${id}:00:00Z`, user: cp })),
    getPrImpl: (num) => {
      if (gets++ > 0) throw new Error('boom');
      return getPrWithTitle('')(num);
    },
  });
  const dismissed = [];
  github.rest.pulls.dismissReview = async (a) => { dismissed.push(a); return { data: {} }; };
  const result = await decide({ github, core, context: makeContext() });
  assert.equal(result.decision, 'skip');
  assert.match(result.reason, /approval withdrawn/);
  assert.equal(dismissed[0].review_id, 999);
});

test('re-read and withdrawal both failing after approving is an error, not a skip', async () => {
  const core = makeCore();
  const failures = [];
  core.setFailed = (m) => failures.push(m);
  const cp = { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' };
  let gets = 0;
  const { github } = makeFakeGithub({
    reviews: [1, 2, 3].map((id) => ({ id, state: 'COMMENTED', submitted_at: `2026-04-15T0${id}:00:00Z`, user: cp })),
    getPrImpl: (num) => {
      if (gets++ > 0) throw new Error('boom');
      return getPrWithTitle('')(num);
    },
  });
  github.rest.pulls.dismissReview = async () => { throw new Error('forbidden'); };
  const result = await decide({ github, core, context: makeContext() });
  assert.equal(result.decision, 'error');
  assert.equal(failures.length, 1);
});

test('rounds-by-type: threshold 0 ignores a still-running Copilot check', async () => {
  await withRoundsByType('chore:0', async () => {
    const core = makeCore();
    const copilotName = 'copilot-pull-request-reviewer';
    const { github, calls } = makeFakeGithub({
      checkRuns: [...DEFAULT_CHECK_RUNS, { ...DEFAULT_CHECK_RUNS[0], name: copilotName, status: 'in_progress', conclusion: null }],
      getPrImpl: getPrWithTitle('chore: x'),
    });
    const result = await decide({ github, core, context: makeContext({ prOverrides: { title: 'chore: x' } }) });
    assert.equal(result.decision, 'approved');
    assert.equal(calls.createReview.length, 1);
  });
});

test('a still-running Copilot check still holds a type that requires review', async () => {
  const core = makeCore();
  const copilotName = 'copilot-pull-request-reviewer';
  const { github } = makeFakeGithub({
    checkRuns: [...DEFAULT_CHECK_RUNS, { ...DEFAULT_CHECK_RUNS[0], name: copilotName, status: 'in_progress', conclusion: null }],
  });
  const result = await decide({ github, core, context: makeContext() });
  assert.equal(result.decision, 'skip');
  assert.match(result.reason, /check still running/);
});

test("a sibling run's in-progress auto-approve check is not treated as CI", async () => {
  const core = makeCore();
  const cp = { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' };
  const { github, calls } = makeFakeGithub({
    checkRuns: [
      ...DEFAULT_CHECK_RUNS,
      { ...DEFAULT_CHECK_RUNS[0], name: 'auto-approve', status: 'in_progress', conclusion: null,
        details_url: 'https://github.com/x/y/actions/runs/888/job/1' },
    ],
    reviews: [1, 2, 3].map((id) => ({ id, state: 'COMMENTED', submitted_at: `2026-04-15T0${id}:00:00Z`, user: cp })),
  });
  const result = await decide({ github, core, context: makeContext() });
  assert.equal(result.decision, 'approved');
  assert.equal(calls.createReview.length, 1);
});

test('a rounds-rule approval is stamped with the threshold it relied on', async () => {
  const core = makeCore();
  const cp = { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' };
  const { github, calls } = makeFakeGithub({
    reviews: [1, 2, 3].map((id) => ({ id, state: 'COMMENTED', submitted_at: `2026-04-15T0${id}:00:00Z`, user: cp })),
  });
  await decide({ github, core, context: makeContext() });
  assert.match(calls.createReview[0].body, /pr-auto-approve:threshold=3/);
});

test('a copilot-clean approval carries no stamp', async () => {
  const core = makeCore();
  const cp = { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' };
  const { github, calls } = makeFakeGithub({
    reviews: [{ id: 1, state: 'COMMENTED', submitted_at: '2026-04-15T08:00:00Z', user: cp }],
  });
  await decide({ github, core, context: makeContext() });
  assert.doesNotMatch(calls.createReview[0].body, /pr-auto-approve:threshold/);
});

test('docs:1 approval is withdrawn when a retitle raises the threshold to 3', async () => {
  await withRoundsByType('docs:1,fix:3', async () => {
    const core = makeCore();
    const cp = { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' };
    const reviews = [
      { id: 1, state: 'COMMENTED', submitted_at: '2026-04-15T07:00:00Z', user: cp },
      { id: 77, state: 'APPROVED', submitted_at: '2026-04-15T08:00:00Z', user: { login: 'axeptio-bot' },
        body: 'Auto-approved: 1-rounds (1 Copilot reviews).\n\n<!-- pr-auto-approve:threshold=1 -->' },
    ];
    const { github, calls } = makeFakeGithub({
      reviewDecision: 'APPROVED', reviews, getPrImpl: getPrWithTitle('fix: now a fix'),
      reviewComments: { 1: [{ id: 10 }] },
    });
    const dismissed = [];
    github.rest.pulls.dismissReview = async (a) => { dismissed.push(a); reviews[1].state = 'DISMISSED'; return { data: {} }; };
    const result = await decide({ github, core, context: makeContext({ prOverrides: { title: 'fix: now a fix' } }) });
    assert.equal(dismissed.length, 1);
    assert.equal(dismissed[0].review_id, 77);
    assert.equal(calls.createReview.length, 0);
    assert.equal(result.decision, 'skip');
  });
});

test('an approval is kept when the threshold has not risen', async () => {
  await withRoundsByType('docs:1', async () => {
    const core = makeCore();
    const { github } = makeFakeGithub({
      reviewDecision: 'APPROVED',
      reviews: [{ id: 77, state: 'APPROVED', submitted_at: '2026-04-15T08:00:00Z', user: { login: 'axeptio-bot' },
        body: 'x\n\n<!-- pr-auto-approve:threshold=1 -->' }],
      getPrImpl: getPrWithTitle('docs: still docs'),
    });
    github.rest.pulls.dismissReview = async () => { throw new Error('must not dismiss'); };
    const result = await decide({ github, core, context: makeContext({ prOverrides: { title: 'docs: still docs' } }) });
    assert.match(result.reason, /already approved/);
  });
});

test('a COMPLETED failing check that shares the auto-approve name still blocks', async () => {
  const core = makeCore();
  const { github } = makeFakeGithub({
    checkRuns: [
      ...DEFAULT_CHECK_RUNS,
      { ...DEFAULT_CHECK_RUNS[0], name: 'auto-approve', status: 'completed', conclusion: 'failure',
        details_url: 'https://github.com/x/y/actions/runs/888/job/1' },
    ],
  });
  const result = await decide({ github, core, context: makeContext() });
  assert.equal(result.decision, 'skip');
  assert.match(result.reason, /failing check: auto-approve/);
});

test('threshold 0: a COMPLETED failing check named like Copilot still blocks', async () => {
  await withRoundsByType('chore:0', async () => {
    const core = makeCore();
    const { github } = makeFakeGithub({
      checkRuns: [...DEFAULT_CHECK_RUNS, { ...DEFAULT_CHECK_RUNS[0], name: 'copilot-pull-request-reviewer', conclusion: 'failure' }],
      getPrImpl: getPrWithTitle('chore: x'),
    });
    const result = await decide({ github, core, context: makeContext({ prOverrides: { title: 'chore: x' } }) });
    assert.equal(result.decision, 'skip');
    assert.match(result.reason, /failing check/);
  });
});

test('an approval stamped with the legacy copilot-optional marker is still withdrawn', async () => {
  await withRoundsByType('docs:0', async () => {
    const core = makeCore();
    const reviews = [{
      id: 77, state: 'APPROVED', submitted_at: '2026-04-15T08:00:00Z', user: { login: 'axeptio-bot' },
      body: 'Auto-approved: copilot-optional.\n\n<!-- pr-auto-approve:copilot-optional -->',
    }];
    const { github } = makeFakeGithub({
      reviewDecision: 'APPROVED', reviews, getPrImpl: getPrWithTitle('fix: code'),
    });
    const dismissed = [];
    github.rest.pulls.dismissReview = async (a) => { dismissed.push(a); reviews[0].state = 'DISMISSED'; return { data: {} }; };
    await decide({ github, core, context: makeContext({ prOverrides: { title: 'fix: code' } }) });
    assert.equal(dismissed.length, 1);
  });
});

// -- bot-login misconfiguration and self-triggered runs ------------------

async function withBotLogin(value, fn) {
  const original = process.env.AUTO_APPROVE_BOT_LOGIN;
  if (value === undefined) delete process.env.AUTO_APPROVE_BOT_LOGIN;
  else process.env.AUTO_APPROVE_BOT_LOGIN = value;
  try {
    return await fn();
  } finally {
    process.env.AUTO_APPROVE_BOT_LOGIN = original;
  }
}

test('error: empty bot-login fails the job and names the variable', async () => {
  for (const value of ['', '   ', undefined]) {
    await withBotLogin(value, async () => {
      const core = makeCore();
      const failures = [];
      core.setFailed = (msg) => failures.push(msg);
      const { github, calls } = makeFakeGithub();
      const result = await decide({ github, context: makeContext(), core });
      assert.equal(result.decision, 'error');
      assert.match(result.reason, /PR_AUTO_APPROVE_BOT_LOGIN/);
      assert.equal(failures.length, 1);
      assert.equal(calls.createReview.length, 0);
    });
  }
});

test('skip: run triggered by the bot\'s own review', async () => {
  const core = makeCore();
  const ctx = makeContext();
  ctx.payload.review = { user: { login: 'axeptio-bot' }, state: 'approved' };
  const { github, calls } = makeFakeGithub();
  const result = await decide({ github, context: ctx, core });
  assert.equal(result.decision, 'skip');
  assert.match(result.reason, /bot's own review/);
  assert.equal(calls.createReview.length, 0);
});

test('a review by someone else still gets evaluated', async () => {
  const core = makeCore();
  const ctx = makeContext();
  ctx.payload.review = { user: { login: 'copilot-pull-request-reviewer[bot]' }, state: 'commented' };
  const cp = { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' };
  const { github, calls } = makeFakeGithub({
    reviews: [{ id: 1, state: 'COMMENTED', submitted_at: '2026-04-16T10:00:00Z', user: cp }],
    reviewComments: { 1: [] },
  });
  const result = await decide({ github, context: ctx, core });
  assert.equal(result.decision, 'approved', `got skip: ${result.reason}`);
  assert.equal(calls.createReview.length, 1);
});

// -- requestCopilotReview ------------------------------------------------

const COPILOT_ENV = { AUTO_APPROVE_ROUNDS_BY_TYPE: 'docs:0,default:3', AUTO_APPROVE_ROUNDS_THRESHOLD: '3' };

function requestSetup({ title, changedFiles, requestImpl }) {
  const { github } = makeFakeGithub({ changedFiles });
  const requested = [];
  github.rest.pulls.requestReviewers = async (a) => {
    if (requestImpl) return requestImpl(a);
    requested.push(a);
    return { data: {} };
  };
  const core = makeCore();
  const warnings = [];
  core.warning = (m) => warnings.push(m);
  const context = makeContext({ prOverrides: { title } });
  return { github, core, context, requested, warnings };
}

test('requestCopilotReview: docs-only PR of a type set to 0 does not request Copilot', async () => {
  const { github, core, context, requested } = requestSetup({ title: 'docs: fix typo', changedFiles: ['README.md'] });
  const out = await decide.requestCopilotReview({ github, core, context, env: COPILOT_ENV });
  assert.equal(out, 'skipped');
  assert.equal(requested.length, 0);
});

test('requestCopilotReview: type 0 touching code still requests Copilot', async () => {
  const { github, core, context, requested } = requestSetup({ title: 'docs: sneaky', changedFiles: ['README.md', 'src/app.js'] });
  const out = await decide.requestCopilotReview({ github, core, context, env: COPILOT_ENV });
  assert.equal(out, 'requested');
  assert.deepEqual(requested[0].reviewers, ['copilot-pull-request-reviewer[bot]']);
  assert.equal(requested[0].pull_number, 42);
});

test('requestCopilotReview: default type requests Copilot without listing files', async () => {
  const { github, core, context, requested } = requestSetup({ title: 'feat: thing', changedFiles: ['src/app.js'] });
  github.rest.repos.compareCommitsWithBasehead = async () => { throw new Error('listed files'); };
  const out = await decide.requestCopilotReview({ github, core, context, env: COPILOT_ENV });
  assert.equal(out, 'requested');
  assert.equal(requested.length, 1);
});

test('requestCopilotReview: the file listing is pinned to the event head SHA', async () => {
  const { github, core, context } = requestSetup({ title: 'docs: fix typo', changedFiles: ['README.md'] });
  const compared = [];
  const original = github.rest.repos.compareCommitsWithBasehead;
  github.rest.repos.compareCommitsWithBasehead = async (a) => { compared.push(a); return original(a); };
  await decide.requestCopilotReview({ github, core, context, env: COPILOT_ENV });
  assert.deepEqual(compared.map((c) => c.basehead), ['heads/develop...deadbeef']);
});

test('requestCopilotReview: an API error only warns', async () => {
  const { github, core, context, warnings } = requestSetup({
    title: 'feat: thing',
    changedFiles: ['src/app.js'],
    requestImpl: async () => { throw Object.assign(new Error('Validation Failed'), { status: 422 }); },
  });
  const out = await decide.requestCopilotReview({ github, core, context, env: COPILOT_ENV });
  assert.equal(out, 'error');
  assert.match(warnings[0], /could not request a Copilot review: 422 Validation Failed/);
});
