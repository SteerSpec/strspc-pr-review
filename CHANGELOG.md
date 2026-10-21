# Changelog

## [1.7.2](https://github.com/SteerSpec/strspc-pr-review/compare/v1.7.1...v1.7.2) (2026-10-21)


### Bug Fixes

* **decide:** poll for the Copilot review itself when no check run exists ([4a0239a](https://github.com/SteerSpec/strspc-pr-review/commit/4a0239ac63375a0a3ff4d727d9281470dd1aa43f))
* **decide:** poll for the Copilot review itself when no check run exists ([14a5354](https://github.com/SteerSpec/strspc-pr-review/commit/14a5354c1de1e931bf6ecc8fb078baca1fd9d34a)), closes [#86](https://github.com/SteerSpec/strspc-pr-review/issues/86)
* **decide:** re-apply the CI gates after waiting for the review ([2c479bc](https://github.com/SteerSpec/strspc-pr-review/commit/2c479bcfb290497544c84cbdb37bd25a71747023))
* **decide:** re-apply the no-checks guard after the review wait; document both waits ([f433617](https://github.com/SteerSpec/strspc-pr-review/commit/f433617712104be5b3f7f4f94d3ffb394e8c84fa))

## [1.7.1](https://github.com/SteerSpec/strspc-pr-review/compare/v1.7.0...v1.7.1) (2026-10-20)


### Bug Fixes

* bump @commitlint/cli from 19.8.1 to 21.2.2 ([0dd7012](https://github.com/SteerSpec/strspc-pr-review/commit/0dd70124b67342eacc9b3bcf1e7b6af2a730af08))
* bump @commitlint/cli from 19.8.1 to 21.2.2 ([4f45003](https://github.com/SteerSpec/strspc-pr-review/commit/4f4500377bc245af5241d3fa38332b6562182f86))
* bump @commitlint/config-conventional from 19.8.1 to 21.2.2 ([2b1fd5f](https://github.com/SteerSpec/strspc-pr-review/commit/2b1fd5f6e3939e11934b48a5901895b4450b41c8))
* bump actions/checkout from 4.4.0 to 7.0.1 ([2f981e2](https://github.com/SteerSpec/strspc-pr-review/commit/2f981e20d0015d4dedd3c985cd95efb31726a010))
* bump actions/checkout from 4.4.0 to 7.0.1 ([ae53430](https://github.com/SteerSpec/strspc-pr-review/commit/ae53430354ae158f12b737c72258d0fb8fa28da4))
* bump actions/setup-node from 4.4.0 to 7.0.0 ([9b2d664](https://github.com/SteerSpec/strspc-pr-review/commit/9b2d6640c1414bfa1c2697418dd1004fb7d71abc))
* bump googleapis/release-please-action from 4.4.1 to 5.0.0 ([5806f6c](https://github.com/SteerSpec/strspc-pr-review/commit/5806f6c67b01ad06e9613c359f3caf60da65355a))
* bump reviewdog/action-actionlint from 1.73.0 to 1.73.2 in the actions group ([9a5acd5](https://github.com/SteerSpec/strspc-pr-review/commit/9a5acd5fd184e20d164812a0f802cb32b95af68e))
* bump the actions group across 1 directory with 2 updates ([#79](https://github.com/SteerSpec/strspc-pr-review/issues/79)) ([d119db2](https://github.com/SteerSpec/strspc-pr-review/commit/d119db2a280c270396076834ed68098fc49f99f6))
* bump the commitlint group with 2 updates ([#78](https://github.com/SteerSpec/strspc-pr-review/issues/78)) ([49cc472](https://github.com/SteerSpec/strspc-pr-review/commit/49cc47270525107c0131ace3c9495f170b4986fb))
* group the commitlint family so its bumps stop colliding ([b02e67b](https://github.com/SteerSpec/strspc-pr-review/commit/b02e67b778c076eacf7123ba9aefbcd954270455))
* match Copilot's 2026-08 suppressed-comments markup ([#76](https://github.com/SteerSpec/strspc-pr-review/issues/76)) ([52554b2](https://github.com/SteerSpec/strspc-pr-review/commit/52554b2bd7abd92038f2e0f8a5b66fc0692e4dd2))
* quote the bug-report dropdown options so the form loads ([b27dca3](https://github.com/SteerSpec/strspc-pr-review/commit/b27dca30bce45ce26dddd0c6f29c1c8fcd18a09d))
* quote the bug-report dropdown options so the form loads ([4ab3c20](https://github.com/SteerSpec/strspc-pr-review/commit/4ab3c20a338d444027a89d5b922eb1c82dbe7003))
* say fine-grained, and stop the guard policing markup ([840d93c](https://github.com/SteerSpec/strspc-pr-review/commit/840d93c1a1a2ca1a736014bfff0dbe71336f2fff))
* the drift-guard PR drifted, and the guard was prose-policing ([15f02cf](https://github.com/SteerSpec/strspc-pr-review/commit/15f02cf73f4d835519948137bbe9ea2fa591163d))

## [1.7.0](https://github.com/SteerSpec/strspc-pr-review/compare/v1.6.0...v1.7.0) (2026-08-22)


### Features

* use github-script v9's getOctokit, drop the hand-rolled client ([a83950f](https://github.com/SteerSpec/strspc-pr-review/commit/a83950f1297978b7757d33f4c45c42777570aca8))


### Bug Fixes

* constrain the npm group so its name stays true ([1985593](https://github.com/SteerSpec/strspc-pr-review/commit/19855936e168a9dcee6c969fb1bbc81e58942b8c))
* give the SHA pins someone to maintain them ([84636ff](https://github.com/SteerSpec/strspc-pr-review/commit/84636ff41a3b4be2b4b3bfd0650c58a7e3ed7124))

## [1.6.0](https://github.com/SteerSpec/strspc-pr-review/compare/v1.5.0...v1.6.0) (2026-08-21)


### Features

* read with GITHUB_TOKEN so private repos work, and explain 403s ([2ef061c](https://github.com/SteerSpec/strspc-pr-review/commit/2ef061c6ab0796f6a14331e976bfca2f4de51c25))


### Bug Fixes

* **ci:** sync-marketplace-pin could never fire on a release ([3cb8247](https://github.com/SteerSpec/strspc-pr-review/commit/3cb824734ac23640beaacb7fa892101d78d81502))
* **ci:** use github.event.inputs, and stop swallowing gh errors ([7c7bc86](https://github.com/SteerSpec/strspc-pr-review/commit/7c7bc868b7e9381fb1f28f3d2e3859f2a14e807e))
* make the one-call token contract true, and honour GITHUB_API_URL ([0a3e087](https://github.com/SteerSpec/strspc-pr-review/commit/0a3e0878de80e67d1284e3a58fefe9ed20049093))
* strip a trailing slash, and stop overstating the permissions needed ([7709a4a](https://github.com/SteerSpec/strspc-pr-review/commit/7709a4a0c88114e8376085cbb29a92770cbd6481))

## [1.5.0](https://github.com/SteerSpec/strspc-pr-review/compare/v1.4.0...v1.5.0) (2026-08-20)


### Features

* **ci:** open the marketplace pin-update PR on release ([063a55e](https://github.com/SteerSpec/strspc-pr-review/commit/063a55e5076e15e387ee50081fab9071c73338e2))
* ship the rollout's lessons, and automate the pin that delivers them ([27a1628](https://github.com/SteerSpec/strspc-pr-review/commit/27a1628cccc65a2c67aa0e623ee3a68c52685cec))
* **skills:** cover a red Copilot check over a clean Copilot review ([452fe1d](https://github.com/SteerSpec/strspc-pr-review/commit/452fe1d17482ac8f51d6218bf8f9b1fd4e72d25e))
* **skills:** tell people how to find their gating workflows ([19eff3d](https://github.com/SteerSpec/strspc-pr-review/commit/19eff3dd35fe71f601ac5c38970627e848702ef3))


### Bug Fixes

* address Copilot review on [#53](https://github.com/SteerSpec/strspc-pr-review/issues/53) ([028cf96](https://github.com/SteerSpec/strspc-pr-review/commit/028cf9617252058b15fa140a7afbcfb5e6169c5d))

## [1.4.0](https://github.com/SteerSpec/strspc-pr-review/compare/v1.3.0...v1.4.0) (2026-08-19)


### Features

* **skills:** ship setup, diagnose and caller-sync skills with the action ([5800d6a](https://github.com/SteerSpec/strspc-pr-review/commit/5800d6a05cff6aad7c66c117486f9017d0523a31))


### Bug Fixes

* **security:** use pull_request_target so a PR cannot exfiltrate the bot token ([c5d5c0b](https://github.com/SteerSpec/strspc-pr-review/commit/c5d5c0b15df79d12a5ad76d1753cc63891fadca6))
* **skills:** close gaps in the drift guards, use portable base64 ([ebba5ae](https://github.com/SteerSpec/strspc-pr-review/commit/ebba5aeafdc18970dfa51d620042c08700466a04))

## [1.3.0](https://github.com/SteerSpec/strspc-pr-review/compare/v1.2.1...v1.3.0) (2026-08-18)


### Features

* **pr-auto-approve:** optionally wait for Copilot's review check ([034440e](https://github.com/SteerSpec/strspc-pr-review/commit/034440ed1c6b4546b3c55b5c556ee3fa16beed8a))


### Bug Fixes

* **pr-auto-approve:** stop waiting once a check has already failed ([298ae88](https://github.com/SteerSpec/strspc-pr-review/commit/298ae88060843972088a3a5bf0b8963541d2971e))

## [1.2.1](https://github.com/SteerSpec/strspc-pr-review/compare/v1.2.0...v1.2.1) (2026-07-26)


### Bug Fixes

* **ci:** use workflow_run as the re-entry point for Actions-based CI ([d2f1ee4](https://github.com/SteerSpec/strspc-pr-review/commit/d2f1ee44cb8e2e442c73f5b8fec1eb8fe0550c2b))

## [1.2.0](https://github.com/SteerSpec/strspc-pr-review/compare/v1.1.2...v1.2.0) (2026-07-26)


### Features

* **ci:** dogfood pr-auto-approve on this repo with cnslr-bt ([3e629c7](https://github.com/SteerSpec/strspc-pr-review/commit/3e629c79a89e59a1b6786980da402c469128d3e0))


### Bug Fixes

* **pr-auto-approve:** make the bot review request best-effort ([5a0c294](https://github.com/SteerSpec/strspc-pr-review/commit/5a0c294ba8a6c7803bbcdf07118d4e9a5277e73f))

## [1.1.2](https://github.com/SteerSpec/strspc-pr-review/compare/v1.1.1...v1.1.2) (2026-07-25)


### Bug Fixes

* **pr-auto-approve:** require the Copilot review to match the head SHA ([3e3e0a0](https://github.com/SteerSpec/strspc-pr-review/commit/3e3e0a0a241f760901974cfaa378cd7c0a22b0ae))

## [1.1.1](https://github.com/SteerSpec/strspc-pr-review/compare/v1.1.0...v1.1.1) (2026-07-25)


### Bug Fixes

* **pr-auto-approve:** don't approve when Copilot suppressed low-confidence comments ([2fbc788](https://github.com/SteerSpec/strspc-pr-review/commit/2fbc788122205be3c849e1dbb3b6f9c82d27f8a9))

## [1.1.0](https://github.com/SteerSpec/strspc-pr-review/compare/v1.0.0...v1.1.0) (2026-07-25)


### Features

* approve on any clean Copilot round (new identity + allow-no-checks) ([#8](https://github.com/SteerSpec/strspc-pr-review/issues/8)) ([c3b3176](https://github.com/SteerSpec/strspc-pr-review/commit/c3b317645d023b428fdfdcffb86a31272b8d6ea4))
* **pr-auto-approve:** support configurable multi-branch base-branch ([#11](https://github.com/SteerSpec/strspc-pr-review/issues/11)) ([176222d](https://github.com/SteerSpec/strspc-pr-review/commit/176222d9b7aa8f7afbd586a55c4bf4853b9d3c02))


### Bug Fixes

* **pr-auto-approve:** add GraphQL reviewDecision idempotency gate ([#9](https://github.com/SteerSpec/strspc-pr-review/issues/9)) ([74aff27](https://github.com/SteerSpec/strspc-pr-review/commit/74aff27ead7fc84bda00dd7bb46a50a0249f6c93))
* **pr-auto-approve:** bind bot-approval idempotency to head SHA ([6cb6ae0](https://github.com/SteerSpec/strspc-pr-review/commit/6cb6ae03724813ff718fbf8bbe423d5ccca46df7))
* **pr-auto-approve:** close gaps vs axeptio/tech-scripts reference workflow ([#14](https://github.com/SteerSpec/strspc-pr-review/issues/14)) ([f973748](https://github.com/SteerSpec/strspc-pr-review/commit/f9737483e9b06fe8b61a977362e7fe7cf720b71c))
* **pr-auto-approve:** wire pull_request_review + bot loop-guard, drop review_requested ([#10](https://github.com/SteerSpec/strspc-pr-review/issues/10)) ([7bbe8d3](https://github.com/SteerSpec/strspc-pr-review/commit/7bbe8d3a79dce9e97225fca9b1e89e107d9310fb))
* **release:** target main branch in release-please ([58ec615](https://github.com/SteerSpec/strspc-pr-review/commit/58ec6154d2fb4fb57bf635052e56c45a67ea5afd))
* **release:** target main branch in release-please ([87e64a7](https://github.com/SteerSpec/strspc-pr-review/commit/87e64a77ea303f2771e0513dde3668888b36c1b6))
* **release:** update moving major tag via git refs API ([4948bc9](https://github.com/SteerSpec/strspc-pr-review/commit/4948bc9e4f87175ab1ed4ea8015b2ff5c3722879))
* **release:** update moving major tag via git refs API ([065af51](https://github.com/SteerSpec/strspc-pr-review/commit/065af51805a4a75324aeca25d2f15d3fe7073e20))

## [0.2.0](https://github.com/SteerSpec/strspc-pr-review/compare/pr-auto-approve-v0.1.0...pr-auto-approve-v0.2.0) (2026-04-21)


### Features

* port pr-auto-approve from axeptio/tech-scripts as OSS ([5489857](https://github.com/SteerSpec/strspc-pr-review/commit/54898576d7fe8e184e52093693b4d106a8577eb1))
* port pr-auto-approve from axeptio/tech-scripts as OSS under Apache 2.0 ([1042b4e](https://github.com/SteerSpec/strspc-pr-review/commit/1042b4ec87c31292f734c8753ff34eb5336bf370))
