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
