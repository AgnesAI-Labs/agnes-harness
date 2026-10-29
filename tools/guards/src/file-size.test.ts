// Hard per-file size limit: no source file may exceed MAX_FILE_LINES (countLines). Files already over
// the limit are listed in file-size-allowlist.json with a ceiling they may not exceed. The list only
// shrinks: an entry whose file is now within the limit or gone is stale and must be removed, and a new
// entry is never accepted. Shrinking a listed file needs no edit, so parallel work does not conflict here.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { countLines } from './count-lines.js'
import { assertBudgetNonIncrease } from './protected-allowances.js'
import { isTestFile, listSourceFiles, presentationSourceFiles, repoRoot } from './repo.js'

const MAX_FILE_LINES = 800
const root = repoRoot()
const allowlist = JSON.parse(
  readFileSync(join(root, 'tools/guards/file-size-allowlist.json'), 'utf8'),
) as Record<string, number>

const measured = new Map<string, number>()
for (const file of [
  ...listSourceFiles(join(root, 'packages')),
  ...listSourceFiles(join(root, 'tools')),
  ...presentationSourceFiles(root),
]) {
  if (isTestFile(file)) continue
  const lines = countLines(readFileSync(file, 'utf8'))
  if (lines > MAX_FILE_LINES || Object.hasOwn(allowlist, file.slice(root.length + 1).replaceAll('\\', '/')))
    measured.set(file.slice(root.length + 1).replaceAll('\\', '/'), lines)
}

describe(`source files stay within ${MAX_FILE_LINES} lines`, () => {
  it('no unlisted file exceeds the limit and no listed file grows', () => {
    const violations = [...measured]
      .filter(([file, lines]) => lines > (allowlist[file] ?? MAX_FILE_LINES))
      .map(([file, lines]) => `${file}: ${lines} > ${allowlist[file] ?? MAX_FILE_LINES}`)
    expect(violations).toEqual([])
  })

  it('allowlist never increases against the protected merge-base', () => {
    expect(assertBudgetNonIncrease(root, 'tools/guards/file-size-allowlist.json')).toEqual([])
  })

  it('allowlist has no stale entries', () => {
    const stale = Object.keys(allowlist).filter((file) => (measured.get(file) ?? 0) <= MAX_FILE_LINES)
    expect(stale, 'remove files that are now within the limit or no longer exist').toEqual([])
  })
})
