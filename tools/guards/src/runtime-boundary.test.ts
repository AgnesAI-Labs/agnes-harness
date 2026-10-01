import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { createScanner } from 'typescript/unstable/ast/scanner'
import { describe, expect, it } from 'vitest'
import { isTestFile, repoRoot } from './repo.js'

const root = repoRoot()

/**
 * Product source is every `src` tree under `packages/`, including nested packages. `tools/**` is not
 * product source. Test, acceptance, and measurement drivers there are trusted and may import host
 * internals; this guard must keep passing when those drivers do. The same import under another
 * package's `src` is still a violation. Host source may import its own storage. The public
 * `@agnes/host` entry is not an internal path.
 */
const HOST_INTERNAL_PREFIXES = ['src/runtime', 'src/adapters/storage-sqlite', 'src/adapters/ddl'] as const

const PLATFORM_PACKAGES = ['@agnes/core', '@agnes/host', '@agnes/daemon', '@agnes/cordis'] as const
const NODE_BARE = new Set([
  'fs',
  'path',
  'os',
  'child_process',
  'net',
  'http',
  'https',
  'sqlite',
  'module',
  'worker_threads',
])

const SNAPSHOT_REL = 'artifacts/runtime-prototype-api/v1/snapshot.json'
const GENERATED_BANNER = /^\/\/ generated from \S+ by tools\/gen(?:[-\w.]*)?\.ts — do not edit$/
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts']
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage'])

type Edge = { specifier: string; value: boolean }
type ListedFile = { path: string }
type SnapshotLists = { generatedFiles: ListedFile[]; sourceFiles: ListedFile[]; inputs: ListedFile[] }

function at(tokens: readonly string[], index: number): string {
  return tokens[index] ?? ''
}

function scanTokens(source: string): string[] {
  const scanner = createScanner(true, 0, source)
  const tokens: string[] = []
  for (;;) {
    scanner.scan()
    const text = scanner.getTokenText()
    if (text === '') return tokens
    tokens.push(text)
  }
}

function quoted(token: string): string | undefined {
  if (
    (token.startsWith("'") && token.endsWith("'") && token.length >= 2) ||
    (token.startsWith('"') && token.endsWith('"') && token.length >= 2)
  ) {
    return token.slice(1, -1)
  }
  if (token.startsWith('`') && token.endsWith('`') && token.length >= 2 && !token.includes('${')) {
    return token.slice(1, -1)
  }
  return undefined
}

/** Value edges follow `export *` / `export { } from` and mixed `import { type A, B }`. */
function importEdges(source: string): Edge[] {
  const tokens = scanTokens(source)
  const edges: Edge[] = []
  for (let index = 0; index < tokens.length; index++) {
    const token = at(tokens, index)
    const next = at(tokens, index + 1)
    if (token === 'require' && at(tokens, index - 1) !== '.' && next === '(') {
      const specifier = quoted(at(tokens, index + 2))
      if (specifier !== undefined) edges.push({ specifier, value: true })
      continue
    }
    if (token === 'import' && next !== '.') {
      if (next === '(') {
        const specifier = quoted(at(tokens, index + 2))
        if (specifier !== undefined) edges.push({ specifier, value: true })
        continue
      }
      const side = quoted(next)
      if (side !== undefined) {
        edges.push({ specifier: side, value: true })
        continue
      }
      const edge = importClause(tokens, index + 1)
      if (edge) edges.push(edge)
      continue
    }
    if (token === 'export') {
      const edge = exportClause(tokens, index + 1)
      if (edge) edges.push(edge)
    }
  }
  return edges
}

function importClause(tokens: readonly string[], start: number): Edge | undefined {
  let index = start
  let typeOnly = false
  if (at(tokens, index) === 'type' && at(tokens, index + 1) !== 'from') {
    typeOnly = true
    index++
  }
  let namedValue = false
  let sawBrace = false
  if (!['{', '*', 'from'].includes(at(tokens, index))) {
    if (!typeOnly) namedValue = true
    index++
    if (at(tokens, index) === ',') index++
  }
  if (at(tokens, index) === '*') {
    if (!typeOnly) namedValue = true
    index++
    if (at(tokens, index) === 'as') index += 2
  }
  if (at(tokens, index) === '{') {
    sawBrace = true
    const named = namedBindings(tokens, index, typeOnly)
    index = named.index
    if (named.value) namedValue = true
  }
  if (at(tokens, index) !== 'from') return undefined
  const specifier = quoted(at(tokens, index + 1))
  if (specifier === undefined) return undefined
  return { specifier, value: typeOnly ? false : sawBrace ? namedValue : true }
}

function exportClause(tokens: readonly string[], start: number): Edge | undefined {
  let index = start
  let typeOnly = false
  if (at(tokens, index) === 'type' && ['{', '*'].includes(at(tokens, index + 1))) {
    typeOnly = true
    index++
  }
  let namedValue = false
  if (at(tokens, index) === '*') {
    namedValue = !typeOnly
    index++
    if (at(tokens, index) === 'as') index += 2
  } else if (at(tokens, index) === '{') {
    const named = namedBindings(tokens, index, typeOnly)
    index = named.index
    namedValue = named.value
  } else {
    return undefined
  }
  if (at(tokens, index) !== 'from') return undefined
  const specifier = quoted(at(tokens, index + 1))
  if (specifier === undefined) return undefined
  return { specifier, value: typeOnly ? false : namedValue }
}

function namedBindings(
  tokens: readonly string[],
  start: number,
  typeOnly: boolean,
): { index: number; value: boolean } {
  let index = start + 1
  let value = false
  while (index < tokens.length && at(tokens, index) !== '}') {
    const before = index
    let bindingIsType = typeOnly
    if (at(tokens, index) === 'type') {
      bindingIsType = true
      index++
    }
    if (!bindingIsType && ![',', '}'].includes(at(tokens, index))) value = true
    if (![',', '}'].includes(at(tokens, index))) index++
    if (at(tokens, index) === 'as') index += 2
    if (at(tokens, index) === ',') index++
    if (index === before) index++
  }
  if (at(tokens, index) === '}') index++
  return { index, value }
}

function posix(path: string): string {
  return path.split(sep).join('/')
}

function repoRelative(file: string, base = root): string {
  return posix(relative(base, file))
}

function isSourceName(name: string): boolean {
  return SOURCE_EXTENSIONS.some((ext) => name.endsWith(ext))
}

function eachSourceFile(dir: string, visit: (file: string) => void): void {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) eachSourceFile(full, visit)
    else if (isSourceName(entry.name) && !isTestFile(entry.name)) visit(full)
  }
}

/** Enter every `packages/**\/src` tree. Nested packages count; `packages/**\/test` does not. */
function eachProductSourceFile(base: string, visit: (file: string) => void): void {
  const walk = (dir: string, inSrc: boolean): void => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full, inSrc || entry.name === 'src')
      else if (inSrc && isSourceName(entry.name) && !isTestFile(entry.name)) visit(full)
    }
  }
  walk(join(base, 'packages'), false)
}

function normalizeModulePath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/[?#].*$/, '')
    .replace(/\.(?:js|mjs|cjs|ts|tsx|mts|cts)$/, '')
}

function hasBoundaryPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`)
}

function isHostInternalPath(path: string): boolean {
  const norm = normalizeModulePath(path)
  return HOST_INTERNAL_PREFIXES.some((prefix) => hasBoundaryPrefix(norm, prefix))
}

function hostInternalSpecifier(base: string, file: string, specifier: string): boolean {
  if (specifier.startsWith('@agnes/host/')) return isHostInternalPath(specifier.slice('@agnes/host/'.length))
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) return false
  const abs = specifier.startsWith('.') ? resolve(dirname(file), specifier) : specifier
  const rel = posix(relative(join(base, 'packages/host'), abs))
  if (rel.startsWith('..')) return false
  return isHostInternalPath(rel)
}

function hostInternalViolations(base: string): string[] {
  const violations: string[] = []
  eachProductSourceFile(base, (file) => {
    if (hasBoundaryPrefix(repoRelative(file, base), 'packages/host')) return
    for (const edge of importEdges(readFileSync(file, 'utf8'))) {
      if (!hostInternalSpecifier(base, file, edge.specifier)) continue
      violations.push(`${repoRelative(file, base)}: imports ${edge.specifier}`)
    }
  })
  return violations
}

function isPlatformSpecifier(specifier: string): boolean {
  if (specifier.startsWith('node:')) return true
  if (specifier === 'better-sqlite3' || specifier.startsWith('better-sqlite3/')) return true
  if (specifier === 'cordis' || specifier.startsWith('cordis/')) return true
  if (specifier === '@cordisjs' || specifier.startsWith('@cordisjs/')) return true
  if (PLATFORM_PACKAGES.some((name) => specifier === name || specifier.startsWith(`${name}/`))) return true
  const bare = specifier.split('/')[0] ?? specifier
  return !specifier.startsWith('@') && !specifier.startsWith('.') && NODE_BARE.has(bare)
}

function resolvesInside(base: string, file: string, specifier: string, prefix: string): boolean {
  if (!specifier.startsWith('.')) return false
  const rel = posix(relative(join(base, prefix), resolve(dirname(file), specifier)))
  return rel === '' || (!rel.startsWith('..') && !isAbsolutePosix(rel))
}

function isAbsolutePosix(path: string): boolean {
  return path.startsWith('/')
}

function layerViolations(base: string, dir: string, reactValueIsForbidden: boolean): string[] {
  const violations: string[] = []
  const prefixes = ['packages/core', 'packages/host', 'packages/daemon', 'packages/cordis']
  eachSourceFile(join(base, dir), (file) => {
    for (const edge of importEdges(readFileSync(file, 'utf8'))) {
      const react = edge.specifier === 'react' || edge.specifier.startsWith('react/')
      if (react) {
        if (reactValueIsForbidden && edge.value)
          violations.push(`${repoRelative(file, base)}: value-imports ${edge.specifier}`)
        continue
      }
      const relativeHit = prefixes.some((prefix) => resolvesInside(base, file, edge.specifier, prefix))
      if (!isPlatformSpecifier(edge.specifier) && !relativeHit) continue
      violations.push(`${repoRelative(file, base)}: imports ${edge.specifier}`)
    }
  })
  return violations
}

function hostDaemonViolations(base: string): string[] {
  const violations: string[] = []
  eachSourceFile(join(base, 'packages/host/src'), (file) => {
    for (const edge of importEdges(readFileSync(file, 'utf8'))) {
      const named = edge.specifier === '@agnes/daemon' || edge.specifier.startsWith('@agnes/daemon/')
      if (!named && !resolvesInside(base, file, edge.specifier, 'packages/daemon')) continue
      violations.push(`${repoRelative(file, base)}: imports ${edge.specifier}`)
    }
  })
  return violations
}

function testkitCoreViolations(base: string): string[] {
  const violations: string[] = []
  const names = ['@agnes/core', '@agnes/host', '@agnes/daemon']
  eachSourceFile(join(base, 'packages/extension-api/testkit'), (file) => {
    for (const edge of importEdges(readFileSync(file, 'utf8'))) {
      if (!edge.value) continue
      const named = names.some((name) => edge.specifier === name || edge.specifier.startsWith(`${name}/`))
      const relativeHit = ['packages/core', 'packages/host', 'packages/daemon'].some((prefix) =>
        resolvesInside(base, file, edge.specifier, prefix),
      )
      if (!named && !relativeHit) continue
      violations.push(`${repoRelative(file, base)}: value-imports ${edge.specifier}`)
    }
  })
  return violations
}

function pathsOf(value: unknown, label: string): ListedFile[] {
  if (!Array.isArray(value)) throw new Error(`${label} is not a list`)
  return value.map((item) => {
    if (typeof item !== 'object' || item === null || typeof (item as { path?: unknown }).path !== 'string') {
      throw new Error(`${label} entry is missing a path`)
    }
    return { path: (item as { path: string }).path }
  })
}

function asSnapshot(value: unknown): SnapshotLists {
  if (typeof value !== 'object' || value === null) throw new Error('snapshot is not an object')
  const record = value as Record<string, unknown>
  const evidence = record.compileEvidence
  if (typeof evidence !== 'object' || evidence === null)
    throw new Error('snapshot is missing compileEvidence')
  return {
    generatedFiles: pathsOf(record.generatedFiles, 'generatedFiles'),
    sourceFiles: pathsOf(record.sourceFiles, 'sourceFiles'),
    inputs: pathsOf((evidence as { inputs?: unknown }).inputs, 'compileEvidence.inputs'),
  }
}

/**
 * Filenames come from the published snapshot: `generatedFiles` must exist and start with the
 * generator banner. A handwritten sibling is legal only when `sourceFiles` or
 * `compileEvidence.inputs` lists it. Directories that snapshot does not mention stay open.
 * Digests and the public surface are not compared.
 */
function generationProblems(base: string, snapshot: SnapshotLists): string[] {
  const problems: string[] = []
  const allowed = new Set(
    [...snapshot.generatedFiles, ...snapshot.sourceFiles, ...snapshot.inputs].map((file) => file.path),
  )
  const closedDirs = new Set<string>()
  for (const file of snapshot.generatedFiles) {
    const abs = join(base, file.path)
    if (!existsSync(abs)) {
      problems.push(`${file.path}: missing`)
      continue
    }
    const first = readFileSync(abs, 'utf8').split(/\r?\n/, 1)[0] ?? ''
    if (!GENERATED_BANNER.test(first)) problems.push(`${file.path}: missing generator banner`)
    const dir = posix(dirname(file.path))
    if (dir.split('/').includes('src')) closedDirs.add(dir)
  }
  for (const dir of closedDirs) {
    const abs = join(base, dir)
    if (!existsSync(abs)) continue
    for (const name of readdirSync(abs)) {
      if (!isSourceName(name)) continue
      const rel = `${dir}/${name}`
      if (!allowed.has(rel)) problems.push(`${rel}: not listed by the published snapshot`)
    }
  }
  return problems
}

function packageExports(base: string, rel: string): Record<string, unknown> {
  const json = JSON.parse(readFileSync(join(base, rel), 'utf8')) as { exports?: unknown }
  if (typeof json.exports !== 'object' || json.exports === null) throw new Error(`${rel} is missing exports`)
  return json.exports as Record<string, unknown>
}

function publicRuntimeSpecifiers(base: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  for (const rel of ['packages/protocol/package.json', 'packages/extension-api/package.json']) {
    const json = JSON.parse(readFileSync(join(base, rel), 'utf8')) as { name?: unknown; exports?: unknown }
    const name = typeof json.name === 'string' ? json.name : ''
    const specs = new Set<string>()
    const exportsField = packageExports(base, rel)
    for (const key of Object.keys(exportsField)) {
      if (
        key === './runtime' ||
        key.startsWith('./runtime/') ||
        key === './client' ||
        key.startsWith('./client/')
      ) {
        specs.add(`${name}${key.slice(1)}`)
      }
    }
    out.set(name, specs)
  }
  return out
}

function isAllowedRuntimeSpecifier(specifier: string, allow: Set<string>): boolean {
  if (allow.has(specifier)) return true
  return allow.has(specifier.replace(/\.(?:js|ts)$/, ''))
}

function runtimePortHit(specifier: string, allow: Map<string, Set<string>>): string | undefined {
  for (const [name, specs] of allow) {
    for (const prefix of ['/runtime', '/client', '/src/runtime', '/src/client']) {
      const head = `${name}${prefix}`
      if (specifier !== head && !specifier.startsWith(`${head}/`)) continue
      if (isAllowedRuntimeSpecifier(specifier, specs)) return undefined
      return specifier
    }
  }
  return undefined
}

function internalRuntimeDirs(rel: string): string | undefined {
  const stripped = normalizeModulePath(rel)
  for (const dir of [
    'packages/protocol/src/runtime',
    'packages/extension-api/src/runtime',
    'packages/extension-api/src/client',
  ]) {
    if (hasBoundaryPrefix(stripped, dir)) return dir
  }
  return undefined
}

function ownerMayImport(fromRel: string, dir: string): boolean {
  if (dir.startsWith('packages/protocol/') && hasBoundaryPrefix(fromRel, 'packages/protocol')) return true
  return dir.startsWith('packages/extension-api/') && hasBoundaryPrefix(fromRel, 'packages/extension-api')
}

function internalRuntimePortViolations(base: string): string[] {
  const allow = publicRuntimeSpecifiers(base)
  const violations: string[] = []
  eachProductSourceFile(base, (file) => {
    const fromRel = repoRelative(file, base)
    for (const edge of importEdges(readFileSync(file, 'utf8'))) {
      const byName = runtimePortHit(edge.specifier, allow)
      if (byName !== undefined) {
        violations.push(`${fromRel}: imports ${edge.specifier}`)
        continue
      }
      if (!edge.specifier.startsWith('.')) continue
      const resolved = posix(relative(base, resolve(dirname(file), edge.specifier)))
      const dir = internalRuntimeDirs(resolved)
      if (dir === undefined || ownerMayImport(fromRel, dir)) continue
      violations.push(`${fromRel}: imports ${edge.specifier}`)
    }
  })
  return violations
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

describe('module edges', () => {
  it('keeps type-only imports and comments out of the value graph', () => {
    const edges = importEdges(`
      import type { ReactElement } from 'react'
      import { type A, B } from 'mod'
      import { type Only } from 'types'
      export type * from 'etype'
      export * from './a.js'
      export { x } from 'named'
      export type { x } from 'etype2'
      export { type x, y } from 'mixed'
      import 'side'
      import type from 'default-name'
      const x = import('dyn')
      const y = require('req')
      /* import x from 'c' */
      import { z } from 'real'
    `)
    expect(edges).toEqual([
      { specifier: 'react', value: false },
      { specifier: 'mod', value: true },
      { specifier: 'types', value: false },
      { specifier: 'etype', value: false },
      { specifier: './a.js', value: true },
      { specifier: 'named', value: true },
      { specifier: 'etype2', value: false },
      { specifier: 'mixed', value: true },
      { specifier: 'side', value: true },
      { specifier: 'default-name', value: true },
      { specifier: 'dyn', value: true },
      { specifier: 'req', value: true },
      { specifier: 'real', value: true },
    ])
  })
})

describe('protocol runtime module boundary', () => {
  it('does not import core, host, daemon, cordis, or node platform modules', () => {
    const violations = layerViolations(root, 'packages/protocol/src/runtime', false)
    expect(violations, violations.join('\n')).toEqual([])
  })

  it('rejects a node platform import written into protocol runtime source', () => {
    withTemp(
      'agnes-protocol-runtime-',
      {
        'packages/protocol/src/runtime/bad.ts': "import { readFileSync } from 'node:fs'\n",
        'packages/protocol/src/runtime/relative.ts': "import { x } from '../../../host/src/index.js'\n",
        'packages/protocol/src/runtime/ok.ts': "import { jcs } from '../jcs.js'\n",
      },
      (base) => {
        const violations = layerViolations(base, 'packages/protocol/src/runtime', false)
        expect(violations.join('\n')).toContain('bad.ts')
        expect(violations.join('\n')).toContain('relative.ts')
        expect(violations.join('\n')).not.toContain('ok.ts')
      },
    )
  })
})

describe('extension-api runtime and client module boundary', () => {
  it('stays off core, host, daemon, node, and sqlite, and only type-imports react', () => {
    const runtime = layerViolations(root, 'packages/extension-api/src/runtime', true)
    const client = layerViolations(root, 'packages/extension-api/src/client', true)
    expect([...runtime, ...client], [...runtime, ...client].join('\n')).toEqual([])
  })

  it('rejects a value import of react and allows a type import', () => {
    withTemp(
      'agnes-extension-surface-',
      {
        'packages/extension-api/src/client/value.ts': "import { createElement } from 'react'\n",
        'packages/extension-api/src/client/type-only.ts': "import type { ReactElement } from 'react'\n",
        'packages/extension-api/src/runtime/sqlite.ts': "import Database from 'better-sqlite3'\n",
      },
      (base) => {
        const client = layerViolations(base, 'packages/extension-api/src/client', true)
        const runtime = layerViolations(base, 'packages/extension-api/src/runtime', true)
        expect(client.join('\n')).toContain('value.ts')
        expect(client.join('\n')).not.toContain('type-only.ts')
        expect(runtime.join('\n')).toContain('sqlite.ts')
      },
    )
  })
})

describe('host source does not import the daemon package', () => {
  it('has no static daemon import under packages/host/src', () => {
    const violations = hostDaemonViolations(root)
    expect(violations, violations.join('\n')).toEqual([])
  })

  it('rejects a daemon import added under host source', () => {
    withTemp(
      'agnes-host-daemon-',
      {
        'packages/host/src/bad.ts': "import { start } from '@agnes/daemon'\n",
        'packages/host/src/relative.ts': "export { main } from '../../daemon/src/index.js'\n",
        'packages/host/src/mention.ts': "const owner = '@agnes/daemon'\n",
      },
      (base) => {
        const violations = hostDaemonViolations(base)
        expect(violations.join('\n')).toContain('bad.ts')
        expect(violations.join('\n')).toContain('relative.ts')
        expect(violations.join('\n')).not.toContain('mention.ts')
      },
    )
  })
})

describe('published runtime generation manifest', () => {
  it('checks generator banners and src siblings from the snapshot lists', () => {
    const problems = generationProblems(
      root,
      asSnapshot(JSON.parse(readFileSync(join(root, SNAPSHOT_REL), 'utf8'))),
    )
    expect(problems, problems.join('\n')).toEqual([])
  })

  it('rejects a manifest entry that is missing or has no generator banner', () => {
    const snapshot: SnapshotLists = {
      generatedFiles: [
        { path: 'packages/protocol/src/runtime/index.ts' },
        { path: 'packages/protocol/src/runtime/missing.ts' },
      ],
      sourceFiles: [],
      inputs: [],
    }
    withTemp(
      'agnes-generated-banner-',
      {
        'packages/protocol/src/runtime/index.ts': 'export const handwritten = 1\n',
      },
      (base) => {
        const problems = generationProblems(base, snapshot)
        expect(problems.join('\n')).toContain('index.ts: missing generator banner')
        expect(problems.join('\n')).toContain('missing.ts: missing')
      },
    )
  })

  it('rejects an unlisted sibling and ignores files outside generated src directories', () => {
    const banner = '// generated from schema/runtime by tools/gen-runtime.ts — do not edit\nexport {}\n'
    const snapshot: SnapshotLists = {
      generatedFiles: [{ path: 'packages/demo/src/runtime/index.ts' }],
      sourceFiles: [{ path: 'packages/demo/src/runtime/kept.ts' }],
      inputs: [],
    }
    withTemp(
      'agnes-generated-sibling-',
      {
        'packages/demo/src/runtime/index.ts': banner,
        'packages/demo/src/runtime/kept.ts': 'export const kept = 1\n',
        'packages/demo/src/runtime/extra.ts': 'export const extra = 1\n',
        'packages/demo/src/other/hand.ts': 'export const hand = 1\n',
      },
      (base) => {
        const problems = generationProblems(base, snapshot)
        expect(problems).toEqual(['packages/demo/src/runtime/extra.ts: not listed by the published snapshot'])
      },
    )
  })
})

describe('product source does not import host runtime or sqlite storage internals', () => {
  it('finds none in package source, while the public host entry stays available', () => {
    const violations = hostInternalViolations(root)
    expect(violations, violations.join('\n')).toEqual([])
  })

  it('rejects the import under another package src and ignores tools, host, and tests', () => {
    withTemp(
      'agnes-host-internal-',
      {
        'packages/other/src/by-specifier.ts': "import { open } from '@agnes/host/src/runtime/store.js'\n",
        'packages/other/src/barrel.ts': "import { sessions } from '@agnes/host'\n",
        'packages/other/src/note.ts':
          "// import { open } from '@agnes/host/src/runtime/store.js'\nexport const note = 1\n",
        'packages/other/src/skipped.test.ts':
          "import { open } from '@agnes/host/src/adapters/ddl/index.js'\n",
        'packages/base/extensions/sample/src/by-relative.ts':
          "import { open } from '../../../../host/src/adapters/storage-sqlite.js'\n",
        'packages/host/src/runtime/local.ts': "import { open } from '../adapters/storage-sqlite.js'\n",
        'tools/acceptance/runtime/prototype/driver.ts':
          "import { open } from '@agnes/host/src/runtime/store.js'\n",
        'tools/bench-runtime-sample.ts': "import { open } from '@agnes/host/src/adapters/ddl.js'\n",
      },
      (base) => {
        const violations = hostInternalViolations(base)
        const text = violations.join('\n')
        expect(text).toContain('packages/other/src/by-specifier.ts')
        expect(text).toContain('packages/base/extensions/sample/src/by-relative.ts')
        expect(text).not.toContain('packages/other/src/barrel.ts')
        expect(text).not.toContain('packages/other/src/note.ts')
        expect(text).not.toContain('skipped.test.ts')
        expect(text).not.toContain('packages/host/')
        expect(text).not.toContain('tools/')
      },
    )
  })
})

describe('extension-api testkit core imports', () => {
  it('does not value-import core, host, or the daemon', () => {
    const violations = testkitCoreViolations(root)
    expect(violations, violations.join('\n')).toEqual([])
  })

  it('rejects a value import of core and allows the type-only transport import', () => {
    withTemp(
      'agnes-testkit-core-',
      {
        'packages/extension-api/testkit/value.ts': "import { RemoteTransport } from '@agnes/core'\n",
        'packages/extension-api/testkit/type-only.ts':
          "import assert from 'node:assert/strict'\nimport type { RemoteTransport } from '@agnes/core'\n",
      },
      (base) => {
        const violations = testkitCoreViolations(base)
        expect(violations.join('\n')).toContain('value.ts')
        expect(violations.join('\n')).not.toContain('type-only.ts')
      },
    )
  })
})

describe('public runtime and client entries', () => {
  it('rejects deep runtime imports from other package source', () => {
    const violations = internalRuntimePortViolations(root)
    expect(violations, violations.join('\n')).toEqual([])
  })

  it('reads allowed subpaths from package exports and rejects an unexported one', () => {
    withTemp(
      'agnes-runtime-port-',
      {
        'packages/protocol/package.json': JSON.stringify({
          name: '@agnes/protocol',
          exports: { './runtime': './src/runtime/index.ts', './gen/*': './gen/ts/*.ts' },
        }),
        'packages/extension-api/package.json': JSON.stringify({
          name: '@agnes/extension-api',
          exports: {
            './runtime': './src/runtime/index.ts',
            './runtime/authoring': './src/runtime/authoring.ts',
            './client': './src/client/index.ts',
          },
        }),
        'packages/other/src/public.ts': "import { helper } from '@agnes/extension-api/runtime/authoring'\n",
        'packages/other/src/wire.ts': "import { Session } from '@agnes/protocol/gen/session-v1'\n",
        'packages/other/src/deep.ts':
          "import type { State } from '@agnes/extension-api/runtime/public-api'\n",
        'packages/other/src/rel.ts': "import { view } from '../../extension-api/src/client/index.js'\n",
        'packages/extension-api/src/runtime/local.ts': "import type { State } from './public-api.js'\n",
        'packages/other/src/note.ts':
          "// import { x } from '@agnes/protocol/src/runtime/public.ts'\nexport const note = 1\n",
      },
      (base) => {
        const violations = internalRuntimePortViolations(base)
        const text = violations.join('\n')
        expect(text).toContain('packages/other/src/deep.ts')
        expect(text).toContain('packages/other/src/rel.ts')
        expect(text).not.toContain('packages/other/src/public.ts')
        expect(text).not.toContain('packages/other/src/wire.ts')
        expect(text).not.toContain('packages/extension-api/src/runtime/local.ts')
        expect(text).not.toContain('note.ts')
      },
    )
  })
})
