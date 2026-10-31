# Changelog

## [1.9.2](https://github.com/SteerSpec/strspc-pr-review/compare/v1.9.1...v1.9.2) (2026-10-31)


### Bug Fixes

* re-check the draft state around the approval ([98e87df](https://github.com/SteerSpec/strspc-pr-review/commit/98e87dfa3dd8f8a3040b22790fa73f870393140a))
* refuse draft and fork PRs on every event ([42ff8ec](https://github.com/SteerSpec/strspc-pr-review/commit/42ff8ec804b1e79b0339202e5b93171c65ed9fec))
* refuse draft and fork PRs on every event ([62787f0](https://github.com/SteerSpec/strspc-pr-review/commit/62787f05238f0cd62bf2b0c679bfa55087be194b))

## [1.9.1](https://github.com/SteerSpec/strspc-pr-review/compare/v1.9.0...v1.9.1) (2026-10-30)


### Bug Fixes

* pass bot_login through env in the deprecated reusable workflow ([2e8cb96](https://github.com/SteerSpec/strspc-pr-review/commit/2e8cb969f5cb1d9ccb44110572b36d16d7478e43))
* pass bot-login to the review-request script through env ([7ec8fba](https://github.com/SteerSpec/strspc-pr-review/commit/7ec8fba5d2bbdfadadd7ccc484ea1e38189b78a0))
* pass bot-login to the review-request script through env ([e3b99df](https://github.com/SteerSpec/strspc-pr-review/commit/e3b99dfaba8dc23099dc8fe5dc9f9cd4c8ad67c0))

## [1.9.0](https://github.com/SteerSpec/strspc-pr-review/compare/v1.8.1...v1.9.0) (2026-10-30)


### Features

* configure callers through org-level STRSPC_PR_AUTO_APPROVE_* variables ([1ac1c4a](https://github.com/SteerSpec/strspc-pr-review/commit/1ac1c4a810521418e1625b827b189efabd4cce1d))
* configure callers through org-level STRSPC_PR_AUTO_APPROVE_* variables ([44ee64a](https://github.com/SteerSpec/strspc-pr-review/commit/44ee64abe5b53fbb7a684856dfdee0848548c1a0))
* re-request Copilot's review when it errors ([65c955d](https://github.com/SteerSpec/strspc-pr-review/commit/65c955dfbdf8606a7a97d59de65fd9eac7c83bbe))
* re-request Copilot's review when it errors (copilot-error-retries) ([198cd67](https://github.com/SteerSpec/strspc-pr-review/commit/198cd67eae3ce6649c7e2acbb9eb925f6e84fc00))
* wire copilot-error-retries to STRSPC_PR_AUTO_APPROVE_COPILOT_ERROR_RETRIES ([a3479a9](https://github.com/SteerSpec/strspc-pr-review/commit/a3479a90de1dcb833f2830767e8fc106face089e))


### Bug Fixes

* always let main through the template's base-branch pre-filter ([6d2fb7a](https://github.com/SteerSpec/strspc-pr-review/commit/6d2fb7a4bda5d3ef5ce9df49c66c033aaeff3f38))
* anchor the errored-review match and limit it to COMMENTED reviews ([ce535af](https://github.com/SteerSpec/strspc-pr-review/commit/ce535af6832ab0b7540f4579b2c7ee7901ffe2e1))
* don't re-request Copilot while a request is already pending ([0c8306a](https://github.com/SteerSpec/strspc-pr-review/commit/0c8306a00a1bb562b137ab8c54ac85005e2bd0fd))
* don't treat an errored Copilot review as clean ([1b7db7c](https://github.com/SteerSpec/strspc-pr-review/commit/1b7db7cec2ca65d77f56ba09221429bb345b779d))
* don't treat an errored Copilot review as clean ([c2dc28b](https://github.com/SteerSpec/strspc-pr-review/commit/c2dc28bbf2c4ad4ddb31a1c018f193a01bd96d7a))
* **e2e:** restore only script-owned repo variables; paginate; POSIX grep ([032f698](https://github.com/SteerSpec/strspc-pr-review/commit/032f698df0f26f0508adb1d85922a1c80cbb3967))
* **e2e:** stop sandbox-vars.sh status printing 404 JSON for unset vars ([c831d82](https://github.com/SteerSpec/strspc-pr-review/commit/c831d823efebf18cffeab59249d403bf15a94588))
* **e2e:** stop sandbox-vars.sh status printing 404 JSON for unset vars ([9055c44](https://github.com/SteerSpec/strspc-pr-review/commit/9055c44aed87df7e6f63993187826276d8aa08e9))
* make CLAUDE.md a regular file so SteerSpec Sync PRs check out ([41183cb](https://github.com/SteerSpec/strspc-pr-review/commit/41183cbbd38e1a68bdd1ad014c2db13502b2a956))
* make CLAUDE.md a regular file so SteerSpec Sync PRs check out ([5770dc3](https://github.com/SteerSpec/strspc-pr-review/commit/5770dc36983fafa1c5bbdc281fa9193de238f294))
* match the pending Copilot reviewer by exact login ([2c97470](https://github.com/SteerSpec/strspc-pr-review/commit/2c9747073b296dee77a3311868395600e7165540))
* report errored reviews seen while polling; cover quoted error text ([b18ba9c](https://github.com/SteerSpec/strspc-pr-review/commit/b18ba9c0e2f362951809694fd96581b581b69e7a))
* retry on a stale review plus an errored head attempt; parse retries strictly ([ffe8f67](https://github.com/SteerSpec/strspc-pr-review/commit/ffe8f6785e74dbb418c8e5cca32d0347a3b4a76a))

## [1.8.1](https://github.com/SteerSpec/strspc-pr-review/compare/v1.8.0...v1.8.1) (2026-10-24)


### Bug Fixes

* **decide:** fail closed when the file listing fails, and re-check the merge base ([1bddfbc](https://github.com/SteerSpec/strspc-pr-review/commit/1bddfbcd70defef4e5d2097daa4e8d23af407a07))
* **decide:** fail closed when the reviews cannot be listed for the stale-approval check ([32ddb08](https://github.com/SteerSpec/strspc-pr-review/commit/32ddb080d4da06821075cc930f8ee7e15bb3ed2e))
* **decide:** gate every relaxed rounds-by-type entry on copilot-optional-paths ([d762e32](https://github.com/SteerSpec/strspc-pr-review/commit/d762e320f21d885d4341f39df3a38d406e6e728c))
* **decide:** harden the rounds-by-type path gate ([96f1f66](https://github.com/SteerSpec/strspc-pr-review/commit/96f1f66f911d482d77ff30436bdf6aa6bc460833))
* **decide:** keep a rounds-by-type 0 path-gated even when it is the default ([f1f6966](https://github.com/SteerSpec/strspc-pr-review/commit/f1f6966e195e5624953adb0e80a412550a2b6248))
* **decide:** list the PR's changed files for the evaluated head SHA ([23e1c17](https://github.com/SteerSpec/strspc-pr-review/commit/23e1c1727d558dbeea4e35cf0964ace912b6697a))
* **decide:** re-read the base branch around approval and name it as heads/&lt;ref&gt; ([2bb5174](https://github.com/SteerSpec/strspc-pr-review/commit/2bb5174c546781eb65d7ae0621e3d8b8d68d3bcc))
* **decide:** restrict the default copilot-optional-paths to Markdown ([ec6d685](https://github.com/SteerSpec/strspc-pr-review/commit/ec6d6850b3cb390e66317dcba7eb7fd8fe05d4e2))
* update vulnerable and outdated dependencies ([1f6f387](https://github.com/SteerSpec/strspc-pr-review/commit/1f6f38791e638dbe47b12cb0201f0ad32ff281b0))
* update vulnerable and outdated dependencies ([d503919](https://github.com/SteerSpec/strspc-pr-review/commit/d503919823063f5e1e5190ce472a9adfe34d8b31))

## [1.8.0](https://github.com/SteerSpec/strspc-pr-review/compare/v1.7.2...v1.8.0) (2026-10-23)


### Features

* **decide:** per-commit-type rounds and optional Copilot review ([92c0aa2](https://github.com/SteerSpec/strspc-pr-review/commit/92c0aa209ac35779faace27925b95da5d546382d))
* **decide:** per-commit-type rounds and optional Copilot review ([9d42255](https://github.com/SteerSpec/strspc-pr-review/commit/9d422557ff375880c6652f42ba59fce7add8e248))
* **decide:** test the Copilot review request and add an e2e scenario ([c7b3962](https://github.com/SteerSpec/strspc-pr-review/commit/c7b396227856261fe884ad2627b6fffb26c0ca0d))
* **decide:** test the Copilot review request and add an e2e scenario ([93acbe4](https://github.com/SteerSpec/strspc-pr-review/commit/93acbe4036727b2ea189ad6e446008f102bc5e34))


### Bug Fixes

* **decide:** dismiss stale approvals with the workflow token when the bot token is refused ([171625f](https://github.com/SteerSpec/strspc-pr-review/commit/171625fd9d80e9af3aff78ade7724c4bff5e8167))
* **decide:** do not treat a sibling auto-approve check as CI ([697c2ff](https://github.com/SteerSpec/strspc-pr-review/commit/697c2ff12ad419c1cb269bcc9827a0308d5a011c))
* **decide:** fail on an empty bot-login and ignore the bot's own review events ([07a6cea](https://github.com/SteerSpec/strspc-pr-review/commit/07a6ceadebb26267e4a3caa7bd7c5c3a135a6094))
* **decide:** fail on an empty bot-login and ignore the bot's own review events ([6c4f026](https://github.com/SteerSpec/strspc-pr-review/commit/6c4f02620bfbc38da50cd20b85c5e414f2946b98))
* **decide:** harden rounds-by-type against retitles, truncation and malformed entries ([8932865](https://github.com/SteerSpec/strspc-pr-review/commit/89328658b18b94e207368959297f14599fa5e28d))
* **decide:** ignore the Copilot check run in the CI gate for types that skip Copilot ([f452356](https://github.com/SteerSpec/strspc-pr-review/commit/f4523562d182f017bb6564588e91ad18d9bdb48a))
* **decide:** keep honoring the first-form copilot-optional approval marker ([29f2b58](https://github.com/SteerSpec/strspc-pr-review/commit/29f2b585e23338013cf9f355cf0fd2a5bc6628fb))
* **decide:** only honor a 0 rounds type when changed files match an allowlist ([dd6dad3](https://github.com/SteerSpec/strspc-pr-review/commit/dd6dad35420f72fcc61046af6f299e2e72ea4c33))
* **decide:** pin approval to the evaluated head and re-check it before a threshold-0 approval ([991bfa0](https://github.com/SteerSpec/strspc-pr-review/commit/991bfa053769ef3fd0fbef93cce9b894c1c187e0))
* **decide:** stamp rounds approvals, narrow the check filters, document dismissal ([3085536](https://github.com/SteerSpec/strspc-pr-review/commit/3085536e585b435d0e40c6aa801c2a801f05cdab))
* **decide:** treat a whitespace-only bot-login as empty ([e9b1ccc](https://github.com/SteerSpec/strspc-pr-review/commit/e9b1ccc0fd298385a52a2b5d2bc2a7cc44ed60f9))
* **decide:** withdraw stale no-Copilot approvals first, fail closed, recheck after approving ([2512f10](https://github.com/SteerSpec/strspc-pr-review/commit/2512f1099921b084be7fda88cd001513e60802c3))
* **e2e:** search every page of PR events for the Copilot request ([13ee4f0](https://github.com/SteerSpec/strspc-pr-review/commit/13ee4f03203289d20a9a016c7095111c3e813735))

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
