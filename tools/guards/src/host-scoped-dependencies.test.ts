import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { isTestFile, listSourceFiles, repoRoot } from './repo.js'

const pathStyle = vi.hoisted(() => ({ separator: '/' }))
vi.mock('node:path', async (importOriginal) => {
  const path = await importOriginal<typeof import('node:path')>()
  return {
    ...path,
    relative: (...args: Parameters<typeof path.relative>) =>
      path
        .relative(...args)
        .replaceAll('\\', '/')
        .replaceAll('/', pathStyle.separator),
  }
})

const root = repoRoot()
const factory = 'createHostScopedDependencies'

// Scan the construction literal conservatively, including templates. A token-only scanner without
// parser context can swallow executable code after a template interpolation.
function constructions(source: string) {
  const pattern = new RegExp(`\\b${factory}\\s*\\(|\\[\\s*['"]${factory}['"]\\s*\\]\\s*\\(`, 'g')
  const calls = [...source.matchAll(pattern)].filter(
    (match) => !/function\s*$/.test(source.slice(0, match.index)),
  )
  const aliases = [
    ...source.matchAll(
      new RegExp(
        `\\b${factory}\\s+(?:as\\b)|\\b${factory}\\s*:|=\\s*(?:[\\w$]+\\.)?${factory}\\b(?!\\s*\\()|=\\s*[\\w$]+\\[\\s*['"]${factory}['"]\\s*\\](?!\\s*\\()`,
        'g',
      ),
    ),
  ]
  return { calls, aliases }
}

describe('Host selected service construction', () => {
  it.each(['/', '\\'])(
    'constructs the fixed service root exactly once in product source, in Host assembly (%s)',
    (separator) => {
      pathStyle.separator = separator
      const calls: string[] = []
      for (const file of listSourceFiles(join(root, 'packages'))) {
        const path = relative(root, file).replaceAll('\\', '/')
        if (!path.includes('/src/') || isTestFile(path)) continue
        const found = constructions(readFileSync(file, 'utf8'))
        expect(found.aliases, `${path}: do not alias the service construction factory`).toEqual([])
        calls.push(...found.calls.map(() => path))
      }
      expect(calls).toEqual(['packages/host/src/assemble.ts'])
    },
  )

  it('pins the bundled default provider source identity without claiming a release lock', () => {
    const directory = join(root, 'packages/package-manager')
    const digest = createHash('sha256')
    for (const file of listSourceFiles(join(directory, 'src/runtime'))) {
      digest.update(relative(directory, file).replaceAll('\\', '/'))
      digest.update('\0')
      digest.update(readFileSync(file))
      digest.update('\0')
    }
    const source = readFileSync(join(root, 'packages/host/src/runtime/host-services.ts'), 'utf8')
    const identity = /DEFAULT_PACKAGE_RUNTIME_DIGEST\s*=\s*['"]([a-f0-9]{64})['"]/.exec(source)?.[1]
    expect(identity).toBe(digest.digest('hex'))
  })

  it('detects multiline and namespace construction and rejects import aliases', () => {
    expect(constructions(`function ${factory}() {}; ${factory}\n ([])`).calls).toHaveLength(1)
    expect(constructions(`services['${factory}'] ([])`).calls).toHaveLength(1)
    expect(constructions(`import { ${factory} as open } from '@agnes/host'`).aliases).toHaveLength(1)
    expect(constructions(`const value = factoryName([])`).calls).toEqual([])
    expect(constructions(`const alternate = ${factory}`).aliases).toHaveLength(1)
    expect(constructions(`const open = services.${factory}; open([])`).aliases).toHaveLength(1)
    expect(constructions(`const open = services['${factory}']; open([])`).aliases).toHaveLength(1)
  })
})
