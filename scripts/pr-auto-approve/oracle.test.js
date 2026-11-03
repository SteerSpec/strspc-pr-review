// SPDX-License-Identifier: Apache-2.0
//
// Holds the real-Copilot tier's jq oracle (e2e/pr-auto-approve/oracle.jq) against
// decide.js. The oracle is written separately on purpose, so it can disagree; this
// makes sure that on every body we know of it agrees, and that the format probe
// passes the shapes Copilot posts and flags the ones it does not.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { overviewBlocker, countSuppressedComments } = require('./decide');

const E2E = path.join(__dirname, '..', '..', 'e2e', 'pr-auto-approve');

// Runs `filter` over `input` with oracle.jq included.
function jq(filter, input) {
  const out = execFileSync('jq', ['-c', '-L', E2E, `include "oracle"; ${filter}`], {
    input: JSON.stringify(input),
  });
  return JSON.parse(out);
}

const readDir = (dir) => fs.readdirSync(path.join(E2E, dir))
  .filter((f) => f.endsWith('.md'))
  .map((f) => [`${dir}/${f}`, fs.readFileSync(path.join(E2E, dir, f), 'utf8')]);

// Bodies Copilot has posted or that the synthetic tier posts as Copilot.
const KNOWN = [...readDir('fixtures'), ...readDir('fixtures/captured')];

const OVERVIEW = (verdict, rest) => `<!-- ccr-overview-v2 -->\n\n### ${verdict}\n\nProse.\n\n${rest}`;

// Bodies only this test needs, each a path through the blocker.
const EXTRA = [
  ['legacy summary', 'Copilot reviewed 1 out of 1 changed files in this pull request and generated no new comments.'],
  ['suppressed', `${OVERVIEW('🟢 Approval recommended', '**No open issues** 🎉')}\n\n<details>\n<summary>Suppressed comments (2)</summary>\n\nx\n</details>`],
  ['previously missed', `${OVERVIEW('🟢 Approval recommended', '**No open issues** 🎉')}\n\n<details>\n<summary><strong>1 previously missed issue</strong></summary>\n\nx\n</details>`],
  ['unknown section', `${OVERVIEW('🟢 Approval recommended', '**No open issues** 🎉')}\n\n<details>\n<summary><strong>Hidden findings</strong></summary>\n\nx\n</details>`],
  ['open issues', OVERVIEW('🟡 Changes recommended', '<details open>\n<summary><strong>2 open issues</strong></summary>\n\n- a\n</details>')],
  ['no statement', OVERVIEW('🟢 Approval recommended', 'Nothing else.')],
  ['unknown verdict', OVERVIEW('🟣 Ship it', '**No open issues** 🎉')],
  ['suppressed, no number', `${OVERVIEW('🟢 Approval recommended', '**No open issues** 🎉')}\n\n<details>\n<summary>Suppressed comments (many)</summary>\n\nx\n</details>`],
  ['suppressed, zero', `${OVERVIEW('🟢 Approval recommended', '**No open issues** 🎉')}\n\n<details>\n<summary>Suppressed comments (0)</summary>\n\nx\n</details>`],
  ['suppressed heading', `${OVERVIEW('🟢 Approval recommended', '**No open issues** 🎉')}\n\n**Suppressed comments (2)**\n\nx`],
  ['suppressed in prose', `${OVERVIEW('🟢 Approval recommended', '**No open issues** 🎉')}\n\nNo suppressed comments (3) were found.`],
  ['unlabelled details', `${OVERVIEW('🟢 Approval recommended', '**No open issues** 🎉')}\n\n<details>hidden findings</details>`],
  ['zero open issues', OVERVIEW('🟢 Approval recommended', '<details open>\n<summary><strong>0 open issues</strong></summary>\n\n</details>')],
  ['fenced quote',`${OVERVIEW('🟢 Approval recommended', '**No open issues** 🎉')}\n\n\`\`\`\n<summary>Suppressed comments (3)</summary>\n\`\`\``],
];

// The reason decide.js gives after "latest Copilot review ", or '' when clean.
function decideBlocker(body, cleanOn) {
  const n = countSuppressedComments(body);
  return n !== 0 ? `has ${n} suppressed comment(s)` : overviewBlocker(body, cleanOn);
}

test('the oracle reads every body as decide.js does', () => {
  const bodies = [...KNOWN, ...EXTRA];
  for (const cleanOn of ['verdict', 'no-open-issues']) {
    const got = jq(`[.[] | {body: .} | body_blocker("${cleanOn}")]`, bodies.map(([, b]) => b));
    bodies.forEach(([name, body], i) => {
      const want = decideBlocker(body, cleanOn);
      if (want === '') {
        assert.equal(got[i], '', `${name} (${cleanOn}): oracle blocks with /${got[i]}/, decide.js approves`);
      } else {
        assert.notEqual(got[i], '', `${name} (${cleanOn}): oracle approves, decide.js says '${want}'`);
        assert.match(want, new RegExp(`^${got[i]}`), `${name} (${cleanOn})`);
      }
    });
  }
});

test('the probe passes every body Copilot is known to post', () => {
  const got = jq('[.[] | {state: "COMMENTED", body: .} | probe]', KNOWN.map(([, b]) => b));
  KNOWN.forEach(([name], i) => {
    assert.equal(got[i].shape, 'overview', name);
    assert.deepEqual(got[i].drift, [], name);
  });
});

test('the probe flags a body in no known shape', () => {
  const cases = {
    'legacy summary': /no ccr-overview marker/,
    'unknown section': /unknown section 'Hidden findings'/,
    'no statement': /states neither/,
    'unknown verdict': /unknown verdict heading 'Ship it'/,
    'unlabelled details': /has no label/,
  };
  const bodies = EXTRA.filter(([name]) => name in cases);
  const got = jq('[.[] | {state: "COMMENTED", body: .} | probe]', bodies.map(([, b]) => b));
  bodies.forEach(([name], i) => {
    assert.ok(got[i].drift.some((d) => cases[name].test(d)), `${name}: ${JSON.stringify(got[i].drift)}`);
  });
});

test('the probe names the reviews of nothing', () => {
  const got = jq('[.[] | probe | .shape]', [
    { state: 'COMMENTED', body: 'Copilot encountered an error and was unable to review this pull request. You can try again by re-requesting a review.' },
    { state: 'COMMENTED', body: 'Copilot was unable to review this pull request because the user who requested the review has reached their quota limit.' },
    { state: 'COMMENTED', body: "Copilot wasn't able to review any files in this pull request." },
    { state: 'CHANGES_REQUESTED', body: 'Copilot encountered an error and was unable to review this pull request.' },
  ]);
  assert.deepEqual(got, ['errored', 'quota', 'no-files', 'changes-requested']);
});

const COPILOT = 'copilot-pull-request-reviewer[bot]';
const CLEAN = OVERVIEW('🟢 Approval recommended', '**No open issues** 🎉');
const review = (over) => ({
  id: 1, user: { login: COPILOT }, state: 'COMMENTED', commit_id: 'head',
  submitted_at: '2026-11-03T10:00:00Z', body: CLEAN, comments: 0, ...over,
});
const expect = (over) => jq('expect', {
  head: 'head', failed_check: null, threshold: 3, clean_on: 'verdict', logins: [COPILOT], reviews: [], ...over,
});

test('the oracle expects the decision the facts call for', () => {
  const cases = [
    [{ reviews: [review()] }, 'approved', /^\^copilot-clean \\\(review 1, $/],
    [{ reviews: [review()], failed_check: 'check (failure)' }, 'skip', /failing check/],
    [{ reviews: [] }, 'skip', /no Copilot review yet/],
    [{ reviews: [review({ user: { login: 'someone' } })] }, 'skip', /no Copilot review yet/],
    [{ reviews: [review({ body: 'Copilot encountered an error and was unable to review this pull request.' })] }, 'skip', /no Copilot review yet/],
    [{ reviews: [review({ commit_id: 'old' })] }, 'skip', /older commit/],
    [{ reviews: [review({ comments: 2 })] }, 'skip', /has 2 comments/],
    [{ reviews: [review({ state: 'CHANGES_REQUESTED' })] }, 'skip', /requested changes/],
    [{ reviews: [1, 2, 3].map((id) => review({ id, comments: 1, submitted_at: `2026-11-03T10:0${id}:00Z` })) }, 'approved', /3-rounds/],
    [{ reviews: [review({ body: OVERVIEW('🔵 Needs a closer look', '**No open issues** 🎉') })] }, 'skip', /has verdict/],
    [{ reviews: [review({ body: OVERVIEW('🔵 Needs a closer look', '**No open issues** 🎉') })], clean_on: 'no-open-issues' }, 'approved', /copilot-clean/],
  ];
  for (const [input, decision, reason] of cases) {
    const got = expect(input);
    assert.equal(got.decision, decision, JSON.stringify(input));
    assert.match(got.reason, reason, JSON.stringify(input));
  }
});

test('the latest real review is the one judged', () => {
  const got = expect({
    reviews: [
      review({ id: 2, submitted_at: '2026-11-03T10:05:00Z' }),
      review({ id: 1, comments: 3, commit_id: 'old', submitted_at: '2026-11-03T10:00:00Z' }),
      review({ id: 3, submitted_at: '2026-11-03T10:09:00Z', body: 'Copilot encountered an error and was unable to review this pull request.' }),
    ],
  });
  assert.deepEqual(got, { decision: 'approved', reason: '^copilot-clean \\(review 2, ' });
});
