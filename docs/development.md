# Development

Back to the [README](../README.md).

## Development

Node 22 (`.nvmrc`).

```bash
npm install
npm test               # 475 unit tests (test declarations); oracle.test.js needs jq
npm run test:coverage  # same tests + coverage gate (80% line / 70% branch)
npm run lint           # actionlint (workflows) + shellcheck (e2e scripts) + issue-form schema
```

`npm run lint` shells out to `actionlint`, `shellcheck` and `python3`, so install those separately.
The unit tests need none of them. End-to-end tests run against two testbed repos, one with
synthetic Copilot reviews and one where Copilot reviews for real: see
[`e2e/pr-auto-approve/README.md`](../e2e/pr-auto-approve/README.md). A same-repo PR into `main`
needs the synthetic suite to pass, and a promotion from `develop` also needs the real-Copilot tier;
release-please's PRs skip that tier. Fork PRs get no secrets, so both skip them.

### Layout

```text
strspc-pr-review/
├── action.yml                        # composite Action entry point
├── docs/                             # reference pages the README links to
├── scripts/
│   ├── pr-auto-approve/
│   │   ├── decide.js                 # all approval rules
│   │   ├── decide.test.js            # unit tests (Node native test runner)
│   │   ├── docs.test.js              # checks the docs/inputs.md tables and a few README claims against action.yml
│   │   ├── e2e.test.js               # checks the e2e scenario manifests cover every input and rule
│   │   ├── e2e-lib.test.js           # unit tests for the e2e harness's shell helpers
│   │   ├── oracle.test.js            # checks the real-Copilot oracle agrees with decide.js
│   │   ├── promotion.js              # the promotion path's own gates
│   │   ├── promotion.test.js         # unit tests for that path, through decide.js too
│   │   ├── release.js                # the release path's own gates
│   │   ├── release.test.js           # unit tests for that path, through decide.js too
│   │   ├── skills.test.js            # guards skills/ against drifting from action.yml
│   │   └── template.test.js          # guards the template against drifting from action.yml
│   └── validate-issue-forms.py       # GitHub drops a malformed issue form silently
├── templates/
│   └── pr-auto-approve.yml           # copy-paste starter for caller repos
├── rules/                            # the dev.steerspec.prreview realm
├── skills/                           # Claude Code skills, published via SteerSpec/.claude
│   ├── pr-auto-approve-setup/
│   ├── pr-auto-approve-diagnose/
│   └── pr-caller-sync/
├── e2e/pr-auto-approve/              # end-to-end harness against the testbed repos
└── .github/
    ├── assets/                       # the SteerSpec logo
    ├── ISSUE_TEMPLATE/               # bug report and feature request forms
    ├── dependabot.yml                # keeps the SHA-pinned actions and dev deps current
    └── workflows/
        ├── auto-approve.yml          # this repo running the action on itself
        ├── e2e.yml                   # synthetic e2e suite, required on main
        ├── e2e-copilot.yml           # real-Copilot e2e tier, on promotions into main
        ├── pr-auto-approve.yml       # reusable workflow, deprecated, kept for compatibility
        ├── test-pr-auto-approve.yml  # CI: tests, actionlint, shellcheck, issue forms, PR title
        ├── release-please.yml        # semver tagging on main
        └── sync-marketplace-pin.yml  # moves the skills pin in SteerSpec/.claude on release
```
