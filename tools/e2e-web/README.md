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

## Runtime and SDK coverage

Each real-runtime test receives a new short `/tmp` directory and an isolated `AGH_HOME` and `HOME`. The harness
starts `node agnes.mjs serve --port PORT` **from its synthetic workspace**. CLI commands use the same
isolated working directory. The catalog matrix explicitly copies the public `examples/packages` fixtures
into that workspace instead of depending on the checkout as the daemon working directory. It
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

SDK flows start only their SDK client; maintained page flows own first-run screenshots and use the
same real daemon and public SDK for persisted-state assertions. `first-run.spec.ts` keeps one
complete root-entry flow (en/light/1440) and one installed-entry flow (zh-CN/light/1440).
Each captures read-only DOM frames and loaded CSS/image/font assets from the production shell
for both themes and widths. The other six variants use an in-memory loopback HTTP fixture,
without starting a daemon, worker or provider. All eight screens per variant retain their
screenshot names, translation, accessibility and focus assertions. Each locale group runs
serially so decorative checks consume only frames from its successful real flow. Filtering
should select the whole locale group (`--grep 'guided first run en/'` or `zh-CN/`); selecting
only a decorative case has no producer and fails explicitly. The older UI smoke files remain
separate from this gate.

## Gate and failure evidence

The required GitHub status is **Web E2E gate** from `.github/workflows/e2e-web.yml`. It aggregates
all twenty-four macOS 14 and twenty Linux Web jobs, all six Linux fast-test shards and the separate
Linux contracts job (including `pnpm test:story`) and three migrated-heavy shards; a failed or
cancelled dependency fails the aggregate. macOS uses nineteen explicit file/flow lists for regular
cases, plus one candidate-review job and four single-case narrow locale/theme jobs. Linux uses
sixteen explicit lists plus the same four narrow jobs; Playwright's count-based `--shard` cannot
balance cases that range from two seconds to three minutes. The lists balance observed
hosted-runner durations, including build and quality prechecks (about two minutes on macOS, one
on Linux), so each list's cases take at most about six and a half minutes: multi-minute candidate
review and narrow flows need separate budgets, first-run checks split by locale, and a spec too
long for one job (`ui-flows`, `ui-gate`, `workbench`, `v3-actions`, `v3-navigation`) is split by
title with `--grep` lists that together select each case once. The `ui-gate` page matrix also
checks its settings pages in two halves per locale/theme, because one pass took 130-165 s of its
150 s deadline. Every job retains one
worker, all checks, and the existing deadlines. Linux Web jobs run the functional, accessibility
and layout assertions without a pixel gate: Linux renders must come from the CI image and cannot
be reviewed locally, so the pixel gate is macOS only. The v3 specs cover full-page navigation, session
search and archive restoration, everyday and advanced settings, provider auto-testing, plugin and
MCP installation, business-agent start, scheduled tasks and session-grant revocation on isolated
Demo homes. Their page matrix checks both locales/themes and 390-pixel layouts. After adding specs or changing these lists,
compare each platform's combined `pnpm e2e:web --list` selections with the full list: every case
must appear exactly once. Uploads retain completed reports, screenshots and trace archives,
excluding volatile Playwright scratch directories.
Maintainers must select that status in the target branch's required checks/ruleset; committing a
workflow alone does not change GitHub branch protection. The workflow runs on pull requests,
merge groups, integration/main pushes and manual dispatch, without path-based skips.
Run the same gate on an unmerged branch with `gh workflow run e2e-web.yml --ref BRANCH`, then
watch the returned run with `gh run watch RUN_ID --exit-status`. Dispatch checks that branch's
specs and baselines. Every ready screen needs a macOS PNG captured with the pinned Chromium;
dispatch does not generate or approve missing baselines.

The local command shares two workers with per-test scheduling. CI runs the platform partitions
listed above with one worker per runner, so concurrent daemon/worker/Chromium trees do not
compete on the same small runner. The complete `pnpm test` fast tier runs in six independent
Vitest shards with one worker each; typechecks, structural guards and kernel regressions run
once in a separate contracts job. The process/data-heavy files listed in
`tools/ci/heavy-migrations.json` run in three additional required shards, retaining all coverage
when a file is moved out of fast. Fast shards upload per-case JSON durations and list cases above
two seconds in the job summary, with runner capacity and peak RSS in the log. CI uses one isolated
fork so Vite and dependency transforms have CPU headroom; test deadlines are unchanged.
All shards and contracts remain required by the aggregate,
so they cannot consume the Web jobs' execution budget or hide a failed partition.
Every Web shard keeps zero retries and a ten-minute CI gate step. Local Playwright runs have a
twelve-minute global deadline, with shorter per-spec deadlines.
`test.only` and retry overrides are refused. A flaky spec remains a gate failure; do not
quarantine it with retries or `test.skip`. To investigate, run the named spec several times:

```sh
pnpm e2e:web --reuse-build --grep 'UI local rescan' --repeat-each 3
```

`.agnes-tmp/e2e-web` (existing ignored local-acceptance directory) contains the HTML/JSON report, screen/failure screenshots,
failure traces, browser errors, process logs and SDK evidence attachments. Redacted diagnostics and
session events are collected through the public SDK before shutdown, including context hook
attribution and trusted timeout/cancellation/execution/result failure classifications. Extension
exception text remains redacted.
SDK and browser RPC timings contain only method names, durations and error codes, never parameters
or response bodies. CI artifacts include the platform and matrix id to avoid upload collisions. Set
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

## Maintained UI and visual gate

`ui-gate.spec.ts` checks first run, Agent options, the account dialog and all settings destinations, including the moved home pages
in en/zh-CN and light/dark at 1280×900. It checks visible and accessible-name i18n keys, horizontal
overflow and WCAG A/AA axe violations, with JSON evidence. `ui-flows.spec.ts` drives account save
against the loopback provider, demo read/cancel, folder review/install/enable/disable, old/new
local plugin generations through rescan and restart, MCP stdio, skill slash preloading, ask,
plan approval, authorized deliverable downloads, child collection, goal completion, background
job output, interactive terminal input/output, schedule creation/archive and the bundled FDE
workflow through restart. Backend assertions use CLI or SDK, never raw admin HTTP from specs.
`candidate-review.spec.ts` retains the exact-test/hash, edited-approval refusal, publication,
history and diff workflow formerly in `ui-flows.spec.ts`. Its CI partition remains required.
Selectors use roles and stable test IDs; disclosures are checked before toggling.

`baselines/ready.json` declares the reviewed screens, with no pending screens. Linux still
requires every screen to be declared, captures its normalized PNG as run evidence and annotates
the skipped comparison as `pixel-snapshot-skipped`. The gate checks compact provider row spacing, one card per discovered package and
selection through the shared version picker. The Discover search baseline filters to a
single-version entry.
Ready PNGs cover key screens in both locales and themes, including installed plugin cards,
Skills empty state, tool rows and the agent-authored candidate review and file diff.
The additional installed-folder card screen is en/light.

`workbench.spec.ts` always checks Files, Terminal, Goal and Changes in en/zh-CN,
light/dark and 1440/1280 widths, with the dock both open and closed: 64 ready
screens. The real session flows also assert process detachment,
permission/sandbox refusals, durable goal controls, read-only historical diffs,
freshness and ledger navigation. `AGH_WORKBENCH_REPORT` optionally copies those
same screenshots to a private report directory; it does not enable or disable
visual assertions. File read clocks are normalized to 12:00 while their localized
labels remain visible. Job/session IDs and exact revisions stay in collapsed
technical details. The demo model's echoed untrusted-receipt ID and background-job
UUID are normalized to fixed-length values only for terminal screenshots; the
receipt wording, command, bytes, state and process controls remain visible. The
synthetic human shell sets a stable `PS1` and clears its initial version-dependent
prompt through real terminal input. No user controls or diff content are masked.
The terminal fixture provisions synthetic protected files at the preset's deny
mount targets and verifies both read and write refusal. On Linux, bubblewrap's
existing fail-closed initialization cannot create a missing deny mount under a
read-only parent; fixture provisioning does not change that backend policy.

Normal gate runs use `updateSnapshots: none`: unknown names, a missing manifest or a missing
ready image fail. Only an explicit reviewed update writes baselines:

```sh
AGH_UPDATE_VISUALS=1 pnpm e2e:web --reuse-build
```

For a capture-only review, `AGH_SKIP_PIXEL_SNAPSHOTS=1` writes the same normalized PNGs to the
run's output directory and annotates each deferred comparison. Inspect those images before
updating a baseline; a capture-only run is not a passing visual gate. Rerun without that flag
and without update mode to verify the reviewed images.

Review PNG changes and the manifest together with the pinned Chromium on macOS.
Linux provisions real bwrap filesystem/process/network namespaces. On Ubuntu CI, a dedicated
AppArmor profile grants user namespaces only to `/usr/bin/bwrap`; global sysctls and AppArmor
enforcement remain unchanged. Provisioning fails if the actual namespace probe fails, so job and
terminal coverage exercises confinement rather than depending on an unconfined fallback.
Linux uses the pinned Ubuntu 24.04 runner with Playwright-installed system libraries and
`fonts-dejavu-core` / `fonts-dejavu-mono`. Install both font packages when reproducing the gate
in a minimal container: without them Chromium falls back to WenQuanYi for monospace text,
changing diagnostic IDs' layout even with identical CSS. PNGs live in `baselines/darwin/`;
there are no Linux baselines. The Linux CI job also runs
production/fixture typechecks, fast tests, guards and kernel identity integration.
Each failed check remains a failed job even when later steps collect Web evidence. Tolerance is
0.2% changed pixels with a per-pixel threshold of 0.2; do not enlarge it to hide a regression.
Only the repository workspace text (checkout name/absolute path) and elapsed turn timing are
hidden; the metadata clock is normalized to 12:00 while its model label stays visible.
Unified Trace captures use the real Record order menu and normalize only the isolated runtime context
path, current clock and elapsed numbers, retaining localized units, records, controls and statuses.
The screenshot stylesheet uses the real document’s advertised CSP nonce; CSP remains enforced. Temporary fixture paths, credentials and machine-specific home data are not baselines.
Screenshots temporarily use the public reduced-motion preference for JavaScript example hints,
then restore the original preference; CSS motion is disabled by Playwright.
Read-only first-run frames settle that same preference before cloning the production DOM.
Authoring provenance frames capture the real Trace inspector, including its header, controls, version,
test and review facts. Separate fact-chain and request gates retain full Trace coverage; live clock-hook
record counts are not rewritten to make the authoring frame deterministic.
Tablet file-workbench frames show the initial report-reading turn alongside the file pane. The capture
still checks tail-follow first, then verifies the report and history-reading affordance, and restores
the tail afterwards. Earlier tool output can change the fractional height of a long transcript, so its
last-line position is not the visual anchor for this file-preview frame.
Finite UI motion and pending controls must settle before axe or screenshots; no fixed sleeps
or error exemptions are used. Automated axe checks complement manual accessibility review.

The Agent picker reads the backend bundle catalog so newly installed bundles are available to
new sessions without restarting the shared worker. Saving deployment-wide default bundles
retains its documented `restart-required` effect; selecting bundles on a new session does not
change those defaults.

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

The three spec files may run in parallel with two workers; each test owns a fresh home, workspace, daemon, port and SDK clients. Tests within a file remain serial. This bounds hosted-runner duration without retries or relaxed assertions. Credential and visual tool flows explicitly choose full-access; L1 refusal is covered separately by sandbox integration tests.

The synthetic stdio MCP fixture explicitly selects `off-with-warning` and checks that the
profile is persisted before trust/enable. Its live tool and Skill assertions also run on
hosts where MCP confinement is unavailable. Strict confinement and refusal are covered by
the sandbox backend and resource-control-worker integration tests.

CI and local guards enforce the reviewed file-size limits in `tools/guards/file-size-allowlist.json`.
Any new excess fails the check and is also appended to the job summary. Re-measurement
uses the guard's `countLines` and exact source-path matching; no report-only switch or
spare allocation bypasses the ceiling. Structural, dependency, counting-regression
and functional assertions remain hard gates.

The runtime launches both serve and CLI children from its synthetic workspace. Agent launch tickets inherit the server workspace, so a test must never start them from the repository checkout.
