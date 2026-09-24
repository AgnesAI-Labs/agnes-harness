import { readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_EXCLUDE_DIRS, isTestFile, listSourceFiles, repoRoot } from './repo.js'

type Evidence = { path: string; marker: string }
type Capability = { id: string; evidence: Evidence[] }
type Registry = { scope: string; capabilities: Capability[] }
type Occurrence = { path: string; line: number; text: string }
type MatrixRow = { id: string; status: string; line: string }

const GAP_PATTERNS = [/\bnot implemented\b/i, /\bnot wired\b/i, /\bnot available in this build\b/i]

function productionFiles(root: string): string[] {
  return listSourceFiles(join(root, 'packages'), {
    excludeDirs: [...DEFAULT_EXCLUDE_DIRS, 'fixtures', 'test', 'testkit'],
  }).filter((file) => !isTestFile(file))
}

function repoPath(root: string, file: string): string {
  return relative(root, file).split(sep).join('/')
}

function findGapOccurrences(root: string): Occurrence[] {
  return productionFiles(root).flatMap((file) =>
    readFileSync(file, 'utf8')
      .split('\n')
      .flatMap((text, index) =>
        GAP_PATTERNS.some((pattern) => pattern.test(text))
          ? [{ path: repoPath(root, file), line: index + 1, text }]
          : [],
      ),
  )
}

function auditRegistry(root: string, registry: Registry): string[] {
  const errors: string[] = []
  const ids = new Set<string>()
  const evidenceKeys = new Set<string>()
  if (!registry.scope.trim()) errors.push('capability registry must explain its scope')
  for (const capability of registry.capabilities) {
    if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/.test(capability.id))
      errors.push(`invalid capability id: ${capability.id}`)
    if (ids.has(capability.id)) errors.push(`duplicate capability id: ${capability.id}`)
    ids.add(capability.id)
    if (capability.evidence.length === 0) errors.push(`${capability.id}: missing source evidence`)
    for (const evidence of capability.evidence) {
      const key = `${evidence.path}\0${evidence.marker}`
      if (evidenceKeys.has(key))
        errors.push(`duplicate source evidence: ${evidence.path}: ${evidence.marker}`)
      evidenceKeys.add(key)
      if (!evidence.path.startsWith('packages/') || evidence.path.includes('..'))
        errors.push(`${capability.id}: invalid production path ${evidence.path}`)
      if (!evidence.marker.trim()) errors.push(`${capability.id}: empty source marker`)
      let source: string
      try {
        source = readFileSync(join(root, evidence.path), 'utf8')
      } catch {
        errors.push(`${capability.id}: missing source ${evidence.path}`)
        continue
      }
      if (!source.includes(evidence.marker))
        errors.push(`${capability.id}: stale marker in ${evidence.path}: ${evidence.marker}`)
    }
  }
  return errors.sort()
}

function auditOccurrences(occurrences: Occurrence[], registry: Registry): string[] {
  const evidence = registry.capabilities.flatMap((capability) => capability.evidence)
  return occurrences
    .filter(
      (occurrence) =>
        !evidence.some((item) => item.path === occurrence.path && occurrence.text.includes(item.marker)),
    )
    .map((occurrence) => `unregistered capability gap: ${occurrence.path}:${occurrence.line}`)
    .sort()
}

function matrixRows(document: string): MatrixRow[] {
  return document
    .split('\n')
    .filter((line) => /^\|\s*`[^`]+`\s*\|/.test(line))
    .map((line) => {
      const cells = line
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim())
      return { id: cells[0]?.replaceAll('`', '') ?? '', status: cells[2] ?? '', line }
    })
}

function auditMatrix(document: string, registry: Registry): string[] {
  const errors: string[] = []
  const rows = matrixRows(document)
  const byId = new Map<string, MatrixRow>()
  for (const row of rows) {
    if (byId.has(row.id)) errors.push(`duplicate capability matrix row: ${row.id}`)
    if (!['stub', 'partial', 'wired'].includes(row.status))
      errors.push(`${row.id}: invalid matrix status ${row.status}`)
    byId.set(row.id, row)
  }
  const registryIds = new Set(registry.capabilities.map(({ id }) => id))
  for (const capability of registry.capabilities) {
    const row = byId.get(capability.id)
    if (!row) {
      errors.push(`capability missing from matrix: ${capability.id}`)
      continue
    }
    for (const evidence of capability.evidence)
      if (!row.line.includes(`\`${evidence.path}\``))
        errors.push(`${capability.id}: matrix omits source ${evidence.path}`)
  }
  for (const id of byId.keys()) if (!registryIds.has(id)) errors.push(`stale capability matrix row: ${id}`)
  return errors.sort()
}

const root = repoRoot()
const registry = JSON.parse(
  readFileSync(join(root, 'tools/guards/capability-stubs.json'), 'utf8'),
) as Registry
const occurrences = findGapOccurrences(root)

describe('capability stub registry', () => {
  it('maps every production gap marker to stable, live source evidence', () => {
    const errors = [...auditRegistry(root, registry), ...auditOccurrences(occurrences, registry)]
    expect(errors, errors.join('\n')).toEqual([])
  })

  it.each(['capabilities.md', 'capabilities.zh-CN.md'])(
    'keeps %s in exact sync with the registry',
    (name) => {
      const document = readFileSync(join(root, 'docs/reference', name), 'utf8')
      const errors = auditMatrix(document, registry)
      expect(errors, errors.join('\n')).toEqual([])
    },
  )

  it('rejects an unregistered source gap', () => {
    const synthetic = [
      ...occurrences,
      { path: 'packages/example/src/new-gap.ts', line: 7, text: "throw new Error('not implemented')" },
    ]
    expect(auditOccurrences(synthetic, registry)).toContain(
      'unregistered capability gap: packages/example/src/new-gap.ts:7',
    )
  })

  it('rejects stale registered evidence', () => {
    const stale: Registry = {
      ...registry,
      capabilities: [
        ...registry.capabilities,
        {
          id: 'example.stale-capability',
          evidence: [{ path: 'packages/example/src/gone.ts', marker: 'not implemented' }],
        },
      ],
    }
    expect(auditRegistry(root, stale)).toContain(
      'example.stale-capability: missing source packages/example/src/gone.ts',
    )
  })
})
