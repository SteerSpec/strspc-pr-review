## What and why

<!-- One paragraph: what changes, and what problem it solves. Link the issue if there is one. -->

## Checklist

- [ ] Commit subjects follow [Conventional Commits](https://www.conventionalcommits.org/) and stay under 120 characters — the `commit-msg` hook enforces this
- [ ] This PR targets `develop` (`main` only receives release promotions)
- [ ] `npm test` and `npm run lint` pass locally
- [ ] `action.yml`, `README.md` and `skills/` still agree — `scripts/pr-auto-approve/skills.test.js` fails when they drift
- [ ] No tokens, secrets or private repository names in the diff, the test fixtures, or this description
