import { readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isTestFile, LITERAL_SCAN_EXCLUDE_DIRS, listSourceFiles, repoRoot } from './repo.js'

const root = repoRoot()

/**
 * The path policy is decided in exactly one kind of place: the file system that moves the bytes.
 * The kernel used to compare a deny list too, on the raw string the caller wrote, while the
 * delivered adapter compared it again after resolving symlinks and folding case - one rule stated
 * twice at two strengths, and the weaker statement was the one the kernel showed a reader.
 *
 * So the decision itself is fenced instead. `decideFsPath` - the one precedence rule over the
 * policy's canonical rule list - is declared in core's fs-guard and may be *run* only by a file
 * system (host's FsOps, the testkit's fenced double); inside `packages/core/src` nothing but its
 * declaration site and the probe builder may even name it. A second comparison in the kernel has
 * to name it, and naming it here is what goes red.
 */
const CORE_SRC = join(root, 'packages/core/src')
// seams.ts is where the contract is declared; fs-guard.ts is where the decision and the probe are
// declared; index.ts only re-exports the names, which is how consumers reach them without a second
// declaration.
const CORE_ALLOWED = [
  'packages/core/src/effects/fs-guard.ts',
  'packages/core/src/effects/seams.ts',
  'packages/core/src/index.ts',
]

describe('the file policy decision lives in one place', () => {
  it('scans a non-trivial number of core source files', () => {
    expect(listSourceFiles(CORE_SRC, { excludeDirs: LITERAL_SCAN_EXCLUDE_DIRS }).length).toBeGreaterThan(20)
  })

  it('packages/core/src names the policy rule list only where the contract and the probe are declared', () => {
    const offenders: string[] = []
    for (const file of listSourceFiles(CORE_SRC, { excludeDirs: LITERAL_SCAN_EXCLUDE_DIRS })) {
      if (isTestFile(file)) continue
      const rel = relative(root, file).split(sep).join('/')
      if (CORE_ALLOWED.includes(rel)) continue
      const text = readFileSync(file, 'utf8')
      for (const token of ['decideFsPath', 'FsPolicy']) {
        const at = text.indexOf(token)
        if (at >= 0) offenders.push(`${rel}:${text.slice(0, at).split('\n').length} names ${token}`)
      }
    }
    expect(offenders, `the policy is the file system's to decide; ${offenders.join(', ')} names it`).toEqual(
      [],
    )
  })

  it('the declaration sites still exist, so the rule above cannot pass by naming nothing', () => {
    expect(readFileSync(join(root, 'packages/core/src/effects/fs-guard.ts'), 'utf8')).toContain(
      'decideFsPath',
    )
    expect(
      readFileSync(join(root, 'packages/core/src/effects/seams.ts'), 'utf8'),
      'the sandbox seam answers the full policy, not a deny list',
    ).toContain('fsPolicy(): FsPolicy')
    expect(readFileSync(join(root, 'packages/core/src/index.ts'), 'utf8')).toContain('decideFsPath')
  })
})
