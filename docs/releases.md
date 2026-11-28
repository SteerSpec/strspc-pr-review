# Branching and releases

Back to the [README](../README.md).

## Branching and releases

```mermaid
flowchart LR
    PR["<b>Pull requests</b><br/>squashed"]
    D["<b>develop</b>"]
    M["<b>main</b><br/>merge commit"]
    R["<b>Release PR</b><br/>release-please"]
    T["<b>vX.Y.Z</b><br/>moves @v1"]

    PR --> D
    D -->|promote| M
    M --> R
    R --> T
    T -.->|sync| D

    classDef branch fill:#161B22,stroke:#3FB950,color:#E6EDF3
    classDef release fill:#238636,stroke:#3FB950,color:#E6EDF3
    class D,M branch
    class T release
```

1. Pull requests target `develop` and are squashed. The commit takes the PR title when a PR has
   several commits, and the commit's own subject when it has one, so CI requires a one-commit PR's
   title to match that subject.
2. A `chore: promote develop to main` pull request carries the bundle to `main`. Merge it with a
   **merge commit**, so [release-please](https://github.com/googleapis/release-please) sees each
   commit.
3. release-please opens a release pull request against `main`. Merging it tags `vX.Y.Z`, following
   [semver](https://semver.org/), and moves `@v1`. Promote first, then merge the release PR: a commit
   still on `develop` at that point is left out of the changelog for good.
4. A `chore: sync develop with vX.Y.Z` pull request copies the changelog, manifest and package files
   from `main` to `develop`. Separately, `sync-marketplace-pin.yml` opens the pull request in
   `SteerSpec/.claude` that moves the skills pin to the new release.

Title types set the version:

| Change | Title | Version |
| ------ | ----- | ------- |
| New capability | `feat:` | minor |
| Fix | `fix:` | patch |
| Docs and chores | `docs:`, `chore:` | no release |
| Rule-only change | `chore(rules):` | no release |

`@v1` always points at the latest `v1.x` release, so pinning it receives patches and
backward-compatible features automatically. The release workflow moves it with a forced
update of the tag.

## Pinning

No tag in this repo is immutable. `@v1` moves by design, and `vX.Y.Z` tags and releases
are not protected either, so an exact `@vX.Y.Z` is a convention rather than a guarantee.
A caller hands the action a bot token that can approve PRs, so a moved tag runs new code
with that token. To review every upgrade, pin a commit SHA with the version in a comment,
and let Dependabot's `github-actions` ecosystem bump it:

```yaml
- uses: SteerSpec/strspc-pr-review@394e1d5fc6f4ab39e284ffcfd13bfa87b38057b0 # v1.12.2
```

Take the SHA from `git rev-list -n1 vX.Y.Z` or the release page. strspc-pr-approval
pins this way.
