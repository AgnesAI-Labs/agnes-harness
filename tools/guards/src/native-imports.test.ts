import { readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_EXCLUDE_DIRS, isTestFile, listSourceFiles, repoRoot } from './repo.js'

// Native packages ship beside the bundles in node_modules, never inside them. A static import makes
// esbuild pull the package's loader into the single-executable bundle, where the injected script's
// require only knows Node builtins, so the executable fails as soon as the importing module is
// evaluated - which is how one static `sharp` import stopped the SEA daemon from starting. Runtime
// code loads these lazily through createRequire (see tools-core local-image.ts); a type-only import
// is erased and stays allowed. The SEA smoke test catches the same failure, but only on CI runs where
// the SEA job is reached; this check runs with every guard pass.
const NATIVE_PACKAGES = ['sharp', 'esbuild', 'fsevents', 'lightningcss']
const NATIVE_SCOPES = ['@img', '@esbuild']

const name = [
  ...NATIVE_PACKAGES.map((pkg) => String.raw`${pkg}(?:\/[^'"]*)?`),
  ...NATIVE_SCOPES.map((scope) => String.raw`${scope}\/[^'"]+`),
].join('|')
const specifier = String.raw`['"]((?:${name}))['"]`
// No semicolons in this codebase, so the import clause may not cross a quote either: otherwise it
// would run from one import statement into the specifier of a later type import.
const VALUE_IMPORT = new RegExp(
  String.raw`^[ \t]*(?:import\s+(?!type\b)[^;'"]*?\bfrom\s*|import\s*|export\s+(?!type\b)[^;'"]*?\bfrom\s*)${specifier}`,
  'gm',
)
const DYNAMIC_IMPORT = new RegExp(String.raw`(?<!\btypeof\s+)\bimport\(\s*${specifier}\s*\)`, 'g')

export function nativeValueImports(text: string): string[] {
  return [...text.matchAll(VALUE_IMPORT), ...text.matchAll(DYNAMIC_IMPORT)].map((match) => match[1] as string)
}

describe('runtime sources load native packages lazily', () => {
  it('recognises value, re-export, side-effect and dynamic imports but not type imports', () => {
    // The import that stopped the SEA daemon from starting.
    expect(
      nativeValueImports("import { createHash } from 'node:crypto'\nimport sharp from 'sharp'\n"),
    ).toEqual(['sharp'])
    expect(nativeValueImports("import {\n  build,\n  type Plugin,\n} from 'esbuild/lib/main.js'")).toEqual([
      'esbuild/lib/main.js',
    ])
    expect(nativeValueImports("import { a } from './a'\nimport type { build } from 'esbuild'")).toEqual([])
    expect(nativeValueImports("import { build } from 'esbuild'")).toEqual(['esbuild'])
    expect(nativeValueImports("export { default } from 'sharp'")).toEqual(['sharp'])
    expect(nativeValueImports("import '@img/sharp-darwin-arm64'")).toEqual(['@img/sharp-darwin-arm64'])
    expect(nativeValueImports("const s = await import('sharp')")).toEqual(['sharp'])
    expect(nativeValueImports("import type { build } from 'esbuild'")).toEqual([])
    expect(nativeValueImports("type Codec = typeof import('sharp')")).toEqual([])
    expect(nativeValueImports("createRequire(import.meta.url)('sharp')")).toEqual([])
    expect(nativeValueImports("import sharpish from 'sharpish'")).toEqual([])
  })

  it('has no static or dynamic native import in any src directory', () => {
    const root = repoRoot()
    const offenders = listSourceFiles(join(root, 'packages'), {
      excludeDirs: [...DEFAULT_EXCLUDE_DIRS, 'test', 'tests', 'testkit', 'fixtures', 'tools', 'bench'],
    })
      .filter((file) => file.includes(`${sep}src${sep}`) && !isTestFile(file))
      .flatMap((file) =>
        nativeValueImports(readFileSync(file, 'utf8')).map((name) => `${relative(root, file)}: ${name}`),
      )
    expect(offenders, 'load native packages with createRequire(import.meta.url) on first use').toEqual([])
  })
})
