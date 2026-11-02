// SPDX-License-Identifier: Apache-2.0
//
// Guards the e2e suite against silently covering less than the action does.
//
// This exists because it happened: copilot-clean-on, promotion-branches and
// release-branches all reached @v1 without a scenario, and the first real run
// of the promotion and release paths was on a production repository.
//
// Deliberately narrow, like docs.test.js: it proves a scenario claims each
// input, not that the scenario is any good. Whether a claim holds is what the
// suite itself checks against the sandbox.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const manifest = JSON.parse(read('e2e/pr-auto-approve/scenarios.json'));
const harness = read('e2e/pr-auto-approve/run.sh');

const DECISIONS = new Set(['approved', 'skip', 'none']);

function declaredInputs() {
  const src = read('action.yml');
  const block = src.slice(src.indexOf('\ninputs:'), src.indexOf('\noutputs:'));
  return new Set([...block.matchAll(/^ {2}([a-z0-9_-]+):$/gm)].map((m) => m[1]));
}

const claimed = () => new Set(manifest.scenarios.flatMap((s) => s.inputs));

test('every action.yml input has a scenario or a stated exemption', () => {
  const exempt = new Set(Object.keys(manifest.exemptions));
  const missing = [...declaredInputs()].filter((i) => !claimed().has(i) && !exempt.has(i));
  assert.deepEqual(missing, [], `no scenario covers: ${missing.join(', ')}`);
});

test('every input a scenario or exemption names exists in action.yml', () => {
  const inputs = declaredInputs();
  const named = [...claimed(), ...Object.keys(manifest.exemptions)];
  assert.deepEqual(named.filter((i) => !inputs.has(i)), []);
});

test('an input with a scenario has no exemption left over', () => {
  const stale = Object.keys(manifest.exemptions).filter((i) => claimed().has(i));
  assert.deepEqual(stale, [], `remove these exemptions: ${stale.join(', ')}`);
});

test('every exemption says why', () => {
  for (const [name, why] of Object.entries({ ...manifest.exemptions, ...manifest.rule_exemptions })) {
    assert.ok(typeof why === 'string' && why.length > 10, `${name} needs a reason`);
  }
});

// The rules say what the action must guarantee, so each one has to name its proof.
const rules = JSON.parse(read('rules/APPROVE.json')).rules;
const cited = () => new Set(manifest.scenarios.flatMap((s) => s.rules));

test('every APPROVE rule has a scenario or a stated exemption', () => {
  const exempt = new Set(Object.keys(manifest.rule_exemptions));
  const missing = rules.map((r) => r.id).filter((id) => !cited().has(id) && !exempt.has(id));
  assert.deepEqual(missing, [], `nothing proves: ${missing.join(', ')}`);
});

test('every rule a scenario or exemption names exists', () => {
  const ids = new Set(rules.map((r) => r.id));
  const named = [...cited(), ...Object.keys(manifest.rule_exemptions)];
  assert.deepEqual(named.filter((id) => !ids.has(id)), []);
});

test('a rule with a scenario has no exemption left over', () => {
  const stale = Object.keys(manifest.rule_exemptions).filter((id) => cited().has(id));
  assert.deepEqual(stale, [], `remove these exemptions: ${stale.join(', ')}`);
});

// Implemented is what fail_on enforces, so it has to mean a scenario proves it.
test('a rule in state I is cited by a scenario', () => {
  const unproven = rules.filter((r) => r.state === 'I' && !cited().has(r.id)).map((r) => r.id);
  assert.deepEqual(unproven, [], `implemented without a scenario: ${unproven.join(', ')}`);
});

test('scenario names are unique', () => {
  const names = manifest.scenarios.map((s) => s.name);
  assert.equal(new Set(names).size, names.length);
});

test('every scenario has a function in run.sh', () => {
  for (const s of manifest.scenarios) {
    const fn = `scenario_${s.name.replaceAll('-', '_')}()`;
    assert.ok(harness.includes(fn), `missing ${fn}`);
  }
});

test('every scenario uses a declared profile', () => {
  for (const s of manifest.scenarios) {
    assert.ok(s.profile in manifest.profiles, `${s.name}: unknown profile ${s.profile}`);
  }
});

// A scenario that only expects "not approved" also passes on a crash, which is
// why each one has to name the reason it expects.
test('every scenario states the outcome it asserts', () => {
  for (const s of manifest.scenarios) {
    assert.ok(DECISIONS.has(s.decision), `${s.name}: unknown decision ${s.decision}`);
    if (s.decision === 'none') {
      assert.equal(s.reason, undefined, s.name);
    } else {
      assert.ok(s.reason, `${s.name}: a scenario with a decision must name its reason`);
      assert.doesNotThrow(() => new RegExp(s.reason), s.name);
    }
  }
});

test('every scenario function in run.sh is listed in the manifest', () => {
  const listed = new Set(manifest.scenarios.map((s) => s.name.replaceAll('-', '_')));
  const orphans = [...harness.matchAll(/^scenario_([a-z0-9_]+)\(\)/gm)]
    .map((m) => m[1])
    .filter((n) => !listed.has(n));
  assert.deepEqual(orphans, []);
});
