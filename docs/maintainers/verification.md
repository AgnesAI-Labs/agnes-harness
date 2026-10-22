# Verification and reproduction

English | [简体中文](verification.zh-CN.md)

<a id="验证与复现"></a>

[Documentation](../README.md) · [Supported scope](../reference/limitations.md) · [Release checks](release.md)

Verify the same revision as the source and documentation you are using. These entry points support reproducible checks. A deterministic local model tests protocols and execution flow; real providers, browsers, and platform experiences require separate validation.

<a id="环境与前置步骤"></a>

## Environment and prerequisites

Run from the repository root. Run `mise trust` and `mise install` first. The exact development Node patch comes from [`.node-version`](../../.node-version), supported user range and pnpm pin from [package.json](../../package.json). Use one entry for installs, builds and checks; it prints actual `process.version` and `process.execPath` and verifies a child runtime:

```sh
mise exec -- node tools/toolchain/run.mjs install --frozen-lockfile
mise exec -- node tools/toolchain/run.mjs --filter @agnes/host build:native
mise exec -- node tools/toolchain/run.mjs --filter @agnes/system-node build:native
```

<a id="静态与自动化检查"></a>

## Static and automated checks

```sh
mise exec -- node tools/toolchain/run.mjs exec node tools/public-docs/verify.mjs
mise exec -- node tools/toolchain/run.mjs typecheck
mise exec -- node tools/toolchain/run.mjs lint
mise exec -- node tools/toolchain/run.mjs gen:check
mise exec -- node tools/toolchain/run.mjs exec vitest run tools/guards/src tools/public-docs/examples.test.ts --maxWorkers=1
```

The [repository guard guide](../../tools/guards/README.md) distinguishes the report-only scope
line-count report from hard file ceilings, the AST function effective-LOC ceiling in turn/generation/
supervisor, and the Host official-business semantic fence. File/function budgets and exact Host
exceptions cannot grow against the protected merge-base; ordinary remeasurement only tightens.
Existing assemble/CU gates remain in force. Guard fixtures cover refusal paths; they do not verify
runtime capability admission or state-machine migrations. See the guide for counting rules, retained
contracts, first-introduction seeds and separate maintainer budget changes.

`pnpm test:all` runs the complete suite; `pnpm test` runs only the fast tier and `pnpm test:heavy` only the real-process and large-data tier (`*.e2e.test.ts`, `*.slow.test.ts`). Retain skips, platform prerequisites, and failures in the results for that revision. A total pass count must not hide unverified areas.

The CLI startup test still gates successful boot and session creation. On shared CI runners, its elapsed time is reported in the job summary rather than used as a pass/fail threshold. To enforce the 300 ms target on a controlled performance machine, set `AGH_ENFORCE_BOOT_BUDGET=1` and run `pnpm exec vitest run packages/cli/test/boot-budget.test.ts --maxWorkers=1`.

Web delivery builds use production React and compressed JavaScript; the development watcher keeps development diagnostics. The focused `packages/cli/test/build-local-web.test.ts` gate walks the emitted static module graph, including import-map vendors, and limits cold JavaScript to 6.75 MiB. Built-in home pages, the chart plotting engine and the offline diagnostics renderer load on demand. The shell imports the declared `@agnes/web-units/shell` entry; the package root retains its diagnostics exports for compatibility. The source table and legend remain available while a plot loads. Historical transcript turns retain exact record identities and use per-turn rendering boundaries; global plugin contributions still receive the current projection. The focused turn and slot tests gate unchanged-history rendering across 20 updates, alongside the existing scroll, selection, navigation and slot lifecycle checks. This byte gate is deterministic; it does not replace real-browser paint, interaction, or transcript measurements.

Generated event, protocol and projection schemas use immutable definitions and CSP-safe cached reference plans. Rejected values still use TypeBox's complete error iterator; policy flags and registered formats remain live. Caller-owned mutable schemas retain interpreted validation. `packages/protocol/test/validate.test.ts` differentially checks results and full errors, including recursive, malformed and policy-dependent inputs. The heavy `validation-plan.slow.test.ts` compares a 500-node projection with the interpreter (median planned time must stay below 70%).

The heavy `packages/cli/test/startup-perf.e2e.test.ts` uses `AGNES_LOCAL_CLI` pointing at an existing local build, an isolated fresh home and a real daemon/worker. It bounds CLI readiness at 8 s and the first session at 4 s, reports each measurement, and stops its processes before cleanup. Run paired startup spans and CPU profiles on the same machine for attribution; these broad regression bounds do not replace paired measurements. Ledger query plans cache statements on their own connection, including scan and append-watermark statements; rows, integrity decisions, commit ordering and checkpoint synchronization are never cached or relaxed.

Streaming preparation reuses scrubbed tool schemas only from detached, frozen registry definitions; every request still mints its own body and runs the provider-wire validation and admission path. `packages/core/test/derive.test.ts` covers equivalent cold/warm stamps, source mutation, replacement and disclosure changes.

While subscribed to events, concurrent equal SDK controls, full UI projection, UI-surface and workspace-change reads share only an in-flight RPC at the same session, generation and event watermark. Events arriving during a read queue a fresh follow-up, shared by callers whose required watermark it covers. Results remain private to each caller; later events trigger fresh reads, refusals are retried, and detach, disconnect and generation changes reject stale results. The focused `packages/sdk/test/session.test.ts` and `ui-projection-sync.test.ts` cases also gate immediate stream-start and turn-end projection while preserving the single ordered projection queue. Plugin session selection is gated in `packages/web-client/test/web-client.test.ts`.

The serial `packages/host-infrastructure/test/adapters/table-reads.slow.test.ts` heavy gate measures five batches of 3,000 owner reads against 50 synthetic rows, with a conservative 150 ms ceiling per batch. It also checks fresh results after writes, schema changes and query-plan eviction, invalid bindings and refused SQL. Query-plan reuse stays within each isolated connection; no rows or authorization results are cached. The existing ledger-integrity and package-load gates remain required.

The package-load gate is the **gates real immutable package preparation** case in `tools/plugin-performance.slow.test.ts`. Run it serially on a performance runner with Node 24:

```sh
mise exec -- node tools/toolchain/run.mjs exec vitest run tools/plugin-performance.slow.test.ts --project heavy --maxWorkers=1 -t 'gates real immutable package preparation'
```

It installs, trusts and pins 20 synthetic packages, each with 200 × 1 KiB payload files plus a module, manifest and two 32 KiB client assets. Three runs measure cold/warm inventory, immutable snapshots, the real Host package-assembly stage (before native/provider startup), readonly client roster/assets, and Surface change-event publication during package IO. Cold uses new readers and empty loader/client disk caches; it does not flush OS caches. Surface transport uses a synthetic SDK response with the production subscription and route lookup; this does not verify daemon IPC or browser rendering.

Every sample gates wall time (10 s per stage, 15 s cold preparation, 1 s Surface publication), event-loop gaps (250 ms), process peak RSS (1536 MiB, including setup/import high water) and sampled RSS growth (256 MiB). The fixed ceilings live in `tools/package-load/metrics.ts`; they are conservative regression budgets, not measured performance claims. The test prints dataset, machine, Node and per-run measurements before budget assertions. Set `AGH_PERFORMANCE_OUTPUT` to a path outside the repository to also save `<path>.package-load.json`. Review results on the same runner before changing ceilings. Warm loader and ordinary/fresh inventory reads must still refuse tampered bytes. The fast `tools/package-load.test.ts` exercises the real path at one-package scale and checks budget refusal without claiming the large-data gate passed.

On Windows, tests that exercise symlink escapes require permission to create symbolic links (Developer Mode or the corresponding account privilege). An `EPERM` from `symlinkSync` while staging a fixture means that environment prerequisite is missing; the security assertion has not run. The shared CI startup diagnostic also runs after a failing test step, unless the suite was skipped or the job was cancelled.

## Previous-build upgrade gate

The [previous-build test](../../tools/upgrade/previous-build.e2e.test.ts) is **suspended by default**, including in the heavy CI tier. Its pinned baselines predate Extension API 5.0 and the SQLite data-directory gate: their fixture plugin/API ranges and persisted formats are incompatible. A skipped test is not upgrade acceptance.

Only after choosing compatible API-5.0 baselines with a supported data format may a maintainer opt in with `AGH_UPGRADE_GATE=1` and `AGH_UPGRADE_PREVIOUS_REF`. The test is intended to cover clean shutdown, process loss, preserved history/pins and refusal of retired metadata; Windows remains skipped. Baselines and optional distribution inputs are declared in [distributions.mjs](../../tools/upgrade/distributions.mjs). Do not force old data through the gate or convert its trust bytes. For end-user recovery use [data-format recovery](../guide/install.md#data-format-and-upgrade); no runtime-data migration is provided.

<a id="构建与真实本地进程"></a>

## Build and real local processes

```sh
mise exec -- node tools/toolchain/run.mjs --filter @agnes/cli build:local
node agnes.mjs --help
node --import tsx tools/public-docs/smoke.mjs
```

The smoke test uses an isolated temporary home, a loopback model fixture, and real CLI/daemon/worker processes. It checks sessions, default helpers, plugins, Web interfaces, updates, and cleanup, then stops the services it started. It accesses Web through HTTP/WebSocket clients, which does not establish real-browser visual acceptance.

The maintained `pnpm e2e:web` gate runs on macOS and Linux in [CI](../../.github/workflows/e2e-web.yml). It builds or validates a reusable runtime, starts real isolated daemon/Web processes from `agnes.mjs serve`, and executes page interactions, persisted mutations, locale/accessibility checks and reviewed platform-specific screenshots. Provision Chromium separately. The [Web gate guide](../../tools/e2e-web/README.md) owns the spec inventory, artifacts, zero-retry policy and baseline review. Fixture coverage establishes the selected scenarios, not every browser or deployment.

See [installation](../guide/install.md) for separate output directories and PowerShell steps, or the [demo guide](../guide/demo.md) for manual exploration.

<a id="记录验证结果"></a>

## Record results

For each acceptance run, record source revision, OS/architecture, Node/pnpm versions, commands, and passed/failed/skipped counts. If fixes are followed by focused regression tests, state their coverage without presenting them as another full-suite run.

Release summaries should link to version-matched CI or redacted acceptance results. Record browser, real-model, external-MCP, physical-device, and other-platform results separately. Local loopback tests cannot establish acceptance in those environments.

<a id="2026-09-24-源码候选验证"></a>

## Release evidence

Use version-matched CI artifacts and release notes for results. Historical source-candidate counts are not current acceptance evidence. Keep real-model results separate from deterministic fixtures, and record exact model/account environment without credentials. No Windows or physical-device acceptance is implied by macOS/Linux CI. See [release checks](release.md).
