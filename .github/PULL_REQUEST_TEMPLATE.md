## What and why

<!-- One paragraph: what changes, and what problem it solves. Link the issue if there is one. -->

## Checklist

- [ ] Commit subjects follow [Conventional Commits](https://www.conventionalcommits.org/) and stay under 120 characters — the `commit-msg` hook enforces this
- [ ] This PR targets `develop` (`main` only receives release promotions)
- [ ] `npm test` and `npm run lint` pass locally
- [ ] `action.yml`, `docs/` and `skills/` still agree — `skills.test.js` checks the skill snippets and `docs.test.js` checks the docs tables against `action.yml`
- [ ] No tokens, secrets or private repository names in the diff, the test fixtures, or this description
