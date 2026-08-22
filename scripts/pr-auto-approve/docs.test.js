// SPDX-License-Identifier: Apache-2.0
//
// Guards README.md against drifting from action.yml.
//
// This exists because the drift already happened and shipped: `github-token`
// was added in v1.6.0 and went undocumented for two releases, while four other
// sections still described the single-token design it replaced. A reader who
// started at Prerequisites provisioned the wrong token and hit a 403 that only
// appears on private repos.
//
// Deliberately narrow, like skills.test.js: it checks that the two lists match,
// not that the prose is any good. A table row is mechanically checkable; whether
// the description is true is not.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');

const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// Names from the `inputs:`/`outputs:` blocks only, so `runs:` step keys and
// `with:` values can't contribute false positives.
function declared(section, next) {
  const src = read('action.yml');
  const start = src.indexOf(`\n${section}:`);
  const end = src.indexOf(`\n${next}:`);
  assert.ok(start !== -1 && end > start, `action.yml must have ${section}: then ${next}:`);
  return new Set(
    [...src.slice(start, end).matchAll(/^ {2}([a-z0-9_-]+):$/gm)].map((m) => m[1]),
  );
}

// Leading-pipe rows of the table under a heading: `| \`name\` | ... |`.
function documented(heading, next) {
  const src = read('README.md');
  const start = src.indexOf(`## ${heading}`);
  const end = src.indexOf(`## ${next}`);
  assert.ok(start !== -1 && end > start, `README must have ## ${heading} then ## ${next}`);
  return new Set(
    [...src.slice(start, end).matchAll(/^\| `([a-z0-9_-]+)`/gm)].map((m) => m[1]),
  );
}

test('every action.yml input has a row in the README Inputs table', () => {
  const missing = [...declared('inputs', 'outputs')].filter(
    (i) => !documented('Inputs', 'Outputs').has(i),
  );
  assert.deepEqual(missing, [], `undocumented inputs: ${missing.join(', ')}`);
});

// The other direction matters too: a row for an input that no longer exists
// sends people to configure something that is silently ignored.
test('the README Inputs table names no input action.yml does not declare', () => {
  const inputs = declared('inputs', 'outputs');
  const phantom = [...documented('Inputs', 'Outputs')].filter((i) => !inputs.has(i));
  assert.deepEqual(phantom, [], `documented but not declared: ${phantom.join(', ')}`);
});

test('every action.yml output has a row in the README Outputs table', () => {
  const missing = [...declared('outputs', 'runs')].filter(
    (o) => !documented('Outputs', 'Troubleshooting').has(o),
  );
  assert.deepEqual(missing, [], `undocumented outputs: ${missing.join(', ')}`);
});

// The claim that sent people into a 403: what the bot PAT actually needs.
//
// Asserted POSITIVELY, on the one section that misled people, rather than by
// banning the string "`repo` scope" anywhere in the file. A ban is stricter than
// the intent -- it would reject a troubleshooting entry that warns against repo
// scope, i.e. exactly the text you would want to write -- and prose-policing is
// outside what this file claims to do.
test('Prerequisites states the permission the bot PAT actually needs', () => {
  const src = read('README.md');
  const start = src.indexOf('## Prerequisites');
  const end = src.indexOf('## Quick start');
  assert.ok(start !== -1 && end > start, 'README must have ## Prerequisites then ## Quick start');
  assert.match(
    src.slice(start, end),
    /`Pull requests: write`/,
    'Prerequisites must say the bot PAT needs Pull requests: write -- describing it as repo-scoped is what sent people into a 403 on private repos',
  );
});

// The test count in Development drifted twice in two days: 62 was stale for
// several releases, and 87 went stale inside the very PR that corrected it.
test('the README test count matches the suite', () => {
  const declared = fs
    .readdirSync(__dirname)
    .filter((f) => f.endsWith('.test.js'))
    .reduce((n, f) => n + (fs.readFileSync(path.join(__dirname, f), 'utf8').match(/^test\(/gm) || []).length, 0);
  const stated = /(\d+) unit tests/.exec(read('README.md'));
  assert.ok(stated, 'README Development section must state a test count');
  assert.equal(
    Number(stated[1]),
    declared,
    `README says ${stated[1]} unit tests; the suite declares ${declared}`,
  );
});
