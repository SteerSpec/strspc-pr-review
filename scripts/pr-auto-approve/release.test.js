// SPDX-License-Identifier: Apache-2.0
// Unit tests for the release path: the helpers in release.js, and the route
// through decide.js. Run with: node --test scripts/pr-auto-approve/

const { test } = require('node:test');
const assert = require('node:assert/strict');
const decide = require('./decide.js');
const {
  getReleaseRoutes,
  findReleaseRoute,
  isReleaseHead,
  releaseAuthorBlocker,
  allowedReleaseFiles,
  visibleTypes,
  unpromotedVisible,
  MAX_LISTED_COMMITS,
} = require('./release.js');

process.env.AUTO_APPROVE_BOT_LOGIN = 'approver-bot';
process.env.AUTO_APPROVE_SANDBOX_REPOS = '';
process.env.AUTO_APPROVE_BASE_BRANCH = 'develop,main';
process.env.AUTO_APPROVE_ROUNDS_THRESHOLD = '3';

const AUTHOR = 'release-app[bot]';
const HEAD = 'cafe0002';
const FULL_NAME = 'acme/widgets';
const HEAD_REF = 'release-please--branches--main';
const CHECK_OK = { name: 'ci', status: 'completed', conclusion: 'success', app: { id: 1 } };

// The shapes SteerSpec repos use, reduced to what the gates read.
const GO_CONFIG = {
  packages: {
    '.': {
      'release-type': 'go',
      'changelog-sections': [
        { type: 'feat', section: 'Features' },
        { type: 'fix', section: 'Bug Fixes' },
        { type: 'docs', section: 'Documentation' },
        { type: 'chore', section: 'Miscellaneous', hidden: true },
      ],
    },
  },
};
const NODE_CONFIG = { 'release-type': 'node', packages: { '.': {} } };
const SIMPLE_CONFIG = { packages: { '.': { 'release-type': 'simple', 'version-file': 'VERSION' } } };
const EXTRA_FILES_CONFIG = {
  packages: {
    '.': {
      'release-type': 'simple',
      'extra-files': [{ type: 'json', path: 'rules/realm.json', jsonpath: '$.realm.version' }],
      'changelog-sections': [
        { type: 'feat', section: 'Features' },
        { type: 'docs', section: 'Documentation', hidden: true },
      ],
    },
  },
};

const commit = (message, sha = 'beef0001') => ({ sha, commit: { message } });
// A commit in the shape a release app's API commit really has.
const appCommit = (sha = HEAD, overrides = {}) => ({
  sha,
  author: { login: AUTHOR },
  committer: { login: 'web-flow' },
  commit: { verification: { verified: true } },
  ...overrides,
});
const encode = (config) => Buffer.from(JSON.stringify(config)).toString('base64');

function makeRepo({
  tip = HEAD,
  config = GO_CONFIG,
  rawConfig,
  configError,
  changedFiles = ['CHANGELOG.md', '.release-please-manifest.json'],
  mergeBase = 'mb000001',
  prCommits = [appCommit()],
  unpromoted = [],
  totalUnpromoted,
  compareSourceError,
  reviews = [],
  checkRuns = [CHECK_OK],
  current,
  reviewDecision = null,
} = {}) {
  const calls = { createReview: [], dismiss: [], reviewers: [], getContent: [], sourceCompare: 0 };
  const github = {
    paginate: async (fn, params) => (await fn(params)).data,
    graphql: async () => ({ repository: { pullRequest: { reviewDecision } } }),
    rest: {
      checks: { listForRef: async () => ({ data: { total_count: checkRuns.length, check_runs: checkRuns } }) },
      git: { getRef: async () => ({ data: { object: { sha: tip } } }) },
      repos: {
        getContent: async (args) => {
          calls.getContent.push(args);
          if (configError) throw configError;
          return { data: { content: rawConfig === undefined ? encode(config) : rawConfig, encoding: 'base64' } };
        },
        compareCommitsWithBasehead: async ({ basehead }) => {
          if (basehead.endsWith(`...${HEAD}`)) {
            return {
              data: {
                merge_base_commit: mergeBase ? { sha: mergeBase } : null,
                files: changedFiles.map((filename) => ({ filename })),
              },
            };
          }
          calls.sourceCompare += 1;
          if (compareSourceError) throw compareSourceError;
          return { data: { total_commits: totalUnpromoted ?? unpromoted.length, commits: unpromoted } };
        },
      },
      pulls: {
        get: async () => ({ data: current || releasePr() }),
        listCommits: async () => ({ data: prCommits }),
        listReviews: async () => ({
          data: reviews.map((r) => (calls.dismiss.some((d) => d.review_id === r.id) ? { ...r, state: 'DISMISSED' } : r)),
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

function releasePr(overrides = {}) {
  return {
    number: 172,
    draft: false,
    title: 'chore(main): release 1.29.0',
    user: { login: AUTHOR },
    head: { ref: HEAD_REF, sha: HEAD, repo: { full_name: FULL_NAME } },
    base: { ref: 'main' },
    ...overrides,
  };
}

const makeContext = (pr) => ({
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

// Runs decide with the release path configured, and restores the env after.
async function run({
  repo = makeRepo(), pr = releasePr(), branches = 'develop:main', author = AUTHOR, env = {}, sleep,
} = {}) {
  const overrides = { AUTO_APPROVE_RELEASE_BRANCHES: branches, AUTO_APPROVE_RELEASE_AUTHOR: author, ...env };
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

test('getReleaseRoutes: reads source:base pairs and a bare base', () => {
  const env = { AUTO_APPROVE_RELEASE_BRANCHES: ' develop:main , stable ' };
  assert.deepEqual(getReleaseRoutes(env), [
    { source: 'develop', base: 'main' },
    { source: null, base: 'stable' },
  ]);
});

test('getReleaseRoutes: blank means off, without a warning', () => {
  const warned = [];
  assert.deepEqual(getReleaseRoutes({ AUTO_APPROVE_RELEASE_BRANCHES: '  ' }, (m) => warned.push(m)), []);
  assert.deepEqual(getReleaseRoutes({}, (m) => warned.push(m)), []);
  assert.deepEqual(warned, []);
});

test('getReleaseRoutes: a malformed entry is dropped with a warning', () => {
  const warned = [];
  const env = { AUTO_APPROVE_RELEASE_BRANCHES: 'a:b:c,:main,develop:,develop:main' };
  assert.deepEqual(getReleaseRoutes(env, (m) => warned.push(m)), [{ source: 'develop', base: 'main' }]);
  assert.equal(warned.length, 3);
  assert.match(warned[0], /'a:b:c'/);
});

test('isReleaseHead: the exact branch, with an optional component', () => {
  assert.equal(isReleaseHead('release-please--branches--main', 'main'), true);
  assert.equal(isReleaseHead('release-please--branches--main--components--pr-auto-approve', 'main'), true);
  assert.equal(isReleaseHead('release-please--branches--main--components--', 'main'), false);
  assert.equal(isReleaseHead('release-please--branches--main-2', 'main'), false);
  assert.equal(isReleaseHead('release-please--branches--main--other', 'main'), false);
  assert.equal(isReleaseHead('release-please--branches--stable', 'main'), false);
  assert.equal(isReleaseHead('develop', 'main'), false);
  assert.equal(isReleaseHead(undefined, 'main'), false);
});

test('findReleaseRoute: needs the base and the head to match', () => {
  const routes = [{ source: 'develop', base: 'main' }];
  const pr = (head, base) => ({ head: { ref: head }, base: { ref: base } });
  assert.deepEqual(findReleaseRoute(pr(HEAD_REF, 'main'), routes), routes[0]);
  assert.equal(findReleaseRoute(pr(HEAD_REF, 'stable'), routes), null);
  assert.equal(findReleaseRoute(pr('feature', 'main'), routes), null);
  assert.equal(findReleaseRoute({}, routes), null);
});

test('releaseAuthorBlocker: needs a configured author, and the PR to be theirs', () => {
  assert.equal(releaseAuthorBlocker({ user: { login: AUTHOR } }, AUTHOR), null);
  assert.match(releaseAuthorBlocker({ user: { login: AUTHOR } }, ''), /release-author is not set/);
  assert.match(releaseAuthorBlocker({ user: { login: 'someone' } }, AUTHOR), /release PR author someone is not release-author/);
  assert.match(releaseAuthorBlocker({ user: null }, AUTHOR), /release PR author unknown/);
});

// -- What release-please owns ----------------------------------------------

const sorted = (set) => [...set].sort();

test('allowedReleaseFiles: go owns the changelog and the manifest', () => {
  assert.deepEqual(sorted(allowedReleaseFiles(GO_CONFIG)), ['.release-please-manifest.json', 'CHANGELOG.md']);
});

test('allowedReleaseFiles: node adds its package files, from a top-level release type', () => {
  assert.deepEqual(sorted(allowedReleaseFiles(NODE_CONFIG)), [
    '.release-please-manifest.json', 'CHANGELOG.md', 'npm-shrinkwrap.json', 'package-lock.json', 'package.json',
  ]);
});

test('allowedReleaseFiles: simple uses version-file, else version.txt', () => {
  assert.ok(allowedReleaseFiles(SIMPLE_CONFIG).has('VERSION'));
  assert.ok(!allowedReleaseFiles(SIMPLE_CONFIG).has('version.txt'));
  assert.ok(allowedReleaseFiles({ packages: { '.': { 'release-type': 'simple' } } }).has('version.txt'));
});

test('allowedReleaseFiles: extra-files, as objects or strings, under the package path', () => {
  assert.ok(allowedReleaseFiles(EXTRA_FILES_CONFIG).has('rules/realm.json'));
  const nested = {
    packages: {
      'apps/web': {
        'release-type': 'node',
        'changelog-path': 'docs/CHANGES.md',
        'extra-files': ['src/version.ts', '/README.md', { type: 'generic', path: 'a/*.ts', glob: true }],
      },
    },
  };
  const out = allowedReleaseFiles(nested);
  assert.ok(out.has('apps/web/docs/CHANGES.md'));
  assert.ok(out.has('apps/web/package.json'));
  assert.ok(out.has('apps/web/src/version.ts'));
  assert.ok(out.has('README.md'), 'a leading slash is repo-relative');
  assert.ok(!out.has('apps/web/a/*.ts'), 'a glob cannot be allow-listed by name');
});

test('allowedReleaseFiles: an unknown release type adds nothing', () => {
  assert.deepEqual(
    sorted(allowedReleaseFiles({ packages: { '.': { 'release-type': 'python' } } })),
    ['.release-please-manifest.json', 'CHANGELOG.md'],
  );
});

test('visibleTypes: package sections, else top-level, else release-please defaults', () => {
  assert.deepEqual(sorted(visibleTypes(GO_CONFIG)), ['docs', 'feat', 'fix']);
  assert.deepEqual(sorted(visibleTypes(EXTRA_FILES_CONFIG)), ['feat']);
  assert.deepEqual(sorted(visibleTypes(NODE_CONFIG)), ['feat', 'fix', 'perf', 'revert']);
  const top = { 'changelog-sections': [{ type: 'build', section: 'Build' }], packages: { '.': {} } };
  assert.deepEqual(sorted(visibleTypes(top)), ['build']);
});

test('unpromotedVisible: visible types, breaking marks and footers count', () => {
  const visible = new Set(['feat', 'fix']);
  const held = (message) => unpromotedVisible([commit(message)], visible).length === 1;
  assert.equal(held('fix: a'), true);
  assert.equal(held('feat(api): a'), true);
  assert.equal(held('chore: a'), false);
  assert.equal(held('chore!: a'), true);
  assert.equal(held('chore(deps)!: a'), true);
  assert.equal(held('chore: a\n\nBREAKING CHANGE: b'), true);
  assert.equal(held('chore: a\n\nBREAKING-CHANGE: b'), true);
  assert.equal(held('chore: a\n\nRelease-As: 2.0.0'), true);
  assert.equal(held('chore: mentions BREAKING CHANGE: in the subject'), false);
  assert.equal(held('Merge branch main into develop'), false, 'release-please ignores these too');
});

// -- Through decide --------------------------------------------------------

test('unset: a release PR takes the Copilot path as before', async () => {
  const out = await run({ branches: '' });
  assert.equal(out.decision, 'skip');
  assert.equal(out.reason, 'no Copilot review yet');
  assert.equal(out.calls.getContent.length, 0);
});

test('approve: a passing release PR needs no Copilot review and no wait', async () => {
  let slept = 0;
  const out = await run({
    env: { AUTO_APPROVE_COPILOT_WAIT_SECONDS: '300' },
    sleep: async () => { slept += 1; },
    repo: makeRepo({ unpromoted: [commit('chore: sync')] }),
  });
  assert.equal(out.decision, 'approved', out.reason);
  assert.equal(out.reason, `release-pr (${HEAD_REF}, nothing unpromoted on develop)`);
  assert.equal(slept, 0);
  assert.equal(out.calls.createReview[0].commit_id, HEAD);
  assert.match(out.calls.createReview[0].body, /<!-- pr-auto-approve:threshold=0 -->/);
});

test('the config comes from the base branch, never the head', async () => {
  const out = await run();
  assert.equal(out.calls.getContent[0].ref, 'refs/heads/main');
  assert.equal(out.calls.getContent[0].path, 'release-please-config.json');
});

test('approve: a node repo with a component head and its package files', async () => {
  const headRef = 'release-please--branches--main--components--pr-auto-approve';
  const pr = releasePr({ head: { ref: headRef, sha: HEAD, repo: { full_name: FULL_NAME } } });
  const out = await run({
    pr,
    repo: makeRepo({
      current: pr,
      config: NODE_CONFIG,
      changedFiles: ['.release-please-manifest.json', 'CHANGELOG.md', 'package-lock.json', 'package.json'],
    }),
  });
  assert.equal(out.decision, 'approved', out.reason);
});

test('approve: simple with version-file, and extra-files', async () => {
  const simple = await run({
    repo: makeRepo({ config: SIMPLE_CONFIG, changedFiles: ['VERSION', 'CHANGELOG.md'] }),
  });
  assert.equal(simple.decision, 'approved', simple.reason);
  const extra = await run({
    repo: makeRepo({ config: EXTRA_FILES_CONFIG, changedFiles: ['rules/realm.json', 'CHANGELOG.md'] }),
  });
  assert.equal(extra.decision, 'approved', extra.reason);
});

test('approve: a bare base has no unpromoted gate', async () => {
  const out = await run({ branches: 'main', repo: makeRepo({ unpromoted: [commit('fix: a')] }) });
  assert.equal(out.decision, 'approved', out.reason);
  assert.equal(out.reason, `release-pr (${HEAD_REF})`);
  assert.equal(out.calls.sourceCompare, 0);
});

test('a PR that is not a release takes the Copilot path', async () => {
  const pr = releasePr({ head: { ref: 'feature', sha: HEAD, repo: { full_name: FULL_NAME } } });
  const out = await run({ pr, repo: makeRepo({ current: pr }) });
  assert.equal(out.reason, 'no Copilot review yet');
  assert.equal(out.calls.getContent.length, 0);
});

test('skip: a fork using the release branch name', async () => {
  const pr = releasePr({ head: { ref: HEAD_REF, sha: HEAD, repo: { full_name: 'someone/widgets' } } });
  const out = await run({ pr });
  assert.equal(out.decision, 'skip');
  assert.match(out.reason, /head repo does not match/);
  assert.equal(out.calls.createReview.length, 0);
});

test('skip: release-author is not set', async () => {
  const out = await run({ author: '' });
  assert.equal(out.decision, 'skip');
  assert.match(out.reason, /release-author is not set/);
});

test('skip: a person pushing a branch with the release name', async () => {
  const pr = releasePr({ user: { login: 'someone' } });
  const out = await run({ pr, repo: makeRepo({ current: pr }) });
  assert.equal(out.decision, 'skip');
  assert.match(out.reason, /release PR author someone is not release-author/);
  assert.equal(out.calls.createReview.length, 0);
});

test('skip: a commit by someone else on top of the release commit', async () => {
  const out = await run({
    repo: makeRepo({
      prCommits: [appCommit('beef0001'), appCommit(HEAD, { author: { login: 'someone' } })],
    }),
  });
  assert.equal(out.decision, 'skip');
  assert.match(out.reason, new RegExp(`commit ${HEAD} is not by release-author`));
});

test('skip: a commit with no linked author', async () => {
  const out = await run({ repo: makeRepo({ prCommits: [appCommit(HEAD, { author: null })] }) });
  assert.match(out.reason, /is not by release-author/);
});

test('skip: a forged author, which no verified signature backs', async () => {
  const unsigned = await run({
    repo: makeRepo({ prCommits: [appCommit(HEAD, { commit: { verification: { verified: false } } })] }),
  });
  assert.match(unsigned.reason, /is not by release-author/);
  const noVerification = await run({ repo: makeRepo({ prCommits: [appCommit(HEAD, { commit: {} })] }) });
  assert.match(noVerification.reason, /is not by release-author/);
});

test('skip: a person signing a commit under the forged author', async () => {
  const out = await run({
    repo: makeRepo({ prCommits: [appCommit(HEAD, { committer: { login: 'someone' } })] }),
  });
  assert.match(out.reason, /is not by release-author/);
  const none = await run({ repo: makeRepo({ prCommits: [appCommit(HEAD, { committer: null })] }) });
  assert.match(none.reason, /is not by release-author/);
});

test('approve: a commit the release author committed and signed itself', async () => {
  const out = await run({
    repo: makeRepo({ prCommits: [appCommit(HEAD, { committer: { login: AUTHOR } })] }),
  });
  assert.equal(out.decision, 'approved', out.reason);
});

test('skip: a commit list that may be partial, or misses the head', async () => {
  const prCommits = Array.from({ length: MAX_LISTED_COMMITS }, (_, i) => appCommit(`s${i}`));
  const long = await run({ repo: makeRepo({ prCommits }) });
  assert.match(long.reason, /250 commits or more/);
  const missing = await run({ repo: makeRepo({ prCommits: [appCommit('other')] }) });
  assert.match(missing.reason, /does not include the evaluated head/);
});

test('skip: a missing config', async () => {
  const out = await run({ repo: makeRepo({ configError: Object.assign(new Error('nf'), { status: 404 }) }) });
  assert.equal(out.decision, 'skip');
  assert.equal(out.reason, 'cannot read release-please-config.json at main (404)');
});

test('skip: an invalid config', async () => {
  const garbled = await run({ repo: makeRepo({ rawConfig: Buffer.from('{').toString('base64') }) });
  assert.match(garbled.reason, /release-please-config.json at main is not valid JSON/);
  const empty = await run({ repo: makeRepo({ config: { packages: {} } }) });
  assert.match(empty.reason, /has no packages/);
});

test('skip: a config that is valid JSON but not an object', async () => {
  const out = await run({ repo: makeRepo({ config: null }) });
  assert.equal(out.reason, 'release-please-config.json at main has no packages');
});

test('skip: a code file in the release PR', async () => {
  const out = await run({ repo: makeRepo({ changedFiles: ['CHANGELOG.md', 'src/x.go'] }) });
  assert.equal(out.decision, 'skip');
  assert.equal(out.reason, 'release PR changes src/x.go, which release-please does not own');
  assert.equal(out.calls.createReview.length, 0);
});

test('skip: 300 files or more', async () => {
  const changedFiles = Array.from({ length: 300 }, () => 'CHANGELOG.md');
  const out = await run({ repo: makeRepo({ changedFiles }) });
  assert.match(out.reason, /300 files or more/);
});

test('skip: no merge base, so the diff cannot be re-verified', async () => {
  const out = await run({ repo: makeRepo({ mergeBase: null }) });
  assert.match(out.reason, /no merge base/);
});

test('skip: a failing check, before the unpromoted read', async () => {
  const out = await run({
    repo: makeRepo({ checkRuns: [{ ...CHECK_OK, conclusion: 'failure', details_url: 'u' }] }),
  });
  assert.match(out.reason, /failing check: ci/);
  assert.equal(out.calls.sourceCompare, 0);
});

test('skip: an unpromoted fix, naming it', async () => {
  const out = await run({ repo: makeRepo({ unpromoted: [commit('fix: drop the bad cache', 'abcdef1234')] }) });
  assert.equal(out.decision, 'skip');
  assert.equal(out.reason, 'develop has 1 unpromoted commit(s): abcdef12 fix: drop the bad cache; promote first');
  assert.equal(out.calls.createReview.length, 0);
});

test('the unpromoted reason names at most 3 commits', async () => {
  const unpromoted = ['fix: a', 'fix: b', 'fix: c', 'fix: d', 'fix: e'].map((m, i) => commit(m, `sha0000${i}`));
  const out = await run({ repo: makeRepo({ unpromoted }) });
  assert.equal(
    out.reason,
    'develop has 5 unpromoted commit(s): sha00000 fix: a, sha00001 fix: b, sha00002 fix: c (+2 more); promote first',
  );
});

test('a long subject is cut in the reason', async () => {
  const out = await run({ repo: makeRepo({ unpromoted: [commit(`fix: ${'x'.repeat(200)}`)] }) });
  assert.ok(out.reason.length < 130, out.reason);
});

test('approve: an unpromoted chore does not block', async () => {
  const out = await run({ repo: makeRepo({ unpromoted: [commit('chore: a')] }) });
  assert.equal(out.decision, 'approved', out.reason);
});

test('skip: a hidden type marked breaking still blocks', async () => {
  const out = await run({ repo: makeRepo({ unpromoted: [commit('chore!: a')] }) });
  assert.match(out.reason, /develop has 1 unpromoted commit/);
});

test('visibility is the repo\'s own: docs blocks here and not there', async () => {
  const unpromoted = [commit('docs: a')];
  const blocks = await run({ repo: makeRepo({ unpromoted }) });
  assert.match(blocks.reason, /unpromoted/);
  const passes = await run({
    repo: makeRepo({ unpromoted, config: EXTRA_FILES_CONFIG, changedFiles: ['CHANGELOG.md'] }),
  });
  assert.equal(passes.decision, 'approved', passes.reason);
});

test('a hidden feat or fix still blocks: the type sets the version, not the changelog', async () => {
  const hidden = { packages: { '.': { 'changelog-sections': [
    { type: 'feat', section: 'Features', hidden: true },
    { type: 'fix', section: 'Bug Fixes', hidden: true },
    { type: 'docs', section: 'Documentation' },
  ] } } };
  for (const message of ['feat: a', 'fix: a']) {
    const out = await run({ repo: makeRepo({ config: hidden, unpromoted: [commit(message)] }) });
    assert.match(out.reason, /develop has 1 unpromoted commit/, message);
  }
  const held = unpromotedVisible([commit('feat: a'), commit('chore: b')], visibleTypes(hidden));
  assert.equal(held.length, 1);
});

test('skip: more unpromoted commits than were listed', async () => {
  const out = await run({ repo: makeRepo({ unpromoted: [commit('chore: a')], totalUnpromoted: 500 }) });
  assert.equal(out.decision, 'skip');
  assert.match(out.reason, /develop is 500 commits ahead of main, more than can be read; promote first/);
});

test('skip: a source branch that does not exist', async () => {
  const out = await run({
    repo: makeRepo({ compareSourceError: Object.assign(new Error('nf'), { status: 404 }) }),
  });
  assert.equal(out.decision, 'skip');
  assert.match(out.reason, /cannot compare develop with main \(404\).*use a bare 'main'/);
});

const STAMPED = {
  id: 5,
  state: 'APPROVED',
  commit_id: 'cafe0000',
  user: { login: 'approver-bot' },
  submitted_at: '2026-10-01T09:00:00Z',
  body: 'Auto-approved: release-pr.\n\n<!-- pr-auto-approve:threshold=0 -->',
};

test('a new head withdraws the older approval and is approved on its own', async () => {
  const out = await run({ repo: makeRepo({ reviews: [STAMPED] }) });
  assert.equal(out.decision, 'approved', out.reason);
  assert.equal(out.calls.dismiss[0].review_id, 5);
  assert.equal(out.calls.createReview[0].commit_id, HEAD);
});

test('an event older than the branch tip leaves the approval alone', async () => {
  const out = await run({ repo: makeRepo({ tip: 'cafe0009', reviews: [STAMPED] }) });
  assert.equal(out.decision, 'skip');
  assert.match(out.reason, new RegExp(`is not the tip of ${HEAD_REF}`));
  assert.equal(out.calls.dismiss.length, 0);
});

test('an approval of the current head is left alone and not proven again', async () => {
  const out = await run({ repo: makeRepo({ reviews: [{ ...STAMPED, commit_id: HEAD }] }) });
  assert.match(out.reason, /bot already approved head/);
  assert.equal(out.calls.sourceCompare, 0);
});

// A later bot COMMENT supersedes the approval, so the run reaches the last gate
// with an approval of this head still standing.
const SUPERSEDED = [
  { ...STAMPED, commit_id: HEAD },
  {
    id: 6, state: 'COMMENTED', commit_id: HEAD, user: { login: 'approver-bot' }, submitted_at: '2026-10-01T09:30:00Z',
  },
];

test('a failed gate withdraws an approval of the current head', async () => {
  const out = await run({ repo: makeRepo({ reviews: SUPERSEDED, unpromoted: [commit('fix: a')] }) });
  assert.match(out.reason, /unpromoted/);
  assert.equal(out.calls.dismiss.length, 1);
  assert.match(out.calls.dismiss[0].message, /^Withdrawn: develop has 1 unpromoted/);
});

test('a failed read of the config withdraws, then reports the failure', async () => {
  const repo = makeRepo({
    reviews: [{ ...STAMPED, commit_id: HEAD }],
    configError: Object.assign(new Error('boom'), { status: 502 }),
  });
  const out = await run({ repo });
  assert.match(out.reason, /^evaluation failed: 502 boom/);
  assert.match(out.calls.dismiss[0].message, /the release PR could not be verified \(502 boom\)/);
});

test('a failed unpromoted read withdraws, then reports the failure', async () => {
  const repo = makeRepo({
    reviews: SUPERSEDED,
    compareSourceError: Object.assign(new Error('boom'), { status: 502 }),
  });
  const out = await run({ repo });
  assert.match(out.reason, /^evaluation failed: 502 boom/);
  assert.match(out.calls.dismiss[0].message, /unpromoted commits could not be read \(502 boom\)/);
});

test('a failed read and a failed withdrawal is an error', async () => {
  const repo = makeRepo({
    reviews: SUPERSEDED,
    compareSourceError: Object.assign(new Error('boom'), { status: 502 }),
  });
  repo.github.rest.pulls.dismissReview = async () => {
    throw Object.assign(new Error('nope'), { status: 500 });
  };
  const out = await run({ repo });
  assert.equal(out.decision, 'error');
  assert.match(out.reason, /could not withdraw the stale approval/);
});

test('a Copilot CHANGES_REQUESTED still blocks a release PR', async () => {
  const copilot = {
    id: 8,
    state: 'CHANGES_REQUESTED',
    commit_id: HEAD,
    user: { login: 'copilot-pull-request-reviewer[bot]' },
    submitted_at: '2026-10-01T09:30:00Z',
  };
  const out = await run({ repo: makeRepo({ reviews: [copilot] }) });
  assert.equal(out.reason, 'latest Copilot review requested changes');
});

test('requestCopilotReview: never requests one for a release PR', async () => {
  const repo = makeRepo();
  const out = await decide.requestCopilotReview({
    github: repo.github,
    context: makeContext(releasePr()),
    core: makeCore(),
    env: { AUTO_APPROVE_RELEASE_BRANCHES: 'develop:main', AUTO_APPROVE_ROUNDS_THRESHOLD: '3' },
  });
  assert.equal(out, 'skipped');
  assert.equal(repo.calls.reviewers.length, 0);
});
