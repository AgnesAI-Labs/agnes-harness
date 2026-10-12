// Bundled extensions should reach the kernel through @agnes/extension-api, not @agnes/core. The files
// that still import core are pinned in extension-core-imports-allowlist.json; the list only shrinks:
// a file that stops importing core must be removed, and no new file may be added.
import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isTestFile, listSourceFiles, repoRoot } from './repo.js'

const root = repoRoot()
const allowlist = JSON.parse(
  readFileSync(join(root, 'tools/guards/extension-core-imports-allowlist.json'), 'utf8'),
) as string[]
const CORE_IMPORT = /(?:from|import\()\s*['"]@agnes\/core(?:\/[^'"]*)?['"]/

const importing = listSourceFiles(join(root, 'packages/base/extensions'))
  .filter((file) => !isTestFile(file) && !/[\\/](test|fixtures)[\\/]/.test(file))
  .filter((file) => CORE_IMPORT.test(readFileSync(file, 'utf8')))
  .map((file) => relative(root, file).split('\\').join('/'))
  .sort()

describe('bundled extensions importing @agnes/core only decrease', () => {
  it('has no new importer', () => {
    expect(importing.filter((file) => !allowlist.includes(file))).toEqual([])
  })
  it('has no stale allowlist entry', () => {
    expect(allowlist.filter((file) => !importing.includes(file))).toEqual([])
  })
})
