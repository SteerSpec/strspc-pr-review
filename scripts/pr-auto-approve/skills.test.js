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

// The drift guard that matters: a skill must not document an input that does not
// exist. Catches renamed and removed inputs, which is exactly how these rot.
test('every action input a skill names actually exists in action.yml', () => {
  const inputs = declaredInputs();
  // Only inspect fenced yaml blocks: prose mentions plain words like "checks"
  // that would collide with input names.
  for (const file of skillFiles()) {
    const body = fs.readFileSync(file, 'utf8');
    for (const block of body.matchAll(/```yaml\n([\s\S]*?)```/g)) {
      for (const m of block[1].matchAll(/^\s*([a-z0-9-]+):\s*'/gm)) {
        const key = m[1];
        // Skip workflow-level keys that legitimately appear in caller snippets.
        if (['name', 'branches', 'types', 'workflows', 'uses', 'if', 'group'].includes(key)) continue;
        assert.ok(
          inputs.has(key),
          `${path.basename(path.dirname(file))}: documents input '${key}' which action.yml does not declare`,
        );
      }
    }
  }
});

// pull_request in a caller snippet would be a token-exfiltration path. The skills
// are what people copy from, so this must never regress.
test('no skill shows a pull_request trigger in a caller snippet', () => {
  for (const file of skillFiles()) {
    const body = fs.readFileSync(file, 'utf8');
    for (const block of body.matchAll(/```yaml\n([\s\S]*?)```/g)) {
      assert.ok(
        !/^\s*pull_request:\s*$/m.test(block[1]),
        `${path.basename(path.dirname(file))}: yaml block uses pull_request; must be pull_request_target`,
      );
    }
  }
});

