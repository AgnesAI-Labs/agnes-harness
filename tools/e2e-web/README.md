# Real daemon / Web merge gate

From the repository root, with Node 24.20.0, pinned pnpm, installed dependencies and cached Chromium:

```sh
pnpm e2e:web
pnpm e2e:web --reuse-build
pnpm e2e:web --list
```

Provision dependencies and the pinned browser once, separately from the offline gate:

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
```

The default command runs `build:local`. `--reuse-build` reuses only an E2E-stamped build whose
product source, manifests, lockfile, root/package TypeScript configurations, Node version, OS and
architecture match; otherwise it rebuilds.
The command also typechecks the harness and runs the i18n-scanner unit checks.
No browser or package installation happens during the gate. `AGH_CHROMIUM_PATH` can select an
already installed executable for local debugging; CI uses the pinned Playwright Chromium cache.

## Phase 1 coverage

Each spec receives a new short `/tmp` directory and an isolated `AGH_HOME` and `HOME`. The harness
starts `node packages/cli/dist/local/agnes.mjs serve --port PORT` **from the repository root**. It
uses the first-run keyless demo model, synthetic workspace data, a loopback OpenAI-compatible
provider and a dependency-free stdio MCP fixture. Child environments allow only the required
path/home/profile/origin values; real provider keys, proxy settings and user configuration are
never inherited. Each SDK-created new session supplies a unique `sessionKey`;
plugin lifecycle sessions explicitly select the installed default Agent loop. Account save asserts the documented
`new-sessions` effect and exercises the credential immediately, then verifies it after restart. Specs use the CLI and public SDK, including the SDK package-admin methods;
they never call raw admin HTTP endpoints. The SDK discovers the advertised WebSocket from the
served root document and exercises browser WebSocket session operations; local administrative operations use the daemon's local transport.

The maintained Phase 1 specs exercise first run, a real demo tool, SDK account verification/save,
credential use after daemon restart, reviewed folder install/trust/enable/disable, old/new local
plugin generations after reload/restart, MCP stdio invocation, workspace skill discovery, and a
bundled FDE workflow writing a deliverable. They assert durable tool results and persisted output,
not just that a request was accepted.

Chromium opens the served shell once to save a startup screenshot; Phase 1 does not drive or
assert page-level UI flows. Existing navigation/conversation smoke files remain separate from the
gate and are intentionally not included in the Phase 1 Playwright test match.

## Gate and failure evidence

The required GitHub status is **Web E2E gate** from `.github/workflows/e2e-web.yml` (macOS 14).
Maintainers must select that status in the target branch's required checks/ruleset; committing a
workflow alone does not change GitHub branch protection. The workflow runs on pull requests,
merge groups, integration/main pushes and manual dispatch, without path-based skips.

The suite has one worker, zero retries, an eight-minute test deadline and a ten-minute CI gate
step. `test.only` and retry overrides are refused. A flaky spec remains a gate failure; do not
quarantine it with retries or `test.skip`. To investigate, run the named spec several times:

```sh
pnpm e2e:web --reuse-build --grep 'local hot reload' --repeat-each 3
```

`.agnes-tmp/e2e-web` (existing ignored local-acceptance directory) contains the HTML/JSON report, startup/failure screenshots,
failure traces, browser errors, process logs and SDK evidence attachments. Set
`AGH_WEB_TEST_OUTPUT` to place these artifacts elsewhere. The harness closes its SDK clients,
stops its own serve process, runs `daemon stop` for its isolated home, and removes only its own
temporary directory. Browser console errors, uncaught page errors and off-loopback requests fail.
Open reports/traces with `pnpm exec playwright show-report .agnes-tmp/e2e-web/report` and
`pnpm exec playwright show-trace PATH_TO_TRACE.zip`.

The hot-reload/restart spec's `@flaky` tag was cleared after the macOS process-identity fix
was integrated and eight consecutive runs on the integrated UI round 2 tip passed with zero
retries. The observed failure came from using calendar-adjusted `kern.boottime` in the daemon
start id: a live daemon could appear stale while retaining its mutation lock. The fix uses the
immutable boot-session UUID and saved process start, with fail-closed migration of old records.
Reproduce any recurrence with `--repeat-each 8`; do not add retries or time tolerance.
Failure reports/traces remain separate from successful runs; process status and daemon audit
are attached, and editor-style code updates are published atomically.

## Phase 2, after the UI overhaul is integrated

Page-level specs and visual baselines are deliberately deferred until the owner confirms the UI
merge. `quality.ts` supplies visible/accessible-name unresolved-key scans, WCAG A/AA axe scans
(with JSON evidence), screenshots, and Playwright visual comparisons. `fixtures.ts` installs
console/pageerror and external-request checks before navigation. No existing UI error is ignored.

After rebasing onto the integrated UI, add maintained specs against roles/test ids for the Agent
chip, account dialog, cancel, every settings section, plugin capability review/toggles, hot reload,
MCP, skills slash, ask/plan/deliverable/jobs/terminal/child/goal/schedule cards and FDE/restart flows.
Include zh/en and light/dark main screens, and activate those specs in `playwright.config.mjs`.

Only then create a reviewed `baselines/ready.json` recording the integrated UI commit, Chromium
version and viewport, and run `AGH_UPDATE_VISUALS=1 pnpm e2e:web` on the CI platform. Commit the
reviewed PNGs with that manifest. Normal gate runs use `updateSnapshots: none` and require every
activated baseline; they never bless missing images automatically. Until the manifest exists,
`screen()` records a `visual-baseline-pending` annotation and a screenshot without claiming visual
regression coverage. Tolerance is 0.2% changed pixels with a per-pixel threshold of 0.2. Baseline
updates require image review, not tolerance growth. Automated axe checks complement, and do not
replace, manual accessibility review.

## UI smoke acceptance

Use the separate UI smoke configuration against an isolated running daemon:

```sh
AGH_WEB_URL=http://127.0.0.1:PORT pnpm exec playwright test --config tools/e2e-web/playwright.ui.config.mjs
```

The navigation skeleton verifies both locales, every settings destination, all provider kinds, local-plugin controls and uncaught browser errors. Extend it for the final integrated mutation/session acceptance described in [UI coverage](../../docs/develop/ui-coverage.md). Do not point mutation acceptance at a real user home.

`ui-quality.spec.ts` runs eight locale/theme/viewport combinations on a real daemon. Set `AGH_UI_WORKSPACE` to its synthetic workspace, optional `AGH_UI_DELIVERABLE` to a file there, and `AGH_UI_REPORT` for screenshots. It checks unresolved locale keys, overflow and errors.

`examples.spec.ts` requires `AGH_INSTALL_EXAMPLES=1` against a disposable home for review, install, trust/enable, dialog language switching and new-session Loop selection.

Stable IDs and APIs: [registry APIs](../../docs/develop/ui-extension-registries.md). Conversation fixtures use production components with synthetic ports.

Set `AGH_UI_AXE=1` for WCAG A/AA checks on every 1440-pixel screen in the UI matrix, including dialogs and conversation cards. `AGH_UI_DELIVERABLE` must be an absolute path to a synthetic file inside `AGH_UI_WORKSPACE`.

Set `AGH_UI_ISOLATED=1` to run each matrix case with its own disposable real daemon, workspace and synthetic deliverable.
