// Line-count ratchet. Each key is a source scope; ratchet.json holds its current budget and
// INITIAL_CEILING holds the reviewed ceiling. Rules:
// - budgets are exact countLines measurements, with no exclusions and no spare allocation;
// - a budget may never exceed its ceiling; raising a ceiling needs a reviewed reason in the commit;
// - both tables declare the same keys; retired scopes are removed from both.
// Allocation history lives in Git history and commit messages, not in this file.
import {
  appendFileSync,
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
import { isTestFile, listSourceFiles, repoRoot, SOURCE_EXTENSIONS } from './repo.js'

const root = repoRoot()
const ratchet = JSON.parse(readFileSync(join(root, 'tools/guards/ratchet.json'), 'utf8')) as Record<
  string,
  number
>

describe('line-count ratchet', () => {
  it('registers both Cordis foundation packages', () => {
    expect(Object.hasOwn(ratchet, 'packages/cordis-loader/src')).toBe(true)
    expect(Object.hasOwn(ratchet, 'packages/plugin-runtime/src')).toBe(true)
    expect(Object.keys(ratchet).sort()).toEqual(Object.keys(INITIAL_CEILING).sort())
  })
  for (const [prefix, max] of Object.entries(ratchet)) {
    it(`${prefix} ≤ ${max} lines`, () => {
      const abs = join(root, prefix)
      // The scan root is unconditionally the parent directory; no either/or decision is made about
      // whether abs itself is a file or a directory. listSourceFiles recurses, so this naturally covers
      // both `${abs}.ts` (the file form) and `${abs}/**` (the directory form), and keeps both in scope
      // even when a file and a directory of the same name coexist. Precision comes from
      // matchesRatchetKey's boundary filter, not from narrowing the scan root. When the parent does not
      // exist, listSourceFiles returns an empty array; such a key must be removed or migrated.
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
      expect(files.length, `${prefix}: stale ratchet key has no source files`).toBeGreaterThan(0)
      const total = files.reduce((n, f) => n + countLines(readFileSync(f, 'utf8')), 0)
      if (total > max && process.env.GITHUB_STEP_SUMMARY)
        appendFileSync(
          process.env.GITHUB_STEP_SUMMARY,
          `- Ratchet exceeded: ${prefix}: ${total} > ${max} (+${total - max})\n`,
        )
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
  it.each(SOURCE_EXTENSIONS)('file form: counts assemble%s, excludes sibling prefix', (ext) => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-ratchet-file-'))
    try {
      writeFileSync(join(dir, `assemble${ext}`), 'const a = 1\n')
      writeFileSync(join(dir, `assemble-legacy${ext}`), 'const b = 1\nconst c = 2\nconst d = 3\n')
      const abs = join(dir, 'assemble')
      const files = listSourceFiles(dirname(abs)).filter((f) => matchesRatchetKey(f, abs))
      expect(files).toEqual([join(dir, `assemble${ext}`)])
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

const INITIAL_CEILING: Record<string, number> = {
  'packages/base/extensions/references': 21,
  'packages/base/extensions/intelligent-ui': 1351,
  'packages/intelligent-ui-contract/src': 238,
  'packages/git-worktree-contract/src': 34,
  'packages/base/src/intelligent-ui-runtime': 55,
  'packages/observability/src': 1363,
  'packages/base/src/memory': 14,
  'packages/memory-file/src': 517,
  'packages/web-conversation/src/presentation': 138,
  'packages/web-conversation/src/markdown': 48,
  'packages/web-conversation/src/turns': 301,
  'packages/web-conversation/src/trace-panel': 11,
  'packages/web-conversation/src': 4068,
  'packages/web-admin/src/settings': 9376,
  'packages/web-admin/src/permission-picker': 267,
  'packages/web-admin/src/admin/plugins/types': 82,
  'packages/web-admin/src/admin/plugins/api': 548,
  'packages/web-admin/src': 16486,
  'packages/web-foundation/src': 2462,
  'packages/daemon-rpc/src/local/methods/extensions': 199,
  'packages/daemon-rpc/src/local/auth': 341,
  'packages/daemon-rpc/src': 8384,
  'packages/daemon/src/supervisor/startup': 18,
  'packages/daemon/src/supervisor/discovery': 446,
  'packages/daemon/src/supervisor/scope': 254,
  'packages/daemon/src/supervisor/configuration': 45,
  'packages/daemon/src/supervisor/service-worker': 103,
  'packages/daemon/src/supervisor': 11329,
  'packages/daemon-admin/src/packages/project': 43,
  'packages/daemon-admin/src/packages/permissions': 99,
  'packages/daemon-admin/src/packages/operations': 416,
  'packages/daemon-admin/src/packages/index': 49,
  'packages/daemon-admin/src/packages/handler': 1960,
  'packages/daemon-admin/src/packages/admin-surface': 990,
  'packages/daemon-admin/src': 6750,
  'packages/daemon-surfaces/src/surfaces': 1961,
  'packages/daemon-surfaces/src': 1962,
  'packages/daemon-foundation/src/jobs': 653,
  'packages/daemon-foundation/src': 4443,
  'packages/host/src/runtime/approval/expiry': 120,
  'packages/host/src/runtime/adapters': 465,
  'packages/host/src/runtime/profile': 1686,
  'packages/host/src/runtime': 13044,
  'packages/host/src/runtime/assemble': 3648,
  'packages/host-providers/src/adapters': 477,
  'packages/host-providers/src/profile': 165,
  'packages/host-providers/src': 5145,
  'packages/host-providers/src/assemble': 2385,
  'packages/host-extensions/src/ext-host/extension-runner-runtime': 187,
  'packages/host-extensions/src/ext-host/extension-seatbelt': 28,
  'packages/host-extensions/src/ext-host/extension-isolation-selector': 160,
  'packages/host-extensions/src/ext-host/hooks-isolation-assembly': 100,
  'packages/host-extensions/src/ext-host/generic-hooks-runner': 90,
  'packages/host-extensions/src/ext-host/runner-transport': 465,
  'packages/host-extensions/src/ext-host/hooks-isolation-client': 232,
  'packages/host-extensions/src/ext-host/tool-context-capabilities': 131,
  'packages/host-extensions/src/ext-host/service-invocation': 267,
  'packages/host-extensions/src': 8133,
  'packages/host-extensions/src/assemble': 1285,
  'packages/host-artifacts/src': 2243,
  'packages/host-computer-use/src': 10586,
  'packages/host-infrastructure/src/adapters/public-fetch': 380,
  'packages/host-infrastructure/src/adapters/secrets-win32': 20,
  'packages/host-infrastructure/src/adapters/exec-output': 32,
  'packages/host-infrastructure/src/adapters/exec-win32': 86,
  'packages/host-infrastructure/src/adapters/process-identity-win32': 18,
  'packages/host-infrastructure/src/adapters/powershell-temporary': 43,
  'packages/host-infrastructure/src/adapters/powershell-file': 47,
  'packages/host-infrastructure/src/adapters/powershell-command': 31,
  'packages/host-infrastructure/src/adapters/powershell': 133,
  'packages/host-infrastructure/src/configuration': 1480,
  'packages/host-infrastructure/src/adapters/storage-sqlite': 658,
  'packages/host-infrastructure/src/adapters': 6471,
  'packages/host-infrastructure/src': 10946,
  'packages/host-common/src/configuration-lock': 39,
  'packages/host-common/src/profile': 1847,
  'packages/host-common/src': 4627,
  'packages/host-common/src/assemble': 1291,
  'packages/core/src/artifacts': 744,
  'packages/core-effects/src': 2850,
  'packages/core-ledger/src': 6755,
  'packages/core-child-control/src': 397,
  'packages/core-common/src': 531,
  'packages/cordis/src': 2117,
  'packages/cordis-loader/src': 784,
  'packages/plugin-runtime/src': 2675,
  'packages/cosmokit/src': 356,
  'packages/web-client/src': 2008,
  'packages/web-slots/src': 620,
  'packages/web-ui/src': 14836,
  'packages/web-units/src': 9920,
  'packages/base/extensions/tools-core': 1121,
  'packages/base/extensions/mcp-server': 446,
  'packages/base/extensions/mcp-search': 178,
  'packages/base/extensions/principals-local': 19,
  'packages/base/extensions/artifacts-local': 315,
  'packages/base/extensions/approval-policy': 467,
  'packages/base/extensions/tools-search': 284,
  'packages/base/extensions/tools-web': 1284,
  'packages/base/extensions/compaction': 386,
  'packages/base/extensions/fs-checkpoint': 390,
  'packages/base/extensions/sandbox': 871,
  'packages/base/extensions/budget': 133,
  'packages/base/extensions/loop-hygiene': 69,
  'packages/system-node/src': 1389,
  'packages/package-manager/src': 8579,
  'packages/package-manager/src/catalog': 219,

  'packages/web/src/app': 4239,
  'packages/web/src/model-picker': 1033,
  'packages/web/src/timeline': 840,
  'packages/web/src/navigation': 190,
  'packages/web/src/session-menu': 124,
  'packages/web/src/shell': 111,
  'packages/web/src/view': 116,
  'packages/web/src/session-binding': 31,

  'packages/cli/src': 7980,
  'packages/cli/src/commands/package': 230,
  'packages/cli/src/tui/package-admin': 1,
  'packages/cli/src/tui/package-controller': 1,
  'packages/cli/src/boot/backend': 550,
  'packages/cli/src/boot/default': 69,
  'packages/cli/src/commands/sessions': 77,
  'packages/cli/launch': 2202, // SKILL-INSTALL-CORE: preserve request-only port in packaged Host options.
  'packages/cli/launch/package-admin': 540,
  'packages/cli/tools/build-local': 381,
  'packages/web/src/serve': 1,

  'packages/core/src': 23781,
  'packages/ai/src': 4409,
  'packages/protocol/src': 4726,
  'packages/cli/src/tui': 38,
  'packages/cli-tui/src': 4957,
  'packages/extension-api/src': 3146, // SKILL-INSTALL-CORE: optional request port and bounded DTO, no admin grant.
  'packages/extension-api/testkit': 730,
  'packages/sdk/src': 6109,
  'packages/sdk/src/extensions.node': 21,
  'packages/sdk/src/package-admin.node': 217,
  'packages/sdk/src/surface.browser': 1,
  'packages/sdk/src/surface.node': 149,
  'packages/daemon/src': 11545,

  'packages/daemon/src/packages/handler': 1,
  'packages/daemon/src/packages/index': 1,
  'packages/daemon/src/packages/operations': 1,
  'packages/daemon/src/local/auth': 1,
  'packages/daemon/src/local/methods/extensions': 1,
  'packages/daemon/src/surfaces': 7,
  'packages/daemon/src/worker/service-authority': 1,

  'packages/web/src': 13976,

  'packages/bridges/src': 1728,
  'packages/channels/src': 5398,
  'packages/code/src': 1805,
  'packages/cli/src/args': 278,
  'packages/runtime-python/src': 7,
  'packages/base/extensions/subagent': 713,
  'packages/base/extensions/skills': 1209,
  'packages/base/extensions/hooks-runner': 1028,
  'packages/base/src/mcp': 1631,
  'packages/base/extensions/privacy': 369,
  'packages/host/src': 13582,
  'packages/base/src/runner-extension': 159,
  'packages/base/src/runner-context': 18,
  'packages/base/src/hooks-isolation-runner': 270,
  'packages/base/src/hooks-isolation': 224,
  'packages/base/tools/build-isolation-runner': 74,
  'packages/base/tools/package-isolation-runtime': 171,

  'packages/base/extensions/refine': 434,
  'packages/base/extensions/plugin-creator': 211,
  'packages/model-adapters/src': 829,
  'packages/base/extensions/subagent-acp': 387,
  'packages/base/extensions/deliverables': 156,
  'packages/base/extensions/interaction': 242,
  'packages/base/extensions/jobs': 1114,
  'packages/base/extensions/mcp-resources': 54,
  'packages/base/extensions/plan-mode': 282,
  'packages/base/extensions/context-rules': 298,
  'packages/base/extensions/goal': 364,
  'packages/base/extensions/jobs-web': 18,
  'packages/base/extensions/subagent-claude-code': 109,
  'packages/base/extensions/subagent-codex': 92,
  'packages/base/extensions/subagent-sdk': 486,
  'packages/base/extensions/time-context': 65,
  'packages/base/extensions/workflow': 364,
  'packages/history-index/src': 1156,
  'packages/base/extensions/session-query': 311,
  'packages/base/extensions/schedule': 803,
  'packages/loop-default/src': 92,
  'packages/base/extensions/computer-use': 1785,
  'packages/web-admin/src/admin/plugins/admin': 2515,
  'packages/web-ui/src/admin-confirmation': 442,
  'packages/web-ui/src/admin-text': 114,
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
  // IUI1: bounded declarative surfaces, action authorization and durable action states.
  ['intelligent-ui', INITIAL_CEILING['packages/base/extensions/intelligent-ui']!],
  // GT1: reviewed schedule implementation and validated tool wrapper; exact measured allocation.
  ['schedule', INITIAL_CEILING['packages/base/extensions/schedule']!],
  // Reviewed gap-fill implementation; exact countLines, no spare allocation.
  ['jobs', INITIAL_CEILING['packages/base/extensions/jobs']!],
  // Reviewed gap-fill implementation; exact countLines, no spare allocation.
  ['tools-web', INITIAL_CEILING['packages/base/extensions/tools-web']!],
  // Reviewed gap-fill implementation; exact countLines, no spare allocation.
  ['sandbox', INITIAL_CEILING['packages/base/extensions/sandbox']!],
  // CORDIS-C1b Task 6 adds invocation-scoped workspace hook snapshots and descendant draining.
  // 2026-09-21 AGH namespace rename, +1 approved by the user: the AGH_DIR import for the workspace
  // `.agh/hooks.json` fallback path. Context-first prompt denial and scoped memo; measured 1007.
  ['hooks-runner', INITIAL_CEILING['packages/base/extensions/hooks-runner']!],
  ['computer-use', INITIAL_CEILING['packages/base/extensions/computer-use']!],
  // 2026-09-23 user-approved: dsh-compatible Skill discovery. Measured 899.
  // SKILL-CATALOG-CLEAN-REWRITE: same reviewed exact total as the catalog/name activation budget above.
  // Skill description bounds and paged reads. Measured 1121, exact.
  // 2026-10-07 invocation flags and flat Markdown admission; countLines 1195, exact.
  ['skills', INITIAL_CEILING['packages/base/extensions/skills']!],
  // Write staleness guard, session images and bounded attachment text reads. Measured 922, exact.
  // 2026-10-07 integrated official job tools and output handling: exact countLines 959.
  ['tools-core', INITIAL_CEILING['packages/base/extensions/tools-core']!],
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
