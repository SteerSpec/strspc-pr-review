// SPDX-License-Identifier: Apache-2.0
//
// Tests lib.sh's gh wrapper against a fake gh: it retries GitHub's transient
// failures and nothing else. A retry must not change what a call returns, and
// must never turn a real refusal into a pass.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LIB = path.join(__dirname, '..', '..', 'e2e', 'pr-auto-approve', 'lib.sh');

// lib.sh needs Bash 4+, which macOS doesn't ship.
const bash = spawnSync('bash', ['-c', 'echo ${BASH_VERSINFO[0]}'], { encoding: 'utf8' });
const skip = !(Number(bash.stdout) >= 4) && 'needs Bash 4+ as `bash` on PATH';

// Each element is one call's answer: [exit code, stdout, stderr]. The fake also
// records each call's arguments and stdin.
function run(answers, command, { stdin = '', retries = 3, env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-gh-'));
  fs.writeFileSync(path.join(dir, 'answers.json'), JSON.stringify(answers));
  fs.writeFileSync(
    path.join(dir, 'gh'),
    `#!/usr/bin/env node
const fs = require('fs'), dir = ${JSON.stringify(dir)};
const calls = fs.existsSync(dir + '/calls.json') ? JSON.parse(fs.readFileSync(dir + '/calls.json')) : [];
let input = '';
try { input = fs.readFileSync(0, 'utf8'); } catch {}
calls.push({ args: process.argv.slice(2), stdin: input, token: process.env.GH_TOKEN });
fs.writeFileSync(dir + '/calls.json', JSON.stringify(calls));
const answers = JSON.parse(fs.readFileSync(dir + '/answers.json'));
const [rc, out, err] = answers[Math.min(calls.length, answers.length) - 1];
process.stdout.write(out); process.stderr.write(err); process.exit(rc);
`,
    { mode: 0o755 },
  );
  const result = spawnSync('bash', ['-c', `set -euo pipefail; source "${LIB}"; ${command}`], {
    encoding: 'utf8',
    input: stdin,
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, E2E_GH_RETRIES: String(retries), E2E_GH_RETRY_DELAY: '0', ...env },
  });
  const calls = JSON.parse(fs.readFileSync(path.join(dir, 'calls.json'), 'utf8'));
  fs.rmSync(dir, { recursive: true, force: true });
  return { ...result, calls };
}

const BAD_GATEWAY = [1, '<html>502</html>', 'HTTP 502: 502 Bad Gateway (https://api.github.com/graphql)\n'];
const WENT_WRONG = [1, '', 'GraphQL: Something went wrong while executing your query on 2026-11-02T16:09:46Z.\n'];

test('a 502 is retried, and only the successful attempt reaches stdout', { skip }, () => {
  const r = run([BAD_GATEWAY, BAD_GATEWAY, [0, 'ok-output\n', '']], 'gh api repos/o/r');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'ok-output\n');
  assert.equal(r.calls.length, 3);
});

test("GraphQL's catch-all error is retried with the same stdin", { skip }, () => {
  const r = run([WENT_WRONG, [0, '{}', '']], 'echo "{\\"query\\":1}" | gh api graphql --input - >/dev/null');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.calls.map((c) => c.stdin), ['{"query":1}\n', '{"query":1}\n']);
});

test('a 4xx is not retried and keeps its exit code and message', { skip }, () => {
  const r = run([[1, '{"message":"Not Found"}', 'gh: Not Found (HTTP 404)\n'], [0, 'never', '']], 'gh api repos/o/r');
  assert.equal(r.status, 1);
  assert.equal(r.calls.length, 1);
  assert.match(r.stderr, /HTTP 404/);
  assert.equal(r.stdout, '{"message":"Not Found"}');
});

test('a refusal that is not transient fails at once', { skip }, () => {
  const refused = [1, '', 'GraphQL: Pull request is not mergeable (mergePullRequest)\n'];
  const r = run([refused, [0, '', '']], 'gh pr merge 1 --merge');
  assert.equal(r.status, 1);
  assert.equal(r.calls.length, 1);
});

test('it gives up after E2E_GH_RETRIES retries and returns the failure', { skip }, () => {
  const r = run([BAD_GATEWAY], 'gh api repos/o/r', { retries: 2 });
  assert.equal(r.status, 1);
  assert.equal(r.calls.length, 3);
  assert.match(r.stderr, /HTTP 502/);
});

// wait_for_ci when GitHub starts no CI: one reopen, then a failure that names GitHub.
const NO_CHECKS = [0, '{"check_runs":[{"name":"auto-approve","status":"completed"}]}', ''];
const ONE_DONE = [0, '{"check_runs":[{"name":"check","status":"completed"}]}', ''];
const HEAD = [0, 'abc123\n', ''];
const WAIT = { E2E_NUDGE_AFTER: '0', E2E_POLL_INTERVAL: '0', E2E_REPO: 'o/r' };

test('wait_for_ci reopens a PR once when no CI starts, and then sees it', { skip }, () => {
  const r = run([HEAD, NO_CHECKS, [0, '', ''], [0, '', ''], HEAD, ONE_DONE], 'wait_for_ci 7', {
    env: { ...WAIT, E2E_TIMEOUT: '30' },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(
    r.calls.filter((c) => c.args[0] === 'pr').map((c) => c.args.slice(0, 2)),
    [['pr', 'close'], ['pr', 'reopen']],
  );
});

test('wait_for_ci blames GitHub when no CI ever starts', { skip }, () => {
  const r = run([HEAD, NO_CHECKS, [0, '', ''], [0, '', ''], HEAD, NO_CHECKS], 'wait_for_ci 7', {
    env: { ...WAIT, E2E_TIMEOUT: '1' },
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /GitHub never started CI on PR #7/);
  assert.equal(r.calls.filter((c) => c.args[1] === 'reopen').length, 1);
});

test('a command run as the bot passes its token to every attempt', { skip }, () => {
  const r = run([BAD_GATEWAY, [0, 'ok', '']], 'E2E_BOT_TOKEN=bot-token as_bot gh api user');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.calls.map((c) => c.token), ['bot-token', 'bot-token']);
});
