import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isTestFile, listSourceFiles, repoRoot } from './repo.js'

// Fresh databases are created by their final CREATE statements; old data is refused by version, not migrated.
describe('no runtime schema upgrades', () => {
  it('finds no ALTER TABLE in production source', () => {
    const root = repoRoot()
    const hits = listSourceFiles(join(root, 'packages'))
      .filter((file) => !isTestFile(file) && !/[\\/](test|testkit|fixtures)[\\/]/.test(file))
      .filter((file) => /\bALTER\s+TABLE\b/i.test(readFileSync(file, 'utf8')))
      .map((file) => relative(root, file).replaceAll('\\', '/'))
    expect(hits).toEqual([])
  })
})
