// SPDX-License-Identifier: Apache-2.0
const { test } = require('node:test');
const assert = require('node:assert/strict');
const createBotClient = require('./bot-client.js');

const okResponse = (body = {}) => ({
  ok: true,
  status: 200,
  json: async () => body,
});

function recordingFetch(response) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return typeof response === 'function' ? response() : response;
  };
  fn.calls = calls;
  return fn;
}

test('posts an APPROVE review to the right endpoint with the bot token', async () => {
  const fetchFn = recordingFetch(okResponse({ id: 7 }));
  const client = createBotClient('bot-pat', { fetch: fetchFn });

  const res = await client.rest.pulls.createReview({
    owner: 'o', repo: 'r', pull_number: 42, event: 'APPROVE', body: 'Auto-approved: x.',
  });

  assert.equal(res.data.id, 7);
  assert.equal(fetchFn.calls.length, 1);
  const { url, init } = fetchFn.calls[0];
  assert.equal(url, 'https://api.github.com/repos/o/r/pulls/42/reviews');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.authorization, 'Bearer bot-pat');
  assert.deepEqual(JSON.parse(init.body), { event: 'APPROVE', body: 'Auto-approved: x.' });
});

// The whole point of the split: this client must never be used for reads, so it
// exposes exactly one method and nothing else can accidentally route through it.
test('exposes only pulls.createReview', () => {
  const client = createBotClient('t', { fetch: recordingFetch(okResponse()) });
  assert.deepEqual(Object.keys(client.rest), ['pulls']);
  assert.deepEqual(Object.keys(client.rest.pulls), ['createReview']);
});

test('throws with .status and GitHub\'s message so decide.js can format it', async () => {
  const fetchFn = recordingFetch({
    ok: false,
    status: 403,
    json: async () => ({ message: 'Resource not accessible by personal access token' }),
  });
  const client = createBotClient('t', { fetch: fetchFn });

  await assert.rejects(
    () => client.rest.pulls.createReview({ owner: 'o', repo: 'r', pull_number: 1, event: 'APPROVE', body: '' }),
    (err) => {
      assert.equal(err.status, 403);
      assert.match(err.message, /not accessible by personal access token/);
      return true;
    },
  );
});

test('falls back to the status when the error body is not JSON', async () => {
  const client = createBotClient('t', {
    fetch: recordingFetch({
      ok: false,
      status: 502,
      json: async () => { throw new Error('not json'); },
    }),
  });

  await assert.rejects(
    () => client.rest.pulls.createReview({ owner: 'o', repo: 'r', pull_number: 1, event: 'APPROVE', body: '' }),
    (err) => err.status === 502 && err.message === 'HTTP 502',
  );
});

test('refuses to build without a token', () => {
  assert.throws(() => createBotClient('', { fetch: recordingFetch(okResponse()) }), /bot token is required/);
});

// Passing fetch: null is not enough to test this — it falls back to
// globalThis.fetch, which exists on every supported Node. The guard only fires
// when there is genuinely none, so the global has to be removed.
test('refuses to build when no fetch exists at all', () => {
  const saved = globalThis.fetch;
  delete globalThis.fetch;
  try {
    assert.throws(() => createBotClient('t'), /no fetch available/);
  } finally {
    globalThis.fetch = saved;
  }
});
