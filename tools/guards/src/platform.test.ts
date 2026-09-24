import { readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isTestFile, LITERAL_SCAN_EXCLUDE_DIRS, listSourceFiles, repoRoot } from './repo.js'

const root = repoRoot()
const ALLOWED = /^packages\/host\/src\/adapters\/platform-[a-z0-9-]+\.ts$/

// The original regexes recognised only three literals (process.platform / os.platform() / os.type())
// and were evaded by entirely ordinary spellings: importing `{ platform } from 'node:os'` and calling
// `platform()`, `const { platform } = process`, `process['platform']`, `process.arch`, `os.arch()`,
// `os.release()`. Coverage is now:
//   - process.platform / process.arch: dot access, index access process['platform'], and destructuring
//     const { platform } = process
//   - os.platform() / os.arch() / os.type() / os.release()
//   - named imports of platform / arch / type / release from 'node:os' / 'os'
// The occasional false positive is preferable to a miss: the sandbox seam will grow three per-platform
// backends, and this guard is the only railing there.
const PATTERNS: RegExp[] = [
  /\bprocess\.(?:platform|arch)\b/,
  /\bprocess\[\s*(['"])(?:platform|arch)\1\s*\]/,
  /\{[^}]*\b(?:platform|arch)\b[^}]*\}\s*=\s*process\b/,
  /\bos\.(?:platform|arch|type|release)\(\)/,
  /\bimport\s*\{[^}]*\b(?:platform|arch|type|release)\b[^}]*\}\s*from\s*['"](?:node:)?os['"]/,
]

// Per-line exemption: a matching line carrying this marker comment is not counted as a violation. When
// a platform check is genuinely needed in production code — today only host's platform-*.ts adapters
// qualify — it is let through with a stated reason, rather than disabling the whole rule.
const EXEMPT_MARKER = '// guards-allow-platform:'

// The guard used to scan only `${root}/packages` and not tools/. Both this guard and
// kernel-create.test.ts should cover tools/. fixtures/ holds data fixtures where a literal
// process.platform is perfectly normal, so it is added to the excluded directories.
// The list is no longer hand-copied in several places: all of them take LITERAL_SCAN_EXCLUDE_DIRS
// from repo.ts.
const SCAN_DIRS = ['packages', 'tools'].map((d) => join(root, d))
const EXCLUDE_DIRS = LITERAL_SCAN_EXCLUDE_DIRS

describe('platform checks only in host platform adapters', () => {
  it('no stray platform/arch checks outside host platform adapters', () => {
    const offenders: string[] = []
    for (const scanDir of SCAN_DIRS) {
      for (const f of listSourceFiles(scanDir, { excludeDirs: EXCLUDE_DIRS })) {
        const rel = relative(root, f).split(sep).join('/')
        // Only `.test.ts` used to be skipped, so `.test.mts` / `.test.cts` were treated as production
        // code and flagged — asymmetric with SOURCE_EXTENSIONS. All of them now go through
        // isTestFile().
        if (ALLOWED.test(rel) || isTestFile(rel)) continue
        const lines = readFileSync(f, 'utf8').split('\n')
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i] ?? ''
          if (line.includes(EXEMPT_MARKER)) continue
          if (PATTERNS.some((re) => re.test(line))) {
            offenders.push(`${rel}:${i + 1}`)
            break
          }
        }
      }
    }
    expect(offenders).toEqual([])
  })
})

// ── A known blind spot, registered and pinned ───────────────────────────────────────────────
// These guards are **line-by-line regexes** and cannot catch storing process in another variable first
// and reading platform off that (`const P2 = process` on one line, `P2.platform` on the next); that
// spelling measured entirely green. Genuinely closing it requires AST analysis, which is deliberately
// not worth it here: this guard aims to prevent someone casually writing a platform check, not to
// prevent deliberate evasion, and the cost/benefit does not justify an AST.
// A gap like this must either be fixed or registered as a pinned test, never quietly ignored — the same
// discipline as "an exception must be consumed".
// This case is **inverted**: if the gap is ever really closed (by switching to an AST scan, say), it
// goes red and forces someone to delete this registration and comment, rather than leaving a stale
// "known limitation" in the file forever.
describe('known blind spot in the platform guard (registered and pinned)', () => {
  it('aliasing via `const P2 = process` + `P2.platform` is not matched by PATTERNS (known limitation)', () => {
    const evasion = ['const P2 = process', 'const current = P2.platform']
    expect(evasion.some((line) => PATTERNS.some((re) => re.test(line)))).toBe(false)
  })
  it('but every direct spelling is matched, so the case above is not the whole regex set failing (zombie-guard check)', () => {
    const caught = [
      'const p = process.platform',
      "const p = process['platform']",
      'const { platform } = process',
      'const p = os.platform()',
      "import { platform } from 'node:os'",
    ]
    for (const line of caught)
      expect(
        PATTERNS.some((re) => re.test(line)),
        line,
      ).toBe(true)
  })
})
