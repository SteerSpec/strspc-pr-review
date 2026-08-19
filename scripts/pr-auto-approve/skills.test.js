// SPDX-License-Identifier: Apache-2.0
// Guards the skills/ docs against drifting from the code they describe.
//
// This exists because drift already happened: the original pr-caller-sync skill
// went stale within a day of the changes it was meant to document, and nothing
// caught it. These checks are deliberately narrow — they verify facts that are
// mechanically checkable, not prose quality.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const SKILLS_DIR = path.join(ROOT, 'skills');

function skillFiles() {
  return fs
    .readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(SKILLS_DIR, d.name, 'SKILL.md'));
}

// Input names declared in action.yml, read from the `inputs:` block only so the
// `outputs:` and step bodies can't contribute false positives.
function declaredInputs() {
  const src = fs.readFileSync(path.join(ROOT, 'action.yml'), 'utf8');
  const start = src.indexOf('\ninputs:');
  const end = src.indexOf('\noutputs:');
  assert.ok(start !== -1 && end > start, 'action.yml must have inputs: then outputs:');
  const block = src.slice(start, end);
  return new Set([...block.matchAll(/^ {2}([a-z0-9-]+):$/gm)].map((m) => m[1]));
}

test('every SKILL.md has name and description frontmatter', () => {
  for (const file of skillFiles()) {
    const body = fs.readFileSync(file, 'utf8');
    assert.match(body, /^---\n/, `${path.basename(path.dirname(file))}: missing frontmatter`);
    assert.match(body, /\nname: [a-z0-9-]+\n/, `${file}: missing name:`);
    assert.match(body, /\ndescription: \S/, `${file}: missing description:`);
  }
});

test('skill directory name matches its frontmatter name', () => {
  for (const file of skillFiles()) {
    const dir = path.basename(path.dirname(file));
    const name = /\nname: ([a-z0-9-]+)\n/.exec(fs.readFileSync(file, 'utf8'))[1];
    assert.equal(name, dir, `${file}: frontmatter name must match its directory`);
  }
});

// Workflow-level keys that appear in caller snippets and are not action inputs.
const WORKFLOW_KEYS = new Set([
  'on', 'jobs', 'name', 'branches', 'types', 'workflows', 'uses', 'if', 'group',
  'permissions', 'runs-on', 'steps', 'concurrency', 'cancel-in-progress', 'with',
  'contents', 'pull-requests', 'checks', 'secrets', 'env',
  'pull_request_target', 'pull_request_review', 'check_run', 'workflow_run',
]);

// Input names a yaml snippet documents.
//
// Matching on the KEY rather than the value shape is deliberate: `key: 300`,
// `key: "300"`, `key: true` and `key: ${{ … }}` must all be caught, so anything
// keyed on quoting would leave gaps.
//
// Two snippet shapes exist in these skills and both must be covered — scoping
// only to `with:` silently stops inspecting the bare ones, which a test below
// pins.
function documentedInputs(yamlBlock) {
  const lines = yamlBlock.split('\n').filter((l) => l.trim() !== '' && !/^\s*#/.test(l));
  const keyOf = (line) => (/^\s*([a-z0-9-]+):/.exec(line) || [])[1];

  const withLine = lines.findIndex((l) => /^\s*with:\s*$/.test(l));
  if (withLine !== -1) {
    // Full caller workflow: inputs are the keys nested under `with:`.
    const withIndent = lines[withLine].length - lines[withLine].trimStart().length;
    const found = [];
    for (const line of lines.slice(withLine + 1)) {
      if (line.length - line.trimStart().length <= withIndent) break;
      const k = keyOf(line);
      if (k) found.push(k);
    }
    return found;
  }
  // Bare fragment showing one or more inputs on their own.
  return lines.map(keyOf).filter((k) => k && !WORKFLOW_KEYS.has(k));
}

// The drift guard that matters: a skill must not document an input that does not
// exist. Catches renamed and removed inputs, which is exactly how these rot.
test('every action input a skill names actually exists in action.yml', () => {
  const inputs = declaredInputs();
  for (const file of skillFiles()) {
    const body = fs.readFileSync(file, 'utf8');
    for (const block of body.matchAll(/```yaml\n([\s\S]*?)```/g)) {
      for (const key of documentedInputs(block[1])) {
        assert.ok(
          inputs.has(key),
          `${path.basename(path.dirname(file))}: documents input '${key}' which action.yml does not declare`,
        );
      }
    }
  }
});

// pull_request in a caller snippet is a token-exfiltration path. The skills are
// what people copy from, so this must never regress. Matching the key alone —
// not the whole line — also catches `pull_request: # note` and `pull_request: {}`.
// `pull_request_target:` and `pull_request_review:` cannot match: the character
// after `pull_request` is `_`, not `:`.
test('no skill shows a pull_request trigger in a caller snippet', () => {
  for (const file of skillFiles()) {
    const body = fs.readFileSync(file, 'utf8');
    for (const block of body.matchAll(/```yaml\n([\s\S]*?)```/g)) {
      assert.ok(
        !/^\s*pull_request:/m.test(block[1]),
        `${path.basename(path.dirname(file))}: yaml block uses pull_request; must be pull_request_target`,
      );
    }
  }
});

