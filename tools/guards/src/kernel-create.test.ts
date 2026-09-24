import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { matchesRatchetKey } from './ratchet-key.js'
import { isTestFile, LITERAL_SCAN_EXCLUDE_DIRS, listSourceFiles, repoRoot } from './repo.js'

const root = repoRoot()
// The only legitimate call site is the single file packages/host/src/assemble.ts, or any file under
// the packages/host/src/assemble/ directory. The old spelling hard-coded one file path, so the moment
// host split the assembly layer into assemble/index.ts it would have flagged that as a violation.
// Now uses the same boundary matcher as ratchet.test.ts (tools/guards/src/ratchet-key.ts), shared
// between the two so they cannot drift apart.
const ALLOWED_ABS = join(root, 'packages/host/src/assemble')

// The guard used to scan only `${root}/packages` and not tools/. Both this guard and platform.test.ts
// should cover tools/. fixtures/ holds data fixtures where the literal `Kernel.create(` is perfectly
// normal, so it is added to the excluded directories.
// The list is no longer hand-copied in several places: all of them take LITERAL_SCAN_EXCLUDE_DIRS from
// repo.ts.
const SCAN_DIRS = ['packages', 'tools'].map((d) => join(root, d))
const EXCLUDE_DIRS = LITERAL_SCAN_EXCLUDE_DIRS

// The old regex /\bKernel\.create\(/ was evaded by `Kernel\n  .create({})`, which measured as 2 passed.
// Purely a whitespace-tolerance problem: arbitrary whitespace, newlines included, is now allowed on
// both sides of the dot and before the parenthesis.
export const KERNEL_CREATE_RE = /\bKernel\s*\.\s*create\s*\(/g

describe('single Kernel.create call site', () => {
  it('Kernel.create( appears exactly once repo-wide, only under packages/host/src/assemble(.ts|/**)', () => {
    const offenders: string[] = []
    let totalOccurrences = 0
    for (const scanDir of SCAN_DIRS) {
      for (const f of listSourceFiles(scanDir, { excludeDirs: EXCLUDE_DIRS })) {
        const rel = relative(root, f)
        // `.test.mts` / `.test.cts` used not to be skipped (too strict), asymmetric with
        // SOURCE_EXTENSIONS.
        if (isTestFile(rel)) continue
        const text = readFileSync(f, 'utf8')
        // Definition sites such as `static async create(` or `create(opts` do not count; only
        // `Kernel.create(` calls are counted, and occurrences within a single file are counted too.
        // The requirement is exactly one call site, so two occurrences in the same file must go red —
        // counting only how many files match is not enough.
        const matches = text.match(KERNEL_CREATE_RE)
        if (!matches) continue
        totalOccurrences += matches.length
        if (!matchesRatchetKey(f, ALLOWED_ABS)) offenders.push(`${rel} (${matches.length}x)`)
      }
    }
    expect(offenders, 'Kernel.create( found outside packages/host/src/assemble').toEqual([])
    // While host has not implemented the assembly layer yet, 0 occurrences is a legitimate starting
    // point (matching the original callers.length === 0 handling). Once it lands there must be exactly
    // 1 — two occurrences, even within one file, must go red, rather than only counting matching
    // files.
    const expectedTotal = totalOccurrences === 0 ? 0 : 1
    expect(
      totalOccurrences,
      'Kernel.create( must appear zero times (not yet implemented) or exactly once',
    ).toBe(expectedTotal)
  })
})

// The inverse pin: newline and whitespace formatting must not evade the matcher again.
describe('Kernel.create matcher tolerates whitespace', () => {
  it.each(['Kernel.create({})', 'Kernel\n  .create({})', 'Kernel .create( {} )', 'Kernel\t.\tcreate\t('])(
    'matches %j',
    (src) => {
      expect(new RegExp(KERNEL_CREATE_RE.source).test(src)).toBe(true)
    },
  )
  it.each(['static async create(', 'kernel.createSession(', 'MyKernel2.create('])(
    'does not match %j',
    (src) => {
      expect(new RegExp(KERNEL_CREATE_RE.source).test(src)).toBe(false)
    },
  )
})
