import { readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { listSourceFiles, repoRoot, SOURCE_EXTENSIONS } from './repo.js'

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
      // A non-whitespace marker keeps import-prefix matching from consuming the literal.
      return token.startsWith('/') ? ' '.repeat(token.length) : '#'.repeat(token.length)
    },
  )
  // Scan import prefixes once, rather than searching the entire growing source prefix for
  // every literal (quadratic on large generated-fixture and UI modules).
  const imports = new Set(
    [
      ...code.matchAll(
        /\b(?:import|require)\s*\(\s*|\bvi\s*\.\s*(?:mock|doMock|unmock|doUnmock)\s*\(\s*|\b(?:from|import)\s*/g,
      ),
    ].map((match) => match.index + match[0].length),
  )
  return literals.flatMap(({ at, value }) => {
    if (!imports.has(at)) return []
    const spec = value.split(/[?#]/)[0]!.replaceAll('\\', '/')
    const path = spec.startsWith('.')
      ? relative(root, resolve(dirname(join(root, file)), spec)).replaceAll('\\', '/')
      : /^@agnes\/(?:core|host|web)\/src\//.test(spec)
        ? `packages/${spec.slice('@agnes/'.length)}`
        : ''
    const targets = /\.[cm]?[jt]sx?$/.test(path)
      ? [path.replace(/\.[cm]?[jt]sx?$/, '.ts'), path.replace(/\.[cm]?[jt]sx?$/, '.tsx')]
      : [`${path}.ts`, `${path}.tsx`, `${path}/index.ts`]
    return targets.filter((target) => retired.has(target))
  })
}

describe('retired implementation private paths', () => {
  // This intentionally reads every module, including tests/scripts; allow CI load beyond 5 seconds.
  it('rejects reintroducing imports of retired modules, including tests and build scripts', () => {
    expect(retired.size).toBeGreaterThan(0)
    const files = listSourceFiles(
      ['packages', 'tools', 'examples'].map((dir) => join(root, dir)),
      {
        extensions: [...SOURCE_EXTENSIONS, '.mtsx', '.ctsx', '.js', '.mjs', '.cjs', '.jsx', '.mjsx', '.cjsx'],
      },
    )
    expect(files.length, 'no modules found, so the repository guard checked nothing').toBeGreaterThan(100)
    const errors = files.flatMap((file) => {
      const path = relative(root, file)
      return privateImports(path, readFileSync(file, 'utf8')).map((target) => `${path} imports ${target}`)
    })
    expect(errors).toEqual([])
  }, 15_000)

  it.each([
    "import type { IdMinter } from '../src/ids.js'",
    "export { defaultIds } from '../src/./ids.ts'",
    "import('../src/ids.js')",
    "require('../src/ids')",
    'import(`../src/ids.js`)',
    "vi.mock('../src/ids.js', () => ({}))",
    `import /* ${' '.repeat(8192)} */ ( /* comment */ '../src/ids.js')`,
    `export { defaultIds } from${' '.repeat(8192)}'../src/ids.js'`,
    "import { defaultIds } from '@agnes/core/src/ids.js'",
    "import /* comment */ ('../src/ids.js')",
    "vi /* comment */ . doUnmock /* comment */ (\n'../src/ids.js')",
    "export { defaultIds } from\n/* comment */ '../src/ids.js'",
  ])('rejects the removed path in %s', (source) => {
    expect(privateImports('packages/core/test/refusal.test.ts', source)).toEqual(['packages/core/src/ids.ts'])
  })

  it.each([
    "import { applyTheme } from '../src/theme.js'",
    "export * from '@agnes/web/src/theme.js'",
    "import('../src/./theme.js')",
    "vi.mock('../src/theme.js', () => ({}))",
  ])('rejects the retired Web path in %s', (source) => {
    expect(privateImports('packages/web/test/theme.test.ts', source)).toEqual(['packages/web/src/theme.ts'])
  })

  it('allows public facades, real owners, retained shims and quoted fixture source', () => {
    const largeFixture = 'const fixture = "not an import";\n'.repeat(10_000)
    expect(privateImports('packages/core/test/compatibility.test.ts', largeFixture)).toEqual([])
    expect(
      privateImports('packages/core/test/compatibility.test.ts', `${largeFixture}import '../src/ids.js'`),
    ).toEqual(['packages/core/src/ids.ts'])
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
