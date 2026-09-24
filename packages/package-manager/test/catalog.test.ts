import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { validateAgainst } from '@agnes/protocol'
import { PackageCatalogDescriptor } from '@agnes/protocol/gen/package-admin'
import { describe, expect, it, vi } from 'vitest'
import { createCatalog, staticCatalogSource } from '../src/catalog.js'
import { createLocalExamplesCatalog } from '../src/local-examples-catalog.js'
import { hashDirectory } from '../src/sources.js'

const epoch = Date.parse('2026-09-13T00:00:00.000Z')
const fixture = (name = 'curated') =>
  JSON.parse(readFileSync(new URL(`./fixtures/catalog/${name}.json`, import.meta.url), 'utf8'))
const source = (id = 'curated', data: unknown = fixture()) => staticCatalogSource(id, async () => data)
it('merges by managed priority without hiding conflicting provenance', async () => {
  const catalog = createCatalog([source(), source('private', fixture('private'))], {
    priority: ['private', 'curated'],
    now: () => epoch,
  })
  const result = await catalog.read()
  expect(result.entries).toHaveLength(1)
  expect(result.entries[0]).toMatchObject({
    sourceId: 'private',
    retrievedAt: new Date(epoch).toISOString(),
    compatibility: 'adapted',
  })
  expect(result.conflicts).toMatchObject([
    { id: 'acme/widget', version: '1.0.0', selectedSourceId: 'private', sourceIds: ['private', 'curated'] },
  ])
  expect(
    result.conflicts[0]?.candidates.map((row) => ({
      sourceId: row.sourceId,
      integrity: row.integrity,
      compatibility: row.compatibility,
    })),
  ).toEqual([
    { sourceId: 'private', integrity: `sha256-${'b'.repeat(64)}`, compatibility: 'adapted' },
    { sourceId: 'curated', integrity: `sha256-${'a'.repeat(64)}`, compatibility: 'supported' },
  ])
  expect(result.sources.map((s) => s.status)).toEqual(['fresh', 'fresh'])
  expect(validateAgainst(PackageCatalogDescriptor, result.entries[0]).ok).toBe(true)
})
it('restores offline snapshots only until issued TTL, without invoking discovery', async () => {
  let now = epoch
  const loader = vi.fn(async () => fixture())
  const first = createCatalog([staticCatalogSource('curated', loader)], {
    priority: ['curated'],
    now: () => now,
  })
  await first.read()
  const snapshots = first.snapshots()
  now += 30000
  const restored = createCatalog([staticCatalogSource('curated', loader)], {
    priority: ['curated'],
    snapshots,
    now: () => now,
  })
  expect((await restored.read({ offline: true })).sources).toEqual([
    { sourceId: 'curated', status: 'cached' },
  ])
  expect(loader).toHaveBeenCalledTimes(1)
  now = epoch + 60000
  expect(await restored.read({ offline: true })).toEqual({
    entries: [],
    conflicts: [],
    sources: [{ sourceId: 'curated', status: 'unavailable' }],
  })
})
it('failed discovery uses only a still-fresh snapshot and reports cache provenance', async () => {
  let fail = false
  const catalog = createCatalog(
    [
      staticCatalogSource('curated', async () => {
        if (fail) throw Error('private detail')
        return fixture()
      }),
    ],
    { priority: ['curated'], now: () => epoch },
  )
  await catalog.read()
  fail = true
  expect((await catalog.read()).sources).toEqual([{ sourceId: 'curated', status: 'cached' }])
})
it.each(['ttl', 'future', 'duplicate', 'source', 'unknown', 'oversize'])(
  'rejects invalid %s documents without publishing',
  async (kind) => {
    const doc = fixture()
    if (kind === 'ttl') doc.ttlMs = 86400001
    if (kind === 'future') doc.issuedAt = '2026-09-14T00:00:00.000Z'
    if (kind === 'duplicate') doc.entries.push({ ...doc.entries[0] })
    if (kind === 'source') doc.entries[0].source = { type: 'npm', ref: 'npm:acme-widget@latest' }
    if (kind === 'unknown') doc.extra = true
    if (kind === 'oversize') doc.entries[0].license = 'x'.repeat(1024 * 1024)
    const catalog = createCatalog([source('curated', doc)], { priority: ['curated'], now: () => epoch })
    expect(await catalog.read()).toEqual({
      entries: [],
      conflicts: [],
      sources: [{ sourceId: 'curated', status: 'unavailable' }],
    })
    expect(catalog.snapshots()).toEqual([])
  },
)
it.each([{ priority: ['curated', 'curated'] }, { priority: ['missing'] }, { priority: [] }])(
  'rejects invalid managed priority $priority',
  ({ priority }) => {
    expect(() => createCatalog([source()], { priority, now: () => epoch })).toThrow('invalid catalog')
  },
)
it('cancellation refuses the whole refresh and preserves the previous snapshot set', async () => {
  const abort = new AbortController()
  const catalog = createCatalog(
    [
      source(),
      staticCatalogSource('private', async () => {
        abort.abort()
        return fixture('private')
      }),
    ],
    { priority: ['curated', 'private'], now: () => epoch },
  )
  await expect(catalog.read({ signal: abort.signal })).rejects.toMatchObject({ code: 'E_PACKAGE_CANCELLED' })
  expect(catalog.snapshots()).toEqual([])
})
it('snapshot input cannot add foreign sources or future retrieval dates', async () => {
  const first = createCatalog([source()], { priority: ['curated'], now: () => epoch })
  await first.read()
  const snapshots = first.snapshots()
  for (const bad of [
    { ...snapshots[0], sourceId: 'foreign' },
    { ...snapshots[0], retrievedAt: '2026-09-14T00:00:00.000Z' },
  ])
    expect(() =>
      createCatalog([source()], { priority: ['curated'], now: () => epoch, snapshots: [bad] }),
    ).toThrow('invalid catalog')
})
it('output and exported snapshots cannot mutate later discovery state', async () => {
  const catalog = createCatalog([source()], { priority: ['curated'], now: () => epoch })
  const result = await catalog.read()
  const row = result.entries[0]
  if (!row) throw Error('missing fixture row')
  row.license = 'changed'
  const snapshots = catalog.snapshots()
  const cached = snapshots[0]?.entries[0]
  if (!cached) throw Error('missing cached row')
  cached.license = 'changed'
  expect((await catalog.read({ offline: true })).entries[0]?.license).toBe('MIT')
})
it('retains unsupported compatibility and treats catalog integrity only as discovery metadata', async () => {
  const doc = fixture()
  doc.entries[0].compatibility = 'unsupported'
  const catalog = createCatalog([source('curated', doc)], { priority: ['curated'], now: () => epoch })
  expect((await catalog.read()).entries[0]).toMatchObject({
    compatibility: 'unsupported',
    integrity: `sha256-${'a'.repeat(64)}`,
  })
  expect(Object.keys(catalog).sort()).toEqual(['read', 'snapshots'])
})

it('rechecks every snapshot at the common publication time after slow discovery', async () => {
  let now = epoch
  const doc = fixture()
  doc.ttlMs = 1000
  const catalog = createCatalog(
    [
      source('curated', doc),
      staticCatalogSource('slow', async () => {
        now += 2000
        throw Error('offline')
      }),
    ],
    { priority: ['curated', 'slow'], now: () => now },
  )
  expect(await catalog.read()).toEqual({
    entries: [],
    conflicts: [],
    sources: [
      { sourceId: 'curated', status: 'unavailable' },
      { sourceId: 'slow', status: 'unavailable' },
    ],
  })
})

describe('local example catalog', () => {
  const workspace = fileURLToPath(new URL('../../..', import.meta.url))

  it('publishes only current plugin-row examples with verified source trees', async () => {
    const catalog = await createLocalExamplesCatalog({ workspace, now: () => epoch })
    const result = await catalog.read({ offline: true })

    expect(result.sources).toEqual([{ sourceId: 'local-examples', status: 'cached' }])
    expect(result.entries).toHaveLength(24)
    expect(result.entries.map(({ id, version }) => `${id}@${version}`).sort()).toEqual([
      '@agnes-examples/client-multi-panel@1.0.0',
      '@agnes-examples/client-multi-panel@2.0.0',
      '@agnes-examples/client-panel@1.0.0',
      '@agnes-examples/client-panel@2.0.0',
      '@agnes-examples/client-service-panel@1.0.0',
      '@agnes-examples/client-service-panel@2.0.0',
      '@agnes-examples/dsh-input-controls@1.0.0',
      '@agnes-examples/dsh-input-controls@2.0.0',
      '@agnes-examples/dsh-model-picker-a@1.0.0',
      '@agnes-examples/dsh-model-picker-a@2.0.0',
      '@agnes-examples/dsh-model-picker-b@1.0.0',
      '@agnes-examples/dsh-model-picker-b@2.0.0',
      '@agnes-examples/dsh-tool-view@1.0.0',
      '@agnes-examples/dsh-tool-view@2.0.0',
      '@agnes-examples/hook-context-note@1.0.0',
      '@agnes-examples/hook-runner-takeover@1.0.0',
      '@agnes-examples/hot-service@1.0.0',
      '@agnes-examples/hot-service@1.1.0',
      '@agnes-examples/hot-tool-plugin@1.0.0',
      '@agnes-examples/skin-example@1.0.0',
      '@agnes-examples/skins-builtin@1.0.0',
      '@agnes-examples/skins-builtin@1.1.0',
      'acme/dashboard@1.0.0',
      'acme/dashboard@2.0.0',
    ])
    for (const entry of result.entries) {
      const directory = fileURLToPath(
        new URL(`../../../${entry.source.ref.slice('file:./'.length)}`, import.meta.url),
      )
      expect(entry.integrity).toBe(hashDirectory(directory))
      expect(entry.sourceId).toBe('local-examples')
      expect(entry.contributions.some((contribution) => contribution.kind === 'extension')).toBe(false)
    }
  })

  it('keeps broken candidates test-only', async () => {
    const normal = await createLocalExamplesCatalog({ workspace, now: () => epoch })
    const faultCatalog = await createLocalExamplesCatalog({
      workspace,
      includeTestOnlyBroken: true,
      now: () => epoch,
    })

    expect((await normal.read({ offline: true })).entries.some((entry) => entry.version === '1.2.0')).toBe(
      false,
    )
    expect(
      (await faultCatalog.read({ offline: true })).entries.filter((entry) => entry.version === '1.2.0'),
    ).toHaveLength(1)
  })
})
