// SPDX-License-Identifier: Apache-2.0
//
// A minimal stand-in for an Octokit client that can post the approval review as
// the bot account.
//
// Why this exists rather than a second Octokit: the action runs inside
// actions/github-script@v7, which authenticates exactly one client from its
// `github-token` input. Building a second one in-script is not possible —
// `require('@actions/github')` fails there with "Cannot find module", because
// v7's `require` is a proxy that resolves paths (how decide.js is loaded) and
// not github-script's own bundled dependencies. Verified on a runner, not
// assumed.
//
// That matters because the two tokens now have different jobs. Reads use the
// workflow's GITHUB_TOKEN: listing check runs needs the `Checks` permission,
// which a fine-grained PAT CANNOT be granted, so a PAT-based read works on
// public repos (where check runs are public) and 403s forever on private ones.
// The bot PAT is needed for exactly one call — the approval — because the review
// must come from an account that is not the PR author.
//
// The shape deliberately mirrors the Octokit surface decide.js already uses, so
// decide.js stays agnostic about which client it holds and its tests keep
// passing with the default (botGithub === github).

const API_VERSION = '2022-11-28';

// Octokit throws errors carrying `.status`, and decide.js's catch formats
// `approval API call failed: ${err.status} ${err.message}`. Matching that shape
// keeps the failure message identical whichever client posted the review.
class BotClientError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'BotClientError';
    this.status = status;
  }
}

/**
 * @param {string} token          PAT for the bot account (needs Pull requests: write).
 * @param {object} [deps]
 * @param {typeof fetch} [deps.fetch]   Injected for tests; defaults to global fetch.
 * @param {string} [deps.baseUrl]       Defaults to $GITHUB_API_URL, then public API.
 */
function createBotClient(token, deps = {}) {
  const doFetch = deps.fetch || globalThis.fetch;
  // GITHUB_API_URL, not a hard-coded host: on GHES and GHEC-with-data-residency
  // the API lives elsewhere, and a hard-coded api.github.com would post the
  // approval to the wrong server. Octokit reads this for you; fetch does not.
  // Trailing slash stripped: GHES installs and proxies hand out both forms of
  // GITHUB_API_URL, and concatenating the slashed one yields //repos/... which
  // some proxies reject.
  const baseUrl = (
    deps.baseUrl || process.env.GITHUB_API_URL || 'https://api.github.com'
  ).replace(/\/+$/, '');

  if (typeof doFetch !== 'function') {
    throw new Error('bot-client: no fetch available (Node 18+ or inject one)');
  }
  if (!token) {
    throw new Error('bot-client: a bot token is required');
  }

  return {
    rest: {
      pulls: {
        async createReview({ owner, repo, pull_number: pullNumber, event, body }) {
          const res = await doFetch(
            `${baseUrl}/repos/${owner}/${repo}/pulls/${pullNumber}/reviews`,
            {
              method: 'POST',
              headers: {
                authorization: `Bearer ${token}`,
                accept: 'application/vnd.github+json',
                'content-type': 'application/json',
                'x-github-api-version': API_VERSION,
                'user-agent': 'steerspec-pr-auto-approve',
              },
              body: JSON.stringify({ event, body }),
            },
          );

          if (res.ok) return { data: await res.json().catch(() => ({})) };

          // Surface GitHub's own message when there is one: "Can not approve
          // your own pull request" and "Resource not accessible by personal
          // access token" are the two that actually happen, and both are
          // useless if reduced to a bare status code.
          let detail = '';
          try {
            const payload = await res.json();
            detail = payload && payload.message ? payload.message : '';
          } catch {
            /* non-JSON body: the status alone will have to do */
          }
          throw new BotClientError(res.status, detail || `HTTP ${res.status}`);
        },
      },
    },
  };
}

module.exports = createBotClient;
module.exports.BotClientError = BotClientError;
