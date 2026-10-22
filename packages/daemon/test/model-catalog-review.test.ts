import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { builtinModelAdapterCatalog, builtinModelSelectionData, type ResolvedProfile } from '@agnes/host'
import {
  publishModelAdapterCatalog,
  type RuntimePluginSnapshot,
  readPublishedModelAdapters,
} from '@agnes/package-manager'
import { afterEach, expect, it, vi } from 'vitest'
import { readModelSelectionCatalog } from '../src/supervisor/model-adapter-lookup.js'

const roots: string[] = []
const race = vi.hoisted(() => ({ file: '', outside: '', replace: false, phase: 'lstat' }))
vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>()
  return {
    ...original,
    openSync: (...args: Parameters<typeof original.openSync>) => {
      const handle = original.openSync(...args)
      if (String(args[0]) === race.file && race.replace && race.phase === 'open') {
        race.replace = false
        original.unlinkSync(race.file)
        original.symlinkSync(race.outside, race.file)
      }
      return handle
    },
    lstatSync: (...args: Parameters<typeof original.lstatSync>) => {
      const stat = original.lstatSync(...args)
      if (String(args[0]) === race.file && race.replace && race.phase === 'lstat') {
        race.replace = false
        original.unlinkSync(race.file)
        original.symlinkSync(race.outside, race.file)
      }
      return stat
    },
  }
})
afterEach(() => {
  race.replace = false
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agh-w3-review-'))
  roots.push(root)
  const profileDir = join(root, 'profile')
  mkdirSync(profileDir)
  const source: RuntimePluginSnapshot = {
    trusted: true,
    enabled: true,
    generation: 1,
    snapshot: {
      packageId: '@review/adapter',
      snapshotId: `sha256-${'a'.repeat(64)}`,
      profile: 'local-dev',
      version: '1.0.0',
      integrity: `sha256-${'b'.repeat(64)}`,
      treeIntegrity: `sha256-${'c'.repeat(64)}`,
      capabilityHash: 'd'.repeat(64),
      directory: join(root, 'verified-source'),
      contributions: [],
    },
  }
  const adapter = {
    id: 'review',
    version: '1.0.0',
    wireApi: 'review-wire',
    sourcePackage: source.snapshot.packageId,
    capabilities: { imageInput: false, tools: true, streaming: true },
    models: [{ id: 'old-model', route: 'old-route' }],
  }
  const profile = {
    hash: 'current-profile',
    packages: [],
    provider: { routes: [], catalog: { include: ['openai'] } },
  } as unknown as ResolvedProfile
  return { root, profileDir, source, adapter, profile }
}

it('keeps an unresolved no-route profile empty, matching unresolvedProviderAssembly', async () => {
  const f = fixture()
  const cold = await builtinModelSelectionData(f.profile)
  expect(cold.models).toEqual([])
})

it('reads intrinsic live model metadata without verifying unrelated plugin trees', async () => {
  const f = fixture()
  f.profile.packages.push({
    id: '@agnes/ai',
    version: '0.0.0',
    integrity: 'builtin:0.0.0',
    source: 'builtin',
    trust: 'builtin',
    enabled: true,
  })
  const adapter = { ...builtinModelAdapterCatalog(f.profile)[0]!, models: [] }
  const sources = vi.fn(async (): Promise<RuntimePluginSnapshot[]> => {
    throw new Error('unrelated scan')
  })
  const read = readModelSelectionCatalog({
    profile: () => f.profile,
    profileDir: f.profileDir,
    sources,
    worker: () => ({ alive: true, command: async () => ({ modelAdapters: [adapter], sources: [] }) }),
  })
  expect(await read()).toEqual([adapter])
  expect(sources).not.toHaveBeenCalled()
  // A live installed row with the release owner's name must use current snapshot verification.
  const shadow = readModelSelectionCatalog({
    profile: () => f.profile,
    profileDir: f.profileDir,
    sources: async () => [],
    worker: () => ({
      alive: true,
      command: async () => ({
        modelAdapters: [adapter],
        sources: [{ plugin: `${adapter.sourcePackage}@spoof/plugin`, entryRevision: 'spoof' }],
      }),
    }),
  })
  expect(await shadow()).not.toContainEqual(adapter)
})

it('fails closed on missing, future-version, wrong-profile, disabled and untrusted persisted projections', () => {
  const f = fixture()
  const file = join(f.profileDir, '.agnes-published-model-adapters.json')
  expect(readPublishedModelAdapters(f.profileDir, f.profile.hash, [f.source])).toEqual([])
  publishModelAdapterCatalog(f.profileDir, f.profile.hash, [f.adapter], [f.source])
  expect(readPublishedModelAdapters(f.profileDir, f.profile.hash, [f.source])).toEqual([f.adapter])
  for (const next of [
    { ...f.source, enabled: false },
    { ...f.source, trusted: false },
  ])
    expect(readPublishedModelAdapters(f.profileDir, f.profile.hash, [next])).toEqual([])
  expect(readPublishedModelAdapters(f.profileDir, 'different-profile', [f.source])).toEqual([])
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  writeFileSync(file, JSON.stringify({ ...saved, version: 2 }))
  expect(readPublishedModelAdapters(f.profileDir, f.profile.hash, [f.source])).toEqual([])
})

it.each(['lstat', 'open'])('rejects replacement by a symlink during projection %s', (phase) => {
  const f = fixture()
  const file = join(f.profileDir, '.agnes-published-model-adapters.json')
  const outside = join(f.root, 'outside.json')
  publishModelAdapterCatalog(f.profileDir, f.profile.hash, [f.adapter], [f.source])
  writeFileSync(outside, readFileSync(file))
  race.file = file
  race.outside = outside
  race.replace = true
  race.phase = phase
  expect(readPublishedModelAdapters(f.profileDir, f.profile.hash, [f.source])).toEqual([])
})

it('rejects an existing projection symlink and publishes by replacing it without following the target', () => {
  const f = fixture()
  const file = join(f.profileDir, '.agnes-published-model-adapters.json')
  const outside = join(f.root, 'outside.json')
  writeFileSync(outside, 'outside sentinel')
  symlinkSync(outside, file)
  expect(readPublishedModelAdapters(f.profileDir, f.profile.hash, [f.source])).toEqual([])
  publishModelAdapterCatalog(f.profileDir, f.profile.hash, [f.adapter], [f.source])
  expect(readFileSync(outside, 'utf8')).toBe('outside sentinel')
  expect(readPublishedModelAdapters(f.profileDir, f.profile.hash, [f.source])).toEqual([f.adapter])
})

it('records that live display is bound to source rows but carries no profile admission token', async () => {
  const f = fixture()
  f.profile.provider.routes = [
    {
      route: 'new-route',
      api: 'review',
      models: [{ id: 'new-model', api: 'review-wire', route: 'new-route' }],
    },
  ] as never
  const read = readModelSelectionCatalog({
    profile: () => f.profile,
    profileDir: f.profileDir,
    sources: async () => [f.source],
    worker: () => ({
      alive: true,
      command: async () => ({
        modelAdapters: [f.adapter],
        sources: [
          {
            plugin: `${f.source.snapshot.packageId}@${f.source.snapshot.snapshotId}/plugin`,
            entryRevision: f.source.snapshot.snapshotId,
          },
        ],
      }),
    }),
  })
  const offered = await read()
  expect(offered.flatMap((a) => a.models)).toContainEqual({ id: 'old-model', route: 'old-route' })
})

it.each([
  ['revoked', 'cold'],
  ['disabled', 'cold'],
  ['revoked', 'live'],
  ['disabled', 'live'],
] as const)(
  'does not synthesize companion adapters from a stale enabled profile when current source is %s (%s)',
  async (state, mode) => {
    const f = fixture()
    const source = { ...f.source, snapshot: { ...f.source.snapshot, packageId: '@agnes/model-adapters' } }
    const profile: ResolvedProfile = {
      ...f.profile,
      packages: [
        {
          id: '@agnes/ai',
          version: '0.0.0',
          integrity: 'builtin:0.0.0',
          source: 'builtin',
          trust: 'builtin',
          enabled: true,
        },
        {
          id: '@agnes/model-adapters',
          version: '1.0.0',
          integrity: source.snapshot.integrity,
          source: 'file:./companion',
          trust: 'trusted',
          enabled: true,
        },
      ],
    }
    let live = [source]
    const read = readModelSelectionCatalog({
      profile: () => profile,
      profileDir: f.profileDir,
      sources: async () => live,
      ...(mode === 'live'
        ? {
            worker: () => ({
              alive: true,
              command: async () => ({
                modelAdapters: ['scripted', 'replay', 'local-openai'].map((id) => ({
                  ...f.adapter,
                  id,
                  sourcePackage: '@agnes/model-adapters',
                  models: [],
                })),
                sources: [],
              }),
            }),
          }
        : {}),
    })
    live = [{ ...source, ...(state === 'revoked' ? { trusted: false } : { enabled: false }) }]
    const offered = await read()
    expect(offered.filter((a) => a.sourcePackage === '@agnes/model-adapters')).toEqual([])
  },
)

it.each(['cold', 'live'] as const)(
  'binds companion descriptions to current verified code (%s)',
  async (mode) => {
    const f = fixture()
    const source = { ...f.source, snapshot: { ...f.source.snapshot, packageId: '@agnes/model-adapters' } }
    const adapter = { ...f.adapter, sourcePackage: source.snapshot.packageId }
    publishModelAdapterCatalog(f.profileDir, f.profile.hash, [adapter], [source])
    let sources = [source]
    let rows = [
      {
        plugin: `${source.snapshot.packageId}@${source.snapshot.snapshotId}/plugin`,
        entryRevision: source.snapshot.snapshotId,
      },
    ]
    const read = readModelSelectionCatalog({
      profile: () => f.profile,
      profileDir: f.profileDir,
      sources: async () => sources,
      ...(mode === 'live'
        ? {
            worker: () => ({
              alive: true,
              command: async () => ({ modelAdapters: [adapter], sources: rows }),
            }),
          }
        : {}),
    })
    expect(await read()).toContainEqual(adapter)
    if (mode === 'live') {
      rows = []
      expect(await read()).not.toContainEqual(adapter)
    }
    sources = []
    expect(await read()).not.toContainEqual(adapter)
  },
)

it.each([
  ['cold', { source: 'link:./ai' }],
  ['live', { source: 'link:./ai' }],
  ['cold', { source: 'workspace:extensions/ai' }],
  ['live', { source: 'workspace:extensions/ai' }],
  ['cold', { source: 'file:./ai' }],
  ['live', { source: 'file:./ai' }],
  ['cold', { integrity: 'builtin:other-release' }],
  ['live', { integrity: 'builtin:other-release' }],
  ['cold', { trust: 'trusted' }],
  ['live', { trust: 'trusted' }],
  ['cold', { enabled: false }],
  ['live', { enabled: false }],
] as const)(
  'does not treat non-release AI identities as intrinsic registrations (%s, %j)',
  async (mode, patch) => {
    const f = fixture()
    const adapter = {
      ...builtinModelAdapterCatalog().find((a) => a.id === 'openai-completions')!,
      models: [],
    }
    f.profile.packages.push({
      id: '@agnes/ai',
      version: '0.0.0',
      integrity: 'builtin:0.0.0',
      source: 'builtin',
      trust: 'builtin',
      enabled: true,
      ...patch,
    })
    const read = readModelSelectionCatalog({
      profile: () => f.profile,
      profileDir: f.profileDir,
      sources: async () => [],
      ...(mode === 'live'
        ? {
            worker: () => ({ alive: true, command: async () => ({ modelAdapters: [adapter], sources: [] }) }),
          }
        : {}),
    })
    expect(await read()).not.toContainEqual(expect.objectContaining({ sourcePackage: '@agnes/ai' }))
  },
)
