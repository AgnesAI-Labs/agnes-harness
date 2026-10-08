import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_EXCLUDE_DIRS, repoRoot } from './repo.js'

const root = repoRoot()
const retired = new Set<string>(
  JSON.parse(readFileSync(join(root, 'tools/guards/retired-private-paths.json'), 'utf8')),
)

function privateImports(file: string, source: string): string[] {
  const literals: Array<{ at: number; value: string }> = []
  const code = source.replace(
    /'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
    (token, at: number) => {
      if (!token.startsWith('/') && !token.includes('${')) literals.push({ at, value: token.slice(1, -1) })
      return ' '.repeat(token.length)
    },
  )
  return literals.flatMap(({ at, value }) => {
    if (
      !/(?:\b(?:from|import)\s*|\b(?:import|require)\s*\(\s*|\bvi\s*\.\s*(?:mock|doMock|unmock|doUnmock)\s*\(\s*)$/.test(
        code.slice(0, at),
      )
    )
      return []
    const spec = value.split(/[?#]/)[0]!.replaceAll('\\', '/')
    const path = spec.startsWith('.')
      ? relative(root, resolve(dirname(join(root, file)), spec)).replaceAll('\\', '/')
      : /^@agnes\/(?:core|host)\/src\//.test(spec)
        ? `packages/${spec.slice('@agnes/'.length)}`
        : ''
    const targets = /\.[cm]?[jt]sx?$/.test(path)
      ? [path.replace(/\.[cm]?[jt]sx?$/, '.ts')]
      : [`${path}.ts`, `${path}/index.ts`]
    return targets.filter((target) => retired.has(target))
  })
}

function moduleFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return DEFAULT_EXCLUDE_DIRS.includes(entry.name) ? [] : moduleFiles(path)
    return /\.[cm]?[jt]sx?$/.test(entry.name) ? [path] : []
  })
}

describe('removed Core and Host private paths', () => {
  it('rejects reintroducing imports of retired modules, including tests and build scripts', () => {
    expect(retired.size).toBeGreaterThan(0)
    const errors = ['packages', 'tools', 'examples']
      .flatMap((dir) => moduleFiles(join(root, dir)))
      .flatMap((file) =>
        privateImports(relative(root, file), readFileSync(file, 'utf8')).map(
          (target) => `${relative(root, file)} imports ${target}`,
        ),
      )
    expect(errors).toEqual([])
  })

  it.each([
    "import type { IdMinter } from '../src/ids.js'",
    "export { defaultIds } from '../src/./ids.ts'",
    "import('../src/ids.js')",
    "require('../src/ids')",
    'import(`../src/ids.js`)',
    "vi.mock('../src/ids.js', () => ({}))",
    "import { defaultIds } from '@agnes/core/src/ids.js'",
  ])('rejects the removed path in %s', (source) => {
    expect(privateImports('packages/core/test/refusal.test.ts', source)).toEqual(['packages/core/src/ids.ts'])
  })

  it('allows public facades, real owners, retained shims and quoted fixture source', () => {
    expect(
      privateImports(
        'packages/core/test/compatibility.test.ts',
        `
      import { Kernel } from '@agnes/core'
      import { MemoryStorage } from '@agnes/core/testkit'
      import { reachability } from '@agnes/core/artifacts'
      import { defaultIds } from '@agnes/core-common/ids'
      import { Kernel } from '../src/kernel.js'
      // import { defaultIds } from '../src/ids.js'
      const fixture = "import { defaultIds } from '../src/ids.js'"
    `,
      ),
    ).toEqual([])
  })
})
