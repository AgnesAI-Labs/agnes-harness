import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { importEdges } from './module-edges.js'
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
const GENERATOR_INPUT = /(?:^|\/)tools\/[^/]*gen[^/]*\.(?:ts|mts|mjs)$/
const BANNER_LINE = /^\/\/ .+do not edit\.?$/
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts']
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage'])

type ListedFile = { path: string }
type SnapshotLists = { generatedFiles: ListedFile[]; sourceFiles: ListedFile[]; inputs: ListedFile[] }

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

/** The default runtime blob and artifacts services. */
const RUNTIME_ARTIFACT_SERVICES = [
  'packages/host/src/runtime/artifacts',
  'packages/host/src/runtime/blob',
  'packages/host/src/runtime/providers/artifacts.ts',
  'packages/host/src/runtime/providers/blob.ts',
  'packages/host/src/runtime/authority-copy.ts',
  'packages/host/src/runtime/authority-transfer.ts',
] as const

/** Legacy `{sha256,size,mime}` readers and the legacy reference index; the daemon owns three readers. */
const LEGACY_ARTIFACT_READERS = {
  modules: [
    'packages/host/src/artifact-read-store',
    'packages/host/src/artifact-ref-index',
    'packages/daemon/src/local/artifact-read',
    'packages/daemon/src/local/artifact-read-authority',
    'packages/daemon/src/supervisor/artifact-read',
  ],
  packages: ['@agnes/daemon'],
} as const

/**
 * The legacy artifact write entry: the local artifacts seam, which the base package root loads.
 * Reviewed allowance: the services reuse `private-artifact-store`'s private file primitives
 * (`openPrivateArtifactDatabase`, `createPrivateArtifactStore`) rooted at their own data directory, so
 * it is not listed; artifact-range-revocation.test.ts shows their writes never reach the legacy CAS.
 */
const LEGACY_ARTIFACT_WRITERS = {
  modules: ['packages/base/extensions/artifacts-local/src/seam'],
  packages: ['@agnes/base'],
} as const

/**
 * Value imports, from the given source and every module it loads through relative imports, of one of
 * the legacy `modules` (repo-relative, without extension) or `packages`. A forbidden module is not
 * followed further.
 */
function legacyArtifactViolations(
  base: string,
  roots: readonly string[],
  legacy: Readonly<{ modules: readonly string[]; packages: readonly string[] }>,
): string[] {
  const queue: string[] = []
  for (const root of roots) {
    if (isSourceName(root)) queue.push(join(base, root))
    else eachSourceFile(join(base, root), (file) => queue.push(file))
  }
  const seen = new Set(queue)
  const violations: string[] = []
  for (const file of queue) {
    for (const edge of importEdges(readFileSync(file, 'utf8'))) {
      if (!edge.value) continue
      const named = legacy.packages.some(
        (name) => edge.specifier === name || edge.specifier.startsWith(`${name}/`),
      )
      if (!named && !edge.specifier.startsWith('.')) continue
      const target = resolve(dirname(file), edge.specifier)
      if (named || legacy.modules.includes(normalizeModulePath(repoRelative(target, base)))) {
        violations.push(`${repoRelative(file, base)}: imports ${edge.specifier}`)
        continue
      }
      const stem = target.replace(/\.(?:js|mjs|cjs|ts|tsx|mts|cts)$/, '')
      const next = [`${stem}.ts`, `${stem}.tsx`, join(stem, 'index.ts')].find((path) => existsSync(path))
      if (next !== undefined && !seen.has(next)) {
        seen.add(next)
        queue.push(next)
      }
    }
  }
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
 * Filenames come from the published snapshot. Banner text comes from generators listed in
 * `compileEvidence.inputs`: a generated file matches when its first line is one of those
 * banners, or its second line is and its first line is a line that generator emits.
 * A handwritten sibling is legal only when `sourceFiles` or
 * `compileEvidence.inputs` lists it. Directories the snapshot does not mention stay open.
 * Digests and the public surface are not compared.
 */
function listedGeneratorSource(base: string, inputs: readonly ListedFile[]): string {
  const parts: string[] = []
  for (const file of inputs) {
    if (!GENERATOR_INPUT.test(file.path)) continue
    const abs = join(base, file.path)
    if (!existsSync(abs)) continue
    parts.push(readFileSync(abs, 'utf8'))
  }
  return parts.join('\n')
}

function bannersFromGenerators(source: string): Set<string> {
  const banners = new Set<string>()
  const bannerText = /\/\/ [^\r\n]*?do not edit\.?(?=['"`\\]|$)/g
  for (const line of source.split(/\r?\n/)) {
    for (const match of line.matchAll(bannerText)) {
      if (BANNER_LINE.test(match[0])) banners.add(match[0])
    }
  }
  return banners
}

function carriesGeneratorBanner(text: string, source: string, banners: ReadonlySet<string>): boolean {
  const lines = text.split(/\r?\n/)
  const first = lines[0] ?? ''
  if (banners.has(first)) return true
  const second = lines[1] ?? ''
  // Generators embed an emitted prelude as a line ending in the two characters "\" and "n".
  return second !== '' && banners.has(second) && first !== '' && source.includes(`${first}\\n`)
}

function generationProblems(base: string, snapshot: SnapshotLists): string[] {
  const problems: string[] = []
  const generatorSource = listedGeneratorSource(base, snapshot.inputs)
  const banners = bannersFromGenerators(generatorSource)
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
    if (!carriesGeneratorBanner(readFileSync(abs, 'utf8'), generatorSource, banners)) {
      problems.push(`${file.path}: missing generator banner`)
    }
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

describe('default runtime artifact services and legacy artifact storage', () => {
  it('load no legacy artifact reader or reference index', () => {
    const violations = legacyArtifactViolations(root, RUNTIME_ARTIFACT_SERVICES, LEGACY_ARTIFACT_READERS)
    expect(violations, violations.join('\n')).toEqual([])
  })

  it('load no legacy artifact write entry', () => {
    const violations = legacyArtifactViolations(root, RUNTIME_ARTIFACT_SERVICES, LEGACY_ARTIFACT_WRITERS)
    expect(violations, violations.join('\n')).toEqual([])
  })

  it('rejects a legacy import made directly, through a loaded module or by package, and ignores types and comments', () => {
    withTemp(
      'agnes-runtime-artifacts-',
      {
        'packages/host/src/runtime/blob/direct.ts': "import { open } from '../../artifact-read-store.js'\n",
        'packages/host/src/runtime/providers/blob.ts': "import { helper } from '../helper.js'\n",
        'packages/host/src/runtime/helper.ts': "export { index } from '../artifact-ref-index.js'\n",
        'packages/host/src/runtime/providers/artifacts.ts': "const read = await import('@agnes/daemon')\n",
        'packages/host/src/runtime/authority-copy.ts':
          "import type { Store } from '../artifact-read-store.js'\n// import '../artifact-read-store.js'\n",
        'packages/host/src/runtime/authority-transfer.ts':
          "import { put } from '../private-artifact-store.js'\n",
        'packages/host/src/runtime/artifacts/seam.ts': "import { artifactsLocal } from '@agnes/base'\n",
        'packages/host/src/unloaded.ts': "import { open } from './artifact-read-store.js'\n",
      },
      (base) => {
        const files = (legacy: Parameters<typeof legacyArtifactViolations>[2]) =>
          legacyArtifactViolations(base, RUNTIME_ARTIFACT_SERVICES, legacy)
            .map((violation) => violation.split(':')[0])
            .sort()
        expect(files(LEGACY_ARTIFACT_READERS)).toEqual([
          'packages/host/src/runtime/blob/direct.ts',
          'packages/host/src/runtime/helper.ts',
          'packages/host/src/runtime/providers/artifacts.ts',
        ])
        expect(files(LEGACY_ARTIFACT_WRITERS)).toEqual(['packages/host/src/runtime/artifacts/seam.ts'])
      },
    )
  })
})

describe('published runtime generation manifest', () => {
  function publishedSnapshot(): SnapshotLists {
    return asSnapshot(JSON.parse(readFileSync(join(root, SNAPSHOT_REL), 'utf8')))
  }

  it('checks src siblings from the snapshot lists', () => {
    const snapshot = publishedSnapshot()
    const problems = generationProblems(root, snapshot)
    const structural = problems.filter((item) => !item.endsWith(': missing generator banner'))
    expect(structural, structural.join('\n')).toEqual([])
    const gaps = problems.filter((item) => item.endsWith(': missing generator banner'))
    expect(snapshot.generatedFiles.length - gaps.length).toBeGreaterThan(0)
  })

  // A published generated file can still lack a banner taken from the generators the snapshot
  // lists. That file is not accepted. Replace this todo with an assertion that generation
  // problems are empty once every generated entry carries such a banner. Do not add a path
  // exception here.
  it.todo('every snapshot generated file carries a banner emitted by a listed generator')

  it('rejects a manifest entry that is missing or has no generator banner', () => {
    const banner = '// generated from schema/runtime by tools/gen-runtime.ts — do not edit'
    const snapshot: SnapshotLists = {
      generatedFiles: [
        { path: 'packages/protocol/src/runtime/index.ts' },
        { path: 'packages/protocol/src/runtime/missing.ts' },
      ],
      sourceFiles: [],
      inputs: [{ path: 'packages/protocol/tools/gen-runtime.ts' }],
    }
    withTemp(
      'agnes-generated-banner-',
      {
        'packages/protocol/tools/gen-runtime.ts': `export const header = ${JSON.stringify(`${banner}\n`)}\n`,
        'packages/protocol/src/runtime/index.ts': 'export const handwritten = 1\n',
      },
      (base) => {
        const problems = generationProblems(base, snapshot)
        expect(problems.join('\n')).toContain('index.ts: missing generator banner')
        expect(problems.join('\n')).toContain('missing.ts: missing')
      },
    )
  })

  it('reads banners and a leading prelude from the generators the snapshot lists', () => {
    const banner = '// generated from runtime client metadata — do not edit'
    const prelude = "import type { Page } from './runtime-public.js'"
    const snapshot: SnapshotLists = {
      generatedFiles: [
        { path: 'packages/demo/src/runtime/direct.ts' },
        { path: 'packages/demo/src/runtime/split.ts' },
        { path: 'packages/demo/src/runtime/foreign.ts' },
        { path: 'packages/demo/src/runtime/note.ts' },
      ],
      sourceFiles: [],
      inputs: [{ path: 'packages/demo/tools/gen-sample.ts' }],
    }
    withTemp(
      'agnes-generated-prelude-',
      {
        'packages/demo/tools/gen-sample.ts': `export const header = ${JSON.stringify(`${banner}\n`)}\nexport const prelude = ${JSON.stringify(`${prelude}\n`)}\n`,
        'packages/demo/src/runtime/direct.ts': `${banner}\nexport {}\n`,
        'packages/demo/src/runtime/split.ts': `${prelude}\n${banner}\nexport {}\n`,
        'packages/demo/src/runtime/foreign.ts': `import { read } from 'elsewhere'\n${banner}\n`,
        'packages/demo/src/runtime/note.ts': '// owned elsewhere\nexport {}\n',
      },
      (base) => {
        const problems = generationProblems(base, snapshot)
        expect(problems).toEqual([
          'packages/demo/src/runtime/foreign.ts: missing generator banner',
          'packages/demo/src/runtime/note.ts: missing generator banner',
        ])
      },
    )
  })

  it('rejects an unlisted sibling and ignores files outside generated src directories', () => {
    const banner = '// generated from schema/runtime by tools/gen-runtime.ts — do not edit'
    const snapshot: SnapshotLists = {
      generatedFiles: [{ path: 'packages/demo/src/runtime/index.ts' }],
      sourceFiles: [{ path: 'packages/demo/src/runtime/kept.ts' }],
      inputs: [{ path: 'packages/demo/tools/gen-runtime.ts' }],
    }
    withTemp(
      'agnes-generated-sibling-',
      {
        'packages/demo/tools/gen-runtime.ts': `export const header = ${JSON.stringify(`${banner}\n`)}\n`,
        'packages/demo/src/runtime/index.ts': `${banner}\nexport {}\n`,
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
