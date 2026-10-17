# Verification and reproduction

English | [简体中文](verification.zh-CN.md)

<a id="验证与复现"></a>

[Documentation](../README.md) · [Supported scope](../reference/limitations.md) · [Release checks](release.md)

Verify the same revision as the source and documentation you are using. These entry points support reproducible checks. A deterministic local model tests protocols and execution flow; real providers, browsers, and platform experiences require separate validation.

<a id="环境与前置步骤"></a>

## Environment and prerequisites

Run from the repository root. Node/pnpm versions are defined in [package.json](../../package.json):

```sh
pnpm install --frozen-lockfile
pnpm --filter @agnes/host build:native
pnpm --filter @agnes/system-node build:native
```

<a id="静态与自动化检查"></a>

## Static and automated checks

```sh
node tools/public-docs/verify.mjs
pnpm typecheck
pnpm lint
pnpm gen:check
pnpm exec vitest run tools/guards/src tools/public-docs/examples.test.ts --maxWorkers=1
```

`pnpm test:all` runs the complete suite; `pnpm test` runs only the fast tier and `pnpm test:heavy` only the real-process and large-data tier (`*.e2e.test.ts`, `*.slow.test.ts`). Retain skips, platform prerequisites, and failures in the results for that revision. A total pass count must not hide unverified areas.

The CLI startup test still gates successful boot and session creation. On shared CI runners, its elapsed time is reported in the job summary rather than used as a pass/fail threshold. To enforce the 300 ms target on a controlled performance machine, set `AGH_ENFORCE_BOOT_BUDGET=1` and run `pnpm exec vitest run packages/cli/test/boot-budget.test.ts --maxWorkers=1`.

The package-load gate is the **gates real immutable package preparation** case in `tools/plugin-performance.slow.test.ts`. Run it serially on a performance runner with Node 24:

```sh
pnpm exec vitest run tools/plugin-performance.slow.test.ts --project heavy --maxWorkers=1 -t 'gates real immutable package preparation'
```

It installs, trusts and pins 20 synthetic packages, each with 200 × 1 KiB payload files plus a module, manifest and two 32 KiB client assets. Three runs measure cold/warm inventory, immutable snapshots, the real Host package-assembly stage (before native/provider startup), readonly client roster/assets, and Surface change-event publication during package IO. Cold uses new readers and empty loader/client disk caches; it does not flush OS caches. Surface transport uses a synthetic SDK response with the production subscription and route lookup; this does not verify daemon IPC or browser rendering.

Every sample gates wall time (10 s per stage, 15 s cold preparation, 1 s Surface publication), event-loop gaps (250 ms), process peak RSS (1536 MiB, including setup/import high water) and sampled RSS growth (256 MiB). The fixed ceilings live in `tools/package-load/metrics.ts`; they are conservative regression budgets, not measured performance claims. The test prints dataset, machine, Node and per-run measurements before budget assertions. Set `AGH_PERFORMANCE_OUTPUT` to a path outside the repository to also save `<path>.package-load.json`. Review results on the same runner before changing ceilings. Warm loader and ordinary/fresh inventory reads must still refuse tampered bytes. The fast `tools/package-load.test.ts` exercises the real path at one-package scale and checks budget refusal without claiming the large-data gate passed.

On Windows, tests that exercise symlink escapes require permission to create symbolic links (Developer Mode or the corresponding account privilege). An `EPERM` from `symlinkSync` while staging a fixture means that environment prerequisite is missing; the security assertion has not run. The shared CI startup diagnostic also runs after a failing test step, unless the suite was skipped or the job was cancelled.

## Previous-build upgrade gate

```sh
pnpm exec vitest run tools/upgrade/previous-build.e2e.test.ts --project heavy --maxWorkers=1
```

This standing heavy-tier gate builds real distributions from the working tree and pinned plugin-core commits in [distributions.mjs](../../tools/upgrade/distributions.mjs). The recent baseline predates the client-normalization and bundled-default fixes; a second, older baseline predates ledger append watermarks. It creates private synthetic homes with a loopback model account, chat/tool/attachment/deliverable/fork/queued history, trusted packages, settings, a schedule and a trigger. Each baseline upgrades after both clean shutdown and process loss. Assertions cover unchanged historical events, writable history, retained authorization, refreshed bundled bytes, and managed recovery through native decisions when needed. No home conversion or old-product migration runs. History rendering uses the Web timeline projection; browser layout has its own gate.

Use `AGH_UPGRADE_PREVIOUS_REF=<commit>` to select another recent baseline. Git must contain both pinned commits (`git fetch --unshallow` for a shallow clone). Optional absolute `AGH_UPGRADE_PREVIOUS_DIST`, `AGH_UPGRADE_LEDGER_DIST` and `AGH_UPGRADE_CURRENT_DIST` directories reuse complete builds; their bytes must match the selected source revisions. The default build stamps the recent previous/current distributions as `1.0.0`/`1.1.0` to exercise release-owned default updates. `AGH_UPGRADE_KEEP=1` retains successful scratch output; failures always retain it and print its location. Build dependencies require registry access; model traffic stays on loopback and uses only a dummy key. Launcher environments omit operator credentials and use private homes. Run serially with enough disk space for three distributions and the installation guide's native toolchains.

For diagnosis, `AGH_UPGRADE_CASE=recent|legacy` and `AGH_UPGRADE_VARIANT=clean|unclean` narrow the run. Leave both unset for the complete gate.

The existing CI heavy job runs this automatically on Linux for PRs and on Linux/macOS for main, nightly and manual runs, with full Git history. Windows explicitly skips this gate: native crash/process-tree acceptance remains a colleague's follow-up; a POSIX pass is not Windows evidence.

<a id="构建与真实本地进程"></a>

## Build and real local processes

```sh
pnpm --filter @agnes/cli build:local
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
