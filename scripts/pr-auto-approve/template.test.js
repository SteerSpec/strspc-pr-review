// SPDX-License-Identifier: Apache-2.0
//
// Guards templates/pr-auto-approve.yml against drifting from action.yml.
//
// Callers configure the action through Actions variables named
// STRSPC_PR_AUTO_APPROVE_<INPUT>, set at org level and overridden per repo. The
// name is derived from the input, so a new input that the template forgets to
// wire, or wires under a misspelt variable, is a setting no org can set — and
// nothing errors, the action just runs on its default.
//
// Narrow like docs.test.js: it checks the wiring, not the comments around it.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// Inputs the template must NOT read from a variable: credentials come from
// secrets, github-token defaults to the workflow token, and the test-only
// inputs must never be set in a production caller.
const NOT_VARIABLES = new Set([
  'bot-github-token',
  'github-token',
  'slack-bot-token',
  'sandbox-repos',
  'test-copilot-logins',
]);

const varName = (input) => `STRSPC_PR_AUTO_APPROVE_${input.toUpperCase().replace(/-/g, '_')}`;

function declaredInputs() {
  const src = read('action.yml');
  const start = src.indexOf('\ninputs:');
  const end = src.indexOf('\noutputs:');
  assert.ok(start !== -1 && end > start, 'action.yml must have inputs: then outputs:');
  return [...src.slice(start, end).matchAll(/^ {2}([a-z0-9_-]+):$/gm)].map((m) => m[1]);
}

// `<input>: <value>` lines under the action step's `with:`, comments excluded.
function templateWith() {
  const src = read('templates/pr-auto-approve.yml');
  const start = src.indexOf('uses: SteerSpec/strspc-pr-review@');
  assert.ok(start !== -1, 'template must call the action');
  const map = new Map();
  for (const m of src.slice(start).matchAll(/^ {10}([a-z0-9-]+): (.+)$/gm)) map.set(m[1], m[2]);
  return map;
}

test('every configurable input is wired to its STRSPC_PR_AUTO_APPROVE_ variable', () => {
  const wired = templateWith();
  const wrong = declaredInputs()
    .filter((i) => !NOT_VARIABLES.has(i))
    .filter((i) => !(wired.get(i) || '').includes(`vars.${varName(i)}`));
  assert.deepEqual(wrong, [], `inputs not read from their variable: ${wrong.join(', ')}`);
});

// An input the step does not forward is a setting that silently does nothing.
test('copilot-clean-on reaches the evaluate step', () => {
  const step = read('action.yml').split('- name: Evaluate and approve')[1].split('- name: ')[0];
  assert.match(step, /AUTO_APPROVE_COPILOT_CLEAN_ON: \$\{\{ inputs\.copilot-clean-on \}\}/);
});

// Both steps read it: the request step must not ask Copilot to review a promotion.
test('promotion-branches reaches the evaluate and request steps', () => {
  const src = read('action.yml');
  for (const name of ['Evaluate and approve', 'Request Copilot review']) {
    const step = src.split(`- name: ${name}`)[1].split('- name: ')[0];
    assert.match(step, /AUTO_APPROVE_PROMOTION_BRANCHES: \$\{\{ inputs\.promotion-branches \}\}/, name);
  }
});

test('the template reads no STRSPC_PR_AUTO_APPROVE_ variable that matches no input', () => {
  const known = new Set(declaredInputs().map(varName));
  const used = [...read('templates/pr-auto-approve.yml').matchAll(/vars\.(STRSPC_PR_AUTO_APPROVE_[A-Z_]+)/g)]
    .map((m) => m[1]);
  const phantom = [...new Set(used)].filter((v) => !known.has(v));
  assert.deepEqual(phantom, [], `variables with no matching input: ${phantom.join(', ')}`);
});

// The loop guard in the job if: and the bot-login input must read the same
// expression: a mismatch (literal in one, unset variable in the other) turns
// the guard into `actor != ''`, which is always true.
test('the loop guard and bot-login read the same expression', () => {
  const expr = templateWith().get('bot-login');
  const inner = /^\$\{\{ (.+) \}\}$/.exec(expr);
  assert.ok(inner, `bot-login must be an expression, got ${expr}`);
  assert.ok(
    read('templates/pr-auto-approve.yml').includes(`github.actor != (${inner[1]})`),
    `job if: must compare github.actor against (${inner[1]})`,
  );
});

test('the job if: base-branch pre-filter reads the same variable as base-branch', () => {
  const src = read('templates/pr-auto-approve.yml');
  assert.match(src, /contains\(vars\.STRSPC_PR_AUTO_APPROVE_BASE_BRANCH \|\| 'main', github\.event\.pull_request\.base\.ref\)/);
  // 'main' must always pass: the action reads a whitespace- or comma-only value
  // as main, which contains() on the raw value cannot see.
  assert.match(src, /github\.event\.pull_request\.base\.ref == 'main' \|\|\s+contains\(vars\.STRSPC_PR_AUTO_APPROVE_BASE_BRANCH/);
  // on: cannot read vars, so a branches: filter would be a second, unsynced copy.
  assert.doesNotMatch(src, /^\s+branches:/m);
});

test('the README names every variable the template reads', () => {
  const readme = read('README.md');
  const used = new Set(
    [...read('templates/pr-auto-approve.yml').matchAll(/vars\.(STRSPC_PR_AUTO_APPROVE_[A-Z_]+)/g)].map((m) => m[1]),
  );
  const missing = [...used].filter((v) => !readme.includes(`\`${v}\``));
  assert.deepEqual(missing, [], `variables missing from README: ${missing.join(', ')}`);
});

// Inputs can now come from Actions variables, so an expression interpolated into
// a github-script body is a code-injection path (a quote in the value breaks out
// of the JS string). Values reach scripts through env: and process.env instead.
// The deprecated reusable workflow is covered too: its callers pass the same values.
function assertNoScriptExpressions(file) {
  const lines = read(file).split('\n');
  const offenders = [];
  let blocks = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)script: \|/);
    if (!m) continue;
    blocks++;
    for (let j = i + 1; j < lines.length; j++) {
      const indent = lines[j].match(/^\s*/)[0].length;
      if (lines[j].trim() && indent <= m[1].length) break;
      if (lines[j].includes('${{')) offenders.push(`${file}:${j + 1}: ${lines[j].trim()}`);
    }
  }
  assert.ok(blocks > 0, `expected at least one script block in ${file}`);
  assert.deepEqual(offenders, []);
}

test('no action.yml script body interpolates an expression', () => {
  assertNoScriptExpressions('action.yml');
});

test('no deprecated reusable workflow script body interpolates an expression', () => {
  assertNoScriptExpressions('.github/workflows/pr-auto-approve.yml');
});
