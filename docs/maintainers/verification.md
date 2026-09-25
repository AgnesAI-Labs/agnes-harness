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

<a id="构建与真实本地进程"></a>

## Build and real local processes

```sh
pnpm --filter @agnes/cli build:local
node packages/cli/dist/local/agnes.mjs --help
node --import tsx tools/public-docs/smoke.mjs
```

The smoke test uses an isolated temporary home, a loopback model fixture, and real CLI/daemon/worker processes. It checks sessions, default helpers, plugins, Web interfaces, updates, and cleanup, then stops the services it started. It accesses Web through HTTP/WebSocket clients, which does not establish real-browser visual acceptance.

See [installation](../guide/install.md) for separate output directories and PowerShell steps, or the [demo guide](../guide/demo.md) for manual exploration.

<a id="记录验证结果"></a>

## Record results

For each acceptance run, record source revision, OS/architecture, Node/pnpm versions, commands, and passed/failed/skipped counts. If fixes are followed by focused regression tests, state their coverage without presenting them as another full-suite run.

Release summaries should link to version-matched CI or redacted acceptance results. Record browser, real-model, external-MCP, physical-device, and other-platform results separately. Local loopback tests cannot establish acceptance in those environments.

<a id="2026-09-24-源码候选验证"></a>

## Source-candidate verification on 2026-09-24

Environment: macOS arm64, Node.js 24.20.0, pnpm 10.34.5, with independent source and isolated runtime directories.

| Check | Result |
| --- | --- |
| Locked dependency installation, two native helpers, complete local build | Passed |
| Types, generated consistency, documentation links, source anchors | Passed |
| Biome | 0 errors; 30 warnings and 15 informational diagnostics retained |
| Automated tests | Initial full run: 18,682 tests; 344 skipped. All 16 failures were fixed and passed focused regression tests |
| Final repository guard rerun | 544 passed, 2 skipped |
| Real local process smoke | 19 stages passed |

The strategy was one full run plus related regressions, without a second full-suite run after fixes. Regressions covered all initial failures, Worker, Host assembly, and documentation examples. Skips remain subject to platform or explicit environment conditions. Real browsers, paid models, external services, physical devices, and other platforms were outside this acceptance scope. Revalidate after source or build-environment changes.
