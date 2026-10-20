// Line-count report. scope-line-count.json holds the last reviewed per-scope totals; this suite prints each
// scope's delta and never fails on growth. Hard size limits live in file-size.test.ts.
// The remaining cases pin the file-selection rules (key boundary matching, test-file exclusion).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { countLines } from './count-lines.js'
import { isTestFile, listSourceFiles, repoRoot, SOURCE_EXTENSIONS } from './repo.js'
import { matchesScopeKey } from './scope-key.js'

const root = repoRoot()
const baseline = JSON.parse(readFileSync(join(root, 'tools/guards/scope-line-count.json'), 'utf8')) as Record<
  string,
  number
>

describe('line-count report (never fails on growth)', () => {
  it('prints the per-scope delta against scope-line-count.json', () => {
    const rows: string[] = []
    for (const [prefix, previous] of Object.entries(baseline)) {
      const abs = join(root, prefix)
      const files = listSourceFiles(dirname(abs)).filter((f) => matchesScopeKey(f, abs) && !isTestFile(f))
      const total = files.reduce((n, f) => n + countLines(readFileSync(f, 'utf8')), 0)
      if (total !== previous)
        rows.push(`${prefix}: ${previous} -> ${total} (${total > previous ? '+' : ''}${total - previous})`)
    }
    if (rows.length) console.info(`line-count delta vs scope-line-count.json:\n${rows.join('\n')}`)
    expect(Object.keys(baseline).length).toBeGreaterThan(0)
  })
})

// Regression cases for two successive defects. A plain string startsWith(abs) counted a sibling file
// sharing the prefix (assemble-legacy.ts) as belonging to the assemble key — a false positive. The
// first fix narrowed the scan root to "if abs is a directory, scan only abs", which introduced a false
// negative: when assemble.ts and assemble/ coexist, assemble.ts fell outside the scan and was not
// counted at all. The scan root is now unconditionally dirname(abs), with the boundary filter
// providing precision.
// Real file layouts are built in a temp directory, removed in a finally at the end of each case.
describe('scope key path-boundary matching (regression: sibling-prefix false match / narrowed-scan-root false negative)', () => {
  it.each(SOURCE_EXTENSIONS)('file form: counts assemble%s, excludes sibling prefix', (ext) => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-scope-file-'))
    try {
      writeFileSync(join(dir, `assemble${ext}`), 'const a = 1\n')
      writeFileSync(join(dir, `assemble-legacy${ext}`), 'const b = 1\nconst c = 2\nconst d = 3\n')
      const abs = join(dir, 'assemble')
      const files = listSourceFiles(dirname(abs)).filter((f) => matchesScopeKey(f, abs))
      expect(files).toEqual([join(dir, `assemble${ext}`)])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('directory form: counts nested files under assemble/', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-scope-dir-'))
    try {
      mkdirSync(join(dir, 'assemble', 'nested'), { recursive: true })
      writeFileSync(join(dir, 'assemble', 'nested', 'deep.ts'), 'const e = 1\n')
      const abs = join(dir, 'assemble')
      const files = listSourceFiles(dirname(abs)).filter((f) => matchesScopeKey(f, abs))
      expect(files).toEqual([join(dir, 'assemble', 'nested', 'deep.ts')])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('co-existing form: assemble.ts (file) and assemble/ (dir) both present, both counted', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-scope-both-'))
    try {
      writeFileSync(join(dir, 'assemble.ts'), 'const a = 1\n')
      mkdirSync(join(dir, 'assemble', 'nested'), { recursive: true })
      writeFileSync(join(dir, 'assemble', 'nested', 'deep.ts'), 'const e = 1\n')
      writeFileSync(join(dir, 'assemble-legacy.ts'), 'const b = 1\nconst c = 2\nconst d = 3\n')
      const abs = join(dir, 'assemble')
      const files = listSourceFiles(dirname(abs)).filter((f) => matchesScopeKey(f, abs))
      expect(files.sort()).toEqual(
        [join(dir, 'assemble', 'nested', 'deep.ts'), join(dir, 'assemble.ts')].sort(),
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// Regression pin for the escape hatch above: code under `src/**/test/` must count towards the line
// budget, while test files such as `.test.ts` / `.test.mts` must continue not to. A real layout is
// built in a temp directory and run through the same filter chain as above.
describe('scope report counts code under a directory named `test` (regression: excluded escape hatch)', () => {
  const collect = (abs: string): string[] =>
    listSourceFiles(dirname(abs)).filter((f) => matchesScopeKey(f, abs) && !isTestFile(f))

  it('src/test/x.ts is counted (it used to be excluded wholesale)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-scope-testdir-'))
    try {
      mkdirSync(join(dir, 'src', 'test'), { recursive: true })
      writeFileSync(join(dir, 'src', 'test', 'x.ts'), 'const a = 1\n')
      expect(collect(join(dir, 'src'))).toEqual([join(dir, 'src', 'test', 'x.ts')])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('every .test.<ext> file is still excluded (N5: .mts/.cts/.tsx too)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agnes-scope-testfile-'))
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
