import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { importEdges, scanTokens } from './module-edges.js'
import { isTestFile, repoRoot } from './repo.js'

/**
 * Checks that follow the published state contract and the one production assembly.
 * Method names are read from the generated service catalog. Callers outside the
 * default state implementation use that public surface. The conformance driver
 * under tools/acceptance is the test entry that loads the public test fixtures.
 */

const STATE_CONTRACT = 'agh.state'
const PROVIDER_REL = 'packages/host/src/runtime/providers/state.ts'
const STATE_DIR = 'packages/host/src/runtime/state'
const REFERENCE_DIR = 'examples/runtime-reference'
const PUBLIC_TESTKITS = ['@agnes/extension-api/testkit', '@agnes/plugin-runtime/testkit'] as const
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git'])
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts']

const root = repoRoot()

function posix(path: string): string {
  return path.split(sep).join('/')
}

function repoRel(file: string, base: string): string {
  return posix(relative(base, file))
}

function eachFile(dir: string, visit: (file: string) => void): void {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) eachFile(full, visit)
    else visit(full)
  }
}

function isSourceFile(file: string): boolean {
  return SOURCE_EXTENSIONS.some((ext) => file.endsWith(ext))
}

function filesUnder(dir: string, accept: (file: string) => boolean = isSourceFile): string[] {
  const out: string[] = []
  eachFile(dir, (file) => {
    if (accept(file)) out.push(file)
  })
  return out
}

function read(file: string): string {
  return readFileSync(file, 'utf8')
}

function extractObject(source: string, from: number): string {
  const start = source.indexOf('{', from)
  if (start < 0) throw new Error('generated service catalog has no object')
  let depth = 0
  let quote = ''
  for (let index = start; index < source.length; index++) {
    const ch = source[index] ?? ''
    if (quote) {
      if (ch === '\\') {
        index++
        continue
      }
      if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return source.slice(start, index + 1)
    }
  }
  throw new Error('generated service catalog object is not closed')
}

function catalogValue(source: string): Record<string, { methods?: Record<string, unknown> }> {
  const marker = source.indexOf('export const RuntimeServiceCatalog')
  if (marker < 0) throw new Error('generated service catalog is missing')
  return JSON.parse(extractObject(source, marker)) as Record<string, { methods?: Record<string, unknown> }>
}

function catalogFiles(base: string): string[] {
  return filesUnder(join(base, 'packages/protocol'), (file) => {
    return isSourceFile(file) && read(file).includes('export const RuntimeServiceCatalog')
  })
}

function catalogMethodNames(source: string, contract: string, baseOnly = false): string[] {
  const methods = catalogValue(source)[contract]?.methods
  if (!methods) return []
  return Object.entries(methods)
    .filter(([, method]) => {
      if (!baseOnly || !method || typeof method !== 'object') return true
      return !('requiredFeature' in method)
    })
    .map(([name]) => name)
}

function containerContractNames(source: string): string[] {
  return Object.keys(catalogValue(source)).filter(
    (name) =>
      name === 'agh.container' || name.startsWith('agh.container.') || name.startsWith('agh.container/'),
  )
}

function interfaceFiles(base: string): string[] {
  return filesUnder(join(base, 'packages/extension-api/src'), (file) => {
    return isSourceFile(file) && read(file).includes('export interface StateStoreControl')
  })
}

function interfaceMethodNames(source: string, name: string): string[] {
  const tokens = scanTokens(source)
  const names: string[] = []
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index] !== 'interface' || tokens[index + 1] !== name) continue
    let cursor = index + 2
    while (cursor < tokens.length && tokens[cursor] !== '{') cursor++
    let depth = 0
    for (let inner = cursor; inner < tokens.length; inner++) {
      const token = tokens[inner] ?? ''
      if (token === '{') depth++
      else if (token === '}') {
        depth--
        if (depth === 0) return names
      } else if (
        depth === 1 &&
        /^[A-Za-z_]/.test(token) &&
        tokens[inner + 1] === '(' &&
        !['readonly', 'static', 'public', 'private', 'protected', 'async'].includes(token)
      ) {
        names.push(token)
      }
    }
  }
  return names
}

function methodSetProblems(catalogSource: string, interfaceSource: string): string[] {
  // Feature-gated operations carry requiredFeature and are published on their own
  // generated interfaces. StateStoreControl is the remaining catalog method set.
  const catalog = catalogMethodNames(catalogSource, STATE_CONTRACT, true)
  const face = interfaceMethodNames(interfaceSource, 'StateStoreControl')
  if (catalog.length === 0) return ['generated state catalog has no methods']
  if (face.length === 0) return ['public state interface has no methods']
  const published = new Set(catalog)
  const declared = new Set(face)
  const problems: string[] = []
  for (const name of catalog) {
    if (!declared.has(name)) problems.push(`public state interface is missing ${name}`)
  }
  for (const name of face) {
    if (!published.has(name)) problems.push(`public state interface adds ${name}`)
  }
  return problems
}

function batchMethodNames(providerSource: string): string[] {
  const marker = providerSource.indexOf('StateStoreControl &')
  if (marker < 0) return []
  const open = providerSource.indexOf('{', marker)
  const body = extractObject(providerSource, open)
  const names: string[] = []
  const pattern = /\/\*\*([\s\S]*?)\*\/\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:<[^;\n]{0,80}>)?\s*\(/g
  for (const match of body.matchAll(pattern)) {
    if ((match[1] ?? '').includes('Host-internal')) names.push(match[2] ?? '')
  }
  return names.filter((name) => name !== '')
}

function unimplementedNames(providerSource: string): string[] {
  const match = providerSource.match(/UNIMPLEMENTED_STATE_METHODS = \[([\s\S]*?)\] as const/)
  if (!match?.[1]) return []
  return [...match[1].matchAll(/'([^']+)'/g)].map((item) => item[1] ?? '').filter((name) => name !== '')
}

function tableNames(sqlSource: string): string[] {
  const names: string[] = []
  const pattern = /CREATE\s+(?:TABLE|VIEW)\s+IF\s+NOT\s+EXISTS\s+([A-Za-z_][A-Za-z0-9_]*)/g
  for (const match of sqlSource.matchAll(pattern)) names.push(match[1] ?? '')
  return names.filter((name) => name !== '')
}

function stateSql(base: string): string {
  return filesUnder(join(base, STATE_DIR))
    .map((file) => read(file))
    .join('\n')
}

function mentionsIdent(text: string, name: string): boolean {
  return new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`).test(text)
}

function isStateOwner(rel: string): boolean {
  return rel === PROVIDER_REL || rel.startsWith(`${STATE_DIR}/`)
}

function callerFiles(base: string): string[] {
  const out: string[] = []
  for (const group of ['packages', 'examples']) {
    for (const file of filesUnder(join(base, group))) {
      const rel = repoRel(file, base)
      if (isTestFile(rel) || isStateOwner(rel)) continue
      if (group === 'packages' && !rel.split('/').includes('src')) continue
      out.push(file)
    }
  }
  return out
}

function bypassProblems(base: string): string[] {
  const provider = join(base, PROVIDER_REL)
  const batches = existsSync(provider) ? batchMethodNames(read(provider)) : []
  const tables = tableNames(stateSql(base))
  const problems: string[] = []
  for (const file of callerFiles(base)) {
    const rel = repoRel(file, base)
    for (const token of scanTokens(read(file))) {
      if (batches.includes(token)) problems.push(`${rel}: calls ${token}`)
      if (!rel.startsWith(`${STATE_DIR}/`)) {
        for (const table of tables) {
          if (mentionsIdent(token, table)) problems.push(`${rel}: reads ${table}`)
        }
      }
    }
  }
  return problems
}

function exportClassNames(source: string, suffix: string): string[] {
  // The token scanner can leave a template literal open and swallow a later class.
  // A production assembly is a top-level `export class` declaration.
  const names: string[] = []
  for (const match of source.matchAll(/(?:^|\n)export class ([A-Za-z_][A-Za-z0-9_]*)/g)) {
    const name = match[1] ?? ''
    if (name.endsWith(suffix)) names.push(name)
  }
  return names
}

function productSourceFiles(base: string): string[] {
  return filesUnder(join(base, 'packages')).filter((file) => {
    const rel = repoRel(file, base)
    return rel.split('/').includes('src') && !isTestFile(rel)
  })
}

function packageDocs(base: string): { name: string; dir: string; json: Record<string, unknown> }[] {
  const out: { name: string; dir: string; json: Record<string, unknown> }[] = []
  for (const group of ['packages', 'tools']) {
    eachFile(join(base, group), (file) => {
      if (!file.endsWith(`${sep}package.json`) && !file.endsWith('/package.json')) return
      const json = JSON.parse(read(file)) as Record<string, unknown>
      const name = typeof json.name === 'string' ? json.name : ''
      out.push({ name, dir: dirname(file), json })
    })
  }
  return out
}

function exportLeaves(value: unknown, subpath: string, out: { subpath: string; target: string }[]): void {
  if (typeof value === 'string') {
    if (value.startsWith('./')) out.push({ subpath, target: value })
    return
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  for (const [key, child] of Object.entries(value)) {
    if (key.startsWith('.')) exportLeaves(child, key, out)
    else exportLeaves(child, subpath, out)
  }
}

function assemblyEntries(base: string, className: string): string[] {
  const entries: string[] = []
  for (const pkg of packageDocs(base)) {
    if (!pkg.json.exports || typeof pkg.json.exports !== 'object') continue
    const leaves: { subpath: string; target: string }[] = []
    exportLeaves(pkg.json.exports, '.', leaves)
    const seen = new Set<string>()
    for (const leaf of leaves) {
      const file = join(pkg.dir, leaf.target)
      if (!existsSync(file) || !isSourceFile(file)) continue
      if (!mentionsIdent(read(file), className)) continue
      const label = `${pkg.name} ${leaf.subpath}`
      if (seen.has(label)) continue
      seen.add(label)
      entries.push(label)
    }
  }
  return entries
}

function forbiddenExportKeys(base: string): string[] {
  const problems: string[] = []
  for (const pkg of packageDocs(base)) {
    if (!pkg.json.exports || typeof pkg.json.exports !== 'object') continue
    const leaves: { subpath: string; target: string }[] = []
    exportLeaves(pkg.json.exports, '.', leaves)
    for (const leaf of leaves) {
      if (leaf.subpath === './container' || leaf.subpath.includes('agh.container')) {
        problems.push(`${pkg.name} exports ${leaf.subpath}`)
      }
    }
  }
  return problems
}

function schemaContainerProblems(base: string): string[] {
  const problems: string[] = []
  const walk = (value: unknown, underNot: boolean, path: string): void => {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index++) walk(value[index], underNot, `${path}[${index}]`)
      return
    }
    if (!value || typeof value !== 'object') return
    const record = value as Record<string, unknown>
    if (!underNot && record.const === 'agh.container') problems.push(`${path}: agh.container is a contract`)
    for (const [key, child] of Object.entries(record))
      walk(child, underNot || key === 'not', `${path}.${key}`)
  }
  eachFile(join(base, 'packages/protocol/schema'), (file) => {
    if (!file.endsWith('.json')) return
    walk(JSON.parse(read(file)) as unknown, false, repoRel(file, base))
  })
  return problems
}

function containerProblems(base: string): string[] {
  const problems: string[] = []
  const catalogs = catalogFiles(base)
  if (catalogs.length !== 1) problems.push(`service catalog files: ${catalogs.length}`)
  const catalog = catalogs[0]
  if (catalog) {
    for (const name of containerContractNames(read(catalog))) problems.push(`catalog publishes ${name}`)
  }
  const assemblies: string[] = []
  const containers: string[] = []
  for (const file of productSourceFiles(base)) {
    const source = read(file)
    assemblies.push(...exportClassNames(source, 'Assembly'))
    containers.push(...exportClassNames(source, 'Container'))
  }
  if (assemblies.length !== 1)
    problems.push(`production assembly classes: ${assemblies.join(', ') || 'none'}`)
  if (containers.length > 0) problems.push(`extra container exports: ${containers.join(', ')}`)
  const className = assemblies[0]
  if (className) {
    const entries = assemblyEntries(base, className)
    if (entries.length !== 1) problems.push(`production assembly entries: ${entries.join(', ') || 'none'}`)
  }
  problems.push(...forbiddenExportKeys(base), ...schemaContainerProblems(base))
  return problems
}

function isPublicTestkitSpecifier(specifier: string): boolean {
  return PUBLIC_TESTKITS.some((name) => specifier === name || specifier.startsWith(`${name}/`))
}

function resolvedRel(base: string, file: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined
  return posix(relative(base, resolve(dirname(file), specifier)))
}

function isPublicTestkitPath(rel: string): boolean {
  return PUBLIC_TESTKITS.some((name) => {
    const dir =
      name === '@agnes/extension-api/testkit'
        ? 'packages/extension-api/testkit'
        : 'packages/plugin-runtime/testkit'
    return rel === dir || rel.startsWith(`${dir}/`)
  })
}

function testkitImportAllowed(rel: string): boolean {
  return (
    isTestFile(rel) ||
    rel.endsWith('.test-d.ts') ||
    rel.split('/').includes('examples') ||
    rel.startsWith('tools/acceptance/')
  )
}

function isProductSource(rel: string): boolean {
  return rel.startsWith('packages/') && rel.split('/').includes('src') && !isTestFile(rel)
}

function testkitProblems(base: string): string[] {
  const problems: string[] = []
  for (const group of ['packages', 'tools', 'examples']) {
    for (const file of filesUnder(join(base, group))) {
      const rel = repoRel(file, base)
      if (isPublicTestkitPath(rel)) continue
      for (const edge of importEdges(read(file))) {
        const resolved = resolvedRel(base, file, edge.specifier)
        const publicHit =
          isPublicTestkitSpecifier(edge.specifier) ||
          (resolved !== undefined && isPublicTestkitPath(resolved))
        const localHit = !publicHit && isProductSource(rel) && resolved?.split('/').includes('testkit')
        if (!publicHit && !localHit) continue
        if (publicHit && testkitImportAllowed(rel)) continue
        problems.push(`${rel}: imports ${edge.specifier}`)
      }
    }
  }
  return problems
}

function referencePackageName(base: string): string {
  const file = join(base, REFERENCE_DIR, 'package.json')
  if (!existsSync(file)) return ''
  const json = JSON.parse(read(file)) as { name?: unknown }
  return typeof json.name === 'string' ? json.name : ''
}

function dependencyNames(json: Record<string, unknown>): string[] {
  const names: string[] = []
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const value = json[field]
    if (value && typeof value === 'object' && !Array.isArray(value)) names.push(...Object.keys(value))
  }
  return names
}

function referenceProblems(base: string): string[] {
  const name = referencePackageName(base)
  if (name === '') return ['reference package is missing']
  const problems: string[] = []
  for (const pkg of packageDocs(base)) {
    if (dependencyNames(pkg.json).includes(name)) problems.push(`${pkg.name} depends on ${name}`)
  }
  for (const file of productSourceFiles(base)) {
    const rel = repoRel(file, base)
    for (const edge of importEdges(read(file))) {
      const resolved = resolvedRel(base, file, edge.specifier)
      const hit =
        edge.specifier === name ||
        edge.specifier.startsWith(`${name}/`) ||
        (resolved !== undefined && (resolved === REFERENCE_DIR || resolved.startsWith(`${REFERENCE_DIR}/`)))
      if (hit) problems.push(`${rel}: imports ${edge.specifier}`)
    }
  }
  return problems
}

function packageDirsNamed(base: string, name: string): string[] {
  return packageDocs(base)
    .filter((pkg) => pkg.name === name)
    .map((pkg) => pkg.dir)
}

function extensionApiValueProblems(base: string, packageName: string): string[] {
  const dirs = packageDirsNamed(base, packageName)
  if (dirs.length !== 1) return [`${packageName} packages: ${dirs.length}`]
  const dir = dirs[0]
  if (!dir) return [`${packageName} packages: 0`]
  const problems: string[] = []
  for (const file of filesUnder(dir)) {
    const rel = repoRel(file, base)
    for (const edge of importEdges(read(file))) {
      if (!edge.value) continue
      const resolved = resolvedRel(base, file, edge.specifier)
      const hit =
        edge.specifier === '@agnes/extension-api' ||
        edge.specifier.startsWith('@agnes/extension-api/') ||
        (resolved !== undefined &&
          (resolved === 'packages/extension-api' || resolved.startsWith('packages/extension-api/')))
      if (hit) problems.push(`${rel}: value-imports ${edge.specifier}`)
    }
  }
  return problems
}

function writeTree(base: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(base, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, text)
  }
}

function withTemp(prefix: string, files: Record<string, string>, run: (base: string) => void): void {
  const base = mkdtempSync(join(tmpdir(), prefix))
  try {
    writeTree(base, files)
    run(base)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}

const providerSample = `export type RuntimeStateStore = StateStoreControl & {
  close(): void
  /** Host-internal. One state-commit covers a model tool batch. */
  commitDispatchBatch(commitId: string): Promise<void>
}
`

const sqlSample = 'export const ddl = `CREATE TABLE IF NOT EXISTS runtime_records (id TEXT)`\n'

const catalogSample = `export const RuntimeServiceCatalog = {
  "agh.state": { "methods": { "open": {}, "lease": {} } }
} as const
`

const interfaceSample = `export interface StateStoreControl {
  open(request: string): void
  lease(request: string): void
}
`

describe('public state methods follow the generated catalog', () => {
  it('matches the generated state interface and keeps batch writers off that set', () => {
    const catalogs = catalogFiles(root)
    const faces = interfaceFiles(root)
    expect(catalogs.map((file) => repoRel(file, root))).toEqual([
      'packages/protocol/gen/ts/runtime-catalog.ts',
    ])
    expect(faces.map((file) => repoRel(file, root))).toEqual([
      'packages/extension-api/src/runtime/public-2.ts',
    ])
    const catalogSource = read(catalogs[0] ?? '')
    const interfaceSource = read(faces[0] ?? '')
    const problems = methodSetProblems(catalogSource, interfaceSource)
    expect(problems, problems.join('\n')).toEqual([])
    const published = new Set(catalogMethodNames(catalogSource, STATE_CONTRACT, true))
    const catalogMethods = new Set(catalogMethodNames(catalogSource, STATE_CONTRACT))
    expect(published.size).toBeGreaterThan(0)
    const provider = read(join(root, PROVIDER_REL))
    const unimplemented = unimplementedNames(provider)
    expect(unimplemented.length).toBeGreaterThan(0)
    expect(unimplemented.filter((name) => !published.has(name))).toEqual([])
    const batches = batchMethodNames(provider)
    expect(batches.length).toBeGreaterThan(0)
    expect(batches.filter((name) => catalogMethods.has(name))).toEqual([])
    expect(interfaceSource.split(/\r?\n/)[0]).toContain('do not edit')
  })

  it('rejects an interface that drops or adds a catalog method', () => {
    expect(methodSetProblems(catalogSample, interfaceSample)).toEqual([])
    const dropped = interfaceSample.replace('lease(request: string): void\n', '')
    const added = `${interfaceSample}  commitDispatchBatch(commitId: string): void\n}\n`.replace(
      '}\n  commitDispatchBatch',
      '  commitDispatchBatch',
    )
    expect(methodSetProblems(catalogSample, dropped).join('\n')).toContain('missing lease')
    expect(methodSetProblems(catalogSample, added).join('\n')).toContain('adds commitDispatchBatch')
  })
})

describe('other packages stay on the public state surface', () => {
  it('does not call a host batch writer or name a state table', () => {
    const batches = batchMethodNames(read(join(root, PROVIDER_REL)))
    const tables = tableNames(stateSql(root))
    expect(batches.length).toBeGreaterThan(0)
    expect(tables.length).toBeGreaterThan(0)
    const problems = bypassProblems(root)
    expect(problems, problems.join('\n')).toEqual([])
  })

  it('rejects a batch call and a state-table read outside the default implementation', () => {
    withTemp(
      'agnes-state-surface-',
      {
        [PROVIDER_REL]: providerSample,
        'packages/host/src/runtime/state/ddl.ts': sqlSample,
        'packages/other/src/call.ts':
          'export const run = (store: { commitDispatchBatch(id: string): void }) => store.commitDispatchBatch("x")\n',
        'packages/other/src/sql.ts': "export const q = 'SELECT id FROM runtime_records'\n",
        'packages/host/src/runtime/state/own.ts':
          "export const own = 'SELECT id FROM runtime_records'\nexport const batch = 'commitDispatchBatch'\n",
        'packages/other/src/note.ts': '// commitDispatchBatch is not a call\nexport const note = 1\n',
      },
      (base) => {
        const problems = bypassProblems(base)
        const text = problems.join('\n')
        expect(text).toContain('packages/other/src/call.ts: calls commitDispatchBatch')
        expect(text).toContain('packages/other/src/sql.ts: reads runtime_records')
        expect(text).not.toContain('packages/host/src/runtime/state/own.ts')
        expect(text).not.toContain('note.ts')
      },
    )
  })
})

describe('production assembly has one entry', () => {
  it('publishes one assembly and no container contract', () => {
    const problems = containerProblems(root)
    expect(problems, problems.join('\n')).toEqual([])
  })

  it('rejects a second assembly, a container export, and a positive container contract', () => {
    withTemp(
      'agnes-assembly-entry-',
      {
        'packages/plugin-runtime/package.json': JSON.stringify({
          name: '@agnes/plugin-runtime',
          exports: {
            '.': './src/index.ts',
            './host': './src/host/index.ts',
            './container': './src/container.ts',
          },
        }),
        'packages/plugin-runtime/src/runtime/cordis-adapter.ts': 'export class FixedCordisAssembly {}\n',
        'packages/plugin-runtime/src/runtime/other.ts': 'export class SecondAssembly {}\n',
        'packages/plugin-runtime/src/host/index.ts':
          "export { FixedCordisAssembly } from '../runtime/cordis-adapter.js'\n",
        'packages/plugin-runtime/src/index.ts': 'export const root = 1\n',
        'packages/plugin-runtime/src/container.ts':
          "export { FixedCordisAssembly } from './runtime/cordis-adapter.js'\n",
        'packages/protocol/gen/ts/runtime-catalog.ts':
          'export const RuntimeServiceCatalog = { "agh.container": { "methods": {} }, "agh.state": { "methods": { "open": {} } } } as const\n',
        'packages/protocol/schema/runtime/bad.json': '{ "const": "agh.container" }\n',
        'packages/protocol/schema/runtime/good.json': '{ "not": { "const": "agh.container" } }\n',
      },
      (base) => {
        const problems = containerProblems(base)
        const text = problems.join('\n')
        expect(text).toContain('SecondAssembly')
        expect(text).toContain('./container')
        expect(text).toContain('catalog publishes agh.container')
        expect(text).toContain('bad.json')
        expect(text).not.toContain('good.json')
      },
    )
  })
})

describe('test fixtures stay out of product source', () => {
  it('lets tests, examples, and the conformance driver import the public testkit', () => {
    const problems = testkitProblems(root)
    expect(problems, problems.join('\n')).toEqual([])
  })

  it('rejects a product import and allows an example and a conformance driver', () => {
    withTemp(
      'agnes-testkit-import-',
      {
        'packages/cli/src/main.ts':
          "import { createTestServiceContainer } from '@agnes/extension-api/testkit'\n",
        'packages/cli/src/local.ts':
          "import { createVerifiedTestRoot } from '../../plugin-runtime/testkit/index.js'\n",
        'packages/host/src/app.ts': "import { createTestHost } from '../testkit/index.js'\n",
        'examples/demo/src/main.ts':
          "import { createRuntimeInboxFixture } from '@agnes/extension-api/testkit'\n",
        'tools/acceptance/runtime/run.ts':
          "import { createRestrictedEffectsFixture } from '../../../packages/extension-api/testkit/index.js'\n",
        'packages/cli/test/main.test.ts':
          "import { createTestServiceContainer } from '@agnes/extension-api/testkit'\n",
      },
      (base) => {
        const problems = testkitProblems(base)
        const text = problems.join('\n')
        expect(text).toContain('packages/cli/src/main.ts')
        expect(text).toContain('packages/cli/src/local.ts')
        expect(text).toContain('packages/host/src/app.ts')
        expect(text).not.toContain('examples/demo/src/main.ts')
        expect(text).not.toContain('tools/acceptance/runtime/run.ts')
        expect(text).not.toContain('main.test.ts')
      },
    )
  })
})

describe('product packages do not depend on the reference package', () => {
  it('keeps the reference package off product dependencies and imports', () => {
    const problems = referenceProblems(root)
    expect(referencePackageName(root)).not.toBe('')
    expect(problems, problems.join('\n')).toEqual([])
  })

  it('rejects a dependency and a relative import of the reference package', () => {
    withTemp(
      'agnes-reference-dep-',
      {
        'examples/runtime-reference/package.json': JSON.stringify({
          name: '@agnes-examples/runtime-reference',
        }),
        'packages/cli/package.json': JSON.stringify({
          name: '@agnes/cli',
          dependencies: { '@agnes-examples/runtime-reference': 'workspace:*' },
        }),
        'packages/cli/src/main.ts':
          "import { sample } from '../../../examples/runtime-reference/src/index.js'\n",
        'packages/host/package.json': JSON.stringify({ name: '@agnes/host', dependencies: {} }),
        'packages/host/src/main.ts': 'export const main = 1\n',
      },
      (base) => {
        const problems = referenceProblems(base)
        const text = problems.join('\n')
        expect(text).toContain('@agnes/cli depends on @agnes-examples/runtime-reference')
        expect(text).toContain('packages/cli/src/main.ts')
        expect(text).not.toContain('@agnes/host depends')
      },
    )
  })
})

describe('sdk and daemon only type-import the extension api', () => {
  it('has no value import in either package', () => {
    const problems = [
      ...extensionApiValueProblems(root, '@agnes/sdk'),
      ...extensionApiValueProblems(root, '@agnes/daemon'),
    ]
    expect(problems, problems.join('\n')).toEqual([])
  })

  it('rejects a value import and allows a type import', () => {
    withTemp(
      'agnes-extension-type-',
      {
        'packages/sdk/package.json': JSON.stringify({ name: '@agnes/sdk' }),
        'packages/sdk/src/value.ts': "import { defineTool } from '@agnes/extension-api/runtime'\n",
        'packages/sdk/src/type-only.ts': "import type { Outcome } from '@agnes/extension-api/runtime'\n",
        'packages/daemon/package.json': JSON.stringify({ name: '@agnes/daemon' }),
        'packages/daemon/src/rel.ts': "import { helper } from '../../extension-api/src/index.js'\n",
      },
      (base) => {
        const sdk = extensionApiValueProblems(base, '@agnes/sdk')
        const daemon = extensionApiValueProblems(base, '@agnes/daemon')
        expect(sdk.join('\n')).toContain('value.ts')
        expect(sdk.join('\n')).not.toContain('type-only.ts')
        expect(daemon.join('\n')).toContain('rel.ts')
      },
    )
  })
})

// The tree still publishes private workspace packages. Do not treat that as done.
it.todo('release builds omit the private mark and workspace protocol dependencies')

// Default service factories are not package runtime entries yet. Do not treat the import ban as done.
it.todo('callers import default service factories only from each package runtime entry')
