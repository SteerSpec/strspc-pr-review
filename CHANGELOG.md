# Changelog

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
