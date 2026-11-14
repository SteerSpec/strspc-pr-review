// SPDX-License-Identifier: Apache-2.0
// Decision logic for the pr-auto-approve reusable workflow.
// Extracted into a module so it can be unit-tested with `node --test`.
//
// Configuration (via environment variables, set by the caller workflow):
//   AUTO_APPROVE_BOT_LOGIN    — login of the bot that posts approval reviews (required)
//   AUTO_APPROVE_BASE_BRANCH  — comma-separated set of base branches PRs must
//                               target to be eligible (default: main)
//   AUTO_APPROVE_SANDBOX_REPOS — comma-separated repo full names where bot-authored
//                               PRs are allowed (for e2e testing); production repos
//                               must not appear here
//   AUTO_APPROVE_COPILOT_CLEAN_ON — which overview verdicts can pass: verdict
//                               (default) or no-open-issues; see getCopilotCleanOn
//   AUTO_APPROVE_PROMOTION_BRANCHES — comma-separated head:base pairs that take
//                               the promotion path instead of the Copilot rules;
//                               see promotion.js
//   AUTO_APPROVE_RELEASE_BRANCHES — comma-separated source:base pairs, or a bare
//                               base, whose release-please PRs take the release
//                               path; see release.js
//   AUTO_APPROVE_RELEASE_AUTHOR — login that must have authored a release PR
//   AUTO_APPROVE_PROTECTED_PATHS — comma-separated globs whose change stops
//                               auto-approval (default: off); see evaluateProtectedPaths
//   AUTO_APPROVE_PROTECTED_PATHS_MODE — approve, manual (default) or allowlist
//   AUTO_APPROVE_PROTECTED_PATHS_ALLOWED — comma-separated logins for allowlist
//
// Usage (from actions/github-script):
//   const decide = require('./scripts/pr-auto-approve/decide.js');
//   await decide({ github, context, core });

const {
  getPromotionPairs,
  findPromotionPair,
  promotionTitleBlocker,
  checkProvenance,
} = require('./promotion.js');
const {
  getReleaseRoutes,
  getReleaseAuthor,
  findReleaseRoute,
  releaseAuthorBlocker,
  checkReleasePr,
  checkUnpromoted,
} = require('./release.js');

// Production Copilot reviewer identities. Strict allowlist of known logins
// — a substring-match fallback could be spoofed by any third-party bot with
// "copilot" in its login. If GitHub publishes a new Copilot bot identity,
// add it here explicitly after verification.
const COPILOT_LOGINS = new Set([
  'copilot-pull-request-reviewer[bot]',
  'github-copilot[bot]',
]);

// Check-run names for Copilot's review, derived from the logins above so the
// two can't drift: GitHub names the check after the bot minus the "[bot]"
// suffix (verified: login 'copilot-pull-request-reviewer[bot]' produces check
// run 'copilot-pull-request-reviewer').
const COPILOT_CHECK_NAMES = new Set(
  [...COPILOT_LOGINS].map((login) => login.replace(/\[bot\]$/, '')),
);

// Copilot withholds some findings into a collapsed block inside the review BODY
// instead of posting them as inline review comments. Those comments are absent
// from pulls.listCommentsForReview (verified 0 against real reviews), so
// scanning the body is the only way to see them.
//
// GitHub has shipped two wordings for that block, and BOTH must match — the
// first replacement went undetected here and silently disabled this gate:
//
//   pre-2026-08  "<summary>Comments suppressed due to low confidence (N)</summary>"
//   2026-08      "<summary>Suppressed comments (N)</summary>", with the findings
//                subtitled by why they were withheld, e.g.
//                "**Previously missed (N)** — in code that hasn't changed since
//                the last review."
//
// Note the second wording drops "low confidence" entirely: "previously missed"
// is a different reason for withholding. The gate does not care why — it exists
// to catch findings the comments API hides, whatever the stated cause.
//
// Treat this as unstable and expect a third wording. The unit tests only assert
// these fixtures, so a third wording would pass them and fail in production. The
// real-Copilot e2e tier (e2e/pr-auto-approve/copilot.sh) is what checks the
// markup against live reviews, and it runs only on demand and before a release.
const SUPPRESSED_PHRASE =
  String.raw`(?:Comments? suppressed due to low confidence|Suppressed comments?)`;

// The phrase alone is too weak to key on. Review bodies discuss their own
// diffs and Copilot quotes the offending snippet back, so in THIS repo — whose
// code and tests are full of the words and of counted fixtures like
// "SUPPRESSED COMMENTS (5)" — a body routinely contains the phrase as ordinary
// text. Counting those blocks a PR that has no hidden findings at all.
//
// Three defences, narrowest first:
//
//   0. drop fenced code blocks before matching. This is the realistic vector:
//      Copilot quotes the offending lines back inside ``` fences, so a PR that
//      merely touches this file would otherwise fail its own gate.
//   1. the phrase as the collapsed block's <summary> heading — the real thing.
//      The count is optional, so a heading that stops printing "(N)" still
//      matches.
//   2. failing that, the phrase at the START OF A LINE carrying an explicit
//      "(N)". That is the shape a heading takes if GitHub drops
//      <details>/<summary> ("**Suppressed comments (2)**"), while mid-sentence
//      prose — "no suppressed comments (3) were found" — never reaches it.
//
// Pass 2 is deliberately kept rather than anchoring to <summary> alone: it
// makes a future markup change degrade to a false SKIP rather than to silence.
// Silence is the failure that auto-approves a PR with hidden findings, and it
// is the one that already shipped once. A false skip is visible and a human
// clears it; silence is not.
// The count is captured only when it is numeric, but a NON-numeric one still
// has to match: presence is what gates the approval, and parseInt's failure
// falls through to `|| 1`. Requiring digits would make "(N)" or "(many)" read
// as no block at all — silence, the one failure direction this gate exists to
// prevent.
const COUNT = String.raw`\((?:(\d+)|[^)]*)\)`;
const FENCED_CODE_RE = /```[\s\S]*?```/g;
const SUPPRESSED_IN_SUMMARY_RE = new RegExp(
  String.raw`<summary>\s*(?:\*\*)?\s*${SUPPRESSED_PHRASE}\s*(?:${COUNT})?\s*(?:\*\*)?\s*</summary>`,
  'i',
);
// Anchored at BOTH ends of the line. The anchors, not the count, are what
// separate a heading from prose: "Suppressed comments (5) are documented below"
// fails the trailing anchor, and "No suppressed comments were found" fails the
// leading one. That lets the count stay OPTIONAL here, so a heading stripped of
// both its <details> wrapper and its count still registers instead of going
// silent. A whole line consisting of nothing but the phrase is a heading.
const SUPPRESSED_HEADING_RE = new RegExp(
  String.raw`^[>\s]*(?:#{1,6}\s*)?(?:\*\*|__)?\s*${SUPPRESSED_PHRASE}\s*(?:${COUNT})?\s*(?:\*\*|__)?\s*$`,
  'im',
);

// Number of suppressed comments in a review body; 0 when there is no such block.
// A matched block with an unparseable count still returns 1 — presence is what
// gates the approval, the number is only for the human-readable reason string.
function countSuppressedComments(body) {
  const text = String(body || '').replace(FENCED_CODE_RE, '');
  const m = SUPPRESSED_IN_SUMMARY_RE.exec(text) || SUPPRESSED_HEADING_RE.exec(text);
  if (!m) return 0;
  return parseInt(m[1], 10) || 1;
}

// Since 2026-10 Copilot opens its review body with an overview: a marker, a
// verdict heading, then the issues still open across all rounds (verified on
// SteerSpec/strspc-pr-review#127 and #128 and SteerSpec/strspc-manager#177):
//
//   <!-- ccr-overview-v2 -->
//   ### 🟢 Approval recommended
//   **No open issues** 🎉
//
// or "<summary><strong>2 open issues</strong></summary>", and findings withheld
// from the inline comments under "<summary><strong>1 previously missed
// issue</strong></summary>". None of that reaches listCommentsForReview, and the
// suppressed-comment patterns above do not match it, so such a review used to
// read as clean. A green verdict is not enough on its own: #127 had one over an
// open High issue.
//
// "Needs a closer look" with no open issues passes only when copilot-clean-on is
// `no-open-issues`, the one verdict that setting touches. Often it just asks a
// human to verify something, and no commit can answer that (strspc-CLI#177). But
// "No open issues" covers published threads only: in a sample of 352 SteerSpec PRs
// (2026-10-31), 25 of 70 such reviews named a concrete defect or finding in the
// verdict sentence, e.g. .github#9, "Two hidden findings ... were omitted from the
// published review". So it is a repo's choice, not the default. That sentence is
// free prose, and is deliberately not parsed to tell the two apart: a keyword
// match caught 18 of those 25 with 2 false positives. The same holds under
// "Approval recommended": 1 of 166 clean green reviews in that sample said an
// issue remained (strspc-CLI#147, round 3 of 3, so the rounds rule approved it
// anyway). That is an accepted risk, not a gap this gate can close.
//
// This gate proves a review clean rather than looking for known problems, so a
// wording it has not seen is a skip, not silence. Same reasoning as the
// suppressed-comment gate: a false skip is visible, and the rounds threshold
// still releases the PR. That is why:
//   - collapsed sections are an allowlist: an unknown or unlabelled one blocks;
//   - "No open issues" counts only before the first collapsed section, which is
//     where the PR-derived text starts;
//   - what proves a review clean is read with fences removed, and what blocks it
//     is read from the raw body, so a fence can only cause a false skip;
//   - the marker is matched loosely enough to survive a new version, and a known
//     verdict heading or an open-issues statement identifies an overview without it.
const OVERVIEW_MARKER_RE = /<!--\s*ccr-overview\b[^>]*-->/i;
const KNOWN_VERDICT_RE = /^#{1,6}\s.*(?:Approval recommended|Changes recommended|Needs a closer look)/im;
const FIRST_HEADING_RE = /^#{1,6}\s+(.+?)\s*$/m;
const APPROVAL_VERDICT_RE = /^[^\p{L}\p{N}]*Approval recommended$/iu;
const CLOSER_LOOK_VERDICT_RE = /^[^\p{L}\p{N}]*Needs a closer look$/iu;
// Both wordings Copilot has used. Not the bare phrase: review summaries of PRs
// about this gate use it in prose, which would skip them for nothing.
const PREVIOUSLY_MISSED_RE = /\b[1-9]\d*\s+previously missed|previously missed\s*\((?!0\))/i;
const OPEN_ISSUES_RE = /<summary\b[^>]*>(?:(?!<\/summary>)[\s\S])*?(\d+)\s+open issues?\b/i;
const NO_OPEN_ISSUES_RE = /^\s*\*\*No open issues\*\*/im;
const SECTION_RE = /<summary\b[^>]*>([\s\S]*?)<\/summary>/gi;
const SAFE_SECTION_RE = /^(?:What changed in this PR|\d+ resolved since last review)$/i;

// copilot-clean-on, normalised. Only an exact `no-open-issues` opts in. Blank is
// the default, `verdict`, because a caller passing an unset variable sends ''
// rather than the action's default. Anything else also reads as `verdict`, with a
// warning, so a typo cannot select the looser reading.
function getCopilotCleanOn(env = process.env, warn) {
  const raw = String(env.AUTO_APPROVE_COPILOT_CLEAN_ON || '').trim().toLowerCase();
  if (raw === 'no-open-issues') return raw;
  if (raw !== '' && raw !== 'verdict' && typeof warn === 'function') {
    warn(`pr-auto-approve: unrecognised copilot-clean-on ${JSON.stringify(raw)}, using 'verdict'`);
  }
  return 'verdict';
}

// The verdict heading of an overview review body, '' when it has none. null when
// the body is not an overview.
function overviewVerdict(body) {
  const unfenced = String(body || '').replace(FENCED_CODE_RE, '');
  const isOverview = OVERVIEW_MARKER_RE.test(unfenced)
    || KNOWN_VERDICT_RE.test(unfenced)
    || OPEN_ISSUES_RE.test(unfenced)
    || NO_OPEN_ISSUES_RE.test(unfenced);
  if (!isOverview) return null;
  const heading = FIRST_HEADING_RE.exec(unfenced);
  return heading ? heading[1] : '';
}

// Why a review body blocks approval; '' when it proves the review clean.
// Completes "latest Copilot review …". A body that is not an overview proves
// nothing: Copilot has posted only overviews since 2026-10 (852 sampled across
// SteerSpec, no legacy "generated no new comments" body since 2026-08), and the
// non-overview bodies seen since were reviews of nothing. An empty body skips
// for the same reason.
function overviewBlocker(body, cleanOn = 'verdict') {
  const verdict = overviewVerdict(body);
  if (verdict === null) return 'has no verdict overview';
  const verdictPasses = APPROVAL_VERDICT_RE.test(verdict)
    || (cleanOn === 'no-open-issues' && CLOSER_LOOK_VERDICT_RE.test(verdict));
  if (!verdictPasses) return `has verdict '${verdict || 'none'}'`;
  const raw = String(body || '');
  const unfenced = raw.replace(FENCED_CODE_RE, '');
  const open = OPEN_ISSUES_RE.exec(raw);
  if (open) return `lists ${open[1]} open issue(s)`;
  if (!NO_OPEN_ISSUES_RE.test(unfenced.split(/<details\b/i)[0])) return 'does not state no open issues';
  if (PREVIOUSLY_MISSED_RE.test(raw)) return 'lists a previously missed issue';
  const sections = [...raw.matchAll(SECTION_RE)];
  for (const [, inner] of sections) {
    const label = inner.replace(/<[^>]*>/g, '').trim();
    if (!SAFE_SECTION_RE.test(label)) return `has section '${label}'`;
  }
  if ((raw.match(/<details\b/gi) || []).length > sections.length) return "has section 'unlabelled'";
  return '';
}

// Copilot posts a COMMENTED review with zero inline comments when it reviewed
// nothing. Three wordings seen in production:
//   - its run failed (SteerSpec/strspc-rules#83): "Copilot encountered an error
//     and was unable to review this pull request. You can try again by
//     re-requesting a review.";
//   - the requester is out of quota (SteerSpec/strspc-pr-review#87, three in a
//     row): "Copilot was unable to review this pull request because the user who
//     requested the review has reached their quota limit.";
//   - every changed file is excluded (SteerSpec/strspc-rules#87): "Copilot wasn't
//     able to review any files in this pull request.", see reviewedNoFiles.
// The first two are the absence of a review, not a clean one, so they must
// neither approve as copilot-clean nor count toward the rounds threshold, and
// are dropped from the review list. Anchored to the start of the body, which
// Copilot writes in full, and COMMENTED-only: a review that quotes a phrase, or
// a CHANGES_REQUESTED review, must never be filtered out (that would fail open).
// Exact production wordings only, matched against the start of the whole body,
// deliberately not each line: a line can carry PR-derived prose, and a match
// drops the review, which lets an older review of the same head become the
// latest. An unknown variant (another reason, a preamble) therefore stays a
// review, which cannot pass as clean (it has no overview) and at worst counts as
// a round, as before.
const NO_REVIEW_CAUSES = [
  [/^Copilot encountered an error and was unable to review this pull request\./i, 'errored'],
  [/^Copilot was unable to review this pull request because the user who requested the review has reached their quota limit\./i, 'hit the requester\'s quota'],
];
// Why Copilot reviewed nothing in this review, for the skip reason; '' when it
// is a real review.
function noReviewCause(review) {
  if (review.state !== 'COMMENTED') return '';
  const body = String(review.body || '').trim();
  const hit = NO_REVIEW_CAUSES.find(([re]) => re.test(body));
  return hit ? hit[1] : '';
}
const isErroredReview = (review) => noReviewCause(review) !== '';

// The no-files sentence comes after a verdict heading and a summary, so it can
// only be matched on a line of its own, where PR-derived prose could put it too.
// Dropping such a review would fail open: an older clean review of the same head
// would become the latest. So it stays the latest review and blocks approval
// (see the copilot-clean path), and only stops counting as a round, which can
// only delay an approval.
const NO_FILES_REVIEWED_RE = /^Copilot wasn['’]t able to review any files in this pull request\./im;
function reviewedNoFiles(review) {
  return NO_FILES_REVIEWED_RE.test(String(review.body || '').replace(FENCED_CODE_RE, ''));
}
const countRounds = (copilotReviews) => copilotReviews.filter((r) => !reviewedNoFiles(r)).length;

// Trimmed so a whitespace-only value counts as empty, not as a (bogus) login.
function getBotLogin() { return (process.env.AUTO_APPROVE_BOT_LOGIN || '').trim(); }
// Comma-separated set of base branches a PR must target to be eligible.
// Whitespace-only/empty falls back to the default so a blank input never makes
// every PR ineligible. Accepts an env override for direct unit testing.
function getBaseBranches(env = process.env) {
  const raw = (env && env.AUTO_APPROVE_BASE_BRANCH) || '';
  const branches = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return new Set(branches.length ? branches : ['main']);
}
// Conventional Commit type of a PR title ("fix(api)!: x" -> "fix"), lowercased;
// null when the title is not conventional. The title, not the commits, is the
// source of truth: squash-merge uses it and release-please reads it.
function parseCommitType(title) {
  const m = /^\s*([A-Za-z]+)(?:\([^)]*\))?!?:/.exec(String(title || ''));
  return m ? m[1].toLowerCase() : null;
}

// "docs:1,chore:1,default:3" -> Map(type -> rounds). Unlike rounds-threshold,
// 0 is a valid value here: Copilot is not required for that type. Malformed
// entries are dropped rather than throwing, so a typo never wedges every PR.
function parseRoundsByType(raw) {
  const map = new Map();
  for (const entry of String(raw || '').split(',')) {
    const parts = entry.split(':').map((s) => s.trim());
    // Exactly two fields: "docs:0:oops" must not quietly select the no-Copilot path.
    if (parts.length !== 2 || !parts[0] || !/^\d+$/.test(parts[1])) continue;
    const [type, count] = parts;
    map.set(type.toLowerCase(), parseInt(count, 10));
  }
  return map;
}

// Rounds threshold for one PR title: the type's entry, else `default`, else
// the plain rounds-threshold input. `defaultThreshold` is what a PR of any
// other type gets (`default`, else rounds-threshold): the bar a relaxed type is
// measured against. `roundsThreshold` is the plain input (never below 1), the
// bar of last resort when `default` is itself 0. Accepts an env override for
// unit tests.
function resolveThreshold(title, env = process.env) {
  const type = parseCommitType(title);
  const byType = parseRoundsByType(env.AUTO_APPROVE_ROUNDS_BY_TYPE);
  const roundsThreshold = Math.max(1, parseInt(env.AUTO_APPROVE_ROUNDS_THRESHOLD, 10) || 3);
  const defaultThreshold = byType.has('default') ? byType.get('default') : roundsThreshold;
  const threshold = type !== null && byType.has(type) ? byType.get(type) : defaultThreshold;
  return { threshold, type, defaultThreshold, roundsThreshold };
}

// Paths a PR may touch for a RELAXED type (one mapped below the default) to
// apply. The title is author-controlled, so on its own it must never lower the
// review gate: a `chore:0` or `docs:1` PR that also edits code gets the default
// rules. Threshold 0 was gated from the start; a type set to 1 is the same
// hole one notch up (a single commented review approves code), so the gate
// covers every type below the default. Types at or above it are not relaxed
// and are never gated, with one exception: 0 is always relaxed, so a
// `default:0` mapping cannot waive Copilot for code (it falls back to
// rounds-threshold, as 0 always did).
// The compare endpoint's files array stops at 300 entries (it paginates commits,
// not files: the list appears on the first page only), so a list that long may
// be truncated and cannot prove the PR is docs-only. null means "cannot tell".
const MAX_LISTED_FILES = 300;
function changedFileNames(changed) {
  if (changed.length >= MAX_LISTED_FILES) return null;
  return changed.flatMap((f) => [f.filename, f.previous_filename]).filter(Boolean);
}

// Changed files of exactly `headSha`, as the names filesMatchPaths expects.
// pulls.listFiles describes whatever the PR's head is when it is called, and
// the head re-reads around the approval cannot tell that apart from a force-push
// that moves the head away and back (A -> B -> A) between the listing and the
// re-read. compare(base...sha) is addressed by the SHA, so the list is the
// evaluated head's by construction; a SHA no longer on the PR is a 404, which
// the top-level catch turns into an "evaluation failed" skip. Three-dot against
// the base BRANCH is what the PR's Files tab shows (merge-base to head), so a
// base that moved on since the PR opened does not pull its commits into the
// list. The branch is named as `heads/<ref>`: a bare name is resolved like a
// git revision, so a TAG of the same name could shadow the branch and the diff
// would be computed from the wrong base (verified: `heads/<tag-name>` is a 404,
// `<tag-name>` resolves). Needs `contents: read` on github-token, which the
// shipped caller grants.
//
// Also returned: the merge base the diff was computed from. The diff of a
// three-dot comparison depends on nothing but the merge base and the head, so
// the merge base is the one value that proves the base branch was not REWRITTEN
// (force-pushed) between this listing and the approval; a base that merely
// moved on keeps the same merge base and is not a change.
async function compareHead({ github, owner, repo, baseRef, headSha }) {
  const { data } = await github.rest.repos.compareCommitsWithBasehead({
    owner, repo, basehead: `heads/${baseRef}...${headSha}`, per_page: 1,
  });
  // A response without a files array has not listed the files: "cannot tell",
  // never "nothing changed".
  return {
    names: Array.isArray(data.files) ? changedFileNames(data.files) : null,
    mergeBase: (data.merge_base_commit && data.merge_base_commit.sha) || null,
    totalCommits: data.total_commits,
  };
}

// Threshold a PR actually gets once the path gate is applied, plus a note for
// the reason string when the gate changed it. Only a relaxed type pays for the
// file listing; the default rules need no file list. `mergeBase` is set only
// when the relaxed threshold was KEPT on the strength of that listing: that is
// the one outcome that rests on the diff, so it is the one the caller must
// re-verify before and after approving.
// `compared`, when given, is a compareHead result for the same head and base
// (the protected-paths gate's), reused instead of listing the files again.
async function applyPathGate({ github, owner, repo, baseRef, headSha, title, env = process.env, compared = null }) {
  const { threshold, type, defaultThreshold, roundsThreshold } = resolveThreshold(title, env);
  const unverified = { threshold, type, note: '', mergeBase: null };
  if (threshold !== 0 && threshold >= defaultThreshold) return unverified;
  const { names, mergeBase } = compared || await compareHead({ github, owner, repo, baseRef, headSha });
  const strict = defaultThreshold > threshold ? defaultThreshold : roundsThreshold;
  const relaxedTo = `type '${type || 'none'}' is relaxed to ${threshold} round(s) but`;
  if (!filesMatchPaths(names, getOptionalPaths(env))) {
    return {
      threshold: strict,
      type,
      note: `${relaxedTo} the PR touches files outside copilot-optional-paths, so the default ${strict} applies`,
      mergeBase: null,
    };
  }
  // Without a merge base the diff cannot be re-verified at approval time, so
  // the relaxation is not granted: the one failure direction this gate exists
  // to prevent is an unverifiable approval.
  if (!mergeBase) {
    return {
      threshold: strict,
      type,
      note: `${relaxedTo} the comparison reported no merge base, so the diff cannot be re-verified and the default ${strict} applies`,
      mergeBase: null,
    };
  }
  return { threshold, type, note: '', mergeBase };
}

// The commits of an allowlist PR must all be read to know its parties; past
// this many the run cannot afford to, so the PR waits.
const MAX_COMPARED_COMMITS = 250;

// Logins of every commit's author and committer. A commit with either one not
// linked to a GitHub account has a party that cannot be checked. `web-flow` as
// committer is GitHub signing a web or merge commit, not a party; as an author
// it is a party like any other.
function commitParties(commits) {
  const logins = [];
  for (const c of commits) {
    const author = c.author && c.author.login;
    const committer = c.committer && c.committer.login;
    if (!author || !committer) return { logins, unlinkedSha: String(c.sha || '') };
    logins.push(author);
    if (committer.toLowerCase() !== 'web-flow') logins.push(committer);
  }
  return { logins, unlinkedSha: null };
}

// The comparison's commits, page by page. Same SHA-addressed comparison as the
// file list, so the commits are the evaluated head's; pulls.listCommits would
// describe whatever the head is when it is called. The response is one object
// per page, so github.paginate does not apply. Commits are kept once per SHA:
// a page repeated by the API must not stand in for one that was never read.
// A page adding nothing new ends the loop.
async function listCompareCommits({ github, owner, repo, baseRef, headSha, totalCommits }) {
  const bySha = new Map();
  for (let page = 1; bySha.size < totalCommits; page++) {
    const { data } = await github.rest.repos.compareCommitsWithBasehead({
      owner, repo, basehead: `heads/${baseRef}...${headSha}`, per_page: 100, page,
    });
    const before = bySha.size;
    for (const c of Array.isArray(data.commits) ? data.commits : []) {
      if (c && c.sha && !bySha.has(c.sha)) bySha.set(c.sha, c);
    }
    if (bySha.size === before) break;
  }
  return [...bySha.values()];
}

// Why the parties of an allowlist PR do not all pass, or '' when they do. The
// PR author first, since that needs no API call.
async function allowlistBlocker({ github, owner, repo, pr, totalCommits, allowed }) {
  const author = pr.user && pr.user.login;
  if (!author) return 'the PR has no author account';
  const notAllowed = (login) => `party '${login}' is not on protected-paths-allowed`;
  if (!allowed.has(author.toLowerCase())) return notAllowed(author);
  if (typeof totalCommits !== 'number') return 'the comparison did not report how many commits the PR has';
  // A PR that changes a file has a commit; none means the response is wrong.
  if (totalCommits < 1) return 'the comparison reported no commits';
  if (totalCommits > MAX_COMPARED_COMMITS) {
    return `the PR has ${totalCommits} commits, more than the ${MAX_COMPARED_COMMITS} that can be checked`;
  }
  const commits = await listCompareCommits({
    github, owner, repo, baseRef: pr.base.ref, headSha: pr.head.sha, totalCommits,
  });
  if (commits.length < totalCommits) return `the comparison returned ${commits.length} of ${totalCommits} commits`;
  const { logins, unlinkedSha } = commitParties(commits);
  if (unlinkedSha !== null) {
    return `commit ${unlinkedSha.slice(0, 8)} has an author or committer with no GitHub account`;
  }
  const stranger = logins.find((l) => !allowed.has(l.toLowerCase()));
  return stranger ? notAllowed(stranger) : '';
}

// protected-paths: whether a PR touching the listed globs may go on to the
// normal rules ('normal') or must wait for a human ('wait'). Every way of not
// knowing the changed files waits, before any party is looked at. `mergeBase`
// is set on every 'normal' that rested on the comparison, so the caller
// re-verifies it around the approval; `compared` is that comparison, for
// applyPathGate to reuse. With no globs, or mode approve, nothing is called.
async function evaluateProtectedPaths({ github, owner, repo, pr, warn, env = process.env }) {
  const globs = getProtectedPaths(env);
  if (!globs.length) return { outcome: 'normal', reason: '', mergeBase: null, compared: null };
  const mode = getProtectedPathsMode(env, warn);
  if (mode === 'approve') return { outcome: 'normal', reason: '', mergeBase: null, compared: null };
  const compared = await compareHead({ github, owner, repo, baseRef: pr.base.ref, headSha: pr.head.sha });
  const wait = (why) => ({ outcome: 'wait', reason: why, mergeBase: null, compared });
  const normal = { outcome: 'normal', reason: '', mergeBase: compared.mergeBase, compared };
  if (compared.names === null) {
    return wait(`changed files cannot be completely listed; protected-paths-mode is ${mode}`);
  }
  if (!compared.mergeBase) {
    return wait(`the comparison reported no merge base, so the changed files cannot be re-verified; protected-paths-mode is ${mode}`);
  }
  const match = firstProtectedMatch(compared.names, globs);
  if (!match) return normal;
  const refusal = `protected path '${match}' changed; protected-paths-mode is ${mode}`;
  if (mode === 'manual') return wait(refusal);
  const blocker = await allowlistBlocker({
    github, owner, repo, pr, totalCommits: compared.totalCommits, allowed: getProtectedPathsAllowed(env),
  });
  return blocker ? wait(`${refusal} and ${blocker}`) : normal;
}

// Stamps the threshold an approval relied on (0 = no Copilot review; N = the
// rounds rule), so a later run can withdraw it if a retitle raises the bar. A
// copilot-clean approval is threshold-independent and carries no stamp.
const THRESHOLD_MARKER_RE = /<!-- pr-auto-approve:threshold=(\d+) -->/;
const LEGACY_OPTIONAL_MARKER = '<!-- pr-auto-approve:copilot-optional -->';
const thresholdMarker = (n) => `<!-- pr-auto-approve:threshold=${n} -->`;

// Markdown only. The earlier `docs/**` admitted any file under docs/ (a script,
// a generated HTML page), which is code as far as a review is concerned.
// `docs/**/*.md` is a subset of `**/*.md`; it is kept so the intent reads off
// the value and so a caller trimming the first glob keeps the docs tree. The
// default here and in action.yml must stay identical.
function getOptionalPaths(env = process.env) {
  const list = String(env.AUTO_APPROVE_COPILOT_OPTIONAL_PATHS || '**/*.md,docs/**/*.md')
    .split(',').map((x) => x.trim()).filter(Boolean);
  return list;
}

function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
    } else if (c === '*') {
      re += '[^/]*';
    } else {
      re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

// True when every changed file matches one of the globs. An empty file list
// proves nothing, so it does not qualify.
function filesMatchPaths(filenames, globs) {
  if (!filenames || !filenames.length || !globs.length) return false;
  const res = globs.map(globToRegExp);
  return filenames.every((f) => res.some((re) => re.test(f)));
}

// protected-paths: globs whose change stops auto-approval unless the mode
// lets the PR through. Empty means the feature is off.
function getProtectedPaths(env = process.env) {
  return String(env.AUTO_APPROVE_PROTECTED_PATHS || '')
    .split(',').map((x) => x.trim()).filter(Boolean);
}

// An empty mode is what a caller passes for an unset variable, so it means the
// default, manual. An unrecognised mode also means manual: a typo must never
// turn the protection off.
const PROTECTED_PATHS_MODES = new Set(['approve', 'manual', 'allowlist']);
function getProtectedPathsMode(env = process.env, warn = () => {}) {
  const mode = String(env.AUTO_APPROVE_PROTECTED_PATHS_MODE || '').trim().toLowerCase();
  if (!mode) return 'manual';
  if (PROTECTED_PATHS_MODES.has(mode)) return mode;
  warn(`pr-auto-approve: unknown protected-paths-mode '${mode}', using manual`);
  return 'manual';
}

// Logins compare case-insensitively, as GitHub's do. A leading @ is kept, so
// it matches no login rather than being guessed away.
function getProtectedPathsAllowed(env = process.env) {
  return new Set(String(env.AUTO_APPROVE_PROTECTED_PATHS_ALLOWED || '')
    .split(',').map((x) => x.trim().toLowerCase()).filter(Boolean));
}

// The first changed file matching any glob, or null. Unlike filesMatchPaths,
// one match is enough.
function firstProtectedMatch(filenames, globs) {
  if (!filenames || !globs.length) return null;
  const res = globs.map(globToRegExp);
  return filenames.find((f) => res.some((re) => re.test(f))) || null;
}

function getSandboxRepos() {
  const raw = process.env.AUTO_APPROVE_SANDBOX_REPOS || '';
  return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
}
function getAllowNoChecks() { return (process.env.AUTO_APPROVE_ALLOW_NO_CHECKS || '').toLowerCase() === 'true'; }
// Seconds to wait for Copilot's review check to finish before giving up.
// 0 (the default) preserves the historical behaviour of skipping immediately.
// Opt-in because waiting consumes billable Actions minutes on private repos.
function getCopilotWaitSeconds() {
  return Math.max(0, parseInt(process.env.AUTO_APPROVE_COPILOT_WAIT_SECONDS, 10) || 0);
}
// Poll interval while waiting. Not an action input — only the tests override it,
// so they don't have to sleep in real time.
function getCopilotPollMs() {
  return Math.max(1, parseInt(process.env.AUTO_APPROVE_COPILOT_POLL_MS, 10) || 15000);
}

function isCopilot(u) {
  if (!u) return false;
  return COPILOT_LOGINS.has(u.login);
}

// Test-only: the e2e harness can opt in to treat additional reviewer
// logins as "Copilot" by setting AUTO_APPROVE_COPILOT_TEST_LOGINS to a
// comma-separated list. The input is only honored when the CALLER repo is
// on the sandbox allowlist — so a production consumer that accidentally
// (or intentionally) passes test_copilot_logins cannot bypass the Copilot
// gate. Add a repo to AUTO_APPROVE_SANDBOX_REPOS only after deliberate review.

// Valid GitHub login shape (alphanumerics + hyphens, optional [bot] suffix).
// Anything else is silently dropped with a warning — a malformed test login
// can never match a real reviewer, so without validation the e2e harness
// would degrade to "no Copilot review yet" and time out later.
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/;

function parseTestLogins(env, contextRepo, warn) {
  const raw = (env && env.AUTO_APPROVE_COPILOT_TEST_LOGINS) || '';
  if (!raw) return new Set();
  const fullName = contextRepo
    ? `${contextRepo.owner}/${contextRepo.repo}`
    : '';
  if (!getSandboxRepos().has(fullName)) {
    // Silently ignore outside sandbox — matches "disabled" behavior so
    // a misconfigured consumer gets the production code path.
    return new Set();
  }
  const accepted = new Set();
  for (const candidate of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (LOGIN_RE.test(candidate)) {
      accepted.add(candidate);
    } else if (typeof warn === 'function') {
      warn(`ignored invalid login in AUTO_APPROVE_COPILOT_TEST_LOGINS: ${JSON.stringify(candidate)}`);
    }
  }
  return accepted;
}

function makeIsCopilot(testLogins) {
  if (!testLogins || testLogins.size === 0) return isCopilot;
  return (u) => {
    if (!u) return false;
    if (testLogins.has(u.login)) return true;
    return isCopilot(u);
  };
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Drop the API host so the reason string stays readable in a Slack message and
// a check summary; the path is the part that identifies the call.
const stripApiHost = (url) => String(url).replace(/^https?:\/\/[^/]+/, '');

// A completed check that blocks approval. Shared by the failing-check gate and
// by the Copilot wait, so the two can never drift into disagreeing about what
// counts as a failure.
const CHECK_OK_CONCLUSIONS = ['success', 'neutral', 'skipped', 'cancelled', 'stale'];
const isFailedCheck = (cr) =>
  cr.status === 'completed' && !CHECK_OK_CONCLUSIONS.includes(cr.conclusion);

// Check runs for a SHA: paginate, drop this workflow's own run, dedupe by
// (name, app.id) keeping the latest attempt. Prevents the self-pending trap
// (this job waiting on its own check) and rerun staleness.
async function fetchCheckRuns({ github, context, owner, repo, headSha }) {
  // Direct call (not paginate): 100 per page covers all practical repos; loop pages if needed.
  const allCheckRuns = [];
  let page = 1;
  while (true) {
    const { data } = await github.rest.checks.listForRef({
      owner, repo, ref: headSha, per_page: 100, page,
    });
    const runs = data.check_runs || [];
    allCheckRuns.push(...runs);
    if (allCheckRuns.length >= data.total_count || runs.length === 0) break;
    page++;
  }
  const selfRunId = String(context.runId);
  // Bounded match: `/runs/111` must not match `/runs/1111`. Accept the id
  // only when followed by `/` (job path) or end-of-string.
  const selfRunRe = new RegExp(`/runs/${selfRunId}(/|$)`);
  const validCheckRuns = allCheckRuns.filter((cr) => cr != null);
  // Sibling runs of this same job (an earlier pull_request_target run being
  // cancelled by the concurrency group, say) report a check with the job's name
  // and are not CI either. Waiting on one stalls a PR that nothing re-triggers,
  // e.g. a type-0 PR, which posts no review to wake the workflow again.
  const selfJobNames = new Set(['auto-approve', context.job].filter(Boolean));
  const notSelf = validCheckRuns.filter(
    (cr) => !(cr.details_url && selfRunRe.test(cr.details_url)) &&
      // Only an UNFINISHED sibling is ignored: a completed (say failing) check that
      // happens to share the name is still a real result and keeps counting.
      !(selfJobNames.has(cr.name) && cr.status !== 'completed'),
  );
  // Dedupe by (name, app.id) keeping the most-recently-started run. A run with
  // no timestamp has not started yet, so it is the newest, not the oldest:
  // scoring it 0 would let an older green run hide a queued rerun.
  const latestByKey = new Map();
  for (const cr of notSelf) {
    const key = `${cr.name}::${cr.app && cr.app.id}`;
    const stamp = cr.started_at || cr.completed_at;
    const ts = stamp ? (Date.parse(stamp) || 0) : Infinity;
    const prev = latestByKey.get(key);
    const isNewer =
      !prev ||
      ts > prev._ts ||
      (ts === prev._ts && (cr.id || 0) > (prev.id || 0));
    if (isNewer) {
      latestByKey.set(key, Object.assign({}, cr, { _ts: ts }));
    }
  }
  return [...latestByKey.values()];
}

// Poll until every check completes, one fails, or the deadline passes, and
// return the freshest check-run list — the caller re-applies the failing and
// pending gates to whatever comes back, so a Copilot check that ends in failure
// is still caught.
//
// The wait starts only when Copilot's check is pending, but once started it
// covers every pending check, including CI after Copilot has finished. CI's
// completion is supposed to re-trigger this workflow, but that workflow_run
// event can fail to arrive (strspc-pr-review#198: a PR whose only run started on
// an early workflow, skipped while CI ran, and was never evaluated again). So
// the earliest run waits. A later run, such as CI's, cancels it through the
// caller's concurrency group and takes over. Cost: on private repos, a waiting
// run bills its minutes from the first completed workflow until the checks
// finish, a later run supersedes it, or the budget runs out. A failed check
// ends the wait at once. Remaining gap: when Copilot registers no check run,
// nothing starts this wait and the PR still relies on CI's event.
async function waitForCopilotCheck({
  github, context, core, owner, repo, headSha, checkRuns, waitSeconds, deadline, sleep,
}) {
  const names = (runs) => runs.map((cr) => cr.name).join(', ');
  let current = checkRuns;
  let waiting = false;
  while (true) {
    // A check has already failed, so approval is impossible whatever Copilot
    // says. Return now rather than spending the timeout to reach the same skip.
    const failed = current.find(isFailedCheck);
    if (failed) {
      core.info(`pr-auto-approve: ${waiting ? 'wait ended' : 'not waiting'}: check failed: ${failed.name}`);
      return current;
    }
    const pending = current.filter((cr) => cr.status !== 'completed');
    if (pending.length === 0) return current;
    if (!waiting) {
      const copilot = pending.filter((cr) => COPILOT_CHECK_NAMES.has(cr.name));
      const others = pending.filter((cr) => !COPILOT_CHECK_NAMES.has(cr.name));
      if (copilot.length === 0) {
        core.info(
          `pr-auto-approve: not waiting: Copilot's check is not pending; ` +
            `${others.length} other check(s) pending: ${names(others)}`,
        );
        return current;
      }
      core.info(
        `pr-auto-approve: waiting up to ${waitSeconds}s for ${names(copilot)}` +
          (others.length ? ` and ${others.length} other check(s): ${names(others)}` : ''),
      );
      waiting = true;
    }
    if (Date.now() >= deadline) {
      core.warning(
        `pr-auto-approve: gave up waiting for ${names(pending)} after ${waitSeconds}s`,
      );
      return current;
    }
    await sleep(Math.min(getCopilotPollMs(), Math.max(0, deadline - Date.now())));
    current = await fetchCheckRuns({ github, context, owner, repo, headSha });
  }
}

// Every client the action uses is built here, so a transient GitHub failure (a
// 5xx, or a dropped connection, which @octokit/request reports as a 500) is
// retried before the run gives up: 3 retries, 1 s + 4 s + 9 s apart, through
// @octokit/plugin-retry, which github-script v9's injected getOctokit carries.
// 4xx stay unretried (the plugin's doNotRetry default: 400, 401, 403, 404, 410,
// 422, 451), so a refused PAT still reaches dismissReview's fallback at once.
// Do NOT use github-script's `retries` input instead: it sets the count in
// `request.retries`, and the plugin then retries every status, exempt ones
// included, with no delay (verified against plugin-retry 8.1.0). Keeping the
// count in `retry.retries` is what makes doNotRetry hold.
const API_RETRIES = 3;

function makeApiClient(getOctokit, token) {
  return getOctokit(token, { retry: { enabled: true, retries: API_RETRIES } });
}

// A Copilot review "covers" the head when it names the head commit, or when
// enough rounds exist for the threshold rule to decide without freshness.
// Dismissing needs write access, not the bot's identity. The bot PAT that can
// post an approval is refused (403) on some setups, so retry once with the
// workflow's own token, which carries the caller job's `pull-requests: write`.
async function dismissReview({ github, botGithub, params }) {
  try {
    return await botGithub.rest.pulls.dismissReview(params);
  } catch (err) {
    if (botGithub === github || ![401, 403].includes(err.status)) throw err;
    return github.rest.pulls.dismissReview(params);
  }
}

function copilotHasReviewedHead(copilotReviews, headSha, threshold) {
  if (copilotReviews.length === 0) return false;
  if (countRounds(copilotReviews) >= threshold) return true;
  const latest = copilotReviews[copilotReviews.length - 1];
  return latest.commit_id === headSha;
}

// Poll the PR's reviews until Copilot has reviewed the head or the deadline
// passes. Returns the latest Copilot review list either way; the caller then
// applies the usual rules to it.
async function waitForCopilotReview({
  core, headSha, threshold, deadline, sleep, initial, load,
}) {
  let current = initial;
  let polled = false;
  while (!copilotHasReviewedHead(current, headSha, threshold)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      core.warning(
        `pr-auto-approve: gave up waiting for a Copilot review of ${headSha} after the wait budget`,
      );
      return { reviews: current, polled };
    }
    core.info(`pr-auto-approve: waiting for Copilot to review ${headSha} (${Math.ceil(remaining / 1000)}s left)`);
    await sleep(Math.min(getCopilotPollMs(), remaining));
    current = await load();
    polled = true;
  }
  return { reviews: current, polled };
}

// Reviewer login accepted by the REST requested_reviewers endpoint; the review
// then shows up as `Copilot` in the PR timeline. Verified on a ruleset-free repo.
const COPILOT_REVIEWER = 'copilot-pull-request-reviewer[bot]';

// Requests the Copilot review unless the PR's type needs none (threshold 0 and
// every changed file optional). Best-effort: requesting is a convenience and
// must never turn the check red, so errors only warn. The title is read from
// the event payload, never interpolated into a script. Returns 'requested',
// 'skipped' or 'error' so callers and tests can tell the outcomes apart.
async function requestCopilotReview({ github, context, core, env = process.env }) {
  try {
    const { owner, repo } = context.repo;
    const pr = context.payload.pull_request;
    if (findPromotionPair(pr, getPromotionPairs(env)) || findReleaseRoute(pr, getReleaseRoutes(env))) {
      core.info('pr-auto-approve: promotion or release PR does not need Copilot; not requesting a review');
      return 'skipped';
    }
    // Only a 0 can make the review unnecessary; any other relaxed type still
    // needs Copilot, so the file listing is spent on 0 alone.
    let { threshold, type } = resolveThreshold(pr.title, env);
    if (threshold === 0) {
      ({ threshold } = await applyPathGate({
        github, owner, repo, baseRef: pr.base.ref, headSha: pr.head.sha, title: pr.title, env,
      }));
    }
    if (threshold === 0) {
      core.info(`pr-auto-approve: type '${type}' does not need Copilot; not requesting a review`);
      return 'skipped';
    }
    await github.rest.pulls.requestReviewers({
      owner, repo, pull_number: pr.number, reviewers: [COPILOT_REVIEWER],
    });
    return 'requested';
  } catch (err) {
    core.warning(
      `pr-auto-approve: could not request a Copilot review: ${err.status || ''} ${err.message || err}`.trim(),
    );
    return 'error';
  }
}

// Max automatic re-requests per head SHA after Copilot errors. 0 (default, also
// any blank/negative/non-numeric value) disables it, so a typo never turns an
// opt-in write call on.
function getErrorRetries(env = process.env) {
  // Whole-string match: parseInt would accept "2foo" or "2.5" as 2.
  const raw = String(env.AUTO_APPROVE_COPILOT_ERROR_RETRIES || '').trim();
  return /^\d+$/.test(raw) ? parseInt(raw, 10) : 0;
}

// Whether a Copilot review request is pending on the PR. Read from GraphQL: the
// REST requested_reviewers list leaves a pending Copilot request out (seen on
// #179, 2026-11-05: REST gave [] while GraphQL reviewRequests held it), so a
// REST-only check never sees the request in flight. GraphQL names the bot
// without the "[bot]" suffix, as a Bot node. Exact names of Bot nodes only: a
// substring match, or a User, could mask a missing Copilot request.
async function copilotRequestPending({ github, owner, repo, prNumber }) {
  const data = await github.graphql(
    `query ($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          reviewRequests(first: 100) {
            nodes { requestedReviewer { __typename ... on Bot { login } } }
          }
        }
      }
    }`,
    { owner, repo, number: prNumber },
  );
  // A response without the list can't prove nothing is pending: throw, so the
  // caller warns and skips the re-request instead of requesting again.
  const pr = data && data.repository && data.repository.pullRequest;
  const nodes = pr && pr.reviewRequests && pr.reviewRequests.nodes;
  if (!Array.isArray(nodes)) {
    throw new Error('the PR\'s review requests could not be read (incomplete GraphQL response)');
  }
  return nodes.some((n) => {
    const r = n && n.requestedReviewer;
    return Boolean(r) && r.__typename === 'Bot' && COPILOT_CHECK_NAMES.has(r.login);
  });
}

// Re-requests the Copilot review after an errored one on the current head.
// `erroredOnHead` comes from the review history, so the cap needs no stored
// state and a re-run cannot exceed it. Best-effort like requestCopilotReview:
// a failure only warns. Returns 'requested', 'exhausted', 'disabled' or 'error'.
async function retryErroredCopilotReview({ github, context, core, prNumber, erroredOnHead, retries }) {
  if (retries <= 0) return 'disabled';
  if (erroredOnHead === 0) return 'none'; // it errored on an older commit only
  if (erroredOnHead > retries) return 'exhausted';
  try {
    const { owner, repo } = context.repo;
    // The budget counts only reviews that already errored, so every run between
    // this request and Copilot's next review would otherwise request again.
    // A request still pending on the PR means the retry is already in flight.
    if (await copilotRequestPending({ github, owner, repo, prNumber })) return 'pending';
    await github.rest.pulls.requestReviewers({
      owner, repo, pull_number: prNumber, reviewers: [COPILOT_REVIEWER],
    });
    return 'requested';
  } catch (err) {
    core.warning(
      `pr-auto-approve: could not re-request a Copilot review: ${err.status || ''} ${err.message || err}`.trim(),
    );
    return 'error';
  }
}

// Events that carry no pull request and ask for a sweep of the open ones.
const SWEEP_EVENTS = new Set(['schedule', 'workflow_dispatch']);
// Most PRs one sweep evaluates, most recently opened first (APPROVE-036). Each costs a dozen or so API
// calls, and a repo with more open PRs than this has bigger problems.
const SWEEP_MAX_PRS = 30;

function isSweep(context) {
  return SWEEP_EVENTS.has(context.eventName) && !(context.payload && context.payload.pull_request);
}

async function decide(args) {
  return isSweep(args.context) ? sweep(args) : evaluate(args);
}

// The fallback for an event that never arrived. A PR is approved by a run that
// one of its own events starts, and GitHub does not always deliver one: CI's
// workflow_run can go missing (#198), and a run Copilot's review triggers is
// held at action_required. Nothing then evaluates the PR again until someone
// pushes. A sweep evaluates every open PR the caller's `if:` would admit, each
// as if its own event had arrived, so the rules are the per-PR rules unchanged.
// It never waits for Copilot: a PR still in progress has events to come.
async function sweep({ github, botGithub = github, context, core, sleep = defaultSleep }) {
  // An empty bot-login fails the job before any PR is read, exactly as it does
  // on an event run (APPROVE-012).
  if (!getBotLogin()) return evaluate({ github, botGithub, context, core, sleep });

  const finish = (decision, reason, prOutputs = {}) => {
    core.info(`pr-auto-approve sweep decision=${decision} reason=${reason}`);
    core.setOutput('decision', decision);
    core.setOutput('reason', reason);
    for (const key of ['pr_url', 'pr_number', 'pr_title', 'pr_author']) {
      core.setOutput(key, prOutputs[key] || '');
    }
    return { decision, reason };
  };

  const { owner, repo } = context.repo;
  const BASE_BRANCHES = getBaseBranches();
  let open;
  try {
    open = await github.paginate(github.rest.pulls.list, {
      owner, repo, state: 'open', sort: 'created', direction: 'desc', per_page: 100,
    });
  } catch (err) {
    core.error(`pr-auto-approve sweep: could not list the open PRs: ${err.status || ''} ${err.message || err}`);
    return finish('skip', `sweep failed: could not list the open PRs: ${err.status || ''} ${err.message || err}`
      .replace(/\s+/g, ' ').trim());
  }
  // The gates evaluate() would apply first, applied here so a PR that can never
  // qualify leaves no decision line behind.
  let candidates = open.filter((p) => !p.draft &&
    p.base && BASE_BRANCHES.has(p.base.ref) &&
    p.head && p.head.repo && p.head.repo.full_name === `${owner}/${repo}`);
  core.info(`pr-auto-approve: sweep: ${candidates.length} of ${open.length} open PR(s) to evaluate`);
  if (candidates.length > SWEEP_MAX_PRS) {
    core.warning(
      `pr-auto-approve: sweep: evaluating the ${SWEEP_MAX_PRS} most recently opened of ${candidates.length} PRs`,
    );
    candidates = candidates.slice(0, SWEEP_MAX_PRS);
  }

  const results = [];
  for (const item of candidates) {
    // Each PR writes its outputs into its own record; the step's outputs are the
    // sweep's, set once at the end. Everything else (logs, summary, setFailed)
    // goes through as it would on an event run.
    const outputs = {};
    const prCore = Object.assign(Object.create(core), {
      setOutput: (key, value) => { outputs[key] = value; },
    });
    let result;
    try {
      // The PR as a pull_request event would carry it, not the list's abridged copy.
      const { data: pr } = await github.rest.pulls.get({ owner, repo, pull_number: item.number });
      const prContext = {
        eventName: context.eventName,
        payload: { pull_request: pr },
        repo: context.repo,
        runId: context.runId,
        job: context.job,
      };
      result = await evaluate({ github, botGithub, context: prContext, core: prCore, sleep, waitSeconds: 0 });
    } catch (err) {
      // evaluate() catches its own failures, so only the read above lands here.
      // One unreadable PR must not stop the others.
      const reason = `evaluation failed: ${err.status || ''} ${err.message || err}`.replace(/\s+/g, ' ').trim();
      core.error(`pr-auto-approve pr=${item.number} decision=skip reason=${reason}`);
      result = { decision: 'skip', reason };
    }
    results.push({ number: item.number, ...result, outputs });
  }

  const approved = results.filter((r) => r.decision === 'approved');
  const errored = results.filter((r) => r.decision === 'error');
  if (approved.length > 0) {
    const rest = results.length - approved.length;
    return finish(
      'approved',
      `sweep approved ${approved.map((r) => `#${r.number} (${r.reason})`).join(', ')}` +
        (rest > 0 ? `; ${rest} other PR(s) not approved` : ''),
      // The notification links one PR; the reason names them all.
      approved[0].outputs,
    );
  }
  if (errored.length > 0) {
    return finish('error', `sweep: ${errored.map((r) => `#${r.number} (${r.reason})`).join(', ')}`, errored[0].outputs);
  }
  return finish('skip', `sweep: ${results.length} PR(s) evaluated, none approved`);
}

async function evaluate(args) {
  try {
    return await decideInner(args);
  } catch (err) {
    // Any unexpected API error (bad/empty token, 403, rate limit, network)
    // is converted to a clean skip so the workflow never flips a required
    // check to red for reasons unrelated to the review state.
    const { core } = args;
    // Name the request that failed. Without it, every failure reads the same --
    // "403 Resource not accessible by personal access token" -- and isolating
    // which of five endpoints was refused took hours the first time.
    const req = err.request || {};
    // Joined rather than interpolated: a missing status used to leave a double
    // space ("evaluation failed:  socket hang up"), and adding the request made
    // that worse.
    let reason = ['evaluation failed:', err.status || '',
      req.url ? `${req.method || 'GET'} ${stripApiHost(req.url)}` : '',
      err.message || err]
      .filter((part) => part !== '' && part !== undefined && part !== null)
      .join(' ');
    // One targeted hint, for the one misconfiguration that cannot be fixed by
    // granting a permission: fine-grained PATs cannot hold `Checks` at all, so
    // a PAT reading check runs on a private repo is permanently broken. Scoped
    // narrowly so it stays a signal rather than noise on unrelated 403s.
    if (err.status === 403 && /\/check-runs/.test(req.url || '')) {
      reason +=
        ' — reading check runs needs the Checks permission, which fine-grained' +
        ' PATs cannot be granted. Reads should use the workflow GITHUB_TOKEN' +
        ' (the github-token input, default); check the caller grants `checks: read`.';
    }
    core.error(`pr-auto-approve ${reason}`);
    core.setOutput('decision', 'skip');
    core.setOutput('reason', reason);
    if (core.summary && typeof core.summary.addRaw === 'function') {
      try {
        await core.summary.addRaw(`**Decision:** skip\n**Reason:** ${reason}\n`).write();
      } catch { /* best-effort */ }
    }
    return { decision: 'skip', reason };
  }
}

async function decideInner({
  github, botGithub = github, context, core, sleep = defaultSleep, waitSeconds: waitOverride,
}) {
  const BOT_LOGIN = getBotLogin();
  const BASE_BRANCHES = getBaseBranches();
  const SANDBOX_REPOS = getSandboxRepos();

  let pr = context.payload.pull_request;

  // Set when the path gate replaced a relaxed threshold with the default, and
  // appended to every reason from then on: "latest Copilot review has 2
  // comments" alone would send a `docs:1` author looking for a bug in the
  // mapping, when the answer is the code file in the diff.
  let thresholdNote = '';

  const setDecision = async (decision, bareReason) => {
    const reason = thresholdNote ? `${bareReason}; ${thresholdNote}` : bareReason;
    core.info(`pr-auto-approve pr=${pr ? pr.number : 'none'} decision=${decision} reason=${reason}`);
    core.setOutput('decision', decision);
    core.setOutput('reason', reason);
    // check_run/workflow_run-triggered runs carry no github.event.pull_request,
    // so the caller's Slack notification steps fall back to these outputs for
    // the PR link/number/title/author instead of emitting an empty/malformed
    // message. `pr` is whatever this closure's outer scope has resolved by
    // the time setDecision runs — null for the handful of skip reasons that
    // fire before a PR is ever resolved (e.g. "no associated PRs").
    core.setOutput('pr_url', pr ? pr.html_url || '' : '');
    core.setOutput('pr_number', pr ? String(pr.number) : '');
    core.setOutput('pr_title', pr ? pr.title || '' : '');
    core.setOutput('pr_author', pr && pr.user ? pr.user.login : '');
    // Summary write is best-effort: a rare I/O failure here must NOT bubble
    // up to the top-level try/catch and flip a successful approval into an
    // "evaluation failed" skip.
    if (core.summary && typeof core.summary.addRaw === 'function') {
      try {
        const prUrl = pr ? pr.html_url : '';
        await core.summary
          .addRaw(`**Decision:** ${decision}\n**Reason:** ${reason}\n**PR:** ${prUrl}\n`)
          .write();
      } catch { /* best-effort */ }
    }
    return { decision, reason };
  };

  // An empty bot login is a misconfiguration, not a skip: the caller's loop
  // guard (`github.actor != vars.STRSPC_PR_AUTO_APPROVE_BOT_LOGIN`) is then always
  // true too, so each approval re-triggers this workflow. That ran away to 17
  // approvals in three minutes once. Fail the job so it cannot pass unnoticed.
  if (!BOT_LOGIN) {
    const reason = 'bot-login is empty: set the STRSPC_PR_AUTO_APPROVE_BOT_LOGIN organization or repository variable ' +
      '(the caller passes it as bot-login and uses it in the job `if:` loop guard)';
    core.error(`pr-auto-approve ${reason}`);
    if (typeof core.setFailed === 'function') core.setFailed(reason);
    return setDecision('error', reason);
  }

  // Backstop for a loop guard that does not match bot-login (e.g. a literal
  // hard-coded in one place only): never evaluate in response to our own review.
  const triggeringReview = context.payload.review;
  if (triggeringReview && triggeringReview.user && triggeringReview.user.login === BOT_LOGIN) {
    return setDecision('skip', 'triggered by the bot\'s own review');
  }

  // pull_request_target / pull_request_review carry the PR in the payload. The
  // caller can no longer filter these by branch in `on:` once the set comes
  // from a variable (`on:` cannot read `vars`), and its `if:` only pre-filters
  // with a substring match, so the exact check lives here, as it does for
  // check_run and workflow_run below.
  if (pr && (!pr.base || !BASE_BRANCHES.has(pr.base.ref))) {
    return setDecision(
      'skip',
      `PR base ref '${pr.base ? pr.base.ref : ''}' not in [${[...BASE_BRANCHES].join(', ')}]`,
    );
  }

  // check_run events don't carry pull_request directly; extract from associated PRs.
  if (!pr && context.payload.check_run) {
    const prs = context.payload.check_run.pull_requests || [];
    if (prs.length === 0) {
      return setDecision('skip', 'check_run: no associated PRs');
    }
    const associatedPrNumber = prs[0] && prs[0].number;
    if (!Number.isInteger(associatedPrNumber) || associatedPrNumber <= 0) {
      return setDecision('skip', 'check_run: associated PR missing valid number');
    }
    const { owner: o, repo: r } = context.repo;
    const { data: fetchedPr } = await github.rest.pulls.get({
      owner: o, repo: r, pull_number: associatedPrNumber,
    });
    if (!fetchedPr.base || !BASE_BRANCHES.has(fetchedPr.base.ref)) {
      return setDecision(
        'skip',
        `check_run: PR base ref '${fetchedPr.base ? fetchedPr.base.ref : ''}' not in [${[...BASE_BRANCHES].join(', ')}]`,
      );
    }
    if (fetchedPr.draft) {
      return setDecision('skip', 'check_run: PR is draft');
    }
    if (!fetchedPr.head || !fetchedPr.head.repo || fetchedPr.head.repo.full_name !== `${o}/${r}`) {
      return setDecision('skip', 'check_run: PR head repo does not match current repo');
    }
    pr = fetchedPr;
  }

  // workflow_run events (for callers whose gating CI reports completion via a
  // separate workflow rather than check_run) don't carry pull_request either;
  // extract from the associated PRs, same shape as the check_run path above.
  if (!pr && context.payload.workflow_run) {
    const wr = context.payload.workflow_run;
    // Only a skipped run says nothing. A failed, timed-out or cancelled run goes
    // through to the check gate, which reads the head's checks itself: a failure
    // on a head the bot already approved must reach the withdrawal there.
    if (wr.conclusion === 'skipped') {
      return setDecision('skip', `workflow_run: conclusion is ${wr.conclusion}`);
    }
    const prs = wr.pull_requests || [];
    if (prs.length === 0) {
      return setDecision('skip', 'workflow_run: no associated PRs');
    }
    const associatedPrNumber = prs[0] && prs[0].number;
    if (!Number.isInteger(associatedPrNumber) || associatedPrNumber <= 0) {
      return setDecision('skip', 'workflow_run: associated PR missing valid number');
    }
    const { owner: o, repo: r } = context.repo;
    if (!wr.head_repository || wr.head_repository.full_name !== `${o}/${r}`) {
      return setDecision('skip', 'workflow_run: head repo does not match current repo');
    }
    const { data: fetchedPr } = await github.rest.pulls.get({
      owner: o, repo: r, pull_number: associatedPrNumber,
    });
    if (!fetchedPr.base || !BASE_BRANCHES.has(fetchedPr.base.ref)) {
      return setDecision(
        'skip',
        `workflow_run: PR base ref '${fetchedPr.base ? fetchedPr.base.ref : ''}' not in [${[...BASE_BRANCHES].join(', ')}]`,
      );
    }
    if (fetchedPr.draft) {
      return setDecision('skip', 'workflow_run: PR is draft');
    }
    if (!fetchedPr.head || !fetchedPr.head.repo || fetchedPr.head.repo.full_name !== `${o}/${r}`) {
      return setDecision('skip', 'workflow_run: PR head repo does not match current repo');
    }
    pr = fetchedPr;
  }

  if (!pr) return setDecision('skip', 'no pull_request in event');

  const { owner, repo } = context.repo;
  const prNumber = pr.number;

  // pull_request_target and pull_request_review carry the PR in the payload, so
  // the check_run and workflow_run gates above never saw it. The caller's `if:`
  // filters these events too, but a caller that wrote its own `if:` may not, and
  // on pull_request_target a fork PR would then reach approval with the bot
  // token. A deleted head repo (null) cannot be shown to be this one, so it
  // skips as well.
  if (pr.draft) return setDecision('skip', 'PR is draft');
  if (!pr.head || !pr.head.repo || pr.head.repo.full_name !== `${owner}/${repo}`) {
    return setDecision('skip', 'PR head repo does not match current repo');
  }

  // Never self-approve — GitHub blocks it anyway, and in prod this guard
  // is load-bearing. Exception: inside sandbox repos the e2e harness runs
  // as both PR author and synthetic reviewer, so without this bypass the
  // harness can never reach the approval path.
  const inSandbox = SANDBOX_REPOS.has(`${owner}/${repo}`);
  if (BOT_LOGIN && pr.user && pr.user.login === BOT_LOGIN && !inSandbox) {
    return setDecision('skip', 'PR author is the bot itself');
  }

  const loadReviews = () => github.paginate(github.rest.pulls.listReviews, {
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  });
  let reviews = null;

  // Threshold an earlier bot approval was stamped with; null for an approval
  // that carries no stamp (copilot-clean, or not ours to judge).
  const stampedThreshold = (r) => {
    if (!r.user || r.user.login !== BOT_LOGIN || r.state !== 'APPROVED') return null;
    const body = String(r.body || '');
    const m = THRESHOLD_MARKER_RE.exec(body);
    // The first marker form (pre-3085536) meant "no Copilot review", i.e. 0.
    return m ? parseInt(m[1], 10) : (body.includes(LEGACY_OPTIONAL_MARKER) ? 0 : null);
  };

  // Dismiss every stamped bot approval `isStale` selects. Loads the reviews
  // (into the shared `reviews`, cleared again if anything was dismissed) and
  // returns an error decision if the reviews cannot be listed or a dismissal
  // fails: a stale approval may then still stand, so neither may read as an
  // ordinary skip. The listing failure in particular must not fall through to
  // the top-level catch: that catch is a skip, and a skip here is precisely the
  // state this helper exists to prevent (an approval the run never found).
  let withdrew = false;
  const failClosed = (reason) => {
    core.error(`pr-auto-approve ${reason}`);
    if (typeof core.setFailed === 'function') core.setFailed(reason);
    return setDecision('error', reason);
  };
  // `unfound` names, for the listing failure, the approval that cannot be found.
  const withdrawStampedApprovals = async (isStale, message, {
    unstamped = false,
    unfound = 'an earlier approval stamped with a relaxed rounds-by-type threshold',
  } = {}) => {
    try {
      reviews = await loadReviews();
    } catch (err) {
      return failClosed(
        `could not list the PR's reviews, so ${unfound} cannot be found and withdrawn: ` +
          `${err.status || ''} ${err.message || err}`.trim(),
      );
    }
    // Every selected approval is tried before a failure is reported: one that
    // cannot be dismissed must not leave the others standing.
    let firstFailure = null;
    for (const r of reviews) {
      const stamped = stampedThreshold(r);
      const isBotApproval = r.user && r.user.login === BOT_LOGIN && r.state === 'APPROVED';
      if (unstamped ? !isBotApproval : stamped === null) continue;
      if (!isStale(stamped, r)) continue;
      try {
        await dismissReview({
          github, botGithub, params: { owner, repo, pull_number: prNumber, review_id: r.id, message },
        });
        withdrew = true;
      } catch (err) {
        firstFailure = firstFailure ||
          `could not withdraw the stale approval (review ${r.id}): ${err.status || ''} ${err.message || err}`.trim();
      }
    }
    if (withdrew) reviews = null;
    return firstFailure ? failClosed(firstFailure) : null;
  };

  // A promotion's or release PR's approval rests on gates that a later head or
  // title can fail. Withdraw it before skipping, for a repo that does not dismiss
  // stale approvals. Unstamped approvals too: a bot approval from the Copilot path,
  // given before the path was configured, was never proven under these gates.
  const refuseRouted = async (reason) => {
    if (BOT_LOGIN) {
      const failed = await withdrawStampedApprovals(() => true, `Withdrawn: ${reason}.`, { unstamped: true });
      if (failed) return failed;
    }
    return setDecision('skip', reason);
  };
  // As with the file listing below: the top-level catch is a skip, which would
  // leave standing an approval this run could not re-prove. Returns an error
  // decision if the withdrawal fails, otherwise null and the caller rethrows.
  const withdrawAfterFailedRead = async (err, what) => {
    if (!BOT_LOGIN) return null;
    const detail = [err.status, err.message || err].filter(Boolean).join(' ');
    return withdrawStampedApprovals(() => true, `Withdrawn: ${what} (${detail}).`, { unstamped: true });
  };

  // Matched here, before anything Copilot: the threshold of 0 below is what skips
  // the waits and the review rules. Provenance and the unpromoted check run
  // further down, after the gates that cost fewer API calls.
  const warn = typeof core.warning === 'function' ? core.warning.bind(core) : undefined;
  const promotion = findPromotionPair(pr, getPromotionPairs(process.env, warn));
  const release = promotion ? null : findReleaseRoute(pr, getReleaseRoutes(process.env, warn));
  let releaseConfig = null;

  // The type's threshold, unless the type is relaxed and the diff reaches
  // outside copilot-optional-paths, in which case the default applies. 0 means
  // Copilot is not required: nothing to wait for, and the review rules below
  // are bypassed.
  //
  // If the file listing itself fails (403: github-token lacks contents: read;
  // 404: the head was force-pushed away mid-run), the run cannot tell whether
  // an earlier relaxed approval still holds, and the ordinary "evaluation
  // failed" skip would leave it standing for a repo that does not dismiss stale
  // approvals. Withdraw every stamped approval first, then let the top-level
  // catch report the failed request as usual.
  let gate;
  if (promotion || release) {
    const blocker = promotion
      ? promotionTitleBlocker(pr.title)
      : releaseAuthorBlocker(pr, getReleaseAuthor());
    if (blocker) return refuseRouted(blocker);
    const headRef = pr.head.ref;
    let tip;
    try {
      ({ data: tip } = await github.rest.git.getRef({ owner, repo, ref: `heads/${headRef}` }));
    } catch (err) {
      const failed = await withdrawAfterFailedRead(err, `the tip of ${headRef} could not be read`);
      if (failed) return failed;
      throw err;
    }
    // A plain skip, not a refusal: an event older than the branch tip says nothing
    // about an approval of a newer head.
    if (tip.object.sha !== pr.head.sha) {
      return setDecision(
        'skip',
        `head ${pr.head.sha.slice(0, 8)} is not the tip of ${headRef} (${tip.object.sha.slice(0, 8)}); the next run re-evaluates it`,
      );
    }
    // Proof covers one head. In a repo that does not dismiss stale approvals, one
    // of an older head would read as APPROVED, and the skips below would return
    // before the path's own gates ever looked at the new commits.
    if (BOT_LOGIN) {
      const failed = await withdrawStampedApprovals(
        (_, r) => r.commit_id !== pr.head.sha,
        `Withdrawn: ${pr.head.sha.slice(0, 8)} is a new head, so the approval has to be earned again.`,
        { unstamped: true },
      );
      if (failed) return failed;
    }
    gate = { threshold: 0, type: parseCommitType(pr.title), note: '', mergeBase: null };
    if (release) {
      let proof;
      try {
        const { names, mergeBase } = await compareHead({
          github, owner, repo, baseRef: pr.base.ref, headSha: pr.head.sha,
        });
        proof = await checkReleasePr({
          github, owner, repo, pr, author: getReleaseAuthor(), names, mergeBase,
        });
        // The approval rests on the file list, so mergeBaseMoved re-reads it.
        gate.mergeBase = mergeBase;
      } catch (err) {
        const failed = await withdrawAfterFailedRead(err, 'the release PR could not be verified');
        if (failed) return failed;
        throw err;
      }
      if (!proof.ok) return refuseRouted(proof.reason);
      releaseConfig = proof.config;
    }
  } else {
    // protected-paths, before anything else that reads the PR's contents: CI,
    // the Copilot waits and reviewDecision all return early, so a refusal placed
    // after them could leave a bot approval standing. Not applied to promotion
    // and release PRs above: those carry changes already gated one PR at a time
    // into their head branch. Any bot approval, stamped or not, is withdrawn on
    // a refusal; human approvals are not ours to touch.
    const withdrawForProtection = (message) => withdrawStampedApprovals(() => true, message, {
      unstamped: true, unfound: 'a bot approval on a protected path',
    });
    let protection;
    try {
      protection = await evaluateProtectedPaths({ github, owner, repo, pr, warn });
    } catch (err) {
      if (BOT_LOGIN) {
        const detail = [err.status, err.message || err].filter(Boolean).join(' ');
        const failed = await withdrawForProtection(
          `Withdrawn: the changed files of ${pr.head.sha.slice(0, 8)} could not be checked against protected-paths (${detail}).`,
        );
        if (failed) return failed;
      }
      throw err;
    }
    if (protection.outcome === 'wait') {
      if (BOT_LOGIN) {
        const failed = await withdrawForProtection(`Withdrawn: ${protection.reason}.`);
        if (failed) return failed;
      }
      return setDecision('skip', protection.reason);
    }
    try {
      gate = await applyPathGate({
        github, owner, repo, baseRef: pr.base.ref, headSha: pr.head.sha, title: pr.title,
        compared: protection.compared,
      });
    } catch (err) {
      if (BOT_LOGIN) {
        const detail = [err.status, err.message || err].filter(Boolean).join(' ');
        const failed = await withdrawStampedApprovals(
          () => true,
          `Withdrawn: the changed files of ${pr.head.sha.slice(0, 8)} could not be listed (${detail}), ` +
            'so a relaxed approval cannot be verified.',
        );
        if (failed) return failed;
      }
      throw err;
    }
    // A pass rests on the comparison (no protected file, or every party
    // allowed), so mergeBaseMoved re-verifies it around the approval. Both come
    // from the same comparison, so they agree when both are set.
    gate.mergeBase = protection.mergeBase || gate.mergeBase;
  }
  const { threshold, type: commitType } = gate;
  if (gate.note) {
    thresholdNote = gate.note;
    core.info(`pr-auto-approve: ${gate.note}`);
  }
  const copilotOptional = threshold === 0;

  // A relaxed approval was earned by the title and the diff at the time. If the
  // title has since changed to a type that needs more rounds, or a push added a
  // file outside copilot-optional-paths, the approval no longer stands:
  // withdraw it and evaluate the PR under the current rules. This runs before
  // every other gate (CI, the Copilot waits, reviewDecision), because those
  // return early and would otherwise leave the stale approval in place.
  if (BOT_LOGIN && !copilotOptional) {
    const failed = await withdrawStampedApprovals(
      (stamped) => stamped < threshold,
      thresholdNote
        ? `Withdrawn: the PR (type ${commitType || 'none'}) touches files outside copilot-optional-paths and needs ${threshold} Copilot review round(s).`
        : `Withdrawn: the PR title (type ${commitType || 'none'}) now needs ${threshold} Copilot review round(s).`,
    );
    if (failed) return failed;
  }

  const headSha = pr.head.sha;
  let checkRuns = await fetchCheckRuns({ github, context, owner, repo, headSha });

  // Copilot finishing its review is the signal this gate needs, but Copilot
  // cannot deliver it. Its check run is created with GITHUB_TOKEN, and
  // GITHUB_TOKEN-generated events never start a new workflow run (the recursion
  // guard) — the check_run event is emitted, it just cannot start us. GitHub
  // now also holds any run Copilot itself triggers at
  // `action_required` pending manual approval (verified 2026-08-18: the same
  // workflow, event and actor ran clean on 2026-07-25 and is gated now). That
  // leaves this run — started by CI completing, so owned by an ungated actor —
  // as the only place the wait can happen. And because CI's own workflow_run can
  // fail to arrive too (#198), the wait is not left to CI's run alone: whichever
  // run first sees Copilot's check pending waits through the other checks as
  // well. Opt-in: see getCopilotWaitSeconds.
  // A sweep passes 0: it evaluates PRs one after another, so a wait on one would
  // hold up every PR after it.
  const waitSeconds = waitOverride === undefined ? getCopilotWaitSeconds() : waitOverride;
  // One budget for both waits below: the check-run wait (when Copilot still
  // registers a check) and the review wait (when it does not).
  const waitDeadline = Date.now() + waitSeconds * 1000;
  if (waitSeconds > 0 && !copilotOptional) {
    checkRuns = await waitForCopilotCheck({
      github, context, core, owner, repo, headSha, checkRuns, waitSeconds, deadline: waitDeadline, sleep,
    });
  } else if (checkRuns.some((cr) => cr.status !== 'completed')) {
    let why = 'wait-for-copilot-seconds is 0';
    if (copilotOptional) why = 'PR needs no Copilot review';
    else if (waitOverride !== undefined) why = 'a sweep does not wait';
    core.info(`pr-auto-approve: not waiting: ${why}`);
  }

  // The CI gates, applied here and again after any review wait below: a
  // rerun or a late-registered check can change the picture while we poll.
  const checkGate = async (allRuns) => {
    // When Copilot is not required, its own check run (pending while an automatic
    // review is still running, or non-success) is not CI and must not hold the PR.
    // Unfinished only: Copilot's check is a github-actions check like any CI job
    // (verified: same app id), so the name cannot prove it is Copilot's, and a
    // completed check with that name must keep counting.
    const runs = copilotOptional
      ? allRuns.filter((cr) => !(COPILOT_CHECK_NAMES.has(cr.name) && cr.status !== 'completed'))
      : allRuns;
    if (runs.length === 0) {
      if (!getAllowNoChecks()) {
        return setDecision('skip', 'no checks on head SHA yet');
      }
      core.warning('pr-auto-approve: no external checks found; proceeding because allow-no-checks=true');
    }
    const badCheck = runs.find(isFailedCheck);
    if (badCheck) {
      const reason = `failing check: ${badCheck.name} (${badCheck.conclusion})`;
      // A check can fail on a head the bot already approved: a retitle reruns the
      // title check with the head unchanged, and so does a manual rerun. Branch
      // protection dismisses approvals only on a push, so withdraw ours here, or
      // the PR stays approved and mergeable on a red check.
      if (BOT_LOGIN) {
        const failed = await withdrawStampedApprovals(() => true, `Withdrawn: ${reason}.`, { unstamped: true });
        if (failed) return failed;
      }
      return setDecision('skip', reason);
    }
    const pending = runs.find((cr) => cr.status !== 'completed');
    if (pending) {
      return setDecision('skip', `check still running: ${pending.name}`);
    }
    return null;
  };
  const gated = await checkGate(checkRuns);
  if (gated) return gated;

  reviews = reviews || await loadReviews();

  // GraphQL reviewDecision gate: GitHub's authoritative "is this PR already
  // approved overall?" signal. It reflects branch-protection dismissals — a
  // stale approval invalidated by a new push reads as REVIEW_REQUIRED, not
  // APPROVED — so it pairs with the head-SHA REST guard instead of masking a
  // needed re-approval. Best-effort: a GraphQL-specific failure is logged and
  // we fall through to the REST review checks, so a GraphQL outage never
  // disables auto-approval.
  let reviewDecision;
  try {
    const gql = await github.graphql(
      `query ($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $number) { reviewDecision }
        }
      }`,
      { owner, repo, number: prNumber },
    );
    reviewDecision = gql?.repository?.pullRequest?.reviewDecision;
  } catch (err) {
    core.warning(
      `pr-auto-approve: reviewDecision query failed, falling through to REST: ${err.status || ''} ${err.message || err}`.trim(),
    );
  }
  if (reviewDecision === 'APPROVED' && !withdrew) {
    return setDecision('skip', 'PR already approved (reviewDecision=APPROVED)');
  }

  // Idempotency: only skip if the bot's LATEST non-dismissed review is APPROVED.
  // A historical approval superseded by COMMENT/CHANGES_REQUESTED must NOT block
  // a fresh approval.
  const botReviews = BOT_LOGIN
    ? reviews
        .filter(
          (r) =>
            r.user &&
            r.user.login === BOT_LOGIN &&
            r.state !== 'DISMISSED' &&
            r.state !== 'PENDING' &&
            r.submitted_at,
        )
        .sort((a, b) => {
          const at = Date.parse(a.submitted_at) || a.id;
          const bt = Date.parse(b.submitted_at) || b.id;
          return at - bt;
        })
    : [];
  const latestBotReview = botReviews[botReviews.length - 1];
  // Bind idempotency to the head SHA: only skip if the bot already approved
  // THIS commit. A stale approval of an earlier commit (e.g. a push has since
  // moved the head, dismissing it under branch protection) must NOT block a
  // fresh approval of the new head. If commit_id is somehow absent, the guard
  // is false and we re-approve — the safe direction.
  const alreadyApproved =
    latestBotReview &&
    latestBotReview.state === 'APPROVED' &&
    latestBotReview.commit_id === headSha;
  if (alreadyApproved) {
    return setDecision('skip', `bot already approved head ${headSha}`);
  }

  const testLogins = parseTestLogins(
    process.env,
    context.repo,
    typeof core.warning === 'function' ? core.warning.bind(core) : undefined,
  );
  const copilotMatches = makeIsCopilot(testLogins);
  // Set by every pass of the selector, including the wait loop's reloads, so a
  // review that errors while we poll still explains the final skip reason.
  let sawErroredReview = false;
  // Errored reviews OF THE CURRENT HEAD: the retry budget is per head SHA, and
  // is recomputed on every pass so it always reflects the latest snapshot.
  let erroredOnHead = 0;
  // What the newest of those reviews said happened, for the skip reason.
  let lastNoReview = { at: -Infinity, cause: 'errored' };
  const selectCopilotReviews = (rs) => {
    erroredOnHead = 0;
    return rs
      .filter((r) => {
        if (!copilotMatches(r.user)) return false;
        const cause = noReviewCause(r);
        if (cause) {
          sawErroredReview = true;
          if (r.commit_id === headSha) erroredOnHead += 1;
          const at = Date.parse(r.submitted_at || '') || 0;
          if (at >= lastNoReview.at) lastNoReview = { at, cause };
          return false;
        }
        return r.state !== 'DISMISSED' && r.state !== 'PENDING' && r.submitted_at;
      })
      .sort((a, b) => {
        const at = a.submitted_at ? Date.parse(a.submitted_at) : a.id;
        const bt = b.submitted_at ? Date.parse(b.submitted_at) : b.id;
        return at - bt;
      });
  };
  let copilotReviews = selectCopilotReviews(reviews);

  // Copilot stopped registering a check run on the head SHA (verified
  // 2026-10-20: the head's check-runs list holds only the repo's own jobs
  // while Copilot posts its review from a `dynamic` workflow), so the wait
  // above never engages and the run started by CI completing used to skip
  // with "no Copilot review yet" seconds before the review landed. Spend the
  // same budget polling the reviews themselves until Copilot has reviewed
  // this head (or enough rounds exist for the threshold to decide).
  if (waitSeconds > 0 && !copilotOptional) {
    const waited = await waitForCopilotReview({
      core,
      headSha,
      threshold,
      deadline: waitDeadline,
      sleep,
      initial: copilotReviews,
      load: async () => selectCopilotReviews(await loadReviews()),
    });
    copilotReviews = waited.reviews;
    if (waited.polled) {
      // Minutes may have passed: a rerun on this head or a check registered
      // late must still block approval.
      checkRuns = await fetchCheckRuns({ github, context, owner, repo, headSha });
      const regated = await checkGate(checkRuns);
      if (regated) return regated;
    }
  }

  core.info(`pr-auto-approve: found ${copilotReviews.length} Copilot review(s) for PR #${prNumber}`);

  // Re-requests (when copilot-error-retries allows) and describes the outcome.
  const erroredReviewNote = async () => {
    const retries = getErrorRetries();
    const retry = await retryErroredCopilotReview({
      github, context, core, prNumber, erroredOnHead, retries,
    });
    return {
      requested: `re-requested, retry ${erroredOnHead}/${retries}`,
      exhausted: `reviewed nothing ${erroredOnHead} time(s) on this head; retries exhausted, re-request a review`,
      pending: `re-request already pending, retry ${erroredOnHead}/${retries}`,
      disabled: 're-request a review',
      none: 're-request a review',
      error: 'automatic re-request failed; re-request a review',
    }[retry];
  };

  if (copilotReviews.length === 0 && !copilotOptional) {
    if (!sawErroredReview) return setDecision('skip', 'no Copilot review yet');
    return setDecision('skip', `no Copilot review yet (its last attempt ${lastNoReview.cause}; ${await erroredReviewNote()})`);
  }

  // Always honor the latest Copilot signal: if the most recent non-dismissed
  // review is CHANGES_REQUESTED, never approve — even under the 3-rounds rule.
  const latest = copilotReviews[copilotReviews.length - 1];
  if (latest) {
    core.info(`pr-auto-approve: latest Copilot review id=${latest.id} state=${latest.state}`);
    if (latest.state === 'CHANGES_REQUESTED') {
      return setDecision('skip', 'latest Copilot review requested changes');
    }
  }

  let reason = '';
  if (promotion) {
    let proof;
    try {
      proof = await checkProvenance({
        github, owner, repo, prNumber, headRef: promotion.head, headSha,
      });
    } catch (err) {
      const failed = await withdrawAfterFailedRead(err, `the provenance of ${headSha.slice(0, 8)} could not be proven`);
      if (failed) return failed;
      throw err;
    }
    if (!proof.ok) return refuseRouted(proof.reason);
    reason = `promotion (${promotion.head} to ${promotion.base}, ${proof.commits} commit(s) from ${proof.prs} approved PR(s))`;
  } else if (release) {
    if (release.source) {
      let proof;
      try {
        proof = await checkUnpromoted({
          github, owner, repo, base: release.base, source: release.source, config: releaseConfig,
        });
      } catch (err) {
        const failed = await withdrawAfterFailedRead(err, 'the unpromoted commits could not be read');
        if (failed) return failed;
        throw err;
      }
      if (!proof.ok) return refuseRouted(proof.reason);
    }
    reason = `release-pr (${pr.head.ref}${release.source ? `, nothing unpromoted on ${release.source}` : ''})`;
  } else if (copilotOptional) {
    reason = `copilot-optional (type ${commitType || 'none'}, rounds-by-type 0)`;
  } else if (countRounds(copilotReviews) >= threshold) {
    reason = `${threshold}-rounds (${countRounds(copilotReviews)} Copilot reviews)`;
  } else {
    // A COMMENTED review is NOT dismissed when a push invalidates approvals, so
    // once `dismiss_stale_reviews_on_push` fires, Copilot's review of the PREVIOUS
    // commit is still the latest one here. Approving on it would clear the gate
    // for code Copilot never read. Require the review to name the current head.
    // An absent commit_id can't prove freshness either, so it skips too — the safe
    // direction, and the rounds threshold above still rescues a PR that somehow
    // never matches.
    if (latest.commit_id !== headSha) {
      // Distinguish the two failure modes: a review of a different commit is
      // routine (you pushed), whereas a review with no commit at all is
      // anomalous. Reporting both as "older commit (unknown)" would send
      // someone hunting for a SHA that was never there.
      const detail = latest.commit_id
        ? `is for an older commit (${String(latest.commit_id).slice(0, 8)})`
        : 'has no commit_id, so its freshness cannot be verified';
      // A current-head attempt that errored on top of this stale review is the
      // same situation as the no-review case: nothing is coming unless the
      // review is re-requested, so retry here too.
      const erroredNote = erroredOnHead > 0 ? `; its attempt on this head ${lastNoReview.cause} (${await erroredReviewNote()})` : '';
      return setDecision(
        'skip',
        `latest Copilot review ${detail}, waiting for re-review${erroredNote}`,
      );
    }
    if (reviewedNoFiles(latest)) {
      return setDecision('skip', 'latest Copilot review says it could not review any files');
    }
    const comments = await github.paginate(
      github.rest.pulls.listCommentsForReview,
      { owner, repo, pull_number: prNumber, review_id: latest.id, per_page: 100 },
    );
    if (comments.length !== 0) {
      return setDecision(
        'skip',
        `latest Copilot review has ${comments.length} comments`,
      );
    }
    // A clean-looking summary plus a suppressed block means Copilot DID produce
    // feedback, it just withheld it from the inline comments. Treat it exactly
    // like inline comments and leave the PR for a human. Note this gate is
    // deliberately absent from the rounds-threshold branch above: that branch is
    // the escape hatch, so a block that never clears can't wedge the PR.
    const suppressed = countSuppressedComments(latest.body);
    if (suppressed !== 0) {
      return setDecision(
        'skip',
        `latest Copilot review has ${suppressed} suppressed comment(s)`,
      );
    }
    // Absent from the rounds-threshold branch for the same reason as above.
    const cleanOn = getCopilotCleanOn(process.env, (m) => core.warning(m));
    const blocker = overviewBlocker(latest.body, cleanOn);
    if (blocker) return setDecision('skip', `latest Copilot review ${blocker}`);
    // Names the verdict the approval relied on. Only a verdict that passed gets
    // here, so nothing PR-derived reaches the approval's body.
    const verdict = overviewVerdict(latest.body);
    reason = `copilot-clean (review ${latest.id}, verdict '${verdict.replace(/^[^\p{L}\p{N}]+/u, '')}', no open issues)`;
  }

  // Every PR field the decision above was computed from is re-read here, so a
  // change that lands while this run is in flight (cancel-in-progress is not
  // atomic) cannot be approved under stale inputs:
  //   - head.sha: the approval below is pinned to headSha by commit_id, so a
  //     push would leave it describing a commit that is no longer the head;
  //   - base.ref: the path gate compared headSha against this branch, so a
  //     retarget changes the diff it judged;
  //   - title: it chose the threshold, so a retitle changes the rules;
  //   - draft: the event snapshot only proves the PR was ready when the run began.
  // base.sha is deliberately NOT compared: the base branch moves whenever
  // anything else merges, and the three-dot comparison is merge-base to head,
  // so the diff is the same for any base tip that has not been merged into
  // headSha (and merging it in would change headSha). A REWRITE of the base
  // (force-push) is the one base change that can alter the diff with the ref
  // and the head unchanged; the merge base catches exactly that, so it is
  // re-read instead, and only when the approval rests on the file list.
  const mergeBaseMoved = async () => {
    if (!gate.mergeBase) return '';
    const { mergeBase } = await compareHead({ github, owner, repo, baseRef: pr.base.ref, headSha });
    if (mergeBase === gate.mergeBase) return '';
    return `base ${pr.base.ref} was rewritten (merge base ${gate.mergeBase.slice(0, 8)} -> ${String(mergeBase || 'none').slice(0, 8)})`;
  };
  const { data: current } = await github.rest.pulls.get({ owner, repo, pull_number: prNumber });
  if (current.head.sha !== headSha) {
    return setDecision('skip', `head moved from ${headSha.slice(0, 8)} to ${current.head.sha.slice(0, 8)} during evaluation`);
  }
  if (!current.base || current.base.ref !== pr.base.ref) {
    return setDecision('skip', `PR base changed from ${pr.base.ref} to ${current.base ? current.base.ref : ''} during evaluation`);
  }
  if (current.draft) {
    return setDecision('skip', 'PR converted to draft during evaluation');
  }
  const rewritten = await mergeBaseMoved();
  if (rewritten) {
    return setDecision('skip', `${rewritten} during evaluation; the next run re-evaluates the diff`);
  }
  if ((current.title || '') !== (pr.title || '')) {
    return setDecision('skip', 'PR title changed during evaluation; the next run re-evaluates it');
  }

  // Only approvals that lean on the threshold are stamped: the optional (0) path
  // and the rounds rule. A clean current-head review holds under any threshold.
  const approvalStamp = copilotOptional || reason.includes('-rounds ')
    ? `\n\n${thresholdMarker(threshold)}`
    : '';
  const botApprovalsOfHead = async () => (await loadReviews()).filter((r) =>
    r.user && r.user.login === BOT_LOGIN && r.state === 'APPROVED' && r.commit_id === headSha);
  let created;
  try {
    // botGithub, not github: this is the ONE call that must come from the bot
    // account rather than the workflow. Everything above reads through
    // `github`, which is the workflow's own GITHUB_TOKEN — listing check runs
    // needs the `Checks` permission, and a fine-grained PAT cannot be granted
    // it, so PAT-based reads work on public repos and 403 forever on private
    // ones. Defaults to `github` so a caller passing one client still works.
    ({ data: created } = await botGithub.rest.pulls.createReview({
      owner,
      repo,
      pull_number: prNumber,
      commit_id: headSha,
      event: 'APPROVE',
      body: `Auto-approved: ${reason}.${approvalStamp}`,
    }));
  } catch (err) {
    const failed = `approval API call failed: ${err.status || ''} ${err.message || err}`.trim();
    // A failed call does not prove that nothing was saved: the call is retried
    // on a 5xx (makeApiClient), and GitHub can save an attempt yet answer 5xx.
    // Look for an approval of this head; if one stands, carry on as if the call
    // had returned it, so the re-read below can still withdraw it.
    let saved;
    try {
      saved = await botApprovalsOfHead();
    } catch (listErr) {
      return setDecision('skip', `${failed}; could not list the reviews to check whether it was saved: ${listErr.status || ''} ${listErr.message || listErr}`.trim());
    }
    if (saved.length === 0) {
      // No approval exists, so an ordinary skip is accurate here.
      return setDecision('skip', failed);
    }
    created = saved[saved.length - 1];
    core.warning(`pr-auto-approve ${failed}, but GitHub saved the approval (review ${created.id})`);
  }

  // From here an approval exists, so nothing below may fall back to a plain
  // skip. The pre-approval re-read leaves a window: a retitle, retarget or push
  // can land between it and the review. Look again (same fields as above) and
  // take the approval back; if the look itself fails, withdraw as a precaution.
  let changedWhileApproving;
  try {
    const { data: after } = await github.rest.pulls.get({ owner, repo, pull_number: prNumber });
    const same = after.head.sha === headSha &&
      Boolean(after.base) && after.base.ref === pr.base.ref &&
      (after.title || '') === (pr.title || '') &&
      !after.draft;
    if (!same) {
      changedWhileApproving = 'PR head, base, title or draft state changed while approving';
    } else {
      const rewritten = await mergeBaseMoved();
      changedWhileApproving = rewritten ? `${rewritten} while approving` : '';
    }
  } catch (err) {
    changedWhileApproving = `could not re-read the PR after approving (${err.status || ''} ${err.message || err})`.trim();
  }
  if (changedWhileApproving) {
    const describe = (err) => `${err.status || ''} ${err.message || err}`.trim();
    // The approval POST is retried on a 5xx (makeApiClient). If GitHub saved
    // an attempt but answered 502, the retry posts a second approval and
    // `created` names only one, so withdraw every bot approval of this head.
    // Every one is tried before any failure is reported; a failed listing or
    // withdrawal fails the job, because an approval may still stand.
    const failures = [];
    let ids = [created.id];
    try {
      ids = [...new Set([created.id, ...(await botApprovalsOfHead()).map((r) => r.id)])];
    } catch (err) {
      failures.push(`the reviews could not be listed to find a duplicate approval: ${describe(err)}`);
    }
    for (const id of ids) {
      try {
        await dismissReview({
          github,
          botGithub,
          params: {
            owner,
            repo,
            pull_number: prNumber,
            review_id: id,
            message: `Withdrawn: ${changedWhileApproving}.`,
          },
        });
      } catch (err) {
        failures.push(`the approval could not be withdrawn (review ${id}): ${describe(err)}`);
      }
    }
    if (failures.length > 0) {
      const failure = `approved, then ${changedWhileApproving}, and ${failures.join('; ')}`;
      core.error(`pr-auto-approve ${failure}`);
      if (typeof core.setFailed === 'function') core.setFailed(failure);
      return setDecision('error', failure);
    }
    return setDecision('skip', `${changedWhileApproving}; approval withdrawn`);
  }
  return setDecision('approved', reason);
}

module.exports = decide;
module.exports.isCopilot = isCopilot;
module.exports.makeIsCopilot = makeIsCopilot;
module.exports.parseTestLogins = parseTestLogins;
module.exports.countSuppressedComments = countSuppressedComments;
module.exports.overviewBlocker = overviewBlocker;
module.exports.getCopilotCleanOn = getCopilotCleanOn;
module.exports.getBaseBranches = getBaseBranches;
module.exports.parseCommitType = parseCommitType;
module.exports.parseRoundsByType = parseRoundsByType;
module.exports.resolveThreshold = resolveThreshold;
module.exports.getOptionalPaths = getOptionalPaths;
module.exports.filesMatchPaths = filesMatchPaths;
module.exports.changedFileNames = changedFileNames;
module.exports.getProtectedPaths = getProtectedPaths;
module.exports.getProtectedPathsMode = getProtectedPathsMode;
module.exports.getProtectedPathsAllowed = getProtectedPathsAllowed;
module.exports.firstProtectedMatch = firstProtectedMatch;
module.exports.requestCopilotReview = requestCopilotReview;
module.exports.retryErroredCopilotReview = retryErroredCopilotReview;
module.exports.getErrorRetries = getErrorRetries;
module.exports.makeApiClient = makeApiClient;
module.exports.API_RETRIES = API_RETRIES;
