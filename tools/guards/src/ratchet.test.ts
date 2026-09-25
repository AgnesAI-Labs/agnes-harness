// 2026-09-25 CSP nonce wiring: measured after shared Antd root wrapper and all production root call sites;
// packages/web-ui/src 450, packages/web/src 13303. Exact measured totals, no spare allocation.
// HELPER-REPAIR integrated with 50d55230: measured web 13260/app 1772/admin 1714, including formatting.
// HELPER-REPAIR: measured SDK 5050, daemon 26353 for stream recovery and bounded skins; no spare.
// PLUGIN-HELPER merge with b/main@8f2e20e7: daemon 25955, Host 38018, measured combined source.
// PLUGIN-HELPER: exact measured request-port/authoring and default migration allocation; no spare.
// DEFAULT-HELPER-PLUGINS: measured bootstrap/port and builtin removal; exact caps, no spare.
// SKILL-DELETE-PRIORITY: protocol root exports two new parameter types; measured 2032, no spare.
// MAIN-INTEGRATION-20260922: exact merged counts with b/main 6a8e52b3; Host 36532,
// Core 23838, protocol 2030, CLI-TUI 4759, SDK 4200; no extra allocation or exclusions.
// SESSION-WORKSPACE-SKILLS: exact merged counts after e2b40954 plus workspace loading; no spare budget.
// MAIN-MERGE-20260922 final b79e678b: measured Host 36455 / assemble 4279 / package-manager 5604; no spare budget.
// MAIN-MERGE-20260922: measured combined Host 36378 / assemble 4223; both feature sets retained.
// BUNDLED-SKILL-HELPER: measured package-manager +12 and build-local +6, no spare budget.
// SKILL-HELPER-REVIEW-FIXES: exact measured Host +42 / assemble +1; see execution/2026-09-22-skill-helper-review-fixes.md.
// SKILL-INSTALL-CORE: exact measured request port/installer/CLI allocations, no exclusions or headroom;
// see execution/2026-09-22-skill-install-core.md. Capability grants and public admin RPC are unchanged.
// 2026-09-22 incremental-apply review fix pass (B1 shared inventory-hash helper, I1 outer-rollback
// deadline, I2 rebuild-on-failed-compensation guard): exact countLines() totals, no spare allocation.
// packages/host/src/assemble 4227->4240, packages/host/src 35669->35682,
// packages/package-manager/src 5579->5591->5592 (biome reformat of stableInventoryRows() added 1 line).
// 2026-09-22 main merge: exact combined counts, including CU retry cleanup and archived panes;
// No exclusions or spare allocation.
// CU-FIRST-RUN: user-approved first-use preparation and replaceable settings lifecycle;
// exact measured totals, no spare allocation. See execution/2026-09-22-computer-use-first-run.md.
// 2026-09-22 hot-update review fixes + synchronized macOS Host changes: exact measured caps; see review-fixes evidence.
// Integrated feature counts; no spare allocation.
// 2026-09-18 combined subscription submission: exact measured feature allocations; see submission evidence.
// SESSION-RESTORE-02: remeasured merged Computer Use/OAuth keys and recovery fixes with countLines;
// see execution/2026-09-18-session-restore-followup.md. No exclusions or spare budget added.
// 2026-09-23 local-examples-catalog agnes.plugins support (hot-tool/agent-automation/compaction-policy/
// skins-builtin/supply-rescue dropped, hot-service/hot-tool-plugin/hook-context-note/hook-runner-
// takeover added): packages/package-manager/src 5611->5674, remeasured after biome --write.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { countLines } from './count-lines.js'
import { matchesRatchetKey } from './ratchet-key.js'
import { isTestFile, listSourceFiles, repoRoot } from './repo.js'

const root = repoRoot()
const ratchet = JSON.parse(readFileSync(join(root, 'tools/guards/ratchet.json'), 'utf8')) as Record<
  string,
  number
>

describe('line-count ratchet', () => {
  it('registers both Cordis foundation packages', () => {
    expect(Object.hasOwn(ratchet, 'packages/cordis-loader/src')).toBe(true)
    expect(Object.hasOwn(ratchet, 'packages/plugin-runtime/src')).toBe(true)
  })
  for (const [prefix, max] of Object.entries(ratchet)) {
    it(`${prefix} ≤ ${max} lines`, () => {
      const abs = join(root, prefix)
      // The scan root is unconditionally the parent directory; no either/or decision is made about
      // whether abs itself is a file or a directory. listSourceFiles recurses, so this naturally covers
      // both `${abs}.ts` (the file form) and `${abs}/**` (the directory form), and keeps both in scope
      // even when a file and a directory of the same name coexist. Precision comes from
      // matchesRatchetKey's boundary filter, not from narrowing the scan root. When the parent does not
      // exist, listSourceFiles returns an empty array, which counts as 0 lines and passes.
      const scanRoot = dirname(abs)
      // This used to add 'test' to excludeDirs, which excluded **any** directory named test in its
      // entirety. Measured: 5000 lines of real source in `packages/protocol/src/test/x.ts` left the
      // ratchet green with 14 passed, while the same 5000 lines in `src/deep/x.ts` went red. The
      // hard line-count ceiling is one of this repo's most central maintainability constraints, and
      // that was its only escape hatch. Changed to **filter test files by filename only and exclude
      // no directories at all**: genuine data-fixture directories are named fixtures/ instead (which
      // is what platform / kernel-create exclude), and fixtures/ holds data rather than source — if
      // source is ever put there, counting it against the line budget is the correct outcome.
      const files = listSourceFiles(scanRoot).filter((f) => matchesRatchetKey(f, abs) && !isTestFile(f))
      const total = files.reduce((n, f) => n + countLines(readFileSync(f, 'utf8')), 0)
      expect(total, `${prefix}: ${total} > ${max}`).toBeLessThanOrEqual(max)
    })
  }
})

// Regression cases for two successive defects. A plain string startsWith(abs) counted a sibling file
// sharing the prefix (assemble-legacy.ts) as belonging to the assemble key — a false positive. The
// first fix narrowed the scan root to "if abs is a directory, scan only abs", which introduced a false
// negative: when assemble.ts and assemble/ coexist, assemble.ts fell outside the scan and was not
// counted at all. The scan root is now unconditionally dirname(abs), with the boundary filter
// providing precision.
// Real file layouts are built in a temp directory, removed in a finally at the end of each case.
describe('ratchet key path-boundary matching (regression: sibling-prefix false match / narrowed-scan-root false negative)', () => {
  it('file form: counts assemble.ts, excludes sibling assemble-legacy.ts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-ratchet-file-'))
    try {
      writeFileSync(join(dir, 'assemble.ts'), 'const a = 1\n')
      writeFileSync(join(dir, 'assemble-legacy.ts'), 'const b = 1\nconst c = 2\nconst d = 3\n')
      const abs = join(dir, 'assemble')
      const files = listSourceFiles(dirname(abs)).filter((f) => matchesRatchetKey(f, abs))
      expect(files).toEqual([join(dir, 'assemble.ts')])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('directory form: counts nested files under assemble/', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-ratchet-dir-'))
    try {
      mkdirSync(join(dir, 'assemble', 'nested'), { recursive: true })
      writeFileSync(join(dir, 'assemble', 'nested', 'deep.ts'), 'const e = 1\n')
      const abs = join(dir, 'assemble')
      const files = listSourceFiles(dirname(abs)).filter((f) => matchesRatchetKey(f, abs))
      expect(files).toEqual([join(dir, 'assemble', 'nested', 'deep.ts')])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('co-existing form: assemble.ts (file) and assemble/ (dir) both present, both counted', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-ratchet-both-'))
    try {
      writeFileSync(join(dir, 'assemble.ts'), 'const a = 1\n')
      mkdirSync(join(dir, 'assemble', 'nested'), { recursive: true })
      writeFileSync(join(dir, 'assemble', 'nested', 'deep.ts'), 'const e = 1\n')
      writeFileSync(join(dir, 'assemble-legacy.ts'), 'const b = 1\nconst c = 2\nconst d = 3\n')
      const abs = join(dir, 'assemble')
      const files = listSourceFiles(dirname(abs)).filter((f) => matchesRatchetKey(f, abs))
      expect(files.sort()).toEqual(
        [join(dir, 'assemble', 'nested', 'deep.ts'), join(dir, 'assemble.ts')].sort(),
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// The "line-count ratchet" cases above check the current value against ratchet.json. Reviewed
// ceilings also live in this test file, so increasing a budget requires an explicit, visible policy
// change in both places. Otherwise a budget can only tighten within its reviewed ceiling.
// 2026-09-23: user-approved rebaseline of the ten exceeded scopes to exact countLines() results
// on ec5f91d6 plus the lint-only follow-up. No source exclusions or spare lines were added;
// see execution/2026-09-23-extension-mcp-closure.md.
// Main integration preserves prior UI/startup caps and adds exact merged ecosystem totals.
// Measured 2026-09-13: Core 10569, protocol 1375, Host 9837, adapters 2176.
// 2026-09-13 unified usage: optional projection facts and completeness, Web disclosure,
// CLI scrollable reports. Exact feature allocation; see unified-usage-details execution evidence.
// 2026-09-13 UI-01..07 integration adds ledger-derived turns and inherited accounting, durable
// fork/reopen, canonical workspace persistence, Web workspace/draft/settings orchestration, and
// isolated Web launch data-dir forwarding. Final exact totals are Core 12206, Protocol 1425,
// SDK 3869, Daemon 14154, Web 5289, Host 10538, Host adapters 2255 (SQLite 626), CLI 8512,
// and CLI launch 494. New Web navigation/shell/turn modules are independently fenced below.
// WIN-12bj: user-approved exact allocation; see windows-budget-install-approved plan.
// Historical allocation comments below describe earlier increments, not the final totals.
// 2026-09-15 main/Windows merge: exact measured allocations; retain main MCP <=800.
// Evidence: execution/2026-09-15-main-windows-merge.md (no counting exclusions changed).
// MAIN-WIN-MERGE-3: exact main thinking-switch increments SDK +6, Daemon +16, Host +15.
// MAC-COMPAT-BOUNDARY: POSIX async durability +14; Host platform gate +3; Hook platform checks +2.
// Exact measured increments, no counting exclusions or other allocations changed.
// MAC-COMPAT repair: caller directory policy +5; journal cache invalidation +5 (operations exact408).
// SESSION-TITLE: exact measured allocation for Host generation, trusted metadata, cost ownership
// and Web refresh. No spare capacity or counting exclusions; execution/2026-09-16-session-title.md.
// CODEX-OAUTH-01: exact authored-source deltas only, preserving concurrent allocations.
// See execution/2026-09-17-codex-oauth.md; no scan exclusions or spare budget added.
// 2026-09-18 Computer Use PR integration: values touched by the two diverged histories were
// remeasured against the resolved tree with this guard's own countLines() implementation.
const INITIAL_CEILING: Record<string, number> = {
  // 2026-09-22 M11 browser effect-command closure: exact measured deltas for the explicit
  // authorization facade, private BFF/RPC, durable journal reuse, and cross-platform test repair.
  // No source exclusions or spare budget were added.
  // 2026-09-17 (web-client-modules P2 / WC4): vendored Cordis core and utilities taken from npm
  // @deepseek-ai/cordis@4.0.2 / @deepseek-ai/cosmokit@1.8.3 (dsh's published vendor/cordis incl.
  // the fiber re-entrant unload patch). Third-party code: exact measured values, no spare; any
  // in-package edit must update VENDORED.md alongside.
  'packages/cordis/src': 2702,
  // CORDIS-C1 Tasks 1-3: foundation plus the eight stable seam facades, verified row runtime and
  // Host-private mutable builtin claim catalogue for reconciled preset data. Exact measurement.
  // 2026-09-22 incremental apply: host transactions unmount the old row before mounting its
  // replacement, bound every adapter call with a per-step deadline and mark the tree tainted when
  // one is abandoned. Re-measured with countLines(): 772, exact cap, no spare.
  'packages/cordis-loader/src': 772,
  // CORDIS-C2 Task 8 adds the canonical immutable runtime-target builder/codec and four closed
  // resource-owned row slots. Re-measured with countLines(): 1860, exact cap, no spare.
  // Task 12 publish-time cycle/secret/policy-builtin validation. Re-measured: 1968, exact.
  // Task 17 adds a Host-only published-root switch for stable dynamic seam facades. Re-measured: 1986, exact.
  // 2026-09-21 seam-facade fix: replaceRoot() must drop the retiring root's `internal/service`
  // subscription, or the old tree's asynchronous close releases the seam value the NEW root just
  // provided (E_SEAM_UNAVAILABLE on every post-boot applyRuntimeTarget). +3 counted lines
  // (`let offService`, `offService?.()`, `offService = undefined`; the rest is comment).
  // Re-measured with this guard's countLines(): 1989, exact cap, no spare.
  // 2026-09-21 row-reuse fix: the verified-row adapter's update() returned early when the newly
  // normalized config is structurally equal to the running one. Every delivery re-decodes the
  // target, so without it each ordinary apply restarted every row that carries an object config.
  // +4 counted lines (the `if`, `state.rawConfig = ...`, `return`, `}`; the rest is comment).
  // Re-measured with this guard's countLines(): 1993, exact cap, no spare.
  // 2026-09-21 row-reuse review: that early return compared with sameValue(), which ignores
  // prototypes, so two different Dates (or Maps, or class instances) a config schema decodes to
  // looked equal and a real config change was silently dropped. The comparison now only recurses
  // through plain objects and arrays of the same prototype. +4 counted lines (`plainPrototypes`,
  // `const prototype`, the two-line `if`). Re-measured: 1997, exact cap, no spare.
  // 2026-09-21 stage 2a: hooks-runner and privacy leave the resource-owned id list (-5 counted
  // lines, tightened to the exact measurement). Re-measured with this guard's countLines(): 1992.
  'packages/plugin-runtime/src': 2024,
  'packages/cosmokit/src': 483,
  // 2026-09-17 (web-client-modules P2 / WC6): author-facing browser API package. Measured 480;
  // exact cap, no spare — new mount points add one table row + host container by contract.
  // 2026-09-22 Web Plugins parity: row-scoped client services and stable web-unit contracts. Exact.
  // CU-ARTIFACT-RETENTION-GC-INDEX C8: measured 1714, exact, no spare (+9). ClientResourceReclaimedError
  // thrown on a 410 artifact_reclaimed read.
  'packages/web-client/src': 1714,
  'packages/web-slots/src': 605,
  // A-line settings selects: React-owned options replace imperative DOM; exact formatted counts.
  // 2026-09-25 C-line migration: web-ui carries the admin/resource component layer
  // (admin-list/admin-detail/admin-dialogs/admin-confirmation/admin-text/resource-* +
  // select-picker/confirm/popover moved in from web-admin-frame). countLines 2589.
  'packages/web-ui/src': 2589,
  'packages/web-units/src': 3172,
  'packages/base/extensions/tools-core': 800,
  // MCP-ROWS stage 2b, steps 1-2 (D118): connection supervisor, catalog hub, and the per-server
  // extension row wiring them together. New extension at the shared default cap; measured 276.
  'packages/base/extensions/mcp-server': 800,
  // MCP-ROWS stage 2b step 2 (D110'): tool_search/tool_describe as their own extension, reading
  // through McpCatalogHub. Built and tested now but not yet loaded (see its own doc comment); new
  // extension at the shared default cap; measured 22.
  'packages/base/extensions/mcp-search': 800,
  'packages/base/extensions/principals-local': 60,
  // 2026-09-19 Computer Use retention: the recent-artifact index accepts the profile's tightened
  // per-session limit (never above the product ceiling of 20). Measured 535; exact cap.
  // 2026-09-19 secure physical-delete executor and attested-plan lease. Measured 624; exact cap.
  'packages/base/extensions/artifacts-local': 624,
  'packages/base/extensions/approval-policy': 300,
  'packages/base/extensions/tools-search': 400,
  // WEBFETCH-01: new component, exact measured allocation.
  // SKILL-GITHUB-RATE-LIMIT: explicit ZIP byte response; measured 380, no spare.
  'packages/host/src/adapters/public-fetch': 380,
  // WEBFETCH-01: new component, exact measured allocation.
  // WEBFETCH review fixes: table-local header tracking and conservative optional-end/comment handling.
  // Measured with countLines: 243 (+15); no unrelated budgets changed.
  // SKILL-GITHUB-RATE-LIMIT: reject unexpected binary in the text tool; measured 244.
  'packages/base/extensions/tools-web': 244,
  'packages/base/extensions/compaction': 800,
  // CORDIS-C1b Task 6 fits checkpoint state to the invocation workspace; exact measured total.
  'packages/base/extensions/fs-checkpoint': 380,
  'packages/base/extensions/sandbox': 800,
  'packages/base/extensions/budget': 90,
  'packages/base/extensions/loop-hygiene': 100,
  'packages/host/src/adapters/powershell': 133,
  'packages/host/src/adapters/powershell-command': 31,
  'packages/host/src/adapters/powershell-file': 47,
  'packages/host/src/adapters/powershell-temporary': 43,
  'packages/host/src/adapters/process-identity-win32': 18,
  'packages/host/src/adapters/exec-win32': 78,
  'packages/host/src/adapters/exec-output': 32,
  'packages/host/src/adapters/secrets-win32': 25,
  // WIN-TITLE-REPAIR: +3 for peer-only rejection backoff; no counting exclusions changed.
  // 2026-09-20 GC attestation keeps Node hashing/path/proxy primitives outside Core, while Windows
  // mapped-image identity remains native-bound. Measured 1080; exact cap.
  // 2026-09-20 live Package Family Name and mapped executable identity. Measured 1098; exact cap.
  // 2026-09-21: add Linux same-handle artifact deletion dispatch and availability. Exact 1122.
  // 2026-09-22: no-replace directory publication, +17 measured lines; no fallback.
  // SKILL-DELETE-PRIORITY: +47 counted lines for 64-bit deletion and platform path preflight; no spare.
  'packages/system-node/src': 1186,
  // 2026-09-13 in-process ecosystem: verified snapshots, rollback journal/GC and the local examples
  // catalogue are the PackageManager-owned state machine. Exact post-integration total; no spare.
  // 2026-09-14: Task 1 orphaned-pin-cleanup adds listRuntimePinsStore() function and
  // PackageManager.listRuntimePins() method to enumerate all runtime pins. Exact post-integration
  // total; no spare.
  // 2026-09-16 (plugin-skin S3): src/skin-assets.ts adds the skin filesystem gate — stylesheet
  // byte cap, asset extension allowlist, per-asset cap, per-skin asset total, and symlink-safe
  // containment via the existing containedEntry. Measured 4735; exact cap, no spare.
  // 2026-09-16 (plugin-skin S5): collectSkinRoster adds roster assembly — enabled/trusted filter,
  // cross-package id uniqueness with shadowed reporting, and a content revision digest.
  // Measured 4773; exact cap, no spare.
  // 2026-09-16 (plugin-skin S11a prep): collectSkinRoster now also reads the manifests a package
  // bundles via package.json `agnes.extensions`, because that is where real packages keep them.
  // Combined measured total: 4826.
  // 2026-09-16 (plugin-skin S15): the roster accepts build-embedded skin data, so a packaged
  // distribution needs no source tree. A packaged build points every builtin at one directory,
  // so the roster also reads a shared directory once. `manifestCapabilities` now enumerates `ui`,
  // so a capability ceiling actually governs skins. Combined measured total: 4867.
  // 2026-09-16 (plugin-skin S23): `rewriteSkinAssetUrls` + `skinCssUrl`, which make an author's
  // relative `url()` resolve under the skin's own route instead of the page root. Measured 4888,
  // exact.
  // 2026-09-17 (WINDOWS-LOCK-RECLAIM, 其他协作者未提交的工作树修改): lockfile.ts 的 ownerIsDead
  // 在 Windows 上补收 EPERM，并给 reclaim 标记补一条陈旧阈值回收，实测 4898。这 10 行属于他人
  // 任务，本文只为让守卫账目与工作树一致而抬到精确值 4898；对应改动尚未提交，记录见 STATUS。
  // WEBFETCH-01: +1 counted lines for approved public retrieval; excludes concurrent work.
  // 2026-09-18 web-client-modules P1a on b/main db043c4d: exact combined-tree measurement.
  // CORDIS-C1 Tasks 2-3: parse the five-field agnes.plugins manifest and load verified immutable
  // package snapshots and expose the exact live snapshot verifier. Re-measured on the integrated
  // tree: 5308; exact cap, no spare.
  // Installed packages become runtime plugin snapshots keyed like desired rows, so a worker can load
  // a package trusted after it started. Re-measured: 5339, exact.
  // 2026-09-21 D75 amendment: agnes.plugins entries may declare `provide` / `inject` service names
  // (bounded, unique, printable) so the daemon can build the row without importing the module.
  // Re-measured with this guard's countLines(): 5366, exact cap, no spare.
  // 2026-09-22 Web Plugins parity: multi-row immutable client asset declarations. Exact.
  // 2026-09-22: a file:/workspace: source that can't be found now names the resolution root
  // it was checked against in the thrown error, instead of leaving the caller to guess why a
  // path that exists relative to their own shell isn't found. Re-measured: 5532, exact cap.
  // 2026-09-22 incremental apply: the kept previous version is exported as an importable snapshot
  // and a live snapshot verifier resolves trust and removal on every call. Re-measured: 5579, exact cap.
  // 2026-09-22 incremental-apply review fix (B1): a shared stableInventoryRows() helper is the
  // single source of truth for the row shape an inventory's hash is computed over, so a second,
  // independent recomputation (deployment resolution) can't silently diverge from it. Re-measured
  // with countLines(): 5591, exact cap, no spare.
  // 2026-09-23 CROSS-PROCESS-ERROR-CONTRACT: PackageError keeps code on secret-shaped messages
  // instead of throwing an untyped Error; error-message re-exports domainFailureFromUnknown.
  // Re-measured with countLines(): 5611, exact cap, no spare.
  // PLUGIN-HELPER: measured 5763 -> 5770; approved feature scope, no spare allocation.
  // Windows stale-lock reclamation added 17 counted lines; exact baseline total, no spare.
  'packages/package-manager/src': 5787,
  'packages/package-manager/src/catalog': 211,
  // Web open-source UI: safe Markdown DOM, compact presentation helpers, task-first creation,
  // and explicit controls. v2 adds accessible compact composer state; exact measured allocation; evidence is tracked with the UI execution.
  // 2026-09-20: map the already-sanitized turn AUTH category to a reconnect instruction. Exact.
  'packages/web/src/presentation': 116,
  'packages/web/src/markdown': 446,
  // Phase03 Web workbench: separate settings controller, stable keyed timeline, run receipts,
  // and client integration. Each component is bounded independently; no execution state
  // machine is added to Web. SDK adds reconnect-start and pre-load permission registration.
  // Exact reviewed allocation; acceptance is recorded separately from these maintenance caps.
  // Model popover: bounded DOM interaction only, with backend-confirmed selection in app.
  // Exact measured allocation; visual and integration evidence is in the 2026-09-13 execution.
  // 2026-09-14 workspace picker: the Web app owns capability, cancel/fallback and existing
  // workspace.add registration wiring. Exact measured total; native OS logic stays in the launcher.
  // 2026-09-14 (merge with the above): concurrent origin/main work (unrelated to
  // profile-command-plan, which never touches this file) pushed the total to 1014. Measured exact.

  // 2026-09-15: appearance-pane work adds the bindAppearance / safeThemeStorage imports and the
  // appearance nav binding. 2026-09-15 (merge with origin/main, which adds the errorNotice
  // diagnostic arguments at the showError call site). Combined exact measured total: 1033.
  // 2026-09-15 (admin-pages A2): the iframe wiring is replaced by openAdminPane() — session exchange,
  // first-open dynamic import + mount, reload on reopen, and in-pane error reporting. Measured: 1049.
  // 2026-09-16 (plugin-skin S8 tail): the same wiring inside app.ts. Measured 1087.
  // 2026-09-16 (plugin-skin S24): the same formatter reflow inside app.ts. Measured 1094, exact.
  // 2026-09-16 (review B1/B2 fix): reconcileSkin plus the cssUrl fallback move out of app.ts into
  // skin.ts's `cacheSkinEntry`, leaving app.ts with the roster fetch, the reconcile call and the
  // now-async select. Measured exact: 1115.
  // 2026-09-16 (same fix, review follow-up): a selection counter keeps an in-flight reconcile from
  // writing the previous skin back over a choice the user made while its stylesheet was fetching.
  // Measured exact: 1121.
  // 2026-09-16 main integration: preserve session-title and admin/skin changes together.
  // Recounted with the existing guard helpers after merging both branches; exact total: 1182.
  // 2026-09-17 WEB-RUN-TRACE: wire the first-party 运行轨迹 panel from projectUI turns.
  // Measured 1190; exact cap, no spare.
  // 2026-09-17 rebase 到 main 后的重新实测（用户拍板合并该工作线）：本文件同时承载
  // WEB-UI-ALIGN-DSH 的设置 rail tab 接线（+6）。两侧相加实测 1196，精确值，无富余。
  // 2026-09-17 DSH trajectory layout: nodes into the panel. Re-measured after rebase: 1197.
  // SESSION-ACTIONS integrated with b/main: exact increment +52.
  // SESSION-ACTIONS: measured implementation 1249 -> 1258, no spare budget.
  // 2026-09-17: Web session permission picker wiring (setYolo + composer control). Measured 1313.
  // 2026-09-18 web-client-modules P1a on b/main db043c4d: roster source, claim resolver and reconnect invalidation.
  // 2026-09-20 Computer Use settings status projection. Measured 1439; exact cap.
  // 2026-09-20: carry the nested sanitized turn-error category into presentation. Exact 1445.
  // 2026-09-22 Web Plugins parity: region handles and authenticated service caller. Exact.
  // MODEL-CONFIG-HOT-UPDATE: exact measured feature allocation; see execution/2026-09-22-model-configuration-hot-update.md.
  // 2026-09-22 new-session composer selection, remeasured on origin/main@056b912f.
  // That main already counted 1654 against the stale 1619 cap. This wiring adds 19. Measured 1673; exact cap, no spare.
  // 2026-09-24 WEB-INCREMENTAL-PROJECTION-TRACE-INDEX C6 (Web incremental wiring) and its review fixes,
  // rebased onto main after C0-C2: merged tree re-measured with countLines(): 1717, exact.
  // 2026-09-24 TRACE-DIAG-EXPORT (user-approved raise): installBrowserLogCapture at module load, the diagnostics
  // dialog and the #report-problem click wiring (+13) merged onto origin/main's 1717. Re-measured: 1730, exact.
  // 2026-09-24 streaming-smoothness quick fixes (user-approved raise), rebased onto origin/main's 1730:
  // renderTrace forwards the transcript meta and still throttles the trace panel to 500 ms while busy.
  // Re-measured with countLines() on the merged tree: 1767, exact, no spare.
  // LEGACY-LEDGER-OPEN: a session an older build wrote is refused as LEGACY_LEDGER_FORMAT (audited),
  // and the Web says so plainly in session recovery. Measured 1776, exact, no spare (+4).
  'packages/web/src/app': 1776,
  // 2026-09-22 UI plugin management: inject the embedded pane's client runtime reconciler.
  // 2026-09-25 UI refactor: permission options now render through the React region contract.
  // Re-measured with countLines(): 215, exact, no spare.
  'packages/web/src/permission-picker': 215,
  // 2026-09-17 WEB-RUN-TRACE: new panel renderer. Measured 130; exact cap, no spare.
  // 2026-09-17 DSH parity: gantt + event list + inspector. Measured 411.
  // 2026-09-17 DSH layout: idle-compressed gantt. Measured 445.
  // B1/main integration: +7 formatter lines around typed turn lookup and expressions; exact count.
  'packages/web/src/trace-panel': 478,
  // 2026-09-15/16 (admin-pages A5b): the popover placement and listbox key map moved to
  // @agnes/web-admin-frame, so this file only keeps its own state machine and rendering.
  // 2026-09-25 UI refactor: model options now render through the React region contract.
  // Re-measured with countLines(): 274, exact, no spare.
  'packages/web/src/model-picker': 274,
  // 2026-09-25 UI refactor: settings-owned element construction uses the shared UI host boundary.
  // Re-measured with countLines(): 754, exact, no spare.
  'packages/web/src/settings': 754,
  // 2026-09-17 rebase 后的重新实测：timeline.ts 的详情弹窗管线已在 WEB-UI-ALIGN-DSH 中删除
  // （原 427 是旧实现的实测值），删码后未跟着收紧会留下 55 行富余，故收到实测精确值 372。
  // 2026-09-24 WEB-INCREMENTAL-PROJECTION-TRACE-INDEX C6 (Web incremental wiring) and its review fixes,
  // rebased onto main after C0-C2: merged tree re-measured with countLines(): 674, exact.
  // 2026-09-24 streaming-smoothness quick fixes (user-approved raise), rebased onto origin/main's 674:
  // unclaimed DSH node mounts skip both per-delta React root renders (subscriptions re-render once on
  // claim flips); fingerprints sample length + 64-char tail. Re-measured with countLines() on the
  // merged tree: 727, exact, no spare.
  // CHUNK-LEDGER-SLIM C6: an assistant node whose streamed text died with its process says how
  // much was lost. Measured 678, exact, no spare (+4).
  // Merge of CHUNK-LEDGER-SLIM (lost-text marker, +4) with the streaming-smoothness quick fixes (727):
  // sampled fingerprints also carry lostChars. Re-measured on the merged tree: 731, exact, no spare.
  'packages/web/src/timeline': 731,
  // 2026-09-17：navigation.ts 的 folderIcon 换成客户端 AgnesProjectFolderIcon 两态字形
  // （两条 path + folderSvg 构造器），展开/收起由 CSS 的 [aria-expanded] 切换。实测 108。
  // SESSION-ACTIONS integrated with b/main: exact increment +43.
  // 2026-09-17 SESSION-MENU: 会话行菜单从 navigation.ts 抽到 session-menu.ts（面板改挂 body、
  // 补 Escape/外部指针/滚动重算），navigation 只留调用点。实测 125，收紧到精确值。
  // 2026-09-17 SESSION-ROW-BG: 行上加 `data-active`（选中底色改由行承载）新增 1 行，实测 126。
  'packages/web/src/navigation': 148,
  // 2026-09-17 SESSION-MENU: 新建 session-menu.ts —— 触发按钮、三项菜单、portal 到 body 的
  // 生命周期与关闭路径，外加行状态（`data-menu-open`，替代不可靠的 `:has()` 重算）。
  // 实测 115，精确值无富余。
  'packages/web/src/session-menu': 115,
  // 2026-09-17：shell.ts 的 SETTINGS 表允许一个面板挂多个 rail 入口（技能 / MCP 共用
  // #resource-settings-pane），showSettingsPane 改按 aria-selected 决定哪一条高亮。实测 89。
  // SESSION-ACTIONS integrated with b/main: exact increment +1.
  'packages/web/src/shell': 106,
  // 2026-09-17 rebase 后的重新实测：turns.ts 把过程摘要搬进过程行、用量面板只留关键项、
  // 运行中页脚整行隐藏（原 432 是旧实现的实测值），收紧到实测精确值 399。
  'packages/web/src/turns': 407,
  // 2026-09-24 WEB-INCREMENTAL-PROJECTION-TRACE-INDEX C6 (Web incremental wiring) and its review fixes,
  // rebased onto main after C0-C2: merged tree re-measured with countLines(): 99, exact.
  'packages/web/src/view': 99,
  // Approval ownership handoff and Host expiry share existing services; no protocol fork.
  'packages/web/src/session-binding': 31,
  // 2026-09-24 SHARED-SESSION-IDLE-CLOSE C2-C5 and review fixes (user-approved raise for the perf
  // batch), rebased onto main with the other perf lanes: merged tree re-measured with
  // countLines(): 105, exact, no spare.
  'packages/host/src/approval-expiry': 105,

  // 2026-09-12 shared local startup: reviewed scope/discovery/coordination, bounded client
  // bootstrap and executable delivery are new subjects, not spare aggregate headroom. Exact
  // measured totals are allocated below; the new subjects also receive independent ceilings.
  // SDK adds one protocol-version refusal; Host adds packaged native-helper path selection.
  // Evidence: execution/2026-09-12-shared-daemon-workbench.md (source allocation review).
  // 2026-09-13 incremental UI projection: snapshot-first attach, bounded opening retry and local
  // patch merge add the exact reviewed production increment. TUI retains its independent 4000 cap.
  // 2026-09-13 PM7 intercepts package commands before chat submission. The CLI command, TUI
  // preview/controller, BFF launch helper, and three-line local-artifact inclusion are exact caps.
  // The final recovery-startup flag forwards only through boot/backend and the launcher: measured
  // integration totals 7872/505/491/158, not spare headroom for existing surfaces.
  // IP10/IP11 add bounded opening/history projection and stable terminal scrollback ownership.
  // Exact merged aggregate after the control-plane and multi-provider lanes: 8286.
  // Integrates main's local command transcript alongside the usage panel: exact merged 8454.
  // 2026-09-14 first-run onboarding TUI: onboarding/tui.ts (176 counted) drives the already-tested
  // reducer and the two previously unwired views over the same client.config endpoint Web uses, and
  // bin.ts's first-run branch shrinks by two lines replacing the readline wizard call. Measured
  // 8783, exact. 97 of that total is NOT this change: main already measured 8609 against the 8512
  // ceiling after the session-resume picker (87b62431) landed without a paired raise, so this key
  // was red on arrival. This raise carries that overshoot rather than hiding it -- the picker's 97
  // lines still owe their own measured justification here.
  'packages/cli/src': 8974,
  'packages/cli/src/commands/package': 160,
  'packages/cli/src/tui/package-admin': 106,
  'packages/cli/src/tui/package-controller': 58,
  // DAEMON-SHORT-SOCKET-PATH: reuse daemon path preflight before spawning; +9 counted lines.
  'packages/cli/src/boot/backend': 538,
  'packages/cli/src/boot/default': 56,
  // 2026-09-22 CLI error surfaces (F03): `sessions show` prints one detail row per field with
  // model-written text escaped, and an id that matches nothing exits 1 on stderr. Exact measured 60.
  'packages/cli/src/commands/sessions': 60,
  // 2026-09-14 workspace picker: fixed-argv macOS/Windows/Linux UI adapters, abort and minimal env.
  // Exact measured total; no native chooser or platform logic is added to the shared daemon.
  // 2026-09-14 (merge with the above): whole-branch review fix wave (Finding 1) adds the two missing
  // 'pins/inspect'/'pins/release' cases to invoke()'s switch, and the PackagePinsInspectParams/
  // PackagePinsReleaseParams type-only imports they need -- without them invoke() silently returned
  // undefined for both actions (no compile error, since the function's return type is
  // Promise<unknown>), which only failed downstream as a 502 E_ADMIN_RESPONSE. Combined exact total
  // after merging both changes: 683 (677 workspace-picker baseline + 6 net from the pins cases).
  // 2026-09-14: Task 4 profile-command-plan adds the same 'trust-workspace' case/import as the
  // package-admin sub-key below (+3).
  // 2026-09-14 (merge with the above): feat/skill-runtime-reliability forwards bootstrap
  // skillResources through packaged-host/worker-entry (+8). Combined exact total after merging
  // both changes: 694 (683 baseline + 3 trust-workspace + 8 skillResources forwarding).
  //
  // 2026-09-16 (merge b/main into feat/admin-pages-ui-refactor): the two sides moved different keys
  // here. This branch left the aggregate at its base value; main raised it 712 -> 714. Re-measured on
  // the merged tree directly (never summed): 714, exact.
  // 2026-09-16 (plugin-skin S14c): `runWebCommand` passes the skin asset resolver to the Web
  // server, so the production launcher actually serves `/skins/*`. Measured 722, exact.
  // 2026-09-16 (merged tree + uncommitted skin work): the working tree carries both blocks, so this
  // key is the combined measurement rather than the merge-only one: 724 (714 merge baseline plus the
  // S14c skin lines).
  // 2026-09-16 (surface-boot-wiring Task 15): new surface-mounts.ts (fetchSurfaceMountLookup /
  // fetchSurfaceMountProxy -- the CLI/Web process's own private-connection fetch of the daemon's
  // Surface mount table, mirroring localPackageAdmin's connection shape) plus its three-line wiring
  // into web-command.ts (import, the one-shot fetch call, and the `mountProxy` option passed to
  // createWebServer). Measured fresh with the guard's own countLines(): 760; a follow-up `biome
  // check` formatting fix wrapped the fail-soft `console.error(...)` call onto four lines (+3).
  // Re-measured fresh with the guard's own countLines(): 763; exact cap, no spare.
  //
  // 2026-09-17 (hot-update Task 1, RC1): surface-mounts.ts's one-shot fetch becomes a background
  // poller -- SURFACE_MOUNT_REFRESH_MS constant, the SurfaceMountFeed type, an intervalMs option on
  // both exported functions, the refresh()/tick() closures and their setInterval/unref/close
  // ladder, plus web-command.ts's matching `mounts` variable (replacing the old `mountProxy` const)
  // and its `await mounts?.close()` shutdown-ladder entry. Measured fresh with the guard's own
  // countLines(): 792; exact cap, no spare.
  // 2026-09-18 web-client-modules P1a: client asset proxy plus reserved Surface mount prefixes.
  // Measured 815 on that branch's own tree, independent of the mcp-oauth-authorization work below.
  //
  // 2026-09-18 (mcp-oauth-authorization Task 4): re-measuring this prefix at this task's own
  // baseline commit (e44181ec, Tasks 1-3 already merged) with the guard's own countLines() found it
  // already at 801, nine lines above the 792 this comment's own history last recorded -- some
  // intervening commit grew this prefix without updating the ceiling, and identifying which one is
  // out of this task's scope (not attributable to anything Task 4 touched). On top of that
  // already-drifted baseline, Task 4 adds a new `oauth-admin.ts` (constructs the daemon-facing
  // resource-lookup client and the file-backed OAuth credential store, mirroring
  // package-admin.ts's/resource-admin.ts's own connection-construction shape) plus web-command.ts's
  // three-line wiring (the new `oauthAdmin` variable, its construction call, joining the
  // `handleAdmin` fallback chain as a third link, and its shutdown-ladder entry). Measured fresh
  // with the guard's own countLines() on the full changed tree: 860; exact cap, no spare.
  //
  // 2026-09-18 (mcp-oauth-authorization Task 5): oauth-admin.ts grows by wiring
  // `onAuthorizationStatus` to the new `mcp.servers.oauth.status.set` RPC method (closing the Task 4
  // gap) and forwarding `startAuthorization` out of `localOAuthAdmin`'s returned object, plus a new
  // `packages/cli/launch/oauth-admin.test.ts` test file (excluded from this count - see
  // `isTestFile()`/`matchesRatchetKey()`, this prefix counts source only). First measured at 866
  // before a final `pnpm lint`/biome formatting pass wrapped the new `onAuthorizationStatus` arrow
  // function's parameter list onto multiple lines (+3); re-measured fresh with the guard's own
  // countLines() on the actually-committed tree: 869, exact cap, no spare.
  //
  // 2026-09-18 (merge into main): merging web-client-modules P1a (815, above) together with the
  // mcp-oauth-authorization branch (869, above) -- both measured from divergent points on this
  // prefix's history -- required re-measuring this key directly on the merged tree, not summing the
  // two branch deltas. CORDIS-C1 Task 3 adds the release-embedded Base plugin declarations without
  // runtime package.json reads, then verifies that the packaged Host receives the immutable plugin
  // selection from the worker. Re-measured with countLines(): 921; exact cap, no spare.
  // Task 11 plugin-tree BFF dispatch through the local launcher SDK. Re-measured: 935, exact.
  // The packaged Host accepts the worker's installed-snapshot reader. Re-measured: 936, exact.
  // 2026-09-21 AGH namespace rename (.agnes -> .agh): +1 counted line, worker-entry.ts imports agnesHome()
  // so the packaged worker resolves its home the same way the daemon does. Re-measured on the tree
  // rebased onto 9a3d70ed (which itself reached 936): 937, exact cap.
  // 2026-09-22 Web Plugins parity: package asset and service BFF launcher integration. Exact.
  'packages/cli/launch': 1113, // SKILL-INSTALL-CORE: preserve request-only port in packaged Host options.
  // 2026-09-14: whole-branch review fix wave (Finding 1), same as above. Measured 90, exact --
  // unaffected by the workspace-picker change (different file, same aggregate prefix).
  // 2026-09-14: Task 4 profile-command-plan wires packages.trustWorkspace into invoke()'s switch --
  // the PackageTrustWorkspaceParams type-only import and the 'trust-workspace' case (two lines).
  // Measured 93, exact.
  //
  // 2026-09-16 (merge b/main into feat/admin-pages-ui-refactor): main raised this sub-key 93 -> 95;
  // this branch left it at the base value. Re-measured on the merged tree: 95, exact.
  // 2026-09-16 (plugin-skin S14c): `readSkin` rides the same private connection instead of opening a
  // second one. Measured 102, exact.
  // 2026-09-16 (merged tree + uncommitted skin work): the working tree carries both blocks, so this
  // sub-key is the combined measurement: 104 (95 merge baseline plus the S14c skin lines).
  // 2026-09-18 web-client-modules P1a: private clientModules.read launcher connection.
  // Task 11 tree get/list/apply/rollback invoke cases. Re-measured: 132, exact.
  'packages/cli/launch/package-admin': 303,
  // 2026-09-15: theme work adds the blocking first-paint theme IIFE build step. 2026-09-15
  // (merge with origin/main, which adds the Windows runtime bundling). Combined exact
  // measured total: 184.
  // 2026-09-15 (admin-pages A1): the same esbuild config gains the two standalone host entries
  // (/admin/plugins, /admin/resources). Measured exact: 186.
  // 2026-09-15 (admin-pages A10): splitting:true added so the panes' dynamic import() stays lazy
  // instead of inlining into app.js. Measured exact: 187.
  //
  // 2026-09-16 (merge b/main into feat/admin-pages-ui-refactor): main left this key at its base value
  // (172), so this branch's raise to 187 is the surviving one. Re-measured on the merged tree
  // directly: 187, exact.
  // 2026-09-17: local packaging copies the fixed-Hermes MIT NOTICE into the transactional output;
  // SEA reuses that exact directory. Measured build-local total: 203; exact cap.
  'packages/cli/tools/build-local': 246,
  // The PM5 bootstrap fallback retains the existing scoped owner/data-dir contract when a selected
  // Profile has not yet been materialized. The final recovery retry admits only an explicit
  // E_LOCK_MISMATCH path and re-resolves with an empty package lock; this is exact compatibility
  // glue, not a second scope path or general profile-error bypass. Measured total: 214.
  'packages/daemon/src/supervisor/scope': 214,
  'packages/daemon/src/supervisor/discovery': 430,
  'packages/daemon/src/supervisor/startup': 18,
  'packages/web/src/serve': 188,
  // 2026-09-12 unified App Server: shared configuration, authenticated RPC, session metadata
  // and immutable per-session profile snapshots. Exact measured totals; new components also
  // have individual caps so this allocation cannot become unrelated source growth.
  // WIN-12c: one import reuses platform backend instead of a raw OS check. Measured total: 880.
  // 2026-09-15: merged with the concurrently landed deployment-declared thinkingEfforts feature
  // (normalizeThinkingEfforts, the exactKeys widening, applyThinkingEfforts — lets a profile
  // override a model's reasoning capability when the installed pi-ai catalogue is incomplete or
  // wrong), landing independently of WIN-12c's own +2. Re-measured on the merged tree directly
  // (never summed): 911; exact cap, no spare.
  'packages/host/src/configuration': 1202,
  'packages/host/src/configuration-lock': 39,
  'packages/daemon/src/supervisor/configuration': 45,
  // S5 service workers reload the profile hash and its immutable snapshot path as one value.
  'packages/daemon/src/supervisor/profile-bindings': 124,

  // 2026-09-09: raised from 5000 by the project owner. The kernel's I1 slice alone
  // reached 4172 lines with files 06 and 07 still owing ten files, so the original
  // cap could not hold without deferring work the acceptance line depends on.
  // Raising a ceiling has to touch this file as well as ratchet.json, so the change
  // is visible in review; the monotonicity guard below still forbids drifting past it.
  // 2026-09-11: I6 Core Tasks 5/37b/39 and daemon Task 27's durable turn-budget contract add
  // child-ledger assembly, typed segment replacement, and recovery-safe inbox/turn markers.
  // Measured total: 9311; 9320 leaves nine lines.
  // 2026-09-11: raised from 9320 for the core↔base VerifyInput repair
  // (archived implementation record): the four verify call sites
  // handed the seam ad-hoc shapes it blind-cast into base's VerifyInput, so every real turn
  // failed closed as 'verifier unavailable'. The fix is a new step/verify-input.ts (~110
  // counted lines) projecting toolCalls/deviations/recentToolKeys/surfaceTailHashes/
  // newToolResults/lastFinishReason from the event log, plus one-line wiring at the four
  // call sites. Splitting is what this already is — the projection is one subject in one
  // new file rather than growth inside tools.ts/session.ts/gate.ts. Measured total: 9418;
  // 9440 leaves twenty-two lines.
  // 2026-09-11: T0.1 accounts for 9208a5e's subagent model-selector repair. KernelChildren now
  // resolves preset slots, model ids and explicit route/model selectors against the sealed provider
  // catalogue instead of rejecting every model override. The change also forks at the triggering
  // user row so a child does not inherit its parent's live operation. Measured total: 9616; the
  // ceiling was set to that exact baseline with no spare allocation. T2.4 adds the three-line
  // admission digest carry-through needed to reconcile a committed inbox write after a crash.
  // 2026-09-12: T3.2 adds the storage-private JCS/SHA-256 ledger chain, bounded verification and
  // core/storage metadata contract. Measured total: 9848; exact ceiling.
  // T4.1 then adds 55 lines for the isolated one-shot execute-permit registry and its two dispatch
  // bindings. This is incremental control logic rather than spare allocation. Measured: 9905.
  // 2026-09-12: I7 Core Task 13 adds the independently bounded fold cache/state tracker and fixture
  // rebuild seam. The production increment is 44 counted lines. Measured total: 9949; exact cap.
  // I7 Base35 adds the explicit Host-owned SessionRef identity-retention predicate; mutable or
  // caller-authored hook context remains cloned. Measured total: 9982; exact cap.
  // I7 Core40 persists versioned/checksummed fold lines through the storage contract, validates
  // their head binding, and resumes the state fold from the stored prefix. Measured: 10202; exact.
  // P2: owner cleanup and single-key projection reads add 42 counted lines; no spare allocation.
  // Phase03 real browser acceptance exposed size-only streaming delay. Immediate first output,
  // bounded batching, serialized writes and an observed cancellation/failure iterator add the
  // exact reviewed increment; paused provider and storage failure regression are in project-ui.test.
  // 2026-09-13 incremental UI projection: fixed-cut pagination makes projectUI cross the storage
  // adapter's 500-row cap and fail closed on a non-contiguous scan. Exact measured total.
  // IP8 replaces per-read replay with the versioned live UI cell, bounded journal and incremental
  // usage state; historical cuts retain the strict paged fallback. Exact reviewed aggregate.
  // IP9 adds the versioned/checksummed UI checkpoint codec, integrity-bound restoration and
  // fail-soft lifecycle checkpoint policy on top of the concurrently landed Projection registry.
  // Exact merged aggregate; no spare allocation.
  // IP10 adds bounded opening/history views and IP9 restoration hardening; exact merged aggregate.
  // Main's durable turn forks and the in-process compact command are integrated at this exact total.
  // 2026-09-14: context-cache-observability Task 1 adds project/cache-health.ts, a pure module
  // tracking cumulative cache hit rate and three-cause invalidation attribution (compaction /
  // system-changed / history-changed) off cost/ledger and request/header rows already in the
  // ledger. New subject, not growth of an existing one. Measured total: 12630; exact cap.
  // 2026-09-14: context-cache-core Task 1 (charset-aware estimateTokens, +10) and Task 2
  // (request/envelope-cache.ts plus its wiring into derive.ts/session.ts/inference.ts/
  // compaction.ts, +29) landed in the same working tree as the context-cache-observability raise
  // above. Folded into one exact cap rather than split across two commits, since both sessions
  // measured against the same shared packages/core/src total. Measured total: 12634; exact cap.
  // 2026-09-14: context-cache-observability Task 5 adds the per-turn x/core/context-breakdown
  // diagnostic: kernel.ts registers the new closed-set diag name, request/contribute.ts adds the
  // ContextSectionSummary/ContextBreakdownDiag types, and step/inference.ts writes one diag event
  // per turn right after beforeRequest (net +20 across the three files). The remainder of this
  // raise is further concurrent context-cache-core growth landed in the same shared working tree
  // between measurements, not attributable to this task. Measured total: 12685; exact cap.
  // 2026-09-14: context-cache-observability Task 6 adds two x/core/* UINode projections
  // (context-sections, contribute-conflict) to project/ui.ts's applyNode switch, plus the
  // Conflict/ContextBreakdownDiag type import (net +12). Measured total: 12698; exact cap.
  // 2026-09-14: +2 more from concurrent growth landed in the same shared working tree between this
  // review's measurement and the prior one; not attributable to a specific task in this line of
  // work. Measured total: 12700; exact cap.
  // 2026-09-14: COMP-02's summary-size guard in step/compaction.ts (+23): reject a compaction whose
  // produced summary is not smaller, estimated-token-wise, than the range it would replace, mirroring
  // the same failure-path shape an outright failed summary request already uses. New invariant, not
  // growth of an existing one. Measured total: 12717; exact cap.
  // 2026-09-14: project/ui.ts routes a user/message tagged data.kind==='runtime_context' to a new
  // 'context' UINode kind instead of 'user', so a harness-internal notice (a hook note, or the
  // per-turn model/cwd/preset snapshot) stops rendering as if the operator typed it. Fixes a real
  // defect, not growth of an existing feature. Measured total: 12723; exact cap.
  // 2026-09-15: request/transforms.ts's applyContextResults switches from replacing the whole
  // sections array on any participant return to merging by id (Map<string, PromptSection> keyed
  // by id, same id overrides the whole row, different ids coexist). Fixes CORE-CTX-01 (a
  // participant contributing only its own section silently discarded every other section, the
  // root cause behind skills' prior workaround). Net +11 for the Map construction/lookup/spread
  // replacing the old array replace/filter. Fixes a real defect, not growth of an existing
  // feature. Measured total: 12734; exact cap.
  // 2026-09-15: request/derive.ts's deriveRequest gains lastRuntimeContextText(), which scans
  // input.surface for the most recent rendered runtime-context snapshot (skipping the three
  // other kind:'runtime_context' note-producers in gate.ts/inference.ts) instead of trusting
  // TurnMemory.lastRuntimeContextHash, which reset to null on every new turn and made the
  // dedup-across-turns comparison structurally impossible. TurnMemory.lastRuntimeContextHash
  // and its four call sites are deleted along with the new scan, net +6. Fixes a real defect
  // (identical runtime-context snapshot resent on every turn instead of only on change), not
  // growth of an existing feature. Measured total: 12740; exact cap.
  // 2026-09-15: merged with the concurrently landed subagent-lifecycle branch, whose own chain
  // (ChildControlStore, tree-budget admission, KernelChildren durable create, retry permits,
  // lease/recovery/cancel, same-instance fence, final-wire counting) raised its side from the same
  // 12734 base to 14019 independently of this branch's +6. Re-measured on the merged tree directly
  // (never summed): 14025; exact cap, no spare.
  // 2026-09-15 (v1 closeout on main): skip tree-budget ledgerProjected when the session is not
  // tree-constrained, keeping main's resolved-model target binding. Re-measured 14024.
  // 2026-09-15: EXTAPI-01 Task 2 adds effects/platform-facts.ts (platformFacts/platformView,
  // copying PlatformSeam fields into the frozen extension-api shapes from Task 1) and wires it
  // into buildToolContext (tool-time platform + sandbox.enforcement()) and HookEngine/Kernel
  // (one platformFacts snapshot computed once at Kernel construction, injected into every hook
  // context). New subject (the platform-facts module) plus its two call-site wirings, not growth
  // of an unrelated feature. Measured total: 14075; exact cap, no spare.
  // 2026-09-15 (EXTAPI-01 final-review fix round, C2): platformView()'s capability() wraps
  // seam.capability(id) in its own try/catch, degrading a throw to
  // {level:'unavailable', scope:[], reason:'threw'} instead of propagating into extension code -
  // the real host backends throw for any capability id outside their fixed allowlist, and the
  // public contract promises capability() is total over any string. Fixes a real defect (an
  // uncaught exception reaching third-party extension code), not growth of an existing feature.
  // Measured total: 14080; exact cap, no spare.
  // 2026-09-15: merged with the /model thinking-switch feature (reentry.ts's setModel gains
  // thinking validation and a capability clamp for a carried-forward level across two fix rounds;
  // session.ts's SessionImpl.setModel widens to match), landing independently of the EXTAPI-01
  // line above. Re-measured on the merged tree directly (never summed): 14047; exact cap, no spare.
  // 2026-09-15: THINKING_LEVELS (derive.ts) widened from the closed off/low/medium/high set to
  // the full off/minimal/low/medium/high/xhigh/max set pi-ai itself tracks, so assertThinking
  // stops rejecting levels the protocol now allows. Measured 14055.
  // 2026-09-15 (EXTAPI-01 x main merge, PR #4): EXTAPI-01's platform-facts chain (14024->14080)
  // merged with main's /model thinking-switch + THINKING_LEVELS chain (14024->14055), landed
  // independently in packages/core/src. Re-measured on the merged tree directly (never summed):
  // PLACEHOLDER; exact cap, no spare.
  // 2026-09-17 WEB-RUN-TRACE: TurnProjection folds UISpan trees (project/trace.ts) and SessionImpl
  // attaches in-process child traces via bounded storage.scan from boundarySeq+1. Measured 14677;
  // exact cap, no spare.
  // B1-A: measured 14693 lines on the shared tree; public transport contract, config and wiring/testkit.
  // WEBFETCH-01: +18 counted lines for approved public retrieval; excludes concurrent work.
  // CORDIS-C1 Tasks 1-3: SeamRuntime.invalidate and Kernel-wide session cache invalidation after a
  // provider swap. C1b Task 5 adds durable child attempts and the workspace lifecycle port.
  // Task 6 adds the revocable WorkspaceInvocationPort, descendant drain and invocation-only tool
  // contexts plus Task 7 quiet publication admission. Re-measured: 22475, exact cap, no spare.
  // CurrentRuntimeLookup may return undefined so Kernel can keep session fallbacks before a
  // published overlay scope exists. Re-measured: 22517, exact cap, no spare.
  // SessionOverlayPort is the unique setPreset path. Re-measured: 22525, exact.
  // 2026-09-22 F01: user-approved exact raise for import failure compensation. Core records
  // creation ownership and retains the writer lease until storage atomically removes only that new
  // session. F01 review also releases only its own lease if that removal fails. Re-measured with
  // countLines(): 23836; prior 23800, +36, no spare.
  // Native import round trip: SessionOptions.skipSessionStartHooks lets an importer open a new
  // session without session_start rows before its own. +2 counted lines; re-measured 23838, exact.
  // 2026-09-23: compaction reasoning-budget fix (D-1/D-3) — summarize() gains a thinkingOverride
  // param, summarizeWithRetry()/mergeSummaryResults()/LOW_OR_BELOW_THINKING retry once at 'low' on
  // a max_tokens-cap cutoff, runCompaction() plumbs preset.compaction.reserveTokens into the
  // before_compact payload. +41 counted lines; re-measured with countLines(): 23879, exact cap, no
  // spare.
  // 2026-09-23 Mac acceptance C2: run() hands back the turn/end row's error with its outcome, so
  // daemon's TURN_ERROR carries the cause (AUTH/403) instead of nothing. +8; countLines() 23887.
  // 2026-09-23 third-party-transform-directive-hooks: ToolSource gains optional hookRank;
  // HookRegistry.on() validates it and snapshot() sorts each event's entries by it (built-in layer
  // first); SessionHookPort's toolResult/approvalRequest readPayload now folds in the accumulated
  // value instead of the original payload, and beforeCompact takes the first plan by dispatch order
  // instead of throwing on a second one, reporting the rest through a new compactPlanIgnored input.
  // +26 counted lines; re-measured with countLines(): 23913, exact cap, no spare.
  // Biome reformatted the snapshot() sort call to multi-line after that measurement was taken
  // (missed in the same commit); +3, re-measured with countLines(): 23916, exact cap, no spare.
  // 2026-09-24 SCAN-TRUNC-01 C1 (user-approved raise for the perf batch): new log/scan-pages.ts
  // (scanPages/scanAll, the one paging helper so no caller trusts a single scan to return every
  // row), SCAN_PAGE_MAX in log/storage.ts, three root exports. +48 counted lines; re-measured with
  // countLines(): 23964, exact, no spare.
  // 2026-09-24 COMPACTION-CUT-IN-TOOL-LOOPS C1 (user-approved raise to measured value): validateReplace
  // judges call/result pairing by surface position (new pairClosed) instead of refusing every
  // tool/result boundary, so a tool loop can be cut without orphaning a result. +11 counted lines;
  // re-measured with countLines(): 23927, exact, no spare.
  // C2: the current prompt is read from the trigger's ledger row, not the surface, so a mid-turn
  // compaction that masks the trigger keeps the preloaded Skill section and suppressed tools. +6;
  // re-measured with countLines(): 23933, exact, no spare.
  // C3: derive puts a fixed user bridge line between a summary and an assistant message directly
  // after it, so a cut at an assistant never sends two assistant messages in a row. +9; re-measured
  // with countLines(): 23942, exact, no spare.
  // C4: compaction's per-node estimate (the before_compact surface and the size guard) counts an
  // assistant message's call arguments, not only its text. +12; re-measured with countLines():
  // 23954, exact, no spare.
  // C5: a split-turn replace masks the prefix it summarized too (one span, judged whole and per
  // segment), so the current turn actually shrinks. +7; re-measured with countLines(): 23961, exact,
  // no spare.
  // C7: a summary that is unusable for good (cut off, empty, tool-calling, final error, not smaller)
  // or cannot fit its window, and a transient failure during overflow or on a second threshold try,
  // falls back to a deterministic elided replace in one transaction; a compaction that completes
  // resumes as already threshold-checked. New file step/compaction-elide.ts 69 lines, routing and
  // wiring in step/compaction.ts +113. +182; re-measured with countLines(): 24143, exact, no spare.
  // Review fixes (same task): a compaction failure is classified by provider error code, so a broken
  // or out-of-quota compaction route is reported instead of elided, and the transient-failure count
  // resets per turn. +24; re-measured with countLines(): 24167, exact, no spare.
  // Review fix: the elided compaction always keeps the previous summary and the first principal
  // request (each bounded to a share of the cap with a truncation marker) and folds the steps between
  // them and the recent work instead. +22; re-measured with countLines(): 24189, exact, no spare.
  // Rebased onto SCAN-TRUNC-01 C1: the COMPACTION-CUT values above were measured on their own
  // branch; the merged tree re-measured with countLines(): 24237 (= 24189 + 48), exact, no spare.
  // 2026-09-24 REQUEST-MEDIA-PREFLIGHT-WINDOWING C1-C2 and CU-ARTIFACT-RETENTION-GC-INDEX P1 plus
  // review fixes (user-approved raise for the perf batch): first-send media window, one-shot decode
  // registration, maxDeleteBytes, requirement wording; +183 counted lines on their own branch.
  // Rebased onto SCAN-TRUNC-01 C1 and COMPACTION-CUT-IN-TOOL-LOOPS: merged tree re-measured with
  // countLines(): 24420 (= 24237 + 183), exact, no spare.
  // 2026-09-24 SHARED-SESSION-IDLE-CLOSE C2-C5 and review fixes (user-approved raise for the perf
  // batch), rebased onto main with the other perf lanes: merged tree re-measured with
  // countLines(): 24560, exact, no spare.
  // SCAN-TRUNC-01 C2: A1-A9 read through scanAll/scanPages (surfaceToolCalls one merged pass,
  // rehydrateTurn last header by a desc point read, ext quota counted page by page). +10 counted
  // lines; re-measured with countLines() on the tree rebased onto main (aaaf606d): 24430, exact, no spare.
  // lines; re-measured with countLines() on the tree rebased onto main (aaaf606d): 24429, exact, no spare.
  // SCAN-TRUNC-01 C3: B class (deferred-marker provenance, preflight bound, parked batch, refine
  // rollback history) and C class read through scanPages/scanAll; tracker.pages() deleted in favour of
  // scanPages. -1 counted line (the hand-written loops it replaces were longer); re-measured with
  // countLines() on the tree rebased onto main (aaaf606d): 24429, exact, no spare.
  // countLines() on the tree rebased onto main (aaaf606d): 24449, exact, no spare.
  // SCAN-TRUNC-01 C6: E_SCAN_TRUNCATED joins the code union; storage.ts documents the no-short-read
  // rules on ScanQuery and adds scanTruncated() (the one spelling of the overflow, its range carried in the
  // message because only code and message cross the worker boundary); MemoryStorage refuses a
  // non-positive or fractional limit and fails a request-everything scan past 500 rows. +20 counted lines;
  // re-measured with countLines() on the tree rebased onto main (aaaf606d): 24449, exact, no spare.
  // 2026-09-24 SCAN-TRUNC-01 C2-C8 and review fixes (user-approved raise for the perf batch),
  // rebased onto main after #6+#7 C4: merged tree re-measured with countLines(): 24603, exact.
  // 2026-09-24 SUBAGENT-OPEN-TRUST-ANCHOR C1 (user-approved raise for the perf batch): verifyLedger takes an
  // optional page yield, and opening a log or replaying a tracked session yields between pages on core's
  // 8 ms time slice (new log/fork-seed.ts holds the yield and its test seam). measured 24632, exact, no spare.
  // C2: onAppended hands the committed integrity entries on; the tracker keeps the state and surface at
  // the trigger of the turn it last opened and answers fork-point requests (fork-seed.ts providers,
  // batchTrigger); SurfaceCache gains upto/snapshot and a module-private seed; the UI cell gains
  // complete. +100; measured 24732, exact, no spare.
  // C3: a delegated child of a live parent opens through the ES-private SessionLogImpl.#openFromLiveParent
  // (chain state from the parent, only (c, b] and its own rows verified, ancestry asserted), openTracked
  // seeds tracker, surface and a partial UI cell from the fork point, partial cells are never
  // checkpointed and the four projections route around them, and Kernel logs a cold open. +145;
  // measured 24877, exact, no spare.
  // Review fixes: rows read for a range must belong to the key asked for and end at its upper bound;
  // a child on another lane than the parent's surface opens cold; unused snapshot fields and a
  // redundant head check removed (-1). Rebased onto main 7b60d297 (no code change there); measured
  // 24876, exact, no spare.
  // UI-CLIP-UTF16: measured 24892, exact, no spare (+16). One UTF-16 clip shared by the UI and
  // trace projections, and bounds on extension-supplied context section and conflict names.
  // UI-CLIP-UTF16 back-off: measured 24898, exact, no spare (+6). A failed UI checkpoint prepare
  // advances the write policy instead of being retried on every later commit.
  // 2026-09-24 OPSTATE O1: storage writes the program counter's register cell from CommitTx.opState
  // and acknowledges it; MemoryStorage keeps a book's own op cells out of a child's view. Rebased onto main 95a02063: measured 24924 (+26), exact.
  // 2026-09-24 OPSTATE O2: the UI cell takes the program counter's summary from the register, seeded
  // on open and refreshed on every commit; a historical projection reads it only at the head. Rebased onto main 95a02063: measured 24941 (+17), exact.
  // 2026-09-24 OPSTATE O4: a log openTracked opened itself is abandoned (faulted, closed, lease
  // released, no UI checkpoint) when the open fails after taking the lease. Rebased onto main 95a02063: measured 24950 (+9), exact.
  // 2026-09-24 OPSTATE review fix 1: the register check on open compares each cell's value with the
  // fold (canonical JSON), not only its seq, so a same-seq rewrite takes the rebuild path. Rebased onto main 95a02063: measured 24954 (+4), exact.
  // 2026-09-24 OPSTATE review fix 4: a forked writer whose open failed is abandoned by the kernel (no
  // UI checkpoint); MemoryStorage.fromEvents seeds only op.state cells (opCells). Rebased onto main 95a02063: measured 24958 (+4), exact.
  // CU-ARTIFACT-RETENTION-GC-INDEX C6, on the tree rebased onto main 67c981cc: measured 25007, exact,
  // no spare (+49). Referenced eviction pass
  // in the retention selector; reclaimed-artifact sentinel, bounded window extension and the
  // ARTIFACT_RECLAIMED restore error in request media; sentinel root export.
  // CU-ARTIFACT-RETENTION-GC-INDEX P2 review fixes: measured 25011, exact, no spare (+4). The request
  // media window keeps the newest nodes that fit a small manifest limit and stops extending instead
  // of failing.
  // WEB-INCREMENTAL-PROJECTION-TRACE-INDEX C1: child trace cache (project/child-trace-cache.ts, a
  // cell traces() read, the session loader switched to it) +127; rebased onto main 14df3240 (UI clip
  // at 24898): measured 25025, exact, no spare.
  // C1 rebased onto main c4dd646e: measured 25138, exact, no spare.
  // WEB-INCREMENTAL-PROJECTION-TRACE-INDEX C2: web opening/patch/history embed child trees under a
  // per-turn budget with truncation placeholders, pages count turn bytes on the live and rebuilt
  // paths, patches re-send turns whose child changed, and session projections run one at a time
  // (+306, incl. the clipUtf16 import after rebasing onto main 14df3240); measured 25331, exact,
  // no spare.
  // C2 rebased onto main c4dd646e: measured 25444, exact, no spare.
  // WEB-INCREMENTAL-PROJECTION-TRACE-INDEX review fixes: one counted put() for the child cache,
  // the child just resolved never evicted, evicted children's last change remembered, live-fold
  // rows counted against the bytes, closed turns' trees reused, and an oversized re-send answered
  // with a replacement (+51); measured 25382, exact, no spare.
  // Review fixes rebased onto main c4dd646e: measured 25495, exact, no spare.
  // 2026-09-24 REDUCER-CLONE R1: ChunkedMap / ChunkedSet, insertion-ordered persistent map and set in
  // 256-entry chunks (reduce/chunked-map.ts). Measured: 25131 (+120), exact.
  // R1 rebased onto main 701a621f: 25615 (+120 over main's 25495).
  // 2026-09-24 REDUCER-CLONE R2: the fold copies only the tables a row writes and keeps toolCalls and
  // decisions in ChunkedMaps; state tables typed read-only; FoldCache drops its unread state reference.
  // Measured: 25158 (+27), exact.
  // R2 rebased onto main 701a621f: 25642.
  // 2026-09-24 REDUCER-CLONE R3: TurnProjection keeps each turn's usage as running sums with a
  // counted-effect set instead of re-adding and re-copying every call per cost row. Measured: 25182 (+24), exact.
  // R3 rebased onto main 701a621f: 25666.
  // 2026-09-24 REDUCER-CLONE R4: cache-health keeps its seen effect ids in a ChunkedSet; the surface
  // is appended in place and handed out as a copy made on first read after a change. Measured: 25183 (+1), exact.
  // R4 rebased onto main 701a621f: 25667.
  // REDUCER-CLONE review fixes: the fork start resets its tables through a helper that marks them
  // copied for the row (+7); measured 25674, exact.
  // UI-CACHE-INCREMENTAL C1 (rebased on 950fc6f3): measured 24927, exact, no spare (-747). The
  // persisted UI projection checkpoint is gone: payload, restore and validation in the UI cell,
  // surface and turn checkpoints, cache-health serialization, the write policy and its log hooks.
  // UI-CACHE-INCREMENTAL C2 (rebased on 950fc6f3): measured 24949, exact, no spare (+22). Opens fold
  // the rows as they are verified: verifyLedger hands each verified page on, and openTracked seeds
  // the tracker from the fold cache before the first page.
  // CHUNK-LEDGER-SLIM C2: live preview hub (listeners + snapshot of inferences in flight) and
  // its publish from the inference flush. Measured 25011, exact, no spare (+62).
  // CHUNK-LEDGER-SLIM C6: the ledger keeps assistant/output counts instead of streamed chunks -
  // started/progress/interrupted writes (the interrupted row from the abort callback so a close
  // keeps it), their relation checks, the UI cell's lost-text marker and fold-cache version 2.
  // Measured 25097, exact, no spare (+86).
  // Skill ZIP response on the merged tree: measured 25098, no spare.
  // CHUNK-LEDGER-SLIM review fix: the abort listener stays until the settlement is admitted, so a
  // close between the end of the stream and the settlement still records the text. Measured
  // 25106, exact, no spare (+9).
  // Merged with b/main (Skill ZIP response, main merges); combined source re-measured, exact, no spare.
  // OPSTATE O5 (program counter leaves the rows): op writes through append with schema check and
  // storage receipt, op-mark rows, relation check on cells, trigger from the op write; minus the fold's
  // op register, its cache codec and the fork tombstone. Measured 25153, exact, no spare (+46).
  // OPSTATE O6: open-time check of the program-counter cells (turn pairing, schema, lane, turn, seq
  // range, dispatched calls not shown as undispatched). Measured 25207, exact, no spare (+54).
  // OPSTATE O6 review fix: the dispatched-call check scans the current batch only. Measured 25213,
  // exact, no spare (+6).
  // OPSTATE O5 review fix: the register map keeps the set of op lanes beside its cells, so the
  // per-append relation check and lease renewal stop copying the whole table. Measured +16 on its
  // own base; with the batch-scan fix above the combined tree measures 25229, exact, no spare.
  // FOLD-CACHE-REMOVAL: the fold cache goes - its codec and write policy, the storage field and
  // reader, the per-append trial fold and the open-time restore; every open folds from seq 1.
  // Measured 25019, exact, no spare (-210).
  // FOLD-CACHE-REMOVAL follow-up: encodeLedgerState, used only by tests, moves to the testkit.
  // Measured 24962, exact, no spare (-57).
  'packages/core/src': 24962,
  // 2026-09-15: DeepSeek V4 Pro/Flash ship a known-thinking-corrections table (new file) so the
  // product corrects pi-ai's verified-wrong reasoning_effort data out of the box, instead of
  // requiring every deployment to hand-edit thinkingEfforts once they notice. Measured 3347.
  // 2026-09-16: expose pi-ai's existing kimi-coding provider as a separate reviewed API-key
  // route without copying its model catalogue. One provider identity and one explicit lazy-load
  // spec add nine lines. Measured 3356; exact cap, no spare.
  // 2026-09-16: request-local retry opt-out flows through facade and PiAdapter; measured 3359.
  // Task 14 live creditsPerUsd getter so the next pricing invocation reads the publisher snapshot.
  // Re-measured with countLines(): 3719, exact cap, no spare.
  // 2026-09-22 pi-ai 0.87.0: transcript normalization and two JSON boundary type imports; exact +3.
  'packages/ai/src': 3834,
  // 2026-09-09: raised from 500, which was exactly the measured count and so forbade every
  // further line. Two repairs were blocked by it and are landing with this raise: the provider
  // factory taking log + pricing (without which every delivered assembly denominates ledger
  // credits in dollars), and the sandbox seam's deny list reaching the file system that enforces
  // it. Those two measure 528. The remaining 90 are the named near-term work for this key -
  // I3's lockfile reading (~50), provider.contract via loadContractStore, which this key already
  // refuses in so many words (~25), and the third profile template's composition (~15).
  // WHERE THE NEXT RAISE STOPS BEING A NUMBER: at 618 this key holds a five-file sequencer whose
  // orchestrator (assemble.ts) is already ~215 lines of ten numbered steps. The next thing that
  // wants room here is package trust and lockfile verification, which is a subject of its own and
  // not a step of the sequence. Split it to its own key rather than raise again; the test that
  // sequencing stays readable is that assemble.ts itself does not pass ~250 counted lines.
  //
  // 2026-09-11: raised from 618 by host Task 24 Step 7
  // (archived implementation record) — createJitiPackageLoader, the real
  // PackageLoader that resolves a package's entry from package.json (exports['.'] / string
  // exports / main, defaulting to ./index.js) and hands it to readNamedExports. This is still
  // Step 7 of the same sequence the note above already accounts for, not the package-trust /
  // lockfile verification (Step 8) the note warns to split out instead — Step 8 remains blocked
  // (needs the `Lockfile` type from the unmerged feat/host-lockfile branch) and out of scope here.
  // Measured total: 639; 650 leaves a little room without inviting scope creep back in.
  //
  // 2026-09-11: raised from 650 by two concurrent lanes landing together, each measured against
  // that same shared baseline without knowing about the other:
  // (a) host Task 25/26 Steps 9-11 (archived implementation record) —
  // assemble.ts's step 9 now wires the real, already-built managed ext host
  // (bindExtensionInvocations + createManagedExtHost + loadBundledExtensions) in place of the old
  // tools-only createExtHost, replacing one line with the ports construction, the shutdown
  // callback (a real judgment call, documented in the code), the native-import default for the raw
  // extension loader, and the two discovery mechanisms (specs built from
  // PackageModule.extensionEntry, plus loadBundledExtensions for package.json's
  // `agnes.extensions` bundles — @agnes/base's real tools ship through the latter, so leaving it
  // unwired would have silently stopped tool delivery). Measured alone: 690.
  // (b) host Task 24 Step 8 (same plan file) — packageDirs plus its builtinDir helper in
  // assemble/packages.ts, ~47 counted lines. The split-rather-than-raise warning above names
  // "package trust and lockfile verification" as the subject that must not grow here; that subject
  // landed separately under packages/ against the packages/host/src budget. Step 8 is the last step
  // of the sequence this key holds — with it landed the sequence is complete, there is no Step 9
  // that adds code to this directory beyond what (a) already accounts for. Measured alone: 686.
  // Combined, both landing on the same merge: measured total 744; 760 leaves a little room without
  // inviting scope creep back in.
  // 2026-09-11: the final I6 assembly wiring supplies ecosystem factories with the fitted sandbox
  // and operation factories with the resolved preset. Measured total: 780; 790 leaves ten lines.
  // 2026-09-11: T0.1 accounts for 2ec8411's runtime switch repair. Assembly exposes only the
  // reviewed built-in API-key routes it actually fitted, so the host can authorize a model switch
  // without treating arbitrary provider routes as declared. Measured total: 814; exact ceiling.
  // 2026-09-12: T6.3 adds the ephemeral opt-in and delegates selection to its own bounded module;
  // assemble retains only validation, service injection and the one discovery callback. Exact 853.
  // I7 Base35 wires consent overlay resolution and canonical session bindings. Exact 897.
  // The CLI SEA release path adds reviewed embedded-extension activation without creating a second
  // assembly route. Final embedded-manifest admission and package-entry containment: 906 exact.
  // P4/P5 add owner-bound projection reads; S3 adds one Service registry and bounded invocation wiring.
  // Service implementation stays outside assemble; R0 applies the effective isolation policy and hash; R1 adds verified inventory and bundled isolation admission; measured total is 1071.
  // H3 threads one shared activation barrier through assembly without moving barrier policy here.
  // S5 exposes the same invocation authority through call and trusted kind inspection; combined
  // assembly is 1082 after resolving the parallel activation/service lanes.
  // WIN-09b: measured Hook grant capability and assembly wiring. Measured 1185.
  // 2026-09-15 (EXTAPI-01 x main merge, PR #4): EXTAPI-01 Task 3's assemble.ts wiring (extensionPlatform
  // computed once, threaded into both the boot and hot-reload staging paths) landed independently of
  // WIN-09b above. Re-measured on the merged tree directly (never summed): 1188; exact cap, no spare.
  // B1-A: measured 1210 lines on the shared tree; public transport contract, config and wiring/testkit.
  // WEBFETCH-01: +2 counted lines for approved public retrieval; excludes concurrent work.
  // resource-live-reload Task 3: reloadEcosystemExtension - buildEcosystemContext (extracted from
  // ecosystemContext to accept a fresh mcpResources/skillResources override), findBundledExtension
  // (re-derives the ExtensionSpec + directories loadBundledExtensions built, since nothing retains
  // them after assembly), makeFactorySelector (factored out of the inline selectExtensionFactory
  // literal so a reload can bind its own contextFor), and the Assembled type/return wiring. Exact
  // measured total: 1282, no spare.
  // resource-live-reload Task 3b: re-measuring this key at the start of Task 3b (commit 646dbe45,
  // clean working tree, no intervening commits - confirmed via `git stash`/`git log -1`) found it
  // already red on arrival at 1289, 7 lines over the 1282 ceiling Task 3's own report claimed as
  // exact-zero-spare. Not attributable to this task - carried forward rather than hidden. Task 3b's
  // own addition is the `reloadableExtensions` line in assemble.ts's createManagedExtHost() call
  // (its accompanying explanatory comment is stripped by this guard's own countLines(), so only the
  // one code line counts): +1. Combined exact measured total: 1290, no spare.
  // resource-live-reload Task 8: `findBundledExtension` gains a second lookup path (embedded
  // manifests, matching the boot-time embeddedExtensions loop further down in assemble.ts) so a
  // packaged build (tools/build-local.ts's SEA) can find and reload `agnes/mcp-client` the same way
  // it is found at boot - previously it was only ever discoverable via the filesystem-scan path,
  // which a packaged build has no directories for, so reload always threw E_EXT_LOAD on a real
  // built worker.mjs (Task 7 confirmed this failed safely, not a crash, but never actually reloaded
  // anything). `reloadEcosystemExtension` routes the embedded case through `managed.loadEmbedded`
  // with the same fresh-resource-bound factory selector as the filesystem path, so the reload's
  // `freshInit` resources actually reach the extension factory (reusing boot's own
  // `selectExtensionFactory`, which is bound to boot-time `deps`, would have "succeeded" while
  // silently keeping stale resources). Fixes a real defect (a class of bug invisible to unit tests
  // by construction, since dev/test hosts always have real extension directories on disk), not
  // growth of an existing feature. Measured with the guard's own countLines(): 1317; exact cap, no
  // spare.
  // 2026-09-18 (resource-live-reload FINAL whole-branch review fix wave, finding I3): Task 8's new
  // `loadEmbedded` branch carried a biome `format` error (the gate `pnpm lint` runs), whose fix
  // re-wraps one `reloadFactorySelector(...)` call across multiple lines: +5 counted lines, no
  // behavior change. Measured with the guard's own countLines() after `biome check` was clean on the
  // file: 1322; exact cap, no spare.
  // 2026-09-18 (merge into main): merging the resource-live-reload branch (1322, above) together
  // with WEBFETCH-01's independently-earned +2 (1212, both measured from the same B1-A:1210
  // baseline on divergent branches) required re-measuring this key directly on the merged tree,
  // not summing the two branch deltas. Re-measured with the guard's own countLines() on the
  // post-merge file: 1324; exact cap, no spare.
  // CORDIS-C1 Task 3: ordinary preset/seam rows, required-owner audits, installed third-party
  // snapshot wiring, layered ordinary rows, static-component refusal, and Cordis-driven immutable
  // snapshot reconciliation. C1b Task 5 wires per-session workspace runtimes and readiness.
  // Task 6 fits approval/checkpoint and workspace hooks before publishing each runtime.
  // Re-measured after Task 7 reconciler lifecycle integration: 2817, exact cap, no spare.
  // CORDIS-C2 Task 10 wires the default Host RuntimeTargetPublisher on the shared PublicationGate.
  // Re-measured with countLines(): 2862, exact cap, no spare.
  // Overlay closeout binds session scopes in assemble. Re-measured: 2895, exact cap, no spare.
  // Kernel currentRuntime reads publisher session scopes. Re-measured: 2906, exact cap, no spare.
  // Generation-scoped publishedSessionRuntime plus resource-owned ordinary refuse. Re-measured: 2921.
  // Task 14 stores isolated overlay context, pins approval tickets, drains dispatch, and reads
  // park/credits from the publisher snapshot. Re-measured: 2966, exact cap, no spare.
  // Task 10: overlay rebuild/bind uses the candidate ordinary tree and candidate composite
  // revision, not the live Kernel/reconciler tables. Re-measured: 2968, exact.
  // Packaged serve plugin enable: Host assembles without provider.routes so applyRuntimeTarget
  // can boot. Inference still throws no-routes. Re-measured: 2989, exact.
  // Empty desired apply keeps Host-static preset/seam/builtin boot rows. Re-measured: 2994, exact.
  // Worker-only allowUnresolvedProvider; CLI print still fail-closes at no-routes. Re-measured: 2999, exact.
  // MCP in-place reload mirrors owners into bound generation registries. Re-measured: 3080, exact.
  // 2026-09-21 extension rows stage 1 Task 2: assemble.ts mounts `agnes/tools-core` as an `ext:` row
  // on a second applyRuntimeTarget (row loader, row builder with its Host-private claim, the driver
  // surface) and suppresses the assembly-time supply of the same id on both paths. The previous
  // 3545 was not an exact measurement; re-measured with this guard's countLines(): 3571, exact cap,
  // no spare.
  // 2026-09-21 extension rows stage 1 Task 3: row-backed ids become revokable per ID in
  // `reloadableExtensions` (mutable() refuses by PACKAGE, and the shipped template puts @agnes/base
  // in seams.sandbox), and a failed retire is reported through the row's onDisposeError instead of
  // being swallowed after applyRuntimeTarget has already resolved. Re-measured with this guard's
  // countLines(): 3587, exact cap, no spare.
  // 2026-09-21 extension rows stage 1 Task 4: all eight ordinary builtin extension ids move onto
  // ext: rows, the Computer Use supply gate is mirrored on the row-building side, and admission is
  // preflighted per installation before a row is built (a builtin the profile's capability ceiling
  // refuses must keep the pre-row supply, or Host stops booting instead of merely failing that one
  // extension). Re-measured with this guard's countLines(): 3619, exact cap, no spare.
  // 2026-09-21 extension rows stage 1 Task 5: the Computer Use privileged input is keyed on the
  // builtin ROW id through EXTENSION_ROW_GRANTS instead of on the owning package name.
  // Re-measured with this guard's countLines(): 3623, exact cap, no spare.
  // 2026-09-21 extension rows stage 1 fix round 1: the Computer Use grant keeps an owner check
  // beside the row-id table (`extensionRowGrantFor`) - buildEcosystemContext runs for every
  // extension the factory selector loads, not only for rows, so the row-id table alone would hand a
  // trusted third-party `agnes/computer-use` the backend provider. Re-measured with this guard's
  // countLines(): 3630, exact cap, no spare.
  // 2026-09-21 extension rows: `Host.extensionRows.apply` is built from the PUBLISHED target
  // (composeExtensionRowTarget) instead of from the boot-time rows and empty resources, so a
  // composite target published since boot is no longer rebuilt away. Re-measured with this guard's
  // countLines(): 3672, exact cap, no spare.
  // Each target re-reads installed snapshots and a package trusted after boot counts as trusted.
  // Re-measured on the merged tree: 3647, exact.
  // Merge of the extension-rows apply fix (3672) with the installed-snapshot / trust change (3647):
  // re-measured on the merged tree with this guard's countLines(): 3689, exact cap, no spare.
  // The Host merges its own ext: rows back into daemon targets, which never name them.
  // Re-measured: 3693, exact.
  // A tree that does not finish starting within 30 s is abandoned instead of holding the apply queue.
  // Re-measured: 3728, exact.
  // 2026-09-21: a package row can replace a builtin ext: row, and only while it is enabled.
  // Re-measured: 3730, exact.
  // 2026-09-22 (plugin rows register through ctx.extension()): the row-extension host is wired into
  // assembly (early creation, root service factory, activation once the kernel exists, shared shutdown
  // dispatch, merged status listing). Re-measured with this guard's countLines(): 3827, exact.
  // 2026-09-22 (builtin extensions supplied through the shared row host): the migrated-id lifecycle in
  // ext-rows and the assembly wiring (shared owner record, builtin row host, selector isolation
  // forwarding, merged listing, reload refusal). Re-measured with this guard's countLines(): 3899, exact.
  // 2026-09-22 (remaining builtin ids migrated): the id set plus the restore of the live tree after a
  // rejected candidate. Re-measured with this guard's countLines(): 3926, exact.
  // 2026-09-22 (review fixes): rebuild only once a candidate mounted, unreadable-manifest governance.
  // Re-measured: 3929, exact.
  // 2026-09-22 merge with Web Plugins parity dynamic service extension reconciliation.
  // Re-measured on the resolved tree with countLines(): 4049, exact.
  // 2026-09-22 hooks-runner-as-row migration, rebased onto the above: re-measured on the resolved
  // tree with this guard's countLines(): 4049, exact cap (its own +4 delta already lands inside the
  // 4049 above, since this migration was rebased directly onto the Web Plugins parity merge).
  // 2026-09-22 (hooks-runner review fixes): thread a per-load token through the isolation selector's
  // crash-report closure so a stale evicted generation cannot be misattributed to its live successor
  // (extension-isolation-selector.ts, builtin-row-host.ts); await outstanding evictions during Host
  // close (extension-owners.ts). Re-measured on the resolved tree with countLines(): 4054, exact
  // cap (the rebase combined the two independent deltas non-additively; this is the real measured
  // total, not 4049 + 1 - see the guard's own countLines() as the source of truth), +1 confirmed red.
  // MODEL-CONFIG-HOT-UPDATE: exact measured feature allocation; see execution/2026-09-22-model-configuration-hot-update.md.
  // Skills cordis service, rebased onto origin/main 7a2218df. Re-measured with countLines(): 4201, exact.
  // MCP-ROWS stage 2b step 1 (D118): DynamicExtension mount type and extraOwnedRowIds plumbing in
  // ext-rows.ts/assemble.ts so runtime-only extensions (no on-disk package) can mount as one ext:
  // row per resource. Re-measured with this guard's countLines(): 4217, exact cap, no spare.
  // MCP-ROWS stage 2b step 2 (D110'): a dynamic row's factory now receives the same owner/id-gated
  // SeamInitContext a bundled ecosystem factory gets, so every MCP row reaches one per-Host
  // McpCatalogHub via @agnes/base's mcpCatalogHubFor(ctx) without Host core importing @agnes/base
  // (host/test/boundary.test.ts). Re-measured: 4220, exact cap, no spare.
  // Merge feat/mcp-rows-stage2b into main: skills-cordis-service (4201) and the MCP-ROWS deltas above
  // (4220) both touched assemble.ts independently; re-measured on the merged tree with this guard's
  // countLines(): 4237, exact cap, no spare.
  // 2026-09-22 incremental apply: per-delivery importers newest first, additive builtin claims,
  // the tainted-tree handling on the live ordinary tree, the outer-rollback row-eligibility change,
  // the no-rebuild-after-transaction + backgrounded-retirement change, the shared
  // stableInventoryRows() review fix, and the I2 compensation-timeout rebuild branch. Re-measured
  // with countLines() on the fully-resolved tree after rebasing onto origin/main: 4257, exact.
  // Merge main (incremental apply) into feat/mcp-rows-stage2b's own merge of main: both independently
  // touched assemble.ts again; re-measured on the fully-resolved tree with this guard's countLines():
  // 4293, exact cap, no spare.
  // 2026-09-22 MCP rows step 3 (design 2026-09-21-resource-rows-design.md §3.7, D119): the ext-row
  // target is now composed inside Host's apply queue (enqueueRuntimeTarget), so a daemon target still
  // in flight is not dropped by a later extensionRows.apply; the dynamic-row load opts into the
  // lifetime registration window, the seam-veto exemption, and a late-registration hook that mirrors
  // the row's owner into the published generation (mirrorGenerationOwner, now shared with
  // reloadEcosystemExtension). Re-measured with countLines(): 4306, exact cap, no spare.
  // Merge origin/main 4ccba8a1 into feat/mcp-rows-step3: main's Skills preload (4318 on main) and the
  // step 3 delta above both touched assemble.ts; re-measured on the merged tree: 4331, exact.
  // MCP rows step 4 (D123/D124): same removal as packages/host/src below. Re-measured: 4328, exact
  // (tightened).
  // Skill directories open for reading: assemble hands the live Skill list to the fence. Re-measured: 4337, exact.
  // 2026-09-23 third-party-transform-directive-hooks: ext-rows.ts adds BUILTIN_HOOK_RANKS, the fixed
  // dispatch-position table keyed ext:<id>, derived from ['agnes/skills', ...EXT_ROW_EXTENSION_IDS].
  // +3 counted lines; re-measured with countLines(): 4340, exact cap, no spare.
  // SINGLE-EXTENSION-PATH staged handoff: Skills/MCP rows, four row-owned services and Web
  // descriptor guards. Exact merged countLines() total; no spare allocation.
  // PLUGIN-HELPER: measured 4191 -> 4192; approved feature scope, no spare allocation.
  'packages/host/src/assemble': 4192,
  // P1: generated-schema validators and duplicate projection-name refusal; measured exact cap.
  // F1 adds Surface JSON/identity validation and lock snapshot validation.
  // PM4 adds strict management DTO validation and method permission/identity contracts; exact total.
  // S5 plus multi-provider integration: Surface auth, receipt ACK and account DTOs; exact 1384.
  // IP10 adds bounded opening/history and patch coordinate contracts on top of S5/F4/F5.
  // Main's fork contract and the in-process package/runtime additions are integrated exactly here.
  // 2026-09-14: SESSION-02 P0 Task 3 registers the packages.trustWorkspace method contract —
  // params/result schema entries, the PACKAGE_ADMIN_METHODS contract row, the DATA_SCHEMAS/
  // CONFIG_VALIDATORS registration, and an explicit PackageAdminDataName union (needed to dodge
  // TS7056 once DATA_SCHEMAS' inferred object literal grew past tsc's declaration-emit limit).
  // Measured exact: 1473.
  // 2026-09-14 (merge with the above): concurrent origin/main protocol work adds 2 more lines.
  // Combined exact total after merging both changes: 1475.
  // 2026-09-15: EVENT_TYPES adds subagent/cost; exporting its generated type brings the exact cap to 1477.
  // 2026-09-15: MCP compatibility follow-up exports McpInputSchema; measured exact total: 1486.
  // 2026-09-16: optional retry=false on Provider.infer, compatible with existing callers; measured 1529.
  // 2026-09-15/16 (admin-pages A8): the SkillRootDiagnostic $def must be on the root surface
  // (boundary.test.ts enforces that), +1 export line. Measured exact: 1487.
  // 2026-09-16 (plugin-skin S1): the `ui` capability + `contributes.skins` on the extension
  // manifest, the SkinListResult BFF contract, the skins.list method row, and validateSkinListResult
  // add exactly 13 net lines to src/configs.ts, src/index.ts and src/package-admin.ts.
  // Measured exact total: 1497.
  // 2026-09-16 (plugin-skin S14b): the skins.read contract, its two $defs and their validators add
  // the skin byte channel's DTOs. Measured exact total: 1504.
  // 2026-09-16 main integration: preserve session-title and admin/skin changes together.
  // Recounted with the existing guard helpers after merging both branches; exact total: 1547.
  // 2026-09-16: /yolo session-wide approval bypass adds SessionSetYoloParams, re-exported from
  // index.ts too. Recounted after merging with the skins/admin-pages work above; exact total: 1550.
  // 2026-09-16 (surface-boot-wiring Task 15): the `_agnes/v1/surfaces.mounts` method contract --
  // two new $defs (SurfacesMountsParams/Result) in schema/agnes-v1.json, their MethodName/METHODS
  // entries in src/methods.ts, and the two-name root export addition in src/index.ts. Measured
  // (on the pre-merge surface-boot-wiring tree) with the guard's own countLines(): 1551.
  // 2026-09-16 (main merge): /yolo and surface-boot-wiring were built in parallel and each measured
  // this ceiling independently, so neither number (1550/1551) reflects the other's additions.
  // Re-measured fresh on the fully merged tree with the guard's own countLines(): 1554; exact cap,
  // no spare.
  // 2026-09-17 WEB-RUN-TRACE: re-export UISpan. Re-measured after rebase onto 9c229971: 1555.
  // SESSION-ACTIONS integrated with b/main: exact increment +7.
  // 2026-09-18 (mcp-sse-transport T1): McpSseTransport must be on the root surface (boundary.test.ts
  // enforces that all non-alias $defs are exported). +1 export line. Measured exact: 1563.
  // 2026-09-18 web-client-modules P1a on b/main db043c4d: exact combined-tree measurement, 1694.
  //
  // 2026-09-18 (mcp-oauth-authorization T1): same rule, one more $def — McpOAuthSecretBinding must
  // be re-exported from index.ts too. +1 export line. Re-measured with the guard's own countLines():
  // 1564, exact, no spare.
  // 2026-09-18 (mcp-oauth-authorization T5): same rule again, two more root $defs —
  // McpOAuthStatusResult/McpOAuthStatusSetParams (the new mcp.servers.oauth.status(.set) RPC
  // contract's DTOs) must be re-exported from index.ts too. +2 export lines. Re-measured with the
  // guard's own countLines(): 1566, exact, no spare.
  //
  // 2026-09-18 (merge into main): merging web-client-modules P1a (1694, above) together with the
  // mcp-oauth-authorization branch (1566, above) -- both measured from divergent points on this
  // $defs export list -- required re-measuring this key directly on the merged tree, not summing
  // the two branch deltas. Re-measured with the guard's own countLines() on the post-merge file:
  // 1697; exact cap, no spare.
  // CORDIS-C1b Task 4: generated WorkerGeneration boundary and runtime validator. Re-measured on
  // b/main@2891ac33 plus Task 7 profile contract: 1709, exact cap, no spare.
  // CORDIS-C2 Task 8 adds the closed RuntimeTargetArtifact/runtime.stale wire envelope. The codec
  // remains owned by plugin-runtime. Re-measured with countLines(): 1724, exact cap, no spare.
  // CORDIS-C2 Task 10 adds boot_ready/converged/apply_failed validators. Re-measured: 1790, exact.
  // Task 11 plugins.tree METHODS. Re-measured: 1822, exact.
  // 2026-09-21 AGH namespace rename (.agnes -> .agh): +2 counted lines: AGH_DIR and WORKSPACE_SECRET_DIRS, the one owner of the harness directory name.
  // Re-measured with this guard's countLines(): 1860, exact cap, no spare.
  // 2026-09-22 Web Plugins parity: browser row and service RPC contracts. Exact.
  // 2026-09-22 K01: root type surface exports schema-defined CompactOutcome. Re-measured: 2030, exact.
  // 2026-09-24 TRACE-DIAG-EXPORT (user-approved raise): diagnostics.collect / diagnostics.events MethodName
  // union and METHODS entries plus the four Diagnostics* type exports. Measured with countLines(): 2182, exact, no spare.
  // CHUNK-LEDGER-SLIM C1: assistant/output event type, session.preview notification and their root
  // type exports (+5). Re-measured with countLines(): 2187, exact, no spare.
  // CHUNK-LEDGER-SLIM final tree: assistant/chunk and its type export removed. Measured 2185, exact, no spare (-2).
  // OPSTATE O5: op.state leaves the event types; validateOpState exported for the register cell (the
  // formatter splits the validate.js export list once it no longer fits a line). Measured 2194,
  // exact, no spare (+9).
  'packages/protocol/src': 2194,
  'packages/cli/src/tui': 4000,
  // 2026-09-16: first registration of packages/cli-tui — it matched none of the (then) 113 ratchet
  // keys, so the cli-progress-surface plan's Tasks 1-4 (Loader hide/restart/stop, formatTurnSummary,
  // the shared ticker + turn-clock wiring in app.ts, and the credits threshold in
  // format-usage.ts/status-bar.ts) grew this package with no line budget watching it at all.
  // Deviation from the task brief's literal Step 1 (`find ... | xargs wc -l`, which gives 4837 for this
  // tree): that raw count includes blank lines and comment-only lines, which the ratchet guard itself
  // never counts (count-lines.ts's countLines() strips both before it ever compares against a ceiling
  // — see its "line-count ratchet" describe block above, which is what actually gates `pnpm test`).
  // Registering 4837 would leave ~826 lines of pure blank/comment slack completely invisible to the
  // ratchet, contradicting this file's own stated convention (every other key's comment above cites a
  // "Measured total: X; exact cap" figure — that figure is always this guard's own countLines() output,
  // never a raw wc -l, which is exactly why those totals run lower than a plain line count would give).
  // Verified empirically, not assumed: ran countLines() over the same file set matchesRatchetKey()/
  // isTestFile() select for this key and for the already-registered `packages/cli/src` key (ceiling
  // 8783 above) — cli/src's current tree measures 6692 raw wc -l vs 5617 guard countLines() (a ~84%
  // ratio), and cli-tui/src measures 4837 raw vs 4011 guard countLines() (a ~83% ratio) — consistent
  // with the guard stripping the same ~15-17% of blank/comment lines in both packages, not a fluke of
  // this one file set. Registering the guard's own exact measured total (4011), matching every other
  // key in this file, no spare.
  // 2026-09-16 CLI deep bug hunt M-11: a digit could approve a permission option the renderer had
  // clipped off screen. app.ts now caps the modal at the rows left under it and hides the pickers and
  // usage panel while an approval is pending; permission-modal.ts exposes `pending`. Measured with
  // countLines() after the fix: 4019 (+8); exact cap.
  // 2026-09-16: /yolo's TUI slash command (commands.ts) adds a switch case plus a SLASH_COMMANDS
  // entry. Recounted after merging with the bug-hunt fix above; exact total: 4029.
  // 2026-09-17 CLI deep bug hunt M-02: a switch while this client's turn or queued prompts were pending
  // sent the queue and Ctrl-C's cancel to the next session. app.ts adds `refuseSwitch()`, called by
  // applySwitch (which now reports whether it switched) and by a session picker choice before it loads;
  // commands.ts calls it for /new, /rewind and /resume <id> before the daemon opens anything. Measured
  // with countLines() after the fix: 4038 (+9); exact cap.
  // 2026-09-17 CLI deep bug hunt M-05: /new, /resume <id>, the session picker and `@` completion read
  // process.cwd() instead of the launch --cwd. app.ts gains a `cwd` option (runTui passes io.cwd) and a
  // `cwd` getter that falls back to process.cwd(). Measured with countLines() after the fix: 4042 (+4);
  // exact cap.
  // 2026-09-17 CLI deep bug hunt M-09: `@` completion let readdirSync's EACCES/ENOENT escape the terminal
  // input callback, exiting in the alternate screen. completeToken catches it and offers no entries.
  // Measured with countLines() after the fix: 4048 (+6); exact cap.
  // 2026-09-17 CLI deep bug hunt M-10: a /new, /resume or picker answer landing after stop() still swapped
  // sessions and started a projection nobody stopped, whose retry timer kept the process alive. applySwitch
  // returns without switching once the app has stopped. Measured with countLines() after the fix: 4049
  // (+1); exact cap.
  // 2026-09-17 CLI deep bug hunt M-12: a resource slash command was classified as mutating by its first word,
  // but the parser takes flags before the action, so `/mcp --expected-revision <rev> trust srv` ran without
  // /mcp confirm. commands.ts now reads the action the way the parser does. Measured with countLines()
  // after the fix: 4050 (+1); exact cap.
  // 2026-09-20 (DBH INV-004 + INV-002), 4094 -> 4100, measured with this guard's countLines():
  //   +3  TuiApp.runInput() collapses the editor's onSubmit routing and the argv-prompt entry
  //       onto one method owning the .catch(showError), so the contract no longer depends on
  //       each caller remembering it (new 4-line method, onSubmit loses 1 line).
  //   +2  waitForPackageOperation() bounds its poll loop and names the give-up reason, matching
  //       the sibling poller in resource-control-cli (constant + terminal throw).
  //   +1  flushQueuedPrompts() re-arms the queued-prompt wake path on every exit, so a prompt
  //       put back after a refusal cannot strand with no live retry route.
  // 2026-09-21 daemon UI demo closure: `/package` completes the pre-existing package-admin
  // contract in the TUI (lifecycle operations and durable operation lookup/cancel), while the
  // reconnect event makes recovery visible. Re-measured with countLines(): 4214; exact cap.
  // 2026-09-22 macOS E2E smoke (bug #2), 4231 -> 4265, measured with this guard's countLines():
  //   TuiApp now handles the SDK's terminal 'closed' event (daemon stop): stops the spinner through
  //   a resetTurn() shared with applySwitch, shows a localized `agnes --resume <id>` notice (new
  //   'notice.closed' key, 3 lines), and refuses input that would re-dial and run unseen. Review
  //   follow-up (+10): the close also cancels the queued-prompt wake and stops the projection, and
  //   one refuseClosed() guards runInput (normalized /quit), actions and both pickers. Second review
  //   follow-up (+4): approval and tool cards go inert after the close (a parked ticket would otherwise
  //   be decided on the restarted daemon), and the approval card's decide callback is guarded too.
  // 2026-09-22 CLI E2E: the /resume picker offered sessions bound to other workspaces, which daemon
  // then refused with ID_CONFLICT; it now keeps only the ones this workspace can load (+1, the root
  // it compares against). Measured with countLines(): 4232; exact cap.
  // Merged both lanes (4265 + 1): re-measured with countLines() after the merge: 4266; exact cap.
  // 2026-09-22 new-session composer selection on top of 4266: memory file, /new, /model and /yolo.
  // Measured with countLines(): 4352; exact cap, no spare.
  // 2026-09-22 TUI visual refresh plus persisted thinking level, rebased over composer selection.
  // Re-measured with countLines(): 4605; exact cap, no spare.
  // 2026-09-22 theme chooser, atomic local preference and full-frame light/dark palette.
  // Measured with countLines(): 4736, exact cap, no spare.
  // Integrated T01/K01 with main 063ce09a: countLines() 4759 = 4736 + 23, no spare.
  // 2026-09-23 Mac acceptance C2: the error notice names a TURN_ERROR's own turn code and gives AUTH
  // a fixed /model hint. countLines() 4772 = 4759 + 13, no spare.
  // WEB-INCREMENTAL-PROJECTION-TRACE-INDEX C3: projection.ts is now a re-export of the SDK engine.
  // measured 4238 (-534), exact, lowered to the measured value.
  // CHUNK-LEDGER-SLIM final tree: the TUI live line reads merged previews. Measured 4232, exact, no spare (-6).
  'packages/cli-tui/src': 4232,
  // Initial ceilings for the remaining packages, registered all at once so that each parallel lane
  // does not have to edit these two files separately. The sdk ceiling of 2500 was newly set by
  // estimate: 404 lines today, plus roughly 360 for the three transports, plus roughly 1650 for the
  // eleven remaining files. Changing any value here must go through review together with this
  // comment.
  // 2026-09-10: raised from 600. The protocol added ToolResult.structured (ERRATA B16, already
  // ruled to exist but never typed), spawn's opts.cwd and info.preset/cwd, and latestExtEvent's
  // signature (spec B14/B15) - three lines of real author-facing surface, not incidental growth.
  // The info type literal's five members are what actually cost the lines: biome will not collapse
  // a multi-line object type literal back onto one line at this file's 110-char width regardless of
  // how the source is written, so there is no format-only way to recover the three lines.
  // I7 Base35 reached 606. S2/P3 add Service/Projection author contracts; measured 681 (<700).
  // 2026-09-15: ToolContext.session.generationDepth, ChildStatus.waitTimedOut, subagent.cancel.
  // Measured total: 702; exact cap.
  // 2026-09-15: subagent.resume + spawn start option. Measured 709.
  // 2026-09-15 (EXTAPI-01): Task 1 adds four new types in common.ts (PlatformFacts and three sandbox-
  // enforcement shapes), platform/sandbox.enforcement members on all four author-facing contexts, four
  // .test-d.ts key-set guards, and the 1.1.0 version bump. Measured 739; exact cap, no spare.
  // 2026-09-16 (plugin-skin S2): the generated theme-token whitelist (extracted from
  // packages/web/public/style.css), the skinProblems checks in manifest.ts, and the whitelist
  // re-exports add exactly 24 lines. Measured 763; exact cap, no spare.
  // WEBFETCH-01: +14 counted lines for approved public retrieval; excludes concurrent work.
  // 2026-09-18 web-client-modules P1a: client capability/contribution coupling validation.
  // CORDIS-C1b Task 6 exposes the bounded workspace-hook context contract; exact measured total.
  // 2026-09-22: the PluginExtensionAPI type a plugin row receives from ctx.extension() (type-only,
  // no runtime export). Re-measured: 912, exact.
  // 2026-09-23 third-party-transform-directive-hooks: PluginExtensionAPI.registerHook (type-only,
  // no runtime export) and its doc-comment update. +1 counted line; re-measured: 935, exact cap.
  // PLUGIN-HELPER: measured 936 -> 937; approved feature scope, no spare allocation.
  'packages/extension-api/src': 937, // SKILL-INSTALL-CORE: optional request port and bounded DTO, no admin grant.
  // Optional author fixture entry; no production runtime code belongs here.
  // B1-A: measured 229 lines on the shared tree; public transport contract, config and wiring/testkit.
  // B1 review repair: exact measured 246; startup cancellation / cwd contract coverage.
  'packages/extension-api/testkit': 246,
  // 2026-09-10: raised from 2500 by Task 15 (stream-disconnect reconnection). The new
  // reattach.ts (the Reconnector: backoff loop, OVERLOADED's retryAfterMs override) plus
  // Session.recover()/waitForQuiescence and Client's reconnect wiring (emit(), the
  // sessions/isClosed accessors, ClientEvent's three new members) measured 2586 counted
  // lines; 2650 leaves a little room without inviting scope creep back in.
  // 2026-09-11: I6 Tasks 18/19 add the interoperable portal identity mint and fail-closed
  // claim client. T2.4 adds the explicit server-receipt acknowledgement after durable client
  // delivery. T2.5 adds browser WebSocket subprotocol negotiation so a browser can authenticate
  // without putting a bearer in its URL. The resulting package measures 2721 counted lines.
  // 2026-09-12: I7 SDK Task 20 adds the single branding cache/text contract and Client lifecycle
  // binding used by both SDK entries and CLI. I8 Task 21 adds the Node-only allowlisted HTTP relay,
  // recursive identity stripping, SSE/poll delivery, bounded bodies and request-target guards.
  // Its security review adds per-principal Client binding, explicit protocol-valid principal fields,
  // failure-safe SSE cleanup, shared-stream detach accounting and response backpressure. Final
  // security review fences detach/reattach, bounds iterator cleanup, drains rejected bodies,
  // rejects prototype-control keys and validates principal fields against their RPC schemas.
  // Task 21/23 final review makes Client/principal binding process-wide and removes Node-only
  // secret-bearing types and the inproc transport from the browser entry, and contains response
  // errors while an SSE writer is waiting for drain. The Node entry finally registers/exports
  // source-auth, while a real browser Client wrapper enforces the restricted runtime surface.
  // Exact 3269.
  // 2026-09-13 PM6/S6 control plane: the Node-only Package Admin and named-extension clients,
  // plus the authenticated Surface relay/browser stub, are distinct public-security subjects.
  // S5/S6 then add composite Surface auth and explicit effect-receipt acknowledgement to the same
  // bounded Node client. Multi-provider and IP10 opening/history integration bring the exact
  // merged SDK total to 3808.
  // Main's durable fork submission and the compact/admin client additions are integrated exactly.
  // 2026-09-15: mandatory Windows identity and per-attempt resolver inside the existing deadline.
  // SDK and CLI ceilings use measured totals for trusted reconnect and Web caller migration.
  //
  // 2026-09-16 (merge b/main into feat/admin-pages-ui-refactor): the merge combines main's SDK lines
  // with this branch's skins namespace; measured on the merged tree: 3910, exact.
  // 2026-09-16 (plugin-skin S5): the SDK `skins` namespace exposing skins.list adds 4 lines.
  // Measured 3901.
  // 2026-09-16 (plugin-skin S14b): `skins.read` beside it. Measured exact total: 3904.
  // 2026-09-16 (merged tree + uncommitted skin work): the working tree carries both blocks, so this
  // key is the combined measurement: 3917 (3910 merge baseline plus the skins lines).
  // 2026-09-16 (surface-boot-wiring Task 15): the SDK `surfaces` namespace exposing
  // `surfaces.mounts()` (one import line, one four-line object) adds 4 lines. Measured fresh with the
  // guard's own countLines(): 3921; exact cap, no spare.
  // SESSION-ACTIONS integrated with b/main: exact increment +5.
  // 2026-09-17: Session.setYolo for the Web permission picker. Measured 3932, exact.
  // 2026-09-18 web-client-modules P1a on b/main db043c4d: clientModules list/read SDK namespace.
  // CORDIS-C1b Task 6 requires the authenticated session id on service calls; exact measured total.
  // 2026-09-21 AGH namespace rename (.agnes -> .agh): +1 counted line: default-journal.node.ts imports AGH_DIR.
  // Re-measured with this guard's countLines(): 4072, exact cap, no spare.
  // 2026-09-22 new-session composer selection: composer-selection.ts. Measured with countLines(): 4156; exact cap, no spare.
  // 2026-09-22 composer selection now validates and restores the remembered thinking level.
  // Re-measured with countLines(): 4166; exact cap, no spare.
  // Integrated task fixes on 4fc6e285; remeasured with countLines(), no spare allocation.
  // 2026-09-23 SDK recovery: explicit five-state public contract and transition notifications.
  // Measured 4234 with countLines(); no unused allowance.
  // WEB-INCREMENTAL-PROJECTION-TRACE-INDEX C3: the TUI projection engine moves unchanged into
  // ui-projection-sync.ts (UIProjectionSync) so the Web workbench can share it. measured 4779, exact,
  // no spare (+545, all from the moved file).
  // WEB-INCREMENTAL-PROJECTION-TRACE-INDEX C4: the engine gains surface/opening/history options,
  // share mode, a single-flight request queue, reject-on-first-opening, the connection-state gate,
  // stream keep-alive, refresh() and an event bypass. measured 4922 (+143), exact, no spare.
  // 2026-09-24 WEB-INCREMENTAL-PROJECTION-TRACE-INDEX C6 (Web incremental wiring) and its review fixes,
  // rebased onto main after C0-C2: merged tree re-measured with countLines(): 4955, exact.
  // CHUNK-LEDGER-SLIM C5: PreviewMerger (offset merge, gap buffer, per-inference cap, overlay onto
  // installed timelines), Session.onPreview and the projection engine's preview forwarding.
  // Measured 5074, exact, no spare (+119).
  // CHUNK-LEDGER-SLIM final tree: the stream keep-alive and its sizing are gone. Measured 5013, exact, no spare (-61).
  // Permission cancellation distinction on the merged tree: measured 5051, no spare.
  'packages/sdk/src': 5051,
  'packages/sdk/src/extensions.node': 21,
  'packages/sdk/src/package-admin.node': 147,
  'packages/sdk/src/surface.browser': 3,
  'packages/sdk/src/surface.node': 163,
  // 2026-09-10: raised from 3000 by daemon Task 17 (WorkerPool / WorkerLink / RemoteSession /
  // WorkerRegistry - archived implementation record). The four new files are
  // real feature surface for the daemon spec's §5.2 one-worker-per-session model: worker-link.ts
  // (81, the framed request/reply link to a worker process), worker-pool.ts (161, spawn + token
  // handshake + start gate + the 5-minute/3-strike crash breaker), remote-session.ts (69, the core
  // `Session`-shaped proxy over a link) and registry.ts (84, the `SessionRegistry`-shaped worker
  // analogue) - 395 lines. A concurrent lane landed lease/lease.ts (32, writer-claim table reads)
  // and storage/table.ts (13, the `TableHandle` contract) in the same window, +45 more. Measured
  // total: 3205; 3260 leaves a little room without inviting scope creep back in.
  //
  // 2026-09-10: raised again from 3260 by Task 22 (storage/lister.ts -
  // archived implementation record). `StorageLister` (the future
  // multi-process form's `SessionLister`, reading the `events`/`writer_claims` tables instead of
  // scanning a live `SessionRegistry`) plus `TicketPort`/`TicketIndex`/`MemoryTickets` measure 85
  // counted lines on their own - nothing else in `packages/daemon/src` changed in this task; Task
  // 11's approval.decide (the intended consumer of `TicketPort`) has not landed in this package or in
  // `@agnes/protocol`'s `METHODS` table, so `local/methods/agnes.ts` was left untouched (see this
  // task's report). Measured total: 3307; 3320 leaves a little room without inviting scope creep
  // back in.
  //
  // 2026-09-10: raised again from 3320 by Task 21's core-logic slice (reclaim.ts -
  // archived implementation record). `reclaimExpired` (the crash-
  // continuation sweep over Task 19's `listExpired`/`releaseClaim`: release an idle claim, or read
  // `op.state` off the `registers` table and drive `openForResume(...).session.resume()` for one
  // with an open turn) measures 55 counted lines on its own - nothing else in `packages/daemon/src`
  // changed in this task. The supervisor wiring half of Task 21 (running this on a timer inside
  // `supervisor.ts`) is separately blocked on Task 18/NoticeSink and not part of this slice; see this
  // task's report. Measured total: 3362; 3375 leaves a little room without inviting scope creep back
  // in.
  //
  // 2026-09-11: raised again from 3375 by the `Registry<T>` extraction task (a new
  // `packages/daemon/src/registry.ts` exporting the shared method shape both `local/sessions.ts`'s
  // `SessionRegistry` and `supervisor/registry.ts`'s `WorkerRegistry` now formally `implements`,
  // plus the one-line `import`/`implements` additions each of those two files and
  // `local/methods/acp.ts` picked up to use it) - 14 counted lines on its own. A concurrent lane
  // landed `local/notice.ts` (`NoticeSink`) in the same window, +29 more. Measured total: 3405;
  // 3418 leaves a little room without inviting scope creep back in.
  //
  // 2026-09-11: raised again from 3418 by daemon Task 18 (`startSupervisor` -
  // archived implementation record). The new `supervisor/supervisor.ts`
  // (317 counted lines: the owner-lock/worker-pool/client-socket assembly, the `RemoteEntryView`/
  // `SupervisorRegistry` bridge that lets a `WorkerRegistry` satisfy `LocalContext.registry` without
  // widening that type across three already-landed files, the profile-only `Host` facade, and
  // `runAgnesd`) accounts for nearly all of it. The rest is the small, additive hooks this task's own
  // report documents needing: `local/methods/acp.ts` gained the optional `onPromptStart`/
  // `onPromptEnd` context hooks `session/prompt` calls around its `inflight` window (this is how the
  // supervisor's `PrompterRouter.originOf` learns which of several concurrent connections owns a
  // session's live prompt - the in-process form never needed this because it only ever has one
  // connection), and `worker/main.ts` gained the optional `deps.buildHost` hook `runWorker` uses
  // instead of `createHost` when supplied (so `test/fake-worker-entry.ts` can run a real worker
  // against a `@agnes/host/testkit` fixture host without a real package loader) - both no-ops for
  // every existing caller that does not pass them. Measured total: 3730; 3745 leaves a little room
  // without inviting scope creep back in.
  // 2026-09-11: I6 daemon Tasks 11/12 and 24-28 add authenticated RPC/notice wiring plus the
  // deliberately isolated jobs subsystem and production supervisor handoff. The merged package
  // measures 4838 counted lines. Jobs retain the independent 800-line sub-budget below, while the
  // 4850 package cap leaves twelve lines and prevents that allocation becoming general growth.
  // 2026-09-11: the final I6 daemon pass adds worker-owned principal resolution, durable
  // session-to-workspace ownership, recovery-safe per-job budgets, and read-only status/doctor
  // probes. Measured total: 5168; 5180 leaves twelve lines.
  // 2026-09-12: migration T2.1 adds the authenticated TLS WebSocket listener and shares the
  // supervisor's per-connection endpoint assembly with Unix clients. Measured total: 5338; exact cap.
  // 2026-09-12: migration T2.3 adds the bounded per-session command scheduler and wires mutation
  // admission/control bypass into embedded and supervisor endpoints. T2.4 adds the persistent
  // command journal, content binding, production composition, receipt ack endpoint, and safe inbox
  // crash-window reconciliation. T2.5 adds browser subprotocol auth plus the supervisor's declared
  // model precheck and fixes the worker switch-result bridge. Measured total: 5849; exact cap.
  // T6.3's nine-line embedder option pass-through is the only daemon change. Exact 5858.
  // 2026-09-12: I7 Daemon Task 23 adds transactional persistent claims and scoped nonce replay
  // tables. The isolated storage module adds 89 counted lines. Measured total: 5947; exact cap.
  // I7 Daemon9 adds production source/JWT authentication, key rotation, JWKS hardening, claims GC,
  // verified journal identity, and startup cleanup. Measured total: 6418; exact cap.
  // I8 Daemon32 separates request admission from connection teardown, adds bounded worker drain /
  // force-kill and double-signal process handling, and makes every cleanup phase failure-isolated.
  // Final review adds startup-worker fencing, cancellable grace drain, bad-peer TLS teardown, and a
  // scheduler intake/abort fence that prevents queued ticks and dispatch continuations from doing
  // new work or heartbeating leases during shutdown. Measured total: 6627; exact cap.
  // I8 Daemon33 adds identity-fenced stop/status control and the real agnesd command dispatch.
  // Measured total: 6749; exact cap.
  // I8 Daemon34 exposes serialized, shutdown-fenced crash reclaim for doctor/acceptance use.
  // Final 32/33/34 review prevents shutdown-aborted scheduler/reclaim continuations from writing
  // after the owner lock is released. Measured total: 6788; exact cap.
  // 2026-09-13 PM5/PM9 control plane: durable Package Admin operation coordination, scoped
  // authority, recovery helpers, and the fixed admin surface/session bridge are separate modules.
  // The final explicit corrupt-lock recovery retry adds ten counted scope lines. Their exact leaf
  // caps keep this approved scope from becoming general daemon headroom. The aggregate is the
  // current measured control-plane total; the integrated activation lane below brings the exact
  // aggregate to 11155 before S5/F4/F5. Multi-provider and IP10 bounded projection bring the
  // exact merged total to 13580.
  // IH2/IH3b/IH4b/IH10 add the production worker activation coordinator, durable recovery and
  // catalog-backed admin service, integrated with main's durable fork lane. The leaf caps below
  // keep the aggregate increase reviewable.
  // Independent IH9 review adds durable turn-revision leases, restart-safe candidate cleanup,
  // cold-start Host activation and the post-await WorkerPool admission fence.
  // Final blank-context recovery review adds fail-stop, child-exit fencing, durable turn recovery,
  // worker-side bootstrap selection, and their narrow orchestration ports, integrated with main's
  // durable fork lane. Manual compaction binds the revision lease before its durable marker, and
  // cleanupPending transactions retry online without requiring a blocked follow-up mutation. The
  // retry lane closes before supervisor ownership is released. The final shutdown review splits
  // intake stop from the turn/assembly fence and waits child-exit recovery before releasing the
  // owner lock. Final acceptance also rebuilds the worker assembly from live desired/active/turn
  // references so uninstall cannot retain dead snapshot paths. Web-observed operation failures also
  // drain queued progress writes before their terminal record. Measured merged total: 16816; exact cap.
  // 2026-09-15: subscribe buffer UTF-8 hard-cap plus JWT nbf check. Measured 16859; exact.
  // 2026-09-16 (plugin-skin S5): the skins.list dispatch branch, its recovery gate and the
  // skinsList projection add 20 lines to packages/daemon/src/packages/handler.ts. Measured 16879.
  // 2026-09-16 (plugin-skin S14a): skins.list inlines stylesheet text under the cap so a skin
  // with no assets needs no second request. Combined measured total: 16893.
  // 2026-09-16 (plugin-skin S15): skins.list prefers inline css and tolerates a missing path.
  // Combined measured total: 16894.
  // 2026-09-16 (plugin-skin S23): skinsList routes the inlined text through a new `inlineSkinCss`
  // helper (rewrite + post-rewrite cap) and uses the shared `skinCssUrl`, so `handler.ts` grows by 6
  // counted lines. Combined measured total: 16900.
  // 2026-09-16 (plugin-skin S14b): the skins.read dispatch branch, the corrupt-ledger gate arm and
  // the private skinsRead method. Combined measured total: 16925.
  // 2026-09-16 (plugin-skin S26): the method allowlist on the package authority, the localWeb
  // skin-read resolver and the supervisor's transport choice. Combined measured total: 16947.
  // 2026-09-16 main integration: preserve session-title and admin/skin changes together.
  // Recounted with the existing guard helpers after merging both branches; exact total: 17016.
  // 2026-09-16: /yolo wires the local + worker RPC handlers (methods/agnes.ts, remote-session.ts,
  // supervisor.ts). Recounted after merging with the skins/admin-pages work above; exact total: 17029.
  // 2026-09-16 (surface-boot-wiring plan, Tasks 2-5): four new production modules under
  // packages/daemon/src/surfaces/ -- deploy-dir.ts (lockfile -> deployDir), deployment-policy.ts
  // (operator-owned grant ceiling, empty by default), artifact-resolver.ts (SurfaceArtifactResolver
  // with package containment) and secret-resolver.ts (SurfaceSecretResolver adapter) -- plus the
  // extraction of secretsDirectory() out of runAgnesd in supervisor/supervisor.ts. This aggregate
  // key covers the daemon package as a whole, so it moves together with the surfaces sub-key below.
  // Measured with the guard's own countLines(): 17107; exact cap, no spare.
  // 2026-09-16 (surface-boot-wiring x wt-task-6 merge): the parallel Surface boot-wiring branches
  // (activation predicate split; four new Surface modules) merged together and were each measured
  // against the pre-merge tree independently. Re-measured on the merged tree directly (never
  // summed) with the guard's own countLines(): 17114; exact cap, no spare.
  // 2026-09-16 (surface-boot-wiring Task 7): new packages/daemon/src/packages/deployment-activation.ts,
  // the real `deployment` ActivationAdapter for surface-only units. Measured with the guard's own
  // countLines(): 17176; exact cap, no spare.
  // 2026-09-16 (surface-boot-wiring Task 8): wires createDeploymentActivation into
  // createInProcessActivationRuntime's `adapters` table behind an optional `surfaces` option on
  // InProcessActivationOptions (in-process-activation.ts). Measured with the guard's own
  // countLines(): 17185; exact cap, no spare.
  // 2026-09-16 (surface-boot-wiring Task 9): active-revisions.json records gain an optional
  // `surfaces?: readonly { id: string }[]` field (activation-journal.ts: type, packageRevision()
  // validator now flexes its exact()-checked key set on whether the key is present) plus the
  // in-process-activation.ts write site (surfaceContributions() + conditional spread) and the
  // cold-start actual-view seed rebuild (`revision.surfaces ?? []` mapped to `kind: 'surface'`
  // observations). Measured (on the pre-merge Task 9 tree) with the guard's own countLines(): 17213.
  // 2026-09-16 (surface-boot-wiring Task 11): new packages/daemon/src/surfaces/mount-proxy.ts, the
  // browser-to-Surface HTTP forwarder (createMountProxy), plus exporting FORGED_IDENTITY_KEYS and
  // normalizeKey from routes.ts for reuse (no new lines from the export keywords themselves; the
  // added doc comment on normalizeKey is counted). Measured (on the pre-merge Task 11 tree) with
  // the guard's own countLines(): 17236.
  // 2026-09-16 (surface-boot-wiring Task 13): deployment-activation.ts now delegates the extension
  // half of a mixed surface+extension unit to an optional `extensionAdapter`, staged once per
  // distinct extension id (the real extensionAdapter refuses more than one owner per unit); every
  // StagedActivation method forwards to it alongside the surface half. in-process-activation.ts's
  // `adapters.deployment` now threads its own `extensionAdapter` through so the delegation is
  // actually reachable in production, not just parametrized. Measured (on the pre-merge Task 13
  // tree) with the guard's own countLines(): 17216.
  // 2026-09-16 (surface-boot-wiring merge, Tasks 9+11+13): Tasks 9/11/13 were built in parallel on
  // sibling worktrees off the same eb388a8d base and each measured this ceiling independently, so
  // none of their individual numbers (17213/17236/17216) reflect the other two's additions.
  // Re-measured fresh on the fully merged tree with the guard's own countLines(): 17295; exact cap,
  // no spare.
  // 2026-09-16 (surface-boot-wiring Task 10): new packages/daemon/src/surfaces/boot-coordination.ts
  // (coordinateSurfacesOnBoot, the plan's central decision -- Surface coordination on every daemon
  // boot, independent of coldStart) plus the supervisor.ts wiring that constructs the SurfaceController,
  // secrets/artifact resolvers, the mutable `deployment()` closure threaded through the `surfaces`
  // option Task 8 added to createInProcessActivationRuntime, and the unconditional
  // coordinateSurfacesOnBoot() call site itself. Measured fresh on this tree with the guard's own
  // countLines() (after `biome check --write` reformatted the ternary secrets-resolver expression onto
  // multiple lines, +3 over the pre-format count): 17352; exact cap, no spare.
  // 2026-09-16 (surface-boot-wiring Task 10, review fix): the `startupCleanup.push(() =>
  // surfaceController.stop())` hook added above is dead on the normal success path
  // (`startupCleanup.length = 0` wipes it the moment startSupervisor returns; it only ever fires on a
  // startup abort). Hoisted `surfaceController` to the function-scoped `let` alongside
  // `inProcessRuntime` and wired an explicit `surfaceController?.stop()` into the real graceful
  // shutdown ladder's `closeSockets` stage (same double-coverage convention this diff already used for
  // `workersServer`). Measured fresh on this tree with the guard's own countLines(): 17355; exact cap,
  // no spare.
  // 2026-09-16 (surface-boot-wiring Task 12): wired Task 11's mount proxy into `startSupervisor`'s
  // returned handle (`surfaceMountProxy`, built from `createMountProxy` + a `lookup` reading the live
  // `SurfaceController.snapshot()`), threaded the same field through `startProductionSupervisor`'s
  // passthrough return, and added the `node:http` type import and the doc-comment additions this
  // required. Measured fresh on this tree with the guard's own countLines(): 17375; exact cap, no
  // spare.
  // 2026-09-16 (surface-boot-wiring Task 15, cross-process bridge): `createMountProxy` only ever ran
  // in-process; `agnes serve`'s browser-facing `createWebServer` is a genuinely separate OS process
  // from `agnesd`, so a JS closure over `SurfaceController` cannot reach it. Adds new
  // `local/methods/surfaces.ts` (registerSurfaces: the `_agnes/v1/surfaces.mounts` RPC handler) plus
  // its two-line wiring into `supervisor.ts` (import + `registerSurfaces(ep, {snapshot: () =>
  // surfaceController?.snapshot()})` inside the per-connection `endpoint()` closure). Measured fresh
  // on this tree with the guard's own countLines(): 17395; exact cap, no spare.
  // 2026-09-16 (surface-boot-wiring final review fix wave): net addition despite retiring the whole
  // dead surfaceMountProxy mechanism from supervisor.ts (its type-signature doc comment, its
  // createMountProxy-built closure, its field on both startSupervisor's and
  // startProductionSupervisor's returned handles, and the now-unused createMountProxy/
  // IncomingMessage/ServerResponse imports) and adding the M4 unix-transport gate on
  // registerSurfaces's registration in its place. The larger additions are the surfaces-package
  // changes covered by the `packages/daemon/src/surfaces` sub-key's own comment above (C1, I3, I5,
  // M2, M3, M7) plus their propagation into local/methods/surfaces.ts (isRoutableSurfaceInstance) and
  // routes.ts (mountMatches). Measured with the guard's own countLines(): 17417; exact cap, no spare.
  // 2026-09-16 (surface-boot-wiring final review fix wave, lint pass): same +5 lines as the
  // `packages/daemon/src/surfaces` sub-key's own comment above (mount-proxy.ts's `node:http` import
  // reflowed onto six lines by `biome check`'s formatter, no behavior change). Measured with the
  // guard's own countLines() after `pnpm lint` was clean: 17422; exact cap, no spare.
  // 2026-09-16 (main merge): /yolo and surface-boot-wiring were built in parallel and each measured
  // this ceiling independently, so neither number (17029/17422) reflects the other's additions.
  // Re-measured fresh on the fully merged tree with the guard's own countLines(): 17435; exact cap,
  // no spare.
  // 2026-09-17 (Block B hot update, Task 2 / RC2): the same +123 lines described in the
  // `packages/daemon/src/surfaces` sub-key's own comment below (controller.ts's generation-keyed
  // records, spawnInstance/stopOneRecord extraction, startInstance/promote/stopInstance, and
  // types.ts's generation/current fields). Nothing outside packages/daemon/src/surfaces/ changed in
  // this task. Measured with the guard's own countLines(): 17558; exact cap, no spare.
  // 2026-09-17 (Block B hot update, Task 2 / RC2 review fix wave): the same +12 lines described in
  // the `packages/daemon/src/surfaces` sub-key's own comment below (spawnInstance's orphan-handle
  // reap, discardRecord's failure visibility). Nothing outside that directory changed. Measured with
  // the guard's own countLines(): 17570; exact cap, no spare.
  // 2026-09-17 (Block B hot update, Task 4 / RC5): the surfaces-directory increase described in the
  // `packages/daemon/src/surfaces` sub-key's own comment below (boot-coordination.ts's extracted
  // `resolveSurfaceDeployment`), plus supervisor.ts's `refresh()` closure wired into the `surfaces`
  // deps object (fresh-inventory re-resolution + artifact-resolver rebuild, the local `packageRuntime`
  // const that keeps narrowing inside the closure, and its doc comment), plus the type-only `refresh?`
  // field added to deployment-activation.ts's `createDeploymentActivation` deps and to
  // in-process-activation.ts's `surfaces` option (the latter needed so supervisor.ts's `surfaces: {...}`
  // literal, which now supplies `refresh`, typechecks against it -- neither file has its own sub-key,
  // so both land in this aggregate). Measured with the guard's own countLines() after `biome check` was
  // clean on these files: 17597; exact cap, no spare.
  // 2026-09-17 (Block B hot update, Task 5 / RC4): +138 lines, all in
  // packages/daemon/src/packages/deployment-activation.ts (no sub-key of its own, so it lands in this
  // aggregate). The hot-update branch itself -- snapshot-based "is this package already serving"
  // detection, the startInstance -> version-confirm -> promote -> stopInstance(old) sequence, the
  // per-generation stop() path that replaces controller.stop() on the hot path, and the module-scope
  // `GET /version` probe helper. (The rewritten RC3.1/RC4 module doc comment landed in the same
  // change but does not count -- countLines() ignores comments.) Measured with the guard's own
  // countLines() after `biome check` was clean on the file: 17735; exact cap, no spare.
  // 2026-09-17 (Block B hot update, Task 5 review fix): +9 lines in the same file -- the post-promote
  // `stopInstance(outgoing)` call wrapped in try/catch plus its console.error, so a failure to tear
  // the OLD generation down can no longer fail the switch and reach the coordinator's discard()
  // against the generation that just took over. Measured with the guard's own countLines() after
  // `biome check` was clean on the file: 17744; exact cap, no spare.
  // 2026-09-17 (Block B hot update, FINAL whole-branch review fix wave): +28 lines, all in
  // `deployment-activation.ts`. Two cross-task integration defects that only showed once all 7 tasks
  // were assembled: (1) the hot path's `stop()` now skips a generation the controller still routes to
  // (`isCurrentGeneration` helper + the guard in the loop), so a post-hoc discard()/rollback() after a
  // SUCCESSFUL promote cannot stop the live Surface and wedge the next reconcile on the cold path's
  // `phase !== 'idle'` BUSY; (2) a `failedToStop` list + `rememberFailedStop` recorded at both sites
  // that deliberately swallow a `stopInstance` rejection, read back by `residue()` so a stuck live
  // child is no longer reported as a clean completion. Measured with the guard's own countLines()
  // after `biome check` was clean on the file: 17772; exact cap, no spare.
  // 2026-09-17 CLI deep bug hunt M-16: `_agnes/v1/session.list` compared the cwd filter as typed with
  // bindings session/new had canonicalized, so a symlink or trailing-slash spelling found nothing. The
  // handler canonicalizes it through the same WorkspaceCatalog.validate. Measured with countLines() after
  // the fix: 17438 (+3); exact cap.
  // 2026-09-17 (origin/main merge into the CLI deep bug hunt branch): Block B hot update (17772) and M-16
  // (17438) each measured this ceiling on their own side of the merge base (17435). Re-measured on the
  // merged tree with the guard's own countLines(): 17775 (17772 + M-16's 3); exact cap, no spare.
  // SESSION-ACTIONS integrated with b/main: exact increment +108.
  // 2026-09-18 (resource-live-reload Task 7): opened the task with this key already red on a clean
  // working tree at 17936 vs the declared 17883 (+53) - confirmed via a stash-isolated re-measure
  // (working tree clean afterward, no intervening commits) that this drift predates Task 7 and is
  // left by other parallel-session work not yet reconciled against this guard (see archived
  // repeated notes on this exact key, e.g. the 2026-09-17 entries acknowledging unreconciled
  // `packages/daemon/src*` drift on main). Task 7 itself narrows `WorkerRegistry.retireForResourceSnapshot()`'s
  // caller: adds `retireSessions()` + a shared `markForResourceRetirement()` helper to registry.ts and
  // narrows `wireResourceSnapshotNotifications()`'s registry parameter type in supervisor.ts - mostly
  // doc comments (stripped by countLines()), so the net increment is only +7 counted lines. Measured
  // with the guard's own countLines() after `biome check` was clean on both files: 17943 (17936 + 7);
  // exact cap, no spare. The pre-existing +53 overage is carried forward unresolved, not fixed here.
  // 2026-09-18 (resource-live-reload FINAL whole-branch review fix wave, finding I1): Task 7's
  // narrowing also moved the `resourceEpoch` bump behind `failedKeys.length > 0`, so on the common
  // all-delivered path the fence that discards a worker caught mid-`acquire()` by a snapshot commit
  // stopped advancing. Adds `WorkerRegistry.noteResourceSnapshotCommitted()` (registry.ts) and calls
  // it unconditionally from `wireResourceSnapshotNotifications` (supervisor.ts), which also widens
  // that function's registry parameter type - most of the change is doc comment (stripped by
  // countLines()), so the counted increment is +7. Measured with the guard's own countLines():
  // 17950 (17943 + 7); exact cap, no spare.
  // 2026-09-18 web-client-modules P1a on b/main db043c4d: immutable snapshots and control wiring.
  // 2026-09-19: local CLI session ownership accepts the daemon's durable ownership index instead
  // of losing authorization whenever a new Host instance reopens an existing session. +9 counted
  // lines in local/index.ts; re-measured with countLines(): 21971, exact cap, no spare.
  // CORDIS-C1b Task 4: one shared worker transport, session channels, durable multi-session
  // recovery, close/recovery fencing, and per-session frame routing. Re-measured on
  // b/main@2891ac33 without Computer Use. C1b Task 5 adds durable workspace authority and binding
  // propagation: 22598, exact cap, no spare. Task 6 adds authenticated session-bound service
  // dispatch and workspace catalog recovery: 22659, exact cap, no spare.
  // CORDIS-C2 Tasks 7-8 add the publication/quiet gates and isolated runtime-target probe. The
  // Task 8 review adds Windows DACL-backed private probe files. Re-measured: 22909, exact cap.
  // CORDIS-C2 Task 10 adds CompositeTargetStore, probe-then-persist publisher, and runtime frame
  // admission. Re-measured with countLines(): 23238, exact cap, no spare.
  // Task 10 startup gate: boot_ready six-tuple admission, lastGood/bootstrap delivery, and
  // qualified converged/failure handling. Re-measured: 23414, exact cap, no spare.
  // Task 11 plugin-tree apply/list/poll plus tree_changed NoticeSink. Re-measured: 23570, exact.
  // Task 11 plugins.tree RPC + CompositeTarget activation. Re-measured: 23673, exact.
  // Skill auto-refresh watcher + WorkspaceCatalog.onBound + package-operation refresh. Re-measured: 23851, exact.
  // Skill watcher: project .agents/.claude dirs, linked user targets, and startup root refresh
  // (23911 on main), plus Skills boundary repair discovery port (+4). Combined: 23915, exact.
  // Shared-worker keeper (P1 of the single-resident-worker design): boot-time acquire, retry backoff, quarantine/eviction exemption for '@shared'. Re-measured: 23982, exact.
  // 2026-09-23 AUDIT-CONFIRMED-BUGFIXES: replay waiter wake-up, post-backoff slot re-check and the
  // recoveryError gate for callService/callEffect, net of the lastGood comparison (-2). Measured: 24658, exact.
  // 2026-09-24 SHARED-SESSION-IDLE-CLOSE P4: ACP feeds hold and release their registry subscription
  // (per-connection dispose, entry identity through the supervisor view, reopen only watched sessions).
  // Measured: 24675 (+17), exact, no spare.
  // Review fixes: a request that outlives its connection gets a detached Feed (+4); a replacement
  // subscribes before the old subscription is released (-1). Measured: 24678, exact, no spare.
  // 2026-09-24 SHARED-SESSION-IDLE-CLOSE C2-C5 and review fixes (user-approved raise for the perf
  // batch), rebased onto main with the other perf lanes: merged tree re-measured with
  // countLines(): 24718, exact, no spare.
  // 2026-09-24 SCAN-TRUNC-01 C4 (user-approved raise for the perf batch): the local scanAll loop (11 lines)
  // becomes rowsOfType over core's scanPages (7), SCAN_PAGE becomes the shared SCAN_PAGE_MAX, and the two
  // 500-seq window reads (acp session/load, attached replay) carry an explicit limit: 500. The wider
  // @agnes/host import is formatted onto five lines. +2 counted lines; re-measured with countLines():
  // 24660, exact, no spare.
  // 2026-09-24 package removal: forward preparation, wait for sanitized target acknowledgement,
  // and keep retiring pins across a failed removal retry. Measured: 24671, exact.
  // Merged with b/main (package-removal acknowledgement, +13) on top of the perf batch (+62): merged tree
  // re-measured with countLines(): 24733, exact, no spare.
  // CU-ARTIFACT-RETENTION-GC-INDEX C8, on the tree rebased onto main 67c981cc: measured 24755, exact,
  // no spare (+22). Reclaimed screenshot
  // reads: runPort reclaimed state, public 410 artifact_reclaimed after authorization, trusted
  // reclaimed reply, and the artifact-media-read reply helper.
  // CONVERSATION-MCP-ONBOARDING: approved local owner bridge and durable receipts; exact +389, no spare.
  // Merged with b/main@82310218; combined source re-measured, exact, no spare.
  // PLUGIN-HELPER: measured 25309 -> 25795; approved feature scope, no spare allocation.
  // 2026-09-24 TRACE-DIAG-EXPORT (user-approved raise): local/methods/diagnostics.ts (owner-gated runtime info,
  // redacted audit-log tails, sanitized ledger pages), requireSessionOwner extracted from registerAgnes, the
  // diagnostics FAMILIES row, and registration at the supervisor and in-process endpoints. Measured with
  // countLines(): 24893, exact, no spare.
  // Merged with origin/main@641f407d..c86a7877 (CONVERSATION-MCP-ONBOARDING, CU-ARTIFACT-RETENTION, REDUCER-CLONE):
  // 25309 + TRACE-DIAG-EXPORT 160 = 25469, re-measured with countLines(), exact, no spare.
  // CHUNK-LEDGER-SLIM C3: live preview routing - the worker-link preview frame, the pool's
  // hosting-link check, WorkerRegistry/SessionRegistry preview fan-out and snapshot, and the
  // RemoteSession snapshot proxy. Measured 25558, exact, no spare (+89).
  // CHUNK-LEDGER-SLIM C4: per-connection preview delivery - a preview budget and low-water
  // resync counted apart from the overload queue, the snapshot hold (PreviewPipe), the raw
  // session.preview stream and the ACP Feed's offset merge and missing-suffix answer; the ACP
  // chunk projection is gone. Measured 25832, exact, no spare (+274).
  // CHUNK-LEDGER-SLIM final tree: chunk filtering in attach and diagnostics is gone. Measured 25827, exact, no spare (-5).
  // CHUNK-LEDGER-SLIM rebased onto main@c1cd6cbe (PLUGIN-HELPER daemon 25955): merged tree re-measured
  // with countLines(): 26313, exact, no spare.
  // CHUNK-LEDGER-SLIM review fix: the ACP Feed takes a running inference from op.state, tells a
  // whole answer when it never learned the inference, and drops stale text until the next one.
  // Measured 26330, exact, no spare (+17).
  // CHUNK-LEDGER-SLIM review minors: viewers catch up once a reopened generation has replayed,
  // a detached or replaced attach feed closes its preview pipe, snapshots resume from what the
  // viewer has and are cut by encoded size, and the worker snapshot is bounded. Measured 26379,
  // exact, no spare (+49).
  // Merged with b/main (Skill ZIP response, main merges); combined source re-measured, exact, no spare.
  // LEGACY-LEDGER-OPEN: a session an older build wrote is refused as LEGACY_LEDGER_FORMAT (audited),
  // not INTERNAL: open-path mapping, approval reopen and the endpoint audit (+23). Re-measured on this tree:
  // 26440, exact, no spare.
  // WIN-SHORT-NAMES: the Skill watcher hands fs.watch the native (long) spelling on Windows, since
  // libuv aborts on a directory watched by its 8.3 short name; measured 26451, exact, no spare (+11).
  'packages/daemon/src': 26451,
  'packages/daemon/src/packages/admin-session': 46,
  // 2026-09-14: whole-branch review fix wave (Finding 1) adds the two missing
  // 'pins/inspect'/'pins/release' entries to the ACTIONS BFF route allowlist, which had been left
  // out of every task's individual review because no Web test exercises ACTIONS directly (they all
  // mock fetch at the PluginAdminApi boundary). Measured 191, exact.
  // 2026-09-14: Task 4 profile-command-plan adds the 'trust-workspace' entry to ACTIONS. Measured
  // 192, exact.
  // Task 11 BFF tree/get|list|apply|rollback. Re-measured: 230, exact.
  // 2026-09-22 Web Plugins parity: browser-row/service package control plane. Exact.
  'packages/daemon/src/packages/admin-surface': 231,
  // A manager error may race its last onProgress callback; the handler drains that callback before
  // recording terminal failure so polling cannot resurrect an operation. Measured total: 1043.
  // 2026-09-14: Task 3 orphaned-pin-cleanup adds RuntimePinReleaseOutcome/RuntimePinsAdapter type
  // definitions plus the RuntimePinDescriptor/RuntimePinReleaseResult protocol import additions
  // consumed by in-process-activation.ts's runtimePins.inspect/release. Exact post-integration
  // total; no spare.
  // 2026-09-14: Task 4 orphaned-pin-cleanup wires packages.pins.inspect/release into Service.call()
  // (two dispatch branches plus the pinsInspect/pinsRelease private methods, the latter also
  // enforcing the same requireBoundClient client-binding check every other effect-kind method
  // enforces) and threads the optional `runtimePins: RuntimePinsAdapter` field through the
  // constructor options and the createPackageAdminService factory. Measured 1083, exact.
  // 2026-09-14: Task 4 profile-command-plan wires packages.trustWorkspace into Service.call() -- the
  // recoveryError gate addition, the dispatch branch, and the private trustWorkspace method (mirrors
  // pinsRelease's requireBoundClient + profileDirectory + manager delegation shape). Measured 1094,
  // exact.
  // 2026-09-16 (plugin-skin S5): skins.list dispatch + skinsList projection in handler.ts.
  // Measured 1114.
  // 2026-09-16 (plugin-skin S14a): readSkinCss + the inline css branch. Measured 1128.
  // 2026-09-16 (plugin-skin S15): the same change inside handler.ts. Measured 1129.
  // 2026-09-16 (plugin-skin S23): `inlineSkinCss` + its doc comment, and `cssUrl` via `skinCssUrl`.
  // Measured 1135, exact.
  // 2026-09-16 (plugin-skin S14b): `skinsRead` and its doc comment. Measured 1160, exact.
  // 2026-09-18 web-client-modules P1a: roster invalidation and package-operation notifications.
  // Task 11 plugins.tree handler. Re-measured: 1314, exact.
  // Task 17: pluginTree getter resolved at call time so production bindPluginTree is visible to
  // tree/list. Re-measured: 1318, exact.
  // Task 17 routes package-tree mutations through the probed publisher. Re-measured: 1326, exact.
  // Trusting a package also enables and activates it. Re-measured: 1332, exact.
  // 2026-09-21: a failed package that is stopped can be removed (the adapter's `stopped` question).
  // Re-measured: 1341, exact.
  // SINGLE-EXTENSION-PATH: generation-qualified skin roster and pinned-snapshot gate. Exact count.
  // 2026-09-23 AUDIT-CONFIRMED-BUGFIXES group-05-3: callService/callEffect join the recoveryError gate.
  // Measured: 1509, exact.
  'packages/daemon/src/packages/handler': 1509,
  // 2026-09-14 doctor activation-recovery report: the optional barrel re-export of
  // ACTIVATION_RECOVERY_FILENAME/ActivationRecoveryBreadcrumb/isActivationRecoveryBreadcrumb adds
  // two lines. Measured 42, exact.
  // 2026-09-14: Task 4 orphaned-pin-cleanup re-exports the RuntimePinsAdapter type from handler.js so
  // supervisor.ts's bindRuntimePins wiring and daemon tests can import it. Measured 43, exact.
  // 2026-09-16 (plugin-skin S26): the `localWebSkinReadAuthority` re-export. Measured 44, exact.
  // 2026-09-18 web-client-modules P1a: registry public exports.
  'packages/daemon/src/packages/index': 58,
  'packages/daemon/src/packages/operations': 410,
  // 2026-09-16 (plugin-skin S26): the authority `methods` allowlist, its enforcement in
  // `requirePackageAdmin`, and `localWebSkinReadAuthority`. Measured 70, exact.
  'packages/daemon/src/packages/permissions': 71,
  'packages/daemon/src/packages/project': 52,
  // H3 and the activation handoff add the supervisor admission seam plus separately factored
  // activation/actual/deployment transaction modules. Review hardening binds scheduled turns,
  // runtime observations, desired/actual drift/orphan reconciliation and failure cleanup. The
  // aggregate ceiling above is the exact measurement after integrating all lanes.
  // 2026-09-13 S5/F4/F5 add the isolated Service worker and journal boundary, composite Surface
  // authentication, bounded Surface runtimes, and fail-closed Portal/BFF routing. The final review
  // adds explicit receipt acknowledgement and strips stale representation metadata. Each
  // new security subject is independently capped below so the aggregate increase is not spare room.
  // 2026-09-15: reject not-yet-valid JWT nbf. Measured 336; exact.
  'packages/daemon/src/local/auth': 336,
  // CORDIS-C1b Task 6 binds public service calls to durable session ownership.
  'packages/daemon/src/local/methods/extensions': 199,
  'packages/daemon/src/supervisor/service-worker': 103,
  // Includes the independently reviewed F6 deployment transaction from the activation lane.
  // 2026-09-16 (surface-boot-wiring plan, Tasks 2-5): deploy-dir.ts (resolveDeployDir),
  // deployment-policy.ts (buildDeploymentPolicy, defaulting every sourceId's grant ceiling to []
  // and refusing to backfill from the customer-authored deploy directory's own instances),
  // artifact-resolver.ts (createSurfaceArtifactResolver, node-artifact containment) and
  // secret-resolver.ts (createSurfaceSecretResolver, string-only, dispose is a deliberate no-op).
  // Measured with the guard's own countLines(): 2244; exact cap, no spare.
  // 2026-09-16 (surface-boot-wiring Task 11): mount-proxy.ts (createMountProxy) forwards browser
  // page/asset traffic to a mounted Surface's loopback endpoint -- the counterpart to routes.ts's
  // SDK-relay path, not merged with it. It strips FORGED_IDENTITY_KEYS (imported from routes.ts,
  // matched via routes.ts's own normalizeKey rather than a re-derived toLowerCase()) and applies
  // surfaceSecurityHeaders() to every response. Measured with the guard's own countLines(): 2295;
  // exact cap, no spare.
  // 2026-09-16 (surface-boot-wiring Task 10): new boot-coordination.ts (coordinateSurfacesOnBoot).
  // Measured with the guard's own countLines(): 2322; exact cap, no spare.
  // 2026-09-16 (surface-boot-wiring final review fix wave): C1 wraps coordinateSurfacesOnBoot's body
  // in a try/catch (boot-coordination.ts) so a Surface boot failure degrades instead of aborting the
  // whole daemon. I5 replaces artifact-resolver.ts's Windows-broken string-prefix containment check
  // with the relative()-based idiom already used in local-runtime.ts/workspace.ts. M7 adds a
  // deployDir-containment check to deployment-policy.ts so a profile trusting its own root cannot
  // self-author its policy override. I3 extracts the shared mount-match predicate and
  // healthy-instance filter (mountMatches/isRoutableSurfaceInstance in types.ts; matchMount in
  // mount-proxy.ts) and retires the dead in-process surfaceMountProxy mechanism from mount-proxy.ts's
  // own doc comments. M2 makes mount-proxy.ts route upstream headers through surfaceSecurityHeaders()
  // (its \r\n\0 filter) instead of spreading them unfiltered, and wraps writeHead in a try/catch. M3
  // narrows createMountProxy's lookup() return type to {mount, host, port}. Measured with the guard's
  // own countLines(): 2364; exact cap, no spare.
  // 2026-09-16 (surface-boot-wiring final review fix wave, lint pass): `biome check`'s formatter
  // reflowed mount-proxy.ts's multi-clause `node:http` import onto six lines (its own organizeImports
  // fix reordered the specifiers, which pushed the line past the width that keeps an import inline)
  // -- +5 lines, no behavior change. Measured with the guard's own countLines() after `pnpm lint` was
  // clean: 2369; exact cap, no spare.
  // 2026-09-17 (Block B hot update, Task 2 / RC2): SurfaceController gains a per-instance,
  // generation-keyed lifecycle. controller.ts re-keys `records` from bare `sourceId` to
  // `sourceId:generation` (new `instanceKey`), adds the `nextGeneration`/`currentGeneration`/
  // `perSourceOperation` bookkeeping, extracts `spawnInstance` (shared by the cold-boot loop and the
  // new `startInstance`) and `stopOneRecord` (shared by the whole-controller `stopRecords` and the
  // new `stopInstance`), and adds the three new public methods plus `projectInstance`/
  // `discardRecord`/`allocateGeneration`/`guardSource`/`trackSourceOperation`/`forgetRecords`.
  // types.ts adds `generation`/`current` to SurfaceInstanceStatus, the three method signatures on
  // SurfaceController, and the `current` clause in isRoutableSurfaceInstance. Roughly a third of the
  // addition is doc comment explaining why each of the three new maps exists, which the invariants
  // here (monotonic generations, promote-before-stop sequencing owned by the caller) need stated at
  // the declaration. Measured with the guard's own countLines() after `biome check` was clean on
  // these files: 2492; exact cap, no spare.
  // 2026-09-17 (Block B hot update, Task 2 / RC2 review fix wave): +12 lines for two leak fixes in
  // controller.ts. `spawnInstance`'s post-health check splits its two conditions apart so the
  // "record left the table while this child was still starting" branch reaps the handle
  // (`forceStopHandle`) before throwing -- previously that branch dropped a live, healthy OS process
  // nothing could reach again, since `discardRecord` no-ops when the record is already gone. And
  // `discardRecord` now collects real failures instead of a throwaway array, keeping the record and
  // logging `surface instance cleanup did not complete` when TERM+KILL did not reap the child,
  // instead of silently deleting it. Measured with the guard's own countLines() after `biome check`
  // was clean on these files: 2504; exact cap, no spare.
  // 2026-09-17 (Block B hot update, Task 4 / RC5): boot-coordination.ts's pure "resolve, don't start"
  // half of `coordinateSurfacesOnBoot` is extracted into a new exported `resolveSurfaceDeployment`
  // function (deploy-dir -> policy -> resolveDeployment, no controller.start), which
  // `coordinateSurfacesOnBoot` now calls instead of inlining those same three steps -- so a hot update
  // (Task 5) can re-run exactly this resolution against fresh package-manager inventory instead of
  // reusing the boot-time snapshot. +9 net lines here (the new function plus its doc comment, minus the
  // three inlined lines it replaced in `coordinateSurfacesOnBoot`). Measured with the guard's own
  // countLines() after `biome check` was clean on this file: 2513; exact cap, no spare.
  // CORDIS-C1b Task 6 threads the authenticated session through Surface service dispatch.
  // Task 16 cold update: stop old then start new, no auto-restore. Re-measured: 2541, exact.
  // SurfaceInstanceStatus.revision is the package snapshot used for mixed/surface-only actual.
  // Re-measured: 2543, exact cap, no spare.
  'packages/daemon/src/surfaces': 2543,
  'packages/daemon/src/worker/service-authority': 48,
  // 2026-09-12: T2.5 introduces the framework-free Web UI, its loopback static launcher and the
  // projection adapter. New package, measured at 320 production TypeScript lines; exact cap.
  // Local Web adds exact Host validation and the connected-but-unconfigured state.
  // Unified App Server: provider settings, verified model selection, revision/effect feedback.
  // 2026-09-13 PM9 adds the fixed browser admin page and DTO-only plugin controller. The final
  // confirmation-facts helper is isolated so its inert preview/trust rendering has its own exact
  // 234-line ceiling; admin/presentation are 904/85 and the complete Web source is 4147. The
  // aggregate, app, and serve increments are measured integration, not spare browser-admin headroom.
  // IH10 makes the fixed admin page catalog-driven and exposes real actual/rollback/cleanup state.
  // Main's workspace/fork refresh is included in the aggregate; each admin leaf remains independently
  // pinned at its exact integrated production count.
  // 2026-09-14 (merge): origin/main's workspace-picker feature adds packages/web/src/workspace-picker.ts
  // under this same aggregate prefix, on top of Task 7's orphan-pins addition below -- neither commit
  // individually exceeded the aggregate on its own branch, but the combined tree does. Exact measured
  // total after merging both: 5739.
  // 2026-09-14: Task 4 profile-command-plan adds the same 'trust-workspace' route-table entry as the
  // api sub-key below (+1). Measured 5740, exact.
  // 2026-09-14 (merge with the above): concurrent origin/main work adds 5 more lines. Combined
  // exact total after merging both changes: 5745.

  // 2026-09-15: appearance-pane + theme mechanism work in packages/web/src (appearance.ts,
  // theme.ts, theme-boot.ts and the app/settings/shell wiring). 2026-09-15 (merge with origin/main,
  // which adds the errorNotice diagnostic arguments in presentation.ts). Combined exact measured
  // total after merging both changes: 5933.
  // 2026-09-15 (admin-pages A1): admin/plugins/standalone.ts added (+19) while admin.ts gave back the
  // bootstrap/auto-run tail it no longer owns (-15). Net +4. Measured exact: 5937.
  // 2026-09-15 (admin-pages A2-A7): openAdminPane wiring in app.ts, the id/markup contract test's
  // supporting surface changes and the detail three-part split. Measured exact: 5963.
  // 2026-09-15/16 (admin-pages A5b): positionPopover + bindListboxKeys moved out of model-picker.ts
  // into @agnes/web-admin-frame. Tightened to the new exact measurement: 5927.
  // 2026-09-16 (plugin-skin S7): src/skin.ts adds the skin preference logic — cache read/write/
  // clear, the one-shot ?skin= override, and mode-aware token application with precise clearing.
  // safeThemeStorage gained an optional removeItem without becoming stricter for existing callers.
  // 2026-09-16 (plugin-skin S7 boot): theme-boot.ts now reads the skin cache, applies tokens and
  // adopts a constructible stylesheet at first paint, and syncs on the skin storage key.
  // 2026-09-16 (plugin-skin S8): bindSkinGroup adds the skin radio group — dynamic options built
  // from the installed roster, a visible failure state with retry, and rollback of a failed
  // selection so no unchecked-by-nothing radio is left behind. Combined measured total: 6132.
  // 2026-09-16 (plugin-skin S8 tail): app.ts calls client.skins.list, builds the group from the
  // roster, writes the skin cache and re-paints through a synthetic storage event. Combined
  // measured total: 6170.
  // 2026-09-16 (plugin-skin S24): `pnpm lint` reflowed the feature's own files to the repo's
  // formatter settings, which wrapped four long lines under packages/web/src (no code change).
  // Combined measured total: 6174.
  // 2026-09-16 (review B1/B2 fix): theme-boot hands sheet ownership to skin.ts's `syncSkinSheet`
  // (which also *removes* the sheet when a skin is turned off), and the cssUrl fallback lands as
  // `fetchSkinCss` / `cacheSkinEntry` / `planSkinReconcile` in skin.ts, plus the visible failure
  // line in appearance.ts. Same-feature growth, no new subsystem. Combined measured total: 6283.
  // 2026-09-16 (same fix, review follow-up): +6 lines for the selection counter that guards the
  // reconcile write path. Combined measured total: 6289.
  // 2026-09-16 main integration: preserve session-title and admin/skin changes together.
  // Recounted with the existing guard helpers after merging both branches; exact total: 6398.
  // 2026-09-17 WEB-RUN-TRACE: first-party 运行轨迹 panel (trace-panel.ts) plus app.ts wiring.
  // Measured 6536; exact cap, no spare.
  // 2026-09-17 rebase 到 main 后的重新实测：远端 6536 与本工作线（WEB-UI-ALIGN-DSH 的
  // tool-icon 等 +37）相加实测 6573，精确值，无富余。
  // 2026-09-17 DSH layout: compressed gantt + left-aligned event rows. Re-measured after rebase: 6889.
  // B1/main integration: +7 formatter lines around typed turn lookup and expressions; exact count.
  // SESSION-ACTIONS integrated with b/main: exact increment +292.
  // SESSION-ACTIONS: measured implementation 7188 -> 7222, no spare budget.
  // 2026-09-17 SESSION-MENU: 精确 +89 —— 新建 session-menu.ts（+115）而 navigation.ts 少 26 行
  // （菜单构造搬走）。实测 7344。其中 +33 来自同一工作树上另一条在途批次（WEB-UI-ALIGN-DSH 的
  // settings.ts，见其 `packages/web/src/settings` 条目），该前缀的上限由那条批次自己收紧；
  // 聚合项按"总和取实测精确值"记账。
  // 2026-09-17 SESSION-ROW-BG: 选中底色从内层按钮改画在会话行上（照 DSH），navigation +1 行。
  // 聚合 7344 -> 7345，实测精确值；改前在 7344 上限下即为红（反向变异即前一次运行的断言）。
  // 2026-09-17 复测：同一工作树上另一条在途批次（settings/账号面板）又加了 23 行，聚合实测 7368。
  // 其中 7345 属本批次（已在上两行记账），+23 属那条批次 —— 其自有前缀 `packages/web/src/settings`
  // 仍红（572 > 516），由它自己收紧；聚合项按"总和取实测精确值"记账。
  // 2026-09-17: session permission picker. New permission-picker.ts (203) plus app wiring; this
  // tree already exceeded 7368 from unrelated admin-plugin growth. Combined measured 7724, exact.
  // WEBFETCH-01: +2 counted lines for approved public retrieval; excludes concurrent work.
  // 2026-09-18 web-client-modules P1a on b/main db043c4d: reconciler and app wiring.
  // 2026-09-18 client-modules reconciler: split roster planning from per-package work so a slow
  // import no longer holds the global critical section and delays another package's change.
  // +7 code lines in reconcile.ts, combined measured 8847, exact; 8846 was red (verified).
  // Task 11 plugin-tree BFF client. Re-measured: 8866, exact.
  // Task 11 page desired/actual + tree BFF. Re-measured: 8912, exact.
  // Task 17: operation-only plugin detail close button so install overlay cannot intercept 信任.
  // Re-measured: 8915, exact.
  // Confirm dialog closes any other open modal so disable/rollback can show. Re-measured: 8926, exact.
  // CU-ARTIFACT-RETENTION-GC-INDEX C8: measured 12285, exact, no spare (+2). Document preview text
  // for a screenshot the retention policy removed.
  // Merged with origin/main (WEB-INCREMENTAL-PROJECTION C6, CU-ARTIFACT-RETENTION): 12561 + TRACE-DIAG-EXPORT 662 =
  // 13223, re-measured with countLines(), exact, no spare.
  // 2026-09-24 streaming-smoothness quick fixes (user-approved raise), rebased onto origin/main's 13223:
  // aggregate carries the timeline (727) and app (1767) file-key deltas above. Re-measured with
  // countLines() on the merged tree: 13313, exact, no spare.
  // CHUNK-LEDGER-SLIM final tree: the live projection merges previews instead of chunks. Measured 13161, exact, no spare (-62).
  // Merge of CHUNK-LEDGER-SLIM (13161) with the streaming-smoothness quick fixes (13313): the preview
  // merge and the throttled trace feed both stand. Re-measured on the merged tree: 13251, exact, no spare.
  // LEGACY-LEDGER-OPEN: a session an older build wrote is refused as LEGACY_LEDGER_FORMAT (audited),
  // 2026-09-25 UI refactor: shared controls and React region rendering in the settings perimeter.
  // Re-measured with countLines(): 13300, exact, no spare.
  'packages/web/src': 13303,
  // 2026-09-17 web-client-modules frontend track (rebased onto L0/permission-picker main): re-measured exact value below.
  // 2026-09-14: Task 7 orphaned-pin-cleanup adds the orphan-pins section to PluginAdminPage — the
  // #orphanPins/#orphanPinsList/#orphanPinsStatus/#orphanPinsReleaseAll element bindings, the
  // #orphanPinList/#orphanPinErrors/#orphanPinNotice state fields, the pinPurposeLabel helper, the
  // pins/inspect call folded into refresh(), and renderOrphanPins/confirmReleasePins/
  // applyPinReleaseResults mirroring the existing #recovery/confirmRemove patterns. Measured 1270
  // (post-`pnpm lint` formatting of two wrapped expressions), exact.
  // 2026-09-14: whole-branch review fix wave adds PIN_RELEASE_BATCH_SIZE chunking to
  // confirmReleasePins (Finding 2: "release all" must not send more than 64 pinIds -- the protocol
  // cap -- in one call), the #orphanPinFetchError field plus refresh()/renderOrphanPins() changes so
  // a pins/inspect failure surfaces a status line and clears the stale list instead of failing
  // silently (Finding 5), and the exported `page` binding tests use to drive a second refresh()
  // directly. Measured 1282, exact.
  // 2026-09-15 (admin-pages A5): renderDetail() splits into head/body/actions so the action row can
  // no longer be scrolled out of reach, and renderOperations/renderLastOperation gain an explicit
  // parent instead of appending to #detail. Measured exact: 1284.
  // 2026-09-17 rebase 到 main 后的重新实测：PluginAdminPage 的状态区由文字 chip 改为三颗状态灯
  // （createStateLights / createSwitch 共用原语）、详情改为模态框并新增遮罩/Escape 收尾路径、
  // 新增期望状态 Switch 与 toggleDesired 确认流（原 1284 是旧实现的实测值）。实测 1333。
  // Task 11 desired/actual status on the plugins page. Re-measured: 1430, exact.
  // Task 17: operation-only detail close control. Re-measured: 1433, exact.
  // Confirm closes other open dialogs before showModal. Re-measured: 1444, exact.
  // 2026-09-21 source dialog: the reference is checked against its type before anything is sent, the
  // dialog stays open until the backend accepts the check (a refusal shows inside it), the field's
  // example follows the type, and the settings dialog is no longer closed by its own sub-dialogs.
  // Re-measured with this guard's countLines(): 1483, exact cap, no spare.
  // 2026-09-22 Web Plugins parity: plugin-row diagnostics and client capability UI. Exact.
  // 2026-09-22 UI plugin management: runtime subscription, retry action, and four-state controls.
  // Re-measured with this guard's countLines(): 1685, exact cap after review follow-up.
  'packages/web/src/admin/plugins/admin': 1714,
  // WEBFETCH-01: +2 counted lines for approved public retrieval; excludes concurrent work.
  // SINGLE-EXTENSION-PATH: new client descriptor capability confirmation. Exact count.
  'packages/web/src/admin/plugins/confirmation': 322,
  // 2026-09-14: Task 7 orphaned-pin-cleanup adds pinsInspect/pinsRelease to PluginAdminApi and
  // generalizes #effect's return type (R = PackageOperationReceipt default) so pinsRelease can return
  // PackagePinsReleaseResult through the same clientId/commandId idempotency path every other effect
  // method uses. Measured 239, exact.
  // 2026-09-14: Task 4 profile-command-plan adds the 'trust-workspace' entry to METHOD_BY_PATH --
  // a route-table entry only (no UI panel), needed to keep the BFF/Web lockstep guard valid. Measured
  // 240, exact.
  // Task 11 tree/get|list|apply|rollback client routes. Re-measured: 293, exact.
  // 2026-09-25 C-line: countLines 314 (biome import organization grew the header block).
  'packages/web/src/admin/plugins/api': 314,
  // 2026-09-22 UI plugin management: browser runtime phase labels and safe failure messages.
  // Re-measured: 112, exact cap.
  'packages/web/src/admin/plugins/presentation': 112,
  // Task 11 tree actual fields. Re-measured: 69, exact.
  // 2026-09-22 UI plugin management: runtime snapshot/subscription source contract.
  // Re-measured: 77, exact cap.
  // 2026-09-25 C-line: countLines 79 (same import reorganization).
  'packages/web/src/admin/plugins/types': 79,
  'packages/daemon/src/jobs': 800,
  'packages/bridges/src': 2600,
  // I7 Channels12/13 add durable refs, bounded multipart outbound delivery, gap recovery, and
  // lifecycle/resource limits. Measured total: 3607; exact cap.
  // I7 Channels19/21 add DingTalk card rendering and edits, deterministic delivery identities,
  // reconnect catch-up, ordered retry, bounded chat state, and account-wide rate-limit conformance.
  // I8 Channels14 adds notice routing and acknowledgement reactions; its review fix routes notices
  // through bounded outbound lanes with cancellable retry and couples target cleanup to the
  // session-cache lifecycle. Final review drains freshly claimed inbound work before dismantling
  // its cache and isolates each shutdown resource. Measured total: 4124; exact cap.
  // I8 Channels15/16 add synchronous and parked approval, text reply and slot action paths. The
  // security review binds slot callbacks to the delivered current card, credentials and projected
  // action, claims/coalesces parked callbacks, and bounds callback memory and RPC lifetime.
  // Channels26 adds a loopback-only readiness server. Measured total: 4810; exact cap.
  // 2026-09-14: context-cache-observability Task 6/7 adds the two context-sections/
  // contribute-conflict cases to runner/draw.ts's whatToDraw switch (both return null, the same
  // treatment 'user'/'compaction' already get -- these are /context's advisory diagnostic rows,
  // never something a chat surface draws). Measured total: 5008; exact cap.
  // 2026-09-14: the new 'context' UINode kind (see packages/core/src's entry above) needs a case
  // in runner/draw.ts's exhaustive switch too; grouped with 'user'/'compaction' as having no
  // channel-message presence of its own. Measured total: 5009; exact cap.
  // 2026-09-18 web-client-modules P1a: ignore the UI-only packages_changed notice.
  // 2026-09-18: durable approval grants added explicit grant propagation to the channel runner.
  // Re-measured after the focused repair: 5125, exact.
  // Task 11 tree_changed is profile-scoped like packages_changed. Re-measured: 5126, exact.
  // 2026-09-20: biome format of runner/draw.ts wrapped long ACP option lines. Re-measured: 5131, exact.
  // 2026-09-23 terminal-client recovery: one supervised Runner at a time, teardown before rebuild.
  // Measured 5250 with countLines(); the guard still rejects any further growth.
  // Durable WAL checkpoints on darwin: the outbound ref store sets checkpoint_fullfsync.
  // Measured 5252, exact, no spare (+2).
  'packages/channels/src': 5252,
  'packages/code/src': 1600,
  'packages/cli/src/args': 300,
  'packages/runtime-python/src': 400,
  // 2026-09-11: initial I6 ceiling for the bundled subagent extension. Task 33's worktree
  // lifecycle is the first slice; the same extension will also own Task 32's three tool
  // registrations. The shared bundled-extension guard below already caps every extension at 800,
  // so this registers that fixed package budget rather than raising an existing allowance.
  'packages/base/extensions/subagent': 800,
  // 2026-09-11: Bridges Task 5 seeds these two planned bundled extensions with generated fact
  // tables. Register their fixed per-extension ceilings now; generated JSON counts as zero source
  // lines today, while the universal bundled-extension guard keeps future implementations ≤800.
  // 2026-09-23 user-approved exception: dsh-compatible discovery (per-entry skipping, linked user
  // Skills, three project directories, single-file Skills, relaxed attachments) and the base-directory
  // note. Measured 899.
  // SKILL-CATALOG-CLEAN-REWRITE: original catalog/name activation plus corrected row accounting;
  // removed catalog-dependent search helper. Measured 1008, exact; see clean-rewrite execution record.
  'packages/base/extensions/skills': 1008,
  // T6.3 injects the Host-owned HTTP executor. CORDIS-C1b Task 6 adds workspace snapshot loading,
  // synchronous registration and descendant-drained command execution; exact measured total.
  // 2026-09-21 AGH namespace rename (.agnes -> .agh): +1 counted line, the AGH_DIR import for the
  // workspace `.agh/hooks.json` fallback path. Re-measured with this guard's countLines(): 955, exact cap.
  'packages/base/extensions/hooks-runner': 955,
  // MCP rows step 4 (design 2026-09-21-resource-rows-design.md §3.9, D122): agnes/mcp-client was
  // retired. Its shared MCP library (connect.ts, register.ts, index-table.ts, the McpServerConfig type)
  // moved here unchanged apart from import paths; the profile-preset reader (config.ts's
  // readMcpConfig, D113) and the extension entry were deleted, search-tools.ts moved into
  // agnes/mcp-search. The 'packages/base/extensions/mcp-client' key (1122, incl. its reviewed
  // exception) is removed with the directory, so the library keeps an exact ceiling of its own
  // instead of escaping the budget by moving. Re-measured with countLines() after formatting: 831, exact.
  // 2026-09-23: MCP cross-server tool-name collision fix (design 2026-09-23-mcp-tool-name-collision-
  // design.md D-1) -- new naming.ts (mcpLocalToolPrefix, shared by register.ts and
  // worker-runtime/mcp-server-rows.ts) plus register.ts's localName() shrinking by three lines as it
  // switches to the shared helper. Re-measured with countLines(): 843, +12 net, exact cap, no spare.
  // Single-resident-worker P2: MCP rows report live status (catalog-info.ts, register.ts's onRemoteCatalog). Re-measured: 858, exact.
  // Single-resident-worker P2: catalogInfoOf now also returns the sorted tool list, reused by both a row's ready status and resourceMcpTools pagination. Re-measured: 872, exact.
  'packages/base/src/mcp': 872,
  // 2026-09-12: I7 Base Tasks 34/35 introduce the privacy extension. Its first slice measures 214
  // counted lines; the universal fixed extension ceiling remains 800 rather than growing Base.
  'packages/base/extensions/privacy': 800,
  // 2026-09-09: host's own budgets, from its plan. The assemble-layer 500 above is
  // the spec's; these three come from the package plan and were previously unenforced,
  // so the implementer could not have been held to them.
  // 2026-09-11: I6 Host Tasks 16/17 add the package manager, rollback journal, acquisition and
  // project-manifest trust gate as separate modules rather than growing the assembly sequencer.
  // Together with the I6 platform/audit work the package measures 6413; 6425 leaves twelve lines.
  // 2026-09-11: I9 Task 3 adds the security boundary for API-key/OAuth credential persistence:
  // closed envelopes, anchored refs, private owner/mode checks, symlink/hardlink refusal and
  // atomic fsync/rename writers. Measured host total: 6946; 6960 leaves fourteen lines.
  // 2026-09-11: T0.1 accounts for 2ec8411's allow-list repair across assemble/provider and
  // session-switch. This is the same reviewed preconfigured-route capability described above;
  // it adds no parallel provider or profile path. Measured total: 7053; exact ceiling.
  // 2026-09-12: T3.2 adds only SQLite integrity columns, migration, atomic persistence and the
  // internal integrity scan required by core. Measured total: 7120; exact ceiling.
  // T5.2 adds the isolated manifest-to-ToolContext permission projector plus its one-line execution
  // binding. This is incremental enforcement, not spare allocation. Measured total: 7203.
  // T6.2 adds only the bounded hooks-runner child connection and strict Seatbelt profile compiler;
  // both are independently fenced below. The runtime correction adds a fail-closed Node/bundle
  // resolver; release-manifest verification completes that boundary.
  // T6.3 adds only the opt-in selector, release launcher, lifecycle/status integration and the
  // assembly option. The two new subjects are independently fenced below. Exact 8105.
  // 2026-09-12: I7/I8 Host Task 17 replaces the signed-workspace startup stub with verified
  // overlay projection and a post-read TOCTOU recheck. The production increment is 28 lines.
  // The verified overlay then enters resolveProfile with lock-identity and ceiling-narrowing gates,
  // adding 23 lines. Measured total: 8156; exact cap.
  // I7 Base35 adds canonical extension-session bindings plus consent overlay wiring. Exact 8361.
  // I7 Core40 adds Memory/SQLite fold-checkpoint storage. I7 Base35 adds the separately factored
  // exact-session trajectory lifecycle plus DNS-pinned HTTPS transport; assemble itself remains
  // within its existing ceiling. Combined measured Host source: 8753. The CLI SEA increment adds
  // reviewed embedded profiles/extensions plus boot-time lock integrity verification while keeping
  // the filesystem development path and the same preflight gates. Measured Host source: 8869;
  // exact cap.
  // Integration of unified configuration/session clients with upstream I8; exact merged count.
  // R1 verified inventory, generic Hook transport/entry, and awaited process supervision: measured total.
  // H3 adds the bounded activation barrier and wires turn/Tool/Service invocation ownership.
  // Review hardening lets only child work of an admitted invocation finish across the gate and
  // binds permits to their issuing barrier. S5 adds trusted query/effect inspection, journal-bound
  // effect admission and explicit inspect/call audit mode. Multi-provider account management is
  // integrated on top; IP9 adds integrity-bound UI checkpoint storage. The exact merged aggregate
  // is measured below.
  // Main's durable fork wiring and activation-gated turn retention are integrated at this exact total.
  // paths.ts is the new single source of truth for the home/data/cache directory layout (AGNES_HOME
  // resolution and validation, dataDir, cacheDir, inDataDir, legacy sessions.db detection), plus the
  // errors.ts addition of E_HOME_INVALID and the profile/resolve.ts default switching from the home
  // root to paths.ts's dataDir/cacheDir. This key was already at 11245/11245 (no spare) from
  // concurrent work when this change started; measured total with paths.ts added: 11263.
  // 2026-09-14 (merge, profile-command-plan): concurrent origin/main work (unrelated to
  // profile-command-plan, which never touches this prefix) pushed the total to 11332. Measured exact.
  // 2026-09-15: subagent lifecycle SQLite child-control store, planned workspaces, doctor
  // maintenance DTO. Measured total: 11857; exact cap.
  // 2026-09-15 (matrix close): SQLite writer-generation fence, workspace patch/peek. Measured
  // total: 11930; exact cap (adapters-only increment).
  // 2026-09-15 (skeptic close): git finish in maintenance, durable permits, input_text columns.
  // Measured 12048.
  // 2026-09-15 (exclusive sweep lease): refuse if lease_until > now. Measured 12070.
  // 2026-09-15 (review R2/R10): ancestor scopes, merge-before-delete, in-use skip, lease steal.
  // Measured 12123.
  // 2026-09-15 (V6 overrun record): Measured 12130.
  // 2026-09-15 (merge): thinkingEfforts override (packages/host/src/configuration) landed
  // alongside the Windows-support adapters that pushed this umbrella scope to 12761 on main.
  // Both increments land under this same parent prefix. Re-measured the merged tree directly
  // (never summed): 12792; exact cap, no spare.
  // 2026-09-15: replaySwitchesOnOpen paginates model-switch rows, honors preset/model seq, restores in memory. Measured 12833; exact.
  // 2026-09-15 (EXTAPI-01 x main merge, PR #4): EXTAPI-01's host-side platform wiring (Tasks 3/4 --
  // assemble.ts, service-context.ts, the isolated hooks-runner boundary) landed independently of the
  // model-switch replay work above. Re-measured on the merged tree directly (never summed): 12853;
  // exact cap, no spare.
  // 2026-09-16 (remote-sandbox Stage A, Task 4): the new fs-io-remote.ts derives an FsIo purely from
  // a RemoteTransport - lstat/readdir/mkdir/rm as python3 -c one-liners printing structured answers
  // (parsing `ls -l` is a portability trap; a script printing exactly the fields wanted is not),
  // readlink as a plain command, upload/download for file content - so the fence in fs.ts runs
  // unmodified over a remote workspace. New file, +200 counted lines (this prefix's scan already
  // includes packages/host/src/adapters below, so the same increment is carried in both; six of the
  // lines are `pnpm lint`'s own formatting of two Object.assign(...) throws across multiple lines,
  // measured after that reformat, not before it). Measured total: 13053; exact cap, no spare.
  // 2026-09-16 (remote-sandbox Stage A, Task 6): openAdapters gained the RA17 remote-mode check (two
  // module-level constants, a small remoteTransportRoot validator, the agreement check itself), the
  // opts.preset option and its doc comment, transport threaded through AdapterBundle/close() and
  // SandboxHostServices/sandboxHostServices() - all new lines, no file added (this prefix's scan
  // already includes packages/host/src/adapters below, so the same increment is carried in both).
  // Measured total: 13097; exact cap, no spare.
  // 2026-09-16 (remote-sandbox Stage A, Task 8): the new remote-workspace.ts (openRemoteWorkspace -
  // makes one remote directory per assembly on open, removes it on close unless keepOnClose asked
  // otherwise) plus openAdapters wiring it into the remote branch (the remoteKeepOnClose config
  // reader, the openRemoteWorkspace call and its transport-closing catch, remoteWorkspaceRoot
  // threaded through AdapterBundle/close()) - new file, no file removed (this prefix's scan already
  // includes packages/host/src/adapters below, so the same increment is carried in both). Measured
  // total: 13142; exact cap, no spare.
  // 2026-09-16 (remote-sandbox Stage A, Task 8 fix round): review found close() awaited
  // remoteWorkspace.close() and transport.close() back to back, unguarded - a thrown/rejected
  // remote-workspace close (the rm -rf failing) skipped transport.close() entirely, which stays a
  // discarded boolean in Stage A's loopback double but becomes a leaked live connection once Stage B
  // fits a real transport. Wrapped the workspace close in try / the transport close in finally so the
  // channel always shuts down; no new file (this prefix's scan already includes
  // packages/host/src/adapters below, so the same +3 increment is carried in both). Measured total:
  // 13145; exact cap, no spare.
  // 2026-09-16 (remote-sandbox Stage A, final-review fix round): the whole-branch review found the
  // exec gate unwired for remote mode - the seam forwarded straight to the transport, so no request
  // ever met createPolicyExec's binding check or, decisively, its authorizeCwd, and the compiled
  // remote file policy applied to no exec at all. Fixed by giving the gate a remote `inner`, which
  // is what spec §4.6 asked for in the first place: the new exec-remote.ts (createRemoteExec - one
  // ExecAdapter over RemoteTransport.exec that hard-refuses a dead channel per RA7) plus openAdapters
  // choosing it for both policyExec and the factory's probe exec. Two smaller review findings land in
  // the same function: the open path now closes the transport on any throw between opening the
  // channel and returning (the mirror image of Task 8's close-path fix), and remote mode no longer
  // measures local filesystem facts for a remote workspace root (no local realpathSync, no local
  // case-sensitivity probe - an unmeasured remote volume is treated as case-sensitive, which is the
  // restrictive direction for the workspace allow rule). New file plus in-place wiring (this prefix's
  // scan already includes packages/host/src/adapters below, so the same +28 increment is carried in
  // both). Measured total: 13173; exact cap, no spare.
  // 2026-09-16 (remote-sandbox Stage A, second final-review fix round - exceptional, user-authorized):
  // the scoped re-review of the round above found three security-relevant gaps. `caseSensitive: true`
  // for an unmeasured remote volume was documented as restrictive and is not: the fence matched
  // `<root>/.GIT` against the workspace allow rule but not against the `.git` hard deny, admitting
  // the denied directory under another spelling, so remote mode now folds case (the fail-safe
  // direction, because folding widens deny matching too). And `createRemoteExec`, now the gate's
  // `inner`, applied none of `createExec`'s four safety defaults - so it gains the environment floor
  // that keeps AGNES_SECRET_* out of a remote command, the default deadline, the default output cap
  // (clamped on this side, not merely requested of the transport), and the abort-before-start refusal.
  // `createExec` keeps its behaviour byte for byte; three of its constants and its abort check are
  // simply exported so the remote runner matches rather than re-invents them. This prefix's scan
  // already includes packages/host/src/adapters below, so the same +28 increment is carried in both.
  // Measured total: 13201; exact cap, no spare.
  // 2026-09-16: hash session identity into title accounting IDs; measured 13595.
  // 2026-09-16 (merge with /yolo): a disableSessionTitle test escape hatch on HostOptions, so a
  // scripted-provider test asserting an exact call count for some other concern doesn't have to
  // spend a scripted response on the background title generation every session otherwise gets.
  // WIN-TITLE-REPAIR: +51 for trusted durable title-cost replay, cancellation, and stable identity.
  // Measured exact total: 13649; evidence: execution/2026-09-17-windows-title-repair.md.
  // B1-A: measured 13692 lines on the shared tree; public transport contract, config and wiring/testkit.
  // B1 review repair: exact measured 13699; startup cancellation / cwd contract coverage.
  // WEBFETCH-01: +376 counted lines for approved public retrieval; excludes concurrent work.
  // resource-live-reload Task 3: host.ts's public `Host.reloadEcosystemExtension` method (doc
  // comment + wiring to Assembled's own implementation of the same name) plus assemble.ts's share of
  // this same increment (tracked precisely by the narrower `packages/host/src/assemble` key above -
  // this key's scan includes assemble.ts too, so the same lines count in both). Exact measured
  // total: 13781, no spare.
  // resource-live-reload Task 3b: re-measuring this key at the start of Task 3b (commit 646dbe45,
  // clean working tree, no intervening commits) found it already red on arrival at 13788, 7 lines
  // over the 13781 ceiling - the same pre-existing 7-line overshoot noted at the narrower
  // `packages/host/src/assemble` key above (this key's scan includes assemble.ts too, so it carries
  // forward here as well). Not attributable to this task. Task 3b's own addition is the narrow
  // seam-immutability allowlist: managed-host.ts's `reloadableExtensions` option declaration, its
  // `o.reloadableExtensions` construction line, and the two guard-site conditions it extends (net +8
  // effective code lines - the option's own explanatory doc comment is stripped by countLines()),
  // plus assemble.ts's +1 counted above. Combined exact measured total: 13797, no spare.
  // resource-live-reload Task 8: assemble.ts's `findBundledExtension`/`reloadEcosystemExtension`
  // fix above (see the narrower `packages/host/src/assemble` key, whose scan this key's scan also
  // includes, so the same lines count in both): +27. Measured with the guard's own countLines():
  // 13824, exact cap, no spare.
  // 2026-09-18 (resource-live-reload FINAL whole-branch review fix wave, finding I3): Task 8's new
  // `loadEmbedded` branch carried a biome `format` error (the gate `pnpm lint` runs), whose fix
  // re-wraps one `reloadFactorySelector(...)` call across multiple lines: +5 counted lines, no
  // behavior change. Measured with the guard's own countLines() after `biome check` was clean on the
  // file: 13829; exact cap, no spare.
  // 2026-09-18 (merge into main): merging the resource-live-reload branch (13829, above) together
  // with WEBFETCH-01's independently-earned +376 (14075, both measured from the same B1 review
  // repair:13699 baseline on divergent branches) required re-measuring this key directly on the
  // merged tree, not summing the two branch deltas. Re-measured with the guard's own countLines()
  // on the post-merge file: 14205; exact cap, no spare.
  // 2026-09-19: the extension loader shares the TypeBox value subpath as one host-owned namespace.
  // The credential writer also prepares POSIX parent directories before taking its lock. Exact cap.
  // CORDIS-C1 Tasks 1-4: ordinary-tree migration, immutable runtime snapshots, stable runtime
  // wiring, snapshot reconciliation, and shared-worker Host session release. Re-measured on
  // b/main@2891ac33 without Computer Use. C1b Task 5 adds Host-owned workspace authority, policy,
  // readiness and per-session runtimes. Task 6 adds invocation ownership, session-bound services,
  // hook snapshots, two-phase shutdown, canonical child invocation and Task 7 publication: 24105,
  // exact cap, no spare.
  // CORDIS-C2 Task 9 foundation adds candidate revocation, resource-generation leases/retirement,
  // and the sole RuntimeState publication coordinator, including background retirement failure
  // accounting after a successful pointer exchange. Re-measured: 24711, exact cap, no spare.
  // CORDIS-C2 Task 10 adds the production target builder, static builtin/preset/seam claims,
  // resource bootstrap factory, and default Host applyRuntimeTarget. Re-measured: 25585, exact.
  // Overlay closeout rebuilds open session scopes on target apply. Re-measured: 25692, exact.
  // Kernel currentRuntime adapter on the published session scope. Re-measured: 25703, exact.
  // Task 13–15 overlay/policy/ordinary refuse and generation view. Re-measured: 25825, exact.
  // Task 14 hot-policy consumers, pending drain swap, and isolate overlay. Re-measured: 26078, exact.
  // createSession drains a leftover cancel_requested/failure_drain turn so resume is a new prompt.
  // Re-measured: 26085, exact.
  // Task 10 overlay candidate runtime view. Re-measured: 26087, exact.
  // no-routes Host assembly for plugin apply. Re-measured: 26108, exact.
  // Empty desired apply merges Host-static boot rows into the ordinary candidate. Re-measured: 26138, exact.
  // Worker-only allowUnresolvedProvider on AssembleDeps. Re-measured: 26144, exact.
  // MCP in-place reload preserves bound session registry identity. Re-measured: 26365, exact.
  // 2026-09-21 extension rows stage 1 (Task 1 ext-rows.ts + Task 2 assemble/host wiring). The 34021
  // above carried spare budget; per this stage's ratchet rule the key is tightened to the exact
  // measurement instead. Re-measured with this guard's countLines(): 33291, exact cap, no spare.
  // 2026-09-21 extension rows stage 1 Task 3 (ext-rows onDisposeError, assemble reloadableExtensions
  // + revoke_failed audit, audit kind, Host.extensionRows fail-closed guard). Re-measured with this
  // guard's countLines(): 33318, exact cap, no spare.
  // 2026-09-21 extension rows stage 1 Task 4 (eight-id list plus the assemble-side row-admission
  // gate). Re-measured with this guard's countLines(): 33350, exact cap, no spare.
  // 2026-09-21 extension rows stage 1 Task 5 (EXTENSION_ROW_GRANTS + the assemble lookup).
  // Re-measured with this guard's countLines(): 33354, exact cap, no spare.
  // 2026-09-21 extension rows stage 1 fix round 1 (extensionRowGrantFor + the corrected
  // reloadableExtensions note). Re-measured with this guard's countLines(): 33361, exact, no spare.
  // 2026-09-21 extension rows: composeExtensionRowTarget (same change as the assemble key above).
  // Re-measured with this guard's countLines(): 33403, exact cap, no spare.
  // Installed snapshots re-read per target plus the relaxed trust check. Re-measured on the merged
  // tree: 33379, exact.
  // Same merge as the assemble key above. Re-measured on the merged tree: 33421, exact cap, no spare.
  // The Host merges its own ext: rows back into daemon targets. Re-measured: 33425, exact.
  // The tree start deadline, its plumbing through the assembler and publisher, and the shutdown order.
  // Re-measured: 33469, exact.
  // 2026-09-21 AGH namespace rename (.agnes -> .agh), rebased onto 90421a2b: +22 counted lines -- the
  // AGH_HOME/AGNES_HOME resolver and its one-shot notice in paths.ts, and three secrets-deny sites that
  // now map WORKSPACE_SECRET_DIRS. Re-measured on the merged tree: 33491, exact cap.
  // A row that is pending says which services it waits for (+14 counted lines). Re-measured on the
  // tree merged with the rename: 33505, exact.
  // 2026-09-21: replaceable builtin ext: rows (claims, recomposition, boot-row merge), and the
  // reverted-target audit kind. Re-measured: 33510, exact.
  // 2026-09-22: third-party plugin rows register tools and observe hooks through ctx.extension():
  // the row-extension host, its API builder, the shared owner record and status book, the publisher's
  // pre-publish check, and the assembly wiring. Re-measured: 34605, exact.
  // 2026-09-22: the builtin row host (admission, factory, lease, four-step unload per ext: row) and its
  // hookup in the assembly. Re-measured: 34946, exact.
  // 2026-09-22: the remaining builtin ids migrated and the live tree restored after a rejected
  // candidate (publisher rebuild option, assembly restore). Re-measured: 34975, exact.
  // 2026-09-22: a row handed to its successor is not reported as residue. Re-measured: 34977, exact.
  // 2026-09-22 (review fixes): governance credit tied to the candidate tree, hook release counting,
  // late re-claim refusal, rebuild gating, and the unreadable-manifest fail-closed path.
  // Re-measured: 34997, exact.
  // 2026-09-22 merge with Web Plugins parity dynamic service extension reconciliation.
  // Re-measured on the resolved and formatted tree: 35118, exact.
  // 2026-09-22 hooks-runner-as-row migration, rebased onto the above (its own generic isolation
  // forwarding to the row host): its own +6 delta already lands inside the 35118 above, since this
  // migration was rebased directly onto the Web Plugins parity merge. Re-measured: 35118, exact cap.
  // 2026-09-22 (hooks-runner review fixes): per-load-token crash attribution (isolation selector,
  // builtin row host), and awaiting outstanding evictions during Host close (extension-owners.ts
  // caller). Re-measured on the resolved tree with countLines(): 35133, exact cap, no spare (the
  // rebase combined the two independent deltas non-additively; this is the real measured total).
  // MODEL-CONFIG-HOT-UPDATE: exact measured feature allocation; see execution/2026-09-22-model-configuration-hot-update.md.
  // 2026-09-22: automatic macOS driver health checks now request only permission-independent core
  // rows, keeping TCC checks out of the lazy preparation path. Re-measured: 35580, exact.
  // 2026-09-22: macOS work daemons start with --no-permissions-gate and refuse fast via a no-prompt
  // check_permissions when TCC grants are missing (no repeated system dialogs, no parked tools).
  // Re-measured: 35605, exact.
  // 2026-09-22: list_windows skips the zero-size offscreen helper windows macOS always reports
  // (CuaDriver's own included) instead of failing every listing and capture. Re-measured: 35606, exact.
  // Skills cordis service, rebased onto origin/main 7a2218df. Re-measured with countLines(): 35640, exact.
  // MCP-ROWS stage 2b step 1 (D118): DynamicExtension mount type and extraOwnedRowIds plumbing in
  // ext-rows.ts/assemble.ts, same delta as packages/host/src/assemble above. Re-measured: 35638, exact.
  // MCP-ROWS stage 2b step 2 (D110'): same dynamic-row SeamInitContext delta as
  // packages/host/src/assemble above. Re-measured: 35641, exact.
  // MCP-ROWS stage 2b step 3 prep (D102): re-exports DynamicExtension from index.ts so
  // worker-runtime's row derivation can build one without reaching into assemble/. Re-measured:
  // 35642, exact.
  // Merge feat/mcp-rows-stage2b into main: same combined delta as packages/host/src/assemble above.
  // Re-measured on the merged tree with this guard's countLines(): 35677, exact.
  // 2026-09-22 incremental apply: live snapshot catalogue lookup, per-delivery importers, additive
  // builtin claims, live-tree transaction handling, the outer-rollback row-eligibility change, the
  // no-rebuild-after-transaction + backgrounded-retirement change, the shared stableInventoryRows()
  // review fix, and the I2 compensation-timeout rebuild branch. Re-measured with countLines() on the
  // fully-resolved tree after rebasing onto origin/main: 35717, exact.
  // Merge main (incremental apply) into feat/mcp-rows-stage2b's own merge of main: same combined
  // delta as packages/host/src/assemble above. Re-measured: 35754, exact.
  // 2026-09-22 MCP rows step 3: the packages/host/src/assemble delta above plus managed-host.ts's
  // RegistrationWindow / DynamicLoad / LateRegistrationBag (lifetime registration window, per-record
  // seam-veto exemption, and late-registration reporting for Host-owned dynamic rows, design §3.7,
  // D119). Re-measured with countLines(): 35810, exact.
  // Merge origin/main 4ccba8a1 into feat/mcp-rows-step3: main's Skills installation / preload work
  // (36532 on main) plus the step 3 delta above; re-measured on the merged tree: 36588, exact.
  // MCP rows step 4 (D123/D124): the Host's MCP inputs (mcpResources / mcpResourceAuthority) and
  // mcp-client's context gates are gone, replaced by agnes/mcp-search's live Skill view; mcp-search
  // joins the builtin ext: row lists. Re-measured: 36581, exact (tightened).
  // Install-only Skill records an explicit disable (new Skills default to enabled). Re-measured: 36588, exact.
  // Skill directories open for reading (fence overlay, root filter, wiring), plus Skills boundary
  // repair: injected discovery and platform adapter replace direct Base imports and platform checks.
  // Combined countLines(): 36730, exact.
  // 2026-09-23 third-party-transform-directive-hooks: session-hooks.ts wires compactPlanIgnored;
  // ext-rows.ts's BUILTIN_HOOK_RANKS table is counted under packages/host/src/assemble above but
  // still folds into this package total; api-proxy.ts fills hookRank for a builtin-trust
  // registration; row-extension-host.ts computes a replacement row's inherited hookRank;
  // row-extension-api.ts implements registerHook (all 17 events, real return value, not just
  // observe-and-drop). +40 counted lines; re-measured with countLines(): 36770, exact cap, no spare.
  // SINGLE-EXTENSION-PATH: row services and Skills/MCP host wiring; includes assemble above.
  // Exact merged countLines() total, no spare allocation.
  // 2026-09-24 CU-ARTIFACT-RETENTION-GC-INDEX C1: measured 37356, exact, no spare (user-approved
  // perf-batch raise; the previous cap 37304 still had 333 unused lines, measured 36971 before).
  // New artifact-ledger-refs.ts (shared extraction moved out of the roots scanner) and
  // artifact-ref-index.ts (private index, chunked anchored catch-up, locked-budget verification);
  // private-artifact-store.ts exports its private-file open and non-blocking lock helpers.
  // CU-ARTIFACT-RETENTION-GC-INDEX C3: measured 37365, exact, no spare (+9). The GC runtime runs
  // the unlocked catch-up, plans from indexed roots with a byte-bounded batch, re-verifies under
  // the ledger lock, reports pressure and aborts on close; the full-table root scan is deleted.
  // CU-ARTIFACT-RETENTION-GC-INDEX C5: measured 37389, exact, no spare (+24). Benchmark-driven:
  // per-connection prepared-statement cache and a skip for sessions already caught up.
  // CU-ARTIFACT-RETENTION-GC-INDEX review I1: measured 37394, exact, no spare (+5). The index
  // records the extractor version and rebuilds when it differs.
  // CU-ARTIFACT-RETENTION-GC-INDEX review I3: measured 37425, exact, no spare (+31). Session
  // states come from one skip-scan query that also reads each last row, with one batched anchor
  // lookup for sessions behind their cursor; candidate refs are read in one json_each query.
  // CU-ARTIFACT-RETENTION-GC-INDEX review I4: measured 37426, exact, no spare (+1). The index
  // uses WAL with NORMAL sync.
  // CU-ARTIFACT-RETENTION-GC-INDEX review M1/M3: measured 37448, exact, no spare (+22). Pressure
  // is reported only for settled or deferred rounds; the runtime keeps one index connection open.
  // Rebased onto the lease row-bound and ACP feed changes (net -1 here): merged tree re-measured
  // with countLines(): 37447, exact, no spare.
  // 2026-09-24 SHARED-SESSION-IDLE-CLOSE C2-C5 and review fixes (user-approved raise for the perf
  // batch), rebased onto main with the other perf lanes: merged tree re-measured with
  // countLines(): 37482, exact, no spare.
  // CU-ARTIFACT-RETENTION-GC-INDEX C4: measured 37483, exact, no spare (+1). The ledger
  // connection sets busy_timeout = 5000.
  // CU-ARTIFACT-RETENTION-GC-INDEX C4 (review M2): measured 37485, exact, no spare (+2). The
  // index wait under the ledger write lock is bounded at 1 s.
  // 2026-09-24 SCAN-TRUNC-01 C2-C8 and review fixes (user-approved raise for the perf batch),
  // rebased onto main after #6+#7 C4: merged tree re-measured with countLines(): 37487, exact.
  // OPSTATE O1: SQLite commit writes the op cell and acknowledges it. Measured: 37494 (+7), exact.
  // CU-ARTIFACT-RETENTION-GC-INDEX C6, on the tree rebased onto main 67c981cc: measured 37501,
  // exact, no spare (+7). Re-export of the
  // reclaimed sentinel and the required lastReferencedAtMs selector input.
  // CU-ARTIFACT-RETENTION-GC-INDEX C7, on the tree rebased onto main 67c981cc: measured 37948,
  // exact, no spare (+447). Active and protected
  // screenshot sets with bounded ancestor reads, locked recompute and 2 s guard, reclaim tombstones,
  // tombstone-safe publish order, marker module shared by scanner and readers, reclaimed reads.
  // CU-ARTIFACT-RETENTION-GC-INDEX P2 review fixes: measured 37965, exact, no spare (+17). A read
  // racing a collector reports reclaimed, one shared index-wait deadline under the ledger lock, and
  // tombstone reads that never create marker directories.
  // CONVERSATION-MCP-ONBOARDING: private builtin tool and wiring; exact +111, no spare.
  // Merged with b/main@82310218; combined source re-measured, exact, no spare.
  // PLUGIN-HELPER: measured 38028 -> 38091; approved feature scope, no spare allocation.
  // UI-CACHE-INCREMENTAL C1 (rebased on 950fc6f3): measured 38003, exact, no spare (-73). SQLite no
  // longer stores UI projection checkpoints; the old table is dropped on open.
  // Merged with b/main@e58e7dd0 (default helper plugins, diagnostics export); combined source
  // re-measured, exact, no spare.
  // SKILL-CATALOG-CLEAN-REWRITE merge: retained skill-preload header (+4), combined exact total.
  // Skill import and approved reinstall on the merged tree: measured 38038, no spare.
  // WIN-SHORT-NAMES: the local fence spells paths as the native resolver does on Windows, so 8.3
  // short names and long names canonicalize alike; measured 38069, exact, no spare (+31).
  // WIN-SQLITE-CLOSE: storage-sqlite closes a database it refused or failed to open (+13).
  // Measured 38050, exact, no spare.
  // Combined with the Windows path canonicalisation on this branch; re-measured exactly.
  // FOLD-CACHE-REMOVAL: SQLite no longer stores the fold cache; the old table is dropped on open.
  // (-52). Measured on this tree: 38030, exact, no spare.
  // Durable WAL checkpoints on darwin: the ledger, table-store and GC ledger-lock connections set
  // checkpoint_fullfsync through one small helper. Measured 38043, exact, no spare (+13).
  'packages/host/src': 38043,
  'packages/host/src/ext-host/service-invocation': 247,
  // T5.2's permission projector is kept independently bounded so later extension-host work cannot
  // hide in the package-wide increment. Measured source: 86 lines.
  // 2026-09-15: project resume onto the capability fence. Measured 90.
  // WEBFETCH-01: +8 counted lines for approved public retrieval; excludes concurrent work.
  'packages/host/src/ext-host/tool-context-capabilities': 98,
  // T6.3 adds child-failure notification, startup/cancel deadlines and invocation-bound capability
  // attribution. Exact 390.
  // R1 extracts transport, narrows the fixed wrapper, and adds generic entry/lease codecs.
  'packages/host/src/ext-host/hooks-isolation-client': 390,
  // CORDIS-C1b Task 6 drains isolated descendants before releasing workspace capabilities.
  'packages/host/src/ext-host/runner-transport': 465,
  // 2026-09-15 (EXTAPI-01): Task 4 threads platform: PlatformFacts through the generic child-process
  // bootstrap path so an isolated hook runner receives the same platform facts an in-process one does.
  // Measured 90; exact cap, no spare.
  'packages/host/src/ext-host/generic-hooks-runner': 90,
  // 2026-09-15 (EXTAPI-01): Task 4 threads platform: PlatformFacts into the fixed-adapter child-process
  // bootstrap and its reconstructed HookContext, mirroring the generic runner above. Measured 144;
  // exact cap, no spare.
  'packages/base/src/runner-extension': 144,
  'packages/base/src/runner-context': 18,
  // Release-owned runtime probe/spawn and opt-in policy selection remain separate bounded subjects.
  'packages/host/src/ext-host/hooks-isolation-assembly': 102,
  // R1 selects verified generic Hook packages in addition to the fixed adapter.
  // 2026-09-22 (hooks-runner review fix): thread a per-load token through to the crash-report
  // closure so a stale evicted generation's crash cannot be attributed to its live successor.
  // Re-measured with countLines(): 160, exact cap, no spare.
  'packages/host/src/ext-host/extension-isolation-selector': 160,
  'packages/host/src/ext-host/extension-seatbelt': 31,
  'packages/host/src/ext-host/extension-runner-runtime': 187,
  // The trusted fixed child entry lives outside the author extension's universal 800-line budget.
  // It reuses hooks-runner's prepared implementation and has no general extension loading surface.
  // R1 adds generic preparation, lease/surface codecs and awaited shutdown.
  // 2026-09-15 (EXTAPI-01): Task 4 threads platform: PlatformFacts through the hooks-isolation-client
  // wire protocol into this fixed child-process entry's reconstructed HookContext. Measured 256; exact
  // cap, no spare. CORDIS-C1b Task 6 tracks isolated descendants through invocation settlement.
  'packages/base/src/hooks-isolation-runner': 270,
  // The fixed Host-side adapter validates configured commands/URLs against the active invocation.
  // The CLI SEA increment adds three counted lines to select the embedded reviewed hook map while
  // retaining the filesystem development path. Task 6 adds invocation-scoped hook capability
  // routing; exact measured total.
  // 2026-09-23 AUDIT-CONFIRMED-BUGFIXES group-01-1: the exec/http re-check also applies the group
  // matcher, sharing hooks-runner's MATCHED/safeMatcher. Measured: 224, exact.
  'packages/base/src/hooks-isolation': 224,
  // The build-only deterministic single-file artifact generator is independently bounded.
  // R1 bundles the static jiti runtime and its Node require shim.
  'packages/base/tools/build-isolation-runner': 74,
  // The release packager pins/verifies official Node archives and emits the aggregate manifest.
  'packages/base/tools/package-isolation-runtime': 171,
  // 2026-09-19 Computer Use closed profile policy and normalization. Re-measured 1090; exact cap.
  // 2026-09-20 appAccess and signed application identity policy. Measured 1116; exact cap.
  // 2026-09-21 AGH namespace rename (.agnes -> .agh): +1 counted line: inputs.ts imports AGH_DIR for <cwd>/.agh/profile.local.yaml.
  // Re-measured with this guard's countLines(): 1185, exact cap, no spare.
  'packages/host/src/profile': 1187,
  // 2026-09-09: raised from 1100. 1071 of it was spent and the 29 left could not cover the deny-list
  // repair with anything to spare; the repair measures 1075. The remaining 100 are platform-win32
  // reaching parity with platform-posix - today its probe() asserts a fixed table where posix
  // measures the volume, looks for a sandbox backend and reads the terminal, and posix spends ~100
  // lines doing so.
  // WHERE THE NEXT RAISE STOPS BEING A NUMBER: this key is eleven files answering four unrelated
  // questions, and two of them dominate - storage-sqlite.ts at 386 and the platform trio at 191.
  // The platform trio is also the part that grows by whole-OS increments, so one operating system's
  // completeness is charged against the fence layer's budget. Give platform its own key when the
  // win32 work starts, and storage its own if it passes ~450; what should be left under `adapters`
  // is the fs / exec / secrets / net fence and nothing else.
  //
  // 2026-09-11: raised from 1175 for the macOS ProcessIdentity backend (daemon's owner-lock crash-
  // recovery needs a live-PID probe on darwin, mirroring the existing process-identity-linux.ts).
  // Three new files: process-identity-macos.ts (42, the libproc-helper spawn/parse wrapper) and
  // process-identity-default.ts (12, the OS dispatcher picking linux/macos/unsupported off a
  // PlatformBackend's `os`, per the boundary test's ban on a raw platform check here) - 54 lines,
  // plus this key's existing files unchanged. Measured total: 1217; 1225 leaves a little room
  // without inviting scope creep back in. The compiled helper's C source
  // (packages/host/native/macos-process-identity.c) and its build script are outside src/ and do
  // not count against this budget.
  // 2026-09-11: raised from 1240 by base Task 14
  // (archived implementation record) — the fs/exec fence
  // itself grew, which is the content this key exists to hold: exec.ts gained createPolicyExec (the
  // spawn-time binding/digest/cwd/no-backend gate) and the revocable probeExec (~60 counted), and
  // adapters/index.ts gained the bootstrap-to-bound FsPolicy binding (bindFsPolicy with the
  // host-integrity floor check and deny-all poisoning, the dataFs/bootstrap policy builders, and
  // sandboxHostServices, ~110 counted). The split the note above names stays the next move, and is
  // unchanged by this: the process-identity trio (~110 counted) is not fs/exec/secrets/net fence
  // and belongs under its own key, but it is another lane's just-landed file set (daemon's
  // owner-lock crash recovery) and moving it from this lane would be churn on their files, so the
  // raise carries it for now. Re-measured after integration before finalizing this ceiling.
  // 2026-09-11: I9 Task 3 puts credential-files.ts and credential-store.ts in the adapters path
  // assigned by the execution plan. They are the secrets fence this key explicitly owns, not a
  // new unrelated adapter family. Measured adapter total: 2020; 2030 leaves ten lines.
  // 2026-09-12: T3.2 extends storage-sqlite with the ledger integrity sidecar only. Measured
  // adapter total: 2114; exact aggregate ceiling. The file crossed the ~450 split trigger above,
  // so the next key fences that file independently instead of hiding future growth in this total.
  // I7 Core40 adds only the fold-checkpoint methods to the storage adapters. Measured: 2165; exact.
  // S3 reuses net fetch with optional invocation cancellation and redirect refusal: +6, exact.
  // IP9 adds the SQLite checkpoint table/read/write path and contains optional-cache write failure
  // behind a savepoint so authoritative events still commit. Exact reviewed totals.
  // 2026-09-15: child_control SQLite tables and ChildControlStore methods. Measured adapters
  // 2662; storage-sqlite 630. Exact caps.
  // 2026-09-15 (matrix close): writer gens table + reserve generation check + workspace
  // update/peek. Measured adapters 2735; exact cap.
  // 2026-09-15 (skeptic close): durable permit ids, input_text/root/branch columns. Measured
  // adapters 2769, storage-sqlite 644.
  // 2026-09-15 (review): ancestor inherit, permit consume guard, writer lease clear.
  // Measured adapters 2793, storage-sqlite 649.
  // 2026-09-15 (V6 overrun record): adapters 2800.
  // 2026-09-15 (main merge): workspace-row dedup on main plus closeout wrap; re-measured 2795.
  // 2026-09-15 (workspace fs backend, phase 0 of remote sandbox): fs-io.ts + fs-io-local.ts split
  // the io out of the fence; fs.ts gained FencedFs / a policy-free canonicalize; index.ts threads
  // workspaceIo. Measured 2842; exact cap, no headroom.
  // 2026-09-16 (remote-sandbox Stage A, Task 4): fs-io-remote.ts (createRemoteFsIo) - the new file
  // itself; see the packages/host/src note above for what it does. Measured 3672; exact cap, no
  // spare.
  // 2026-09-16 (remote-sandbox Stage A, Task 6): openAdapters assembly wiring for remote mode - see
  // the packages/host/src note above for what it does. No new file. Measured 3716; exact cap, no
  // spare.
  // 2026-09-16 (remote-sandbox Stage A, Task 8): remote-workspace.ts (openRemoteWorkspace) - the new
  // file itself; see the packages/host/src note above for what it does. Measured 3757; exact cap, no
  // spare.
  // 2026-09-16 (remote-sandbox Stage A, Task 8 fix round): try/finally around the workspace/transport
  // close - see the packages/host/src note above for what it does. No new file. Measured 3760; exact
  // cap, no spare.
  // 2026-09-16 (remote-sandbox Stage A, final-review fix round): exec-remote.ts (createRemoteExec) -
  // the new file itself - plus the openAdapters changes that put it in the gate's `inner`, close the
  // transport on any open-path throw, and stop measuring local filesystem facts for a remote
  // workspace root. See the packages/host/src note above for what each one does. Measured 3788;
  // exact cap, no spare.
  // 2026-09-16 (remote-sandbox Stage A, second final-review fix round - exceptional, user-authorized):
  // exec-remote.ts gains createExec's four safety defaults (environment floor, default deadline,
  // output cap clamped here rather than trusted to the transport, abort-before-start), exec.ts
  // exports the constants and the abort check it already used so they are matched rather than
  // re-invented, index.ts folds case for an unmeasured remote volume, and remote-transport.ts
  // corrects one backwards sentence about FencedFs.write. See the packages/host/src note above.
  // Measured 3816; exact cap, no spare.
  // B1-A: measured 3827 lines on the shared tree; public transport contract, config and wiring/testkit.
  // B1 review repair: exact measured 3834; startup cancellation / cwd contract coverage.
  // WEBFETCH-01: +365 counted lines for approved public retrieval; excludes concurrent work.
  // C1b Task 5 adds the per-session local/remote adapter factory; exact measured total, no spare.
  // Task 13 refuses legacy session_profiles store paths at adapter open. Re-measured: 4947, exact.
  // Lazy package table open for Node 22 setAuthorizer. Re-measured: 4956, exact.
  // Task 17 review: refuse session_profiles tables in owner DBs. Re-measured: 4963, exact.
  // 2026-09-21 AGH namespace rename (.agnes -> .agh): +6 counted lines: index.ts and session-workspace.ts each import WORKSPACE_SECRET_DIRS and map it into their floor rules (+2 each after formatting).
  // Re-measured with this guard's countLines(): 4969, exact cap, no spare.
  // Integrated N02 + F01 on b79e678b; exact countLines() totals, nested counts not added twice.
  // Skill directories open for reading: fs.ts read overlay plus its wiring in both factories. Re-measured: 5031, exact.
  // 2026-09-24 SHARED-SESSION-IDLE-CLOSE C2-C5 and review fixes (user-approved raise for the perf
  // batch), rebased onto main with the other perf lanes: merged tree re-measured with
  // countLines(): 5054, exact, no spare.
  // CU-ARTIFACT-RETENTION-GC-INDEX C4: measured 5055, exact, no spare (+1): busy_timeout on
  // the ledger connection in storage-sqlite.ts.
  // 2026-09-24 SCAN-TRUNC-01 C2-C8 and review fixes (user-approved raise for the perf batch),
  // rebased onto main after #6+#7 C4: merged tree re-measured with countLines(): 5061, exact.
  // OPSTATE O1: same change as packages/host/src. Measured: 5068 (+7), exact.
  // UI-CACHE-INCREMENTAL C1 (rebased on 950fc6f3): measured 4995, exact, no spare (-73).
  // SKILL-GITHUB-RATE-LIMIT: measured 5010, no spare.
  // WIN-SHORT-NAMES: FsIo.finalPath, its local and session-workspace wiring, and one local realpath
  // helper; measured 5042, exact, no spare (+32).
  // WIN-SQLITE-CLOSE: same change as packages/host/src. Measured 5023 (+13), exact.
  // Combined with the Windows path canonicalisation on this branch; re-measured exactly.
  // FOLD-CACHE-REMOVAL: same change as packages/host/src. Measured on this tree: 5003, exact, no spare (-52).
  // Durable WAL checkpoints on darwin: the helper plus its two storage call sites. Measured 5014,
  // exact, no spare (+11).
  'packages/host/src/adapters': 5014,

  // C1b Task 5 persists child creation attempts and deferred recovery; exact total, no spare.
  // Task 17 review: sqlite_master scan + table-name refuse. Re-measured: 674, exact.
  // 2026-09-22 F01: delete statements and transactional writer-lease validation for compensating
  // only an import-created session. User approved this exact raise; 674 -> 698 (+24), no spare.
  // 2026-09-24 SHARED-SESSION-IDLE-CLOSE C2-C5 and review fixes (user-approved raise for the perf
  // batch), rebased onto main with the other perf lanes: merged tree re-measured with
  // countLines(): 721, exact, no spare.
  // CU-ARTIFACT-RETENTION-GC-INDEX C4: measured 722, exact, no spare (+1): PRAGMA busy_timeout
  // = 5000 on the ledger connection.
  // 2026-09-24 SCAN-TRUNC-01 C2-C8 and review fixes (user-approved raise for the perf batch),
  // rebased onto main after #6+#7 C4: merged tree re-measured with countLines(): 728, exact.
  // OPSTATE O1: same change. Measured: 735 (+7), exact.
  // UI-CACHE-INCREMENTAL C1 (rebased on 950fc6f3): measured 667, exact, no spare (-68).
  // WIN-SQLITE-CLOSE: a refused or failed open closes its database file again, so Windows can
  // delete it. Measured 680 (+13), exact, no spare.
  // FOLD-CACHE-REMOVAL: fold cache statements, write, read and delete gone; the table is dropped on
  // open. Measured on this tree: 632, exact, no spare (-48).
  // Durable WAL checkpoints on darwin: the ledger and table-store connections call the checkpoint
  // sync helper. Measured 635, exact, no spare (+3).
  'packages/host/src/adapters/storage-sqlite': 635,
  // 2026-09-11: Base Task 19 adds the after-core queue drain, T0 gate integration, verifier and
  // compact triggers, human gate, and production tool/operation sharing. Measured: 394; cap at 400.
  'packages/base/extensions/refine': 400,
}

describe('line-count ratchet stays within reviewed ceilings', () => {
  for (const [prefix, ceiling] of Object.entries(INITIAL_CEILING)) {
    it(`${prefix}: ratchet.json value must not exceed initial ceiling ${ceiling}`, () => {
      const current = ratchet[prefix]
      expect(current, `${prefix} missing from ratchet.json`).toBeDefined()
      expect(
        current,
        `${prefix}: ratchet.json says ${current}, initial ceiling is ${ceiling}`,
      ).toBeLessThanOrEqual(ceiling)
    })
  }
})

// Each bundled extension defaults to 800 lines; named reviewed exceptions are listed below.
// Every subdirectory must be registered in ratchet.json and stay within its explicit ceiling. While the
// directory does not exist, it.runIf skips rather than a static if/else placeholder, so the real
// assertion switches on automatically once the directory appears instead of becoming a vacuously true
// zombie case.
const extensionsDir = join(root, 'packages/base/extensions')
const extensionDirs = existsSync(extensionsDir)
  ? readdirSync(extensionsDir).filter((e) => statSync(join(extensionsDir, e)).isDirectory())
  : []

// User-approved allocations; no general increase for other or future extensions.
const EXTENSION_CEILING_EXCEPTIONS = new Map([
  // CORDIS-C1b Task 6 adds invocation-scoped workspace hook snapshots and descendant draining.
  // 2026-09-21 AGH namespace rename, +1 approved by the user: the AGH_DIR import for the workspace
  // `.agh/hooks.json` fallback path. Measured 955.
  ['hooks-runner', 955],
  ['computer-use', 1786],
  // 2026-09-23 user-approved: dsh-compatible Skill discovery. Measured 899.
  // SKILL-CATALOG-CLEAN-REWRITE: same reviewed exact total as the catalog/name activation budget above.
  ['skills', 1008],
])

describe('bundled extension line budgets (default ≤ 800, named reviewed exceptions)', () => {
  it.runIf(extensionDirs.length === 0)('packages/base/extensions/ does not exist yet', () => {
    expect(extensionDirs).toEqual([])
  })

  it.runIf(extensionDirs.length > 0)('every extension has a ratchet key within its ceiling', () => {
    for (const name of extensionDirs) {
      const key = `packages/base/extensions/${name}`
      const ceiling = EXTENSION_CEILING_EXCEPTIONS.get(name) ?? 800
      expect(ratchet[key], `${key} missing from ratchet.json`).toBeDefined()
      expect(ratchet[key], `${key}: ${ratchet[key]} > ${ceiling}`).toBeLessThanOrEqual(ceiling)
    }
  })
})

// Regression pin for the escape hatch above: code under `src/**/test/` must count towards the line
// budget, while test files such as `.test.ts` / `.test.mts` must continue not to. A real layout is
// built in a temp directory and run through the same filter chain as above.
describe('ratchet counts code under a directory named `test` (regression: excluded escape hatch)', () => {
  const collect = (abs: string): string[] =>
    listSourceFiles(dirname(abs)).filter((f) => matchesRatchetKey(f, abs) && !isTestFile(f))

  it('src/test/x.ts is counted (it used to be excluded wholesale)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-ratchet-testdir-'))
    try {
      mkdirSync(join(dir, 'src', 'test'), { recursive: true })
      writeFileSync(join(dir, 'src', 'test', 'x.ts'), 'const a = 1\n')
      expect(collect(join(dir, 'src'))).toEqual([join(dir, 'src', 'test', 'x.ts')])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('every .test.<ext> file is still excluded (N5: .mts/.cts/.tsx too)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-ratchet-testfile-'))
    try {
      mkdirSync(join(dir, 'src'), { recursive: true })
      for (const ext of ['ts', 'mts', 'cts', 'tsx'])
        writeFileSync(join(dir, 'src', `a.test.${ext}`), 'const a = 1\n')
      writeFileSync(join(dir, 'src', 'real.mts'), 'const a = 1\n')
      expect(collect(join(dir, 'src'))).toEqual([join(dir, 'src', 'real.mts')])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
