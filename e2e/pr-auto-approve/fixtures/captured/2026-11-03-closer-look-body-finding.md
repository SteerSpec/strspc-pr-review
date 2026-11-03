<!-- ccr-overview-v2 -->

### 🔵 Needs a closer look

The change depends on live GitHub and Copilot behavior, permissions, billing, and timing that static review cannot independently validate.

**No open issues** 🎉

<details>
<summary><strong>What changed in this PR</strong></summary>

This pull request adds the foundation for a real-Copilot end-to-end testing tier while preserving the existing synthetic sandbox.

**Changes:**
- Adds `sandbox.sh --real` provisioning, synchronization, reset, ruleset, secret, and CI support.
- Adds a baseline `sum`/`mean` library and Node.js tests for future Copilot fixtures.
- Documents the real-Copilot testbed, setup process, and security model.
- **Moderate issue:** The mandatory-main ruleset should allow merge commits to match the production merge contract rather than permitting squash merges only.

This pull request requires changes.

| File | Summary |
| --- | --- |
| `e2e/​pr-auto-approve/​testbed/​src/​stats.test.js` | Tests the baseline statistics library with Node’s built-in test runner. |
| `e2e/​pr-auto-approve/​testbed/​src/​stats.js` | Provides the baseline library used by real-Copilot scenarios. |
| `e2e/​pr-auto-approve/​sandbox.sh` | Adds real-testbed provisioning, workflow generation, synchronization, reset support, and configuration. |
| `e2e/​pr-auto-approve/​README.md` | Documents the real-Copilot testbed, setup commands, configuration, and operational differences. |
</details>

<sub>Review effort: Lite</sub>
