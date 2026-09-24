import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { repoRoot } from './repo.js'

type DependencyGroup = 'dependencies' | 'devDependencies' | 'optionalDependencies' | 'peerDependencies'

type DirectDependency = {
  name: string
  versions: Set<string>
  consumers: Set<string>
  groups: Set<DependencyGroup>
}

type ProvenanceEntry = {
  name: string
  version: string
  license: string
  source: string
  purpose: string
  rationale: string
  consumers: string[]
}

type RegisteredProvenance = ProvenanceEntry & {
  category: 'runtime' | 'build'
}

type ProvenanceFile = {
  scope: string
  packages: ProvenanceEntry[]
}

const dependencyGroups = new Set<DependencyGroup>([
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
])

function yamlScalar(value: string): string {
  const trimmed = value.trim()
  const quote = trimmed[0]
  if ((quote === "'" || quote === '"') && trimmed.at(-1) === quote) {
    const inner = trimmed.slice(1, -1)
    return quote === "'" ? inner.replaceAll("''", "'") : JSON.parse(trimmed)
  }
  return trimmed
}

function parseDirectDependencies(lockfile: string): Map<string, DirectDependency> {
  const lines = lockfile.split(/\r?\n/)
  const direct = new Map<string, DirectDependency>()
  let inImporters = false
  let importer: string | undefined
  let group: DependencyGroup | undefined

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (line === 'importers:') {
      inImporters = true
      continue
    }
    if (!inImporters) continue
    if (/^\S/.test(line) && line.trim() !== '') break

    const importerMatch = line.match(/^ {2}([^ ].*):$/)
    if (importerMatch) {
      importer = yamlScalar(importerMatch[1] ?? '')
      group = undefined
      continue
    }

    const groupMatch = line.match(/^ {4}([^ ].*):$/)
    if (groupMatch) {
      const candidate = yamlScalar(groupMatch[1] ?? '') as DependencyGroup
      group = dependencyGroups.has(candidate) ? candidate : undefined
      continue
    }

    const dependencyMatch = line.match(/^ {6}([^ ].*):$/)
    if (!dependencyMatch || !importer || !group) continue

    const name = yamlScalar(dependencyMatch[1] ?? '')
    let specifier = ''
    let resolvedVersion = ''
    for (let fieldIndex = index + 1; fieldIndex < lines.length; fieldIndex += 1) {
      const fieldLine = lines[fieldIndex] ?? ''
      if (fieldLine.trim() !== '' && !fieldLine.startsWith('        ')) break
      const specifierMatch = fieldLine.match(/^ {8}specifier: (.+)$/)
      if (specifierMatch) specifier = yamlScalar(specifierMatch[1] ?? '')
      const versionMatch = fieldLine.match(/^ {8}version: (.+)$/)
      if (versionMatch) resolvedVersion = yamlScalar(versionMatch[1] ?? '').replace(/\(.*/, '')
    }

    if (specifier.startsWith('workspace:') || resolvedVersion.startsWith('link:')) continue
    if (!resolvedVersion) throw new Error(`direct dependency ${importer}:${name} has no locked version`)

    const entry = direct.get(name) ?? {
      name,
      versions: new Set<string>(),
      consumers: new Set<string>(),
      groups: new Set<DependencyGroup>(),
    }
    entry.versions.add(resolvedVersion)
    entry.consumers.add(importer)
    entry.groups.add(group)
    direct.set(name, entry)
  }

  if (!inImporters || direct.size === 0) {
    throw new Error('pnpm-lock.yaml importers contained no external direct dependencies')
  }
  return direct
}

function readProvenance(root: string): RegisteredProvenance[] {
  const files = [
    { file: 'runtime-dependencies.json', category: 'runtime' },
    { file: 'build-dependencies.json', category: 'build' },
  ] as const
  return files.flatMap(({ file, category }) => {
    const parsed = JSON.parse(readFileSync(join(root, 'third-party', file), 'utf8')) as ProvenanceFile
    expect(parsed.scope, `${file} must explain its scope`).toBeTruthy()
    return parsed.packages.map((entry) => ({ ...entry, category }))
  })
}

function auditProvenance(
  direct: Map<string, DirectDependency>,
  provenance: RegisteredProvenance[],
): string[] {
  const errors: string[] = []
  const registered = new Map<string, RegisteredProvenance>()

  for (const entry of provenance) {
    for (const field of ['name', 'version', 'license', 'source', 'purpose', 'rationale'] as const) {
      if (typeof entry[field] !== 'string' || entry[field].trim() === '') {
        errors.push(`${entry.name || '<unnamed>'}: missing ${field}`)
      }
    }
    if (!Array.isArray(entry.consumers) || entry.consumers.length === 0) {
      errors.push(`${entry.name || '<unnamed>'}: missing consumers`)
    }
    if (registered.has(entry.name)) errors.push(`duplicate provenance: ${entry.name}`)
    registered.set(entry.name, entry)
  }

  for (const [name, dependency] of direct) {
    const entry = registered.get(name)
    if (!entry) {
      errors.push(`missing provenance: ${name}@${[...dependency.versions].sort().join(',')}`)
      continue
    }
    const versions = [...dependency.versions].sort()
    if (versions.length !== 1 || versions[0] !== entry.version) {
      errors.push(`${name}: locked ${versions.join(',')} but provenance records ${entry.version}`)
    }
    const consumers = [...dependency.consumers].sort()
    const recordedConsumers = [...entry.consumers].sort()
    if (JSON.stringify(consumers) !== JSON.stringify(recordedConsumers)) {
      errors.push(
        `${name}: lock consumers ${consumers.join(',')} but provenance records ${recordedConsumers.join(',')}`,
      )
    }
    const expectedCategory =
      dependency.groups.has('dependencies') || dependency.groups.has('optionalDependencies')
        ? 'runtime'
        : 'build'
    if (entry.category !== expectedCategory) {
      errors.push(`${name}: expected ${expectedCategory} provenance, found ${entry.category}`)
    }
  }

  for (const name of registered.keys()) {
    if (!direct.has(name)) errors.push(`stale provenance: ${name}`)
  }
  return errors
}

const root = repoRoot()
const direct = parseDirectDependencies(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8'))
const provenance = readProvenance(root)

describe('direct dependency provenance', () => {
  it('registers every external direct lockfile dependency with complete provenance', () => {
    expect(auditProvenance(direct, provenance)).toEqual([])
  })

  it('fails closed when a provenance record is removed', () => {
    const removed = provenance[0]
    expect(removed).toBeDefined()
    expect(auditProvenance(direct, provenance.slice(1))).toContain(
      `missing provenance: ${removed?.name}@${removed?.version}`,
    )
  })

  it('parses quoted scoped names, peer suffixes and workspace links', () => {
    const parsed = parseDirectDependencies(`lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      '@scope/runtime':
        specifier: 1.2.3
        version: 1.2.3(peer@4.5.6)
      '@workspace/local':
        specifier: workspace:*
        version: link:packages/local

packages:
`)
    expect([...parsed.keys()]).toEqual(['@scope/runtime'])
    expect([...(parsed.get('@scope/runtime')?.versions ?? [])]).toEqual(['1.2.3'])
  })
})
