import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_ENABLED_BUNDLED_PACKAGES, OPTIONAL_BUNDLED_PACKAGES } from '@agnes/package-manager'
import { afterEach, expect, it, vi } from 'vitest'
import { discoverLocalExamples } from '../src/packages/local-examples.js'

const optionalFixture = vi.hoisted(() => ({
  packages: [] as Array<typeof import('@agnes/package-manager').OPTIONAL_BUNDLED_PACKAGES[number]>,
  root: '',
}))
vi.mock('@agnes/package-manager', async (original) => {
  const module = await original<typeof import('@agnes/package-manager')>()
  return {
    ...module,
    OPTIONAL_BUNDLED_PACKAGES: optionalFixture.packages,
    bundledPluginSource: (ref: string) =>
      optionalFixture.packages.some((pkg) => pkg.ref === ref)
        ? { root: optionalFixture.root, path: 'optional-payload' }
        : module.bundledPluginSource(ref),
  }
})

const roots: string[] = []
afterEach(() => {
  vi.useRealTimers()
  optionalFixture.packages.length = 0
  optionalFixture.root = ''
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
it.each([
  { broken: false, optional: false },
  { broken: true, optional: false },
  { broken: false, optional: true },
  { broken: true, optional: true },
])(
  'discovers bundled plugins with broken examples=$broken and optional fixture=$optional',
  async ({ broken, optional }) => {
    // Fake only Date, before discovery, so the catalog clock can cross the snapshot ttl below.
    vi.useFakeTimers({ toFake: ['Date'] })
    const start = Date.now()
    const root = mkdtempSync(join(tmpdir(), 'agnes-builtin-catalog-'))
    roots.push(root)
    if (optional) {
      const pkg = {
        name: 'fixture-optional',
        id: '@fixture/optional',
        version: '1.0.0',
        license: 'Apache-2.0',
        ref: 'file:./bundled-plugins/fixture-optional',
        sourcePath: 'optional-payload',
      }
      optionalFixture.root = root
      optionalFixture.packages.push(pkg)
      const payload = join(root, pkg.sourcePath)
      mkdirSync(payload)
      writeFileSync(
        join(payload, 'package.json'),
        JSON.stringify({ name: pkg.id, version: pkg.version, license: pkg.license }),
      )
      expect(DEFAULT_ENABLED_BUNDLED_PACKAGES.some((entry) => entry.id === pkg.id)).toBe(false)
    }
    if (broken) mkdirSync(join(root, 'examples', 'packages'), { recursive: true })
    const catalog = await discoverLocalExamples(root)
    const result = await catalog.read({ offline: true })
    expect(result.entries).toHaveLength(optional ? 21 : 20)
    if (!optional) expect(OPTIONAL_BUNDLED_PACKAGES).toEqual([])
    expect(
      result.entries
        .filter((entry) => entry.sourceId === 'builtin-plugins')
        .map((entry) => entry.id)
        .sort(),
    ).toEqual([...DEFAULT_ENABLED_BUNDLED_PACKAGES, ...OPTIONAL_BUNDLED_PACKAGES].map((pkg) => pkg.id).sort())
    const examples = result.entries.filter((entry) => entry.sourceId === 'official-examples')
    expect(examples.map((entry) => entry.id).sort()).toEqual(
      [
        '@agnes-example/dag-loop',
        '@agnes-example/react-loop',
        '@agnes-fde/data-report',
        '@agnes-fde/finance-reconcile',
        '@agnes-fde/knowledge-qa',
        '@agnes-fde/ops-runbook',
        '@agnes-fde/support-triage',
        '@community/tool-panel',
        '@community/mcp-skills',
        '@community/dag-loop-adapter',
      ].sort(),
    )
    expect(
      examples.every((entry) => entry.integrity && entry.source.ref.startsWith('file:./bundled-examples/')),
    ).toBe(true)
    expect(result.entries.find((entry) => entry.id === '@agnes/skill-helper')).toMatchObject({
      id: '@agnes/skill-helper',
      version: '0.3.2',
      sourceId: 'builtin-plugins',
      source: { type: 'file', ref: 'file:./bundled-plugins/skill-helper' },
    })
    expect(result.entries.find((entry) => entry.id === '@agnes/mcp-helper')).toMatchObject({
      id: '@agnes/mcp-helper',
      version: '0.1.2',
      source: { ref: 'file:./bundled-plugins/mcp-helper' },
    })
    expect(result.entries.find((entry) => entry.id === '@agnes/goal-ui')).toMatchObject({
      id: '@agnes/goal-ui',
      version: '0.1.2',
      source: { ref: 'file:./bundled-plugins/goal-ui' },
    })
    expect(result.entries.find((entry) => entry.id === '@agnes/interaction-ui')).toMatchObject({
      id: '@agnes/interaction-ui',
      version: '0.1.2',
      source: { ref: 'file:./bundled-plugins/interaction-ui' },
    })
    expect(result.entries.find((entry) => entry.id === '@agnes/deliverables-ui')).toMatchObject({
      id: '@agnes/deliverables-ui',
      version: '0.1.5',
      source: { ref: 'file:./bundled-plugins/deliverables-ui' },
    })
    for (const id of ['navigation-ui', 'conversation-ui'])
      expect(result.entries.find((entry) => entry.id === `@agnes/${id}`)).toMatchObject({
        id: `@agnes/${id}`,
        version: '0.1.1',
        source: { ref: `file:./bundled-plugins/${id}` },
      })
    expect(result.entries.find((entry) => entry.id === '@agnes/document-reader')).toMatchObject({
      id: '@agnes/document-reader',
      version: '0.1.4',
      source: { ref: 'file:./bundled-plugins/document-reader' },
    })
    for (const pkg of OPTIONAL_BUNDLED_PACKAGES)
      expect(result.entries.find((entry) => entry.id === pkg.id)).toMatchObject({
        version: pkg.version,
        sourceId: 'builtin-plugins',
        source: { ref: pkg.ref },
        integrity: expect.stringMatching(/^sha256-/),
      })
    expect(JSON.stringify(result.entries)).not.toContain('github.com')
    expect(result.sources.find((source) => source.sourceId === 'builtin-plugins')?.status).toBe('fresh')
    if (broken)
      expect(result.sources.find((source) => source.sourceId === 'local-examples')?.status).toBe(
        'unavailable',
      )

    // Bundled snapshots never go stale: they are served from cache until ttlMs, and an offline read
    // after that reloads them instead of emptying the catalog. A source that never loaded stays out.
    const ids = (read: typeof result) => read.entries.map((entry) => `${entry.id}@${entry.version}`)
    const status = (read: typeof result, sourceId: string) =>
      read.sources.find((source) => source.sourceId === sourceId)?.status
    vi.setSystemTime(start + 86_399_999)
    const cached = await catalog.read({ offline: true })
    expect({ ids: ids(cached), builtin: status(cached, 'builtin-plugins') }).toEqual({
      ids: ids(result),
      builtin: 'cached',
    })
    vi.setSystemTime(start + 86_400_001)
    const expired = await catalog.read({ offline: true })
    expect({ ids: ids(expired), builtin: status(expired, 'builtin-plugins') }).toEqual({
      ids: ids(result),
      builtin: 'fresh',
    })
    if (broken) expect(status(expired, 'local-examples')).toBe('unavailable')
  },
)
