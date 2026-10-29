import type { ConfigurationService, ResolvedProfile } from '@agnes/host'
import { expect, it } from 'vitest'
import { configurationApplication } from '../src/supervisor/configuration.js'

it('reports the revision actually activated and leaves storage/policy changes for restart', async () => {
  const initial = {
    name: 'local-dev',
    dataDir: '/data',
    hash: 'old',
    chain: [],
    adapters: { storage: 'sqlite', secrets: { kind: 'file' } },
    provider: { package: '@agnes/ai', adapters: [] },
  } as unknown as ResolvedProfile
  let revision = 0
  const snapshot = () => ({
    profile: 'local-dev',
    revision,
    configured: revision > 0,
    provider: null,
    effect: 'new-sessions' as const,
  })
  const service = { get: async () => snapshot() } as ConfigurationService
  let next = { ...initial, hash: 'new', provider: { package: '@agnes/ai', adapters: ['@agnes/ai'] } }
  let published = initial
  const activate = async (profile: ResolvedProfile) => {
    published = profile
  }
  const application = await configurationApplication({
    service,
    profile: initial,
    reloadProfile: async () => next,
    activate,
  })
  revision = 1
  expect(application.present(snapshot()).effect).toBe('restart-required')
  expect(application.restartPending()).toBe(true)
  expect((await application.apply(snapshot())).effect).toBe('new-sessions')
  expect(application.restartPending()).toBe(false)
  expect(application.profile().hash).toMatch(/^sha256-[a-f0-9]{64}$/)
  expect(published).toBe(application.profile())
  const accepted = published
  for (const change of [
    { dataDir: '/different-storage' },
    { policy: { capabilityCeiling: ['exec'], workspacePackages: 'require-project-trust' as const } },
    { composition: { providers: { compaction: null } } },
    { adminBundles: ['test/kit#main'] },
  ]) {
    revision++
    next = { ...application.profile(), ...change }
    expect((await application.apply(snapshot())).effect).toBe('restart-required')
    expect(application.restartPending()).toBe(true)
    expect(application.profile()).toBe(accepted)
    expect(published).toBe(accepted)
  }
  const stale = snapshot()
  revision++
  expect((await application.apply(stale)).effect).toBe('restart-required')
  expect(published).toBe(accepted)
})

it('still activates provider setup after the package lock changed in-process', async () => {
  const initial = {
    name: 'local-dev',
    schemaVersion: 1,
    dataDir: '/data',
    cacheDir: '/cache',
    hash: 'old',
    chain: [],
    packages: [{ id: '@agnes/ai', source: 'builtin' }],
    adapters: { storage: 'sqlite', secrets: { kind: 'file' } },
    provider: { package: '@agnes/ai', adapters: [] },
    transports: [],
    policy: { capabilityCeiling: [], workspacePackages: 'require-project-trust' },
    limits: {},
  } as unknown as ResolvedProfile
  let revision = 0
  const snapshot = () => ({
    profile: 'local-dev',
    revision,
    configured: revision > 0,
    provider: null,
    effect: 'new-sessions' as const,
  })
  const service = { get: async () => snapshot() } as ConfigurationService
  const next = {
    ...initial,
    hash: 'new',
    packages: [...initial.packages, { id: 'test/legacy-preset', source: 'file:/tmp/legacy' }],
    // Installing a bundle enriches the next boot profile even when none of its presets is selected.
    composition: {},
    compositionSources: {},
    bundleCatalog: { 'test/legacy-preset#main': { id: 'test/legacy-preset#main', document: {} } },
    bundlePresets: {},
    adminBundles: [],
    provider: {
      package: '@agnes/ai',
      adapters: ['@agnes/ai'],
      routes: [
        { route: 'deepseek', api: 'openai-chat', models: [{ id: 'deepseek-v4-flash', slot: 'primary' }] },
      ],
    },
  } as unknown as ResolvedProfile
  let published = initial
  const activate = async (profile: ResolvedProfile) => {
    published = profile
  }
  const application = await configurationApplication({
    service,
    profile: initial,
    reloadProfile: async () => next,
    activate,
  })
  revision = 1
  expect((await application.apply(snapshot())).effect).toBe('new-sessions')
  expect(published).toBe(application.profile())
  expect(application.profile().provider.routes).toHaveLength(1)
  // Account publication must not replace the worker's immutable deployment with new boot metadata.
  expect(application.profile().packages).toEqual(initial.packages)
  expect(application.profile().composition).toBeUndefined()
  expect(application.profile().bundleCatalog).toBeUndefined()
})

it('acknowledges presentation-only CAS revisions without activating an execution profile or reporting restart', async () => {
  const profile = { hash: 'original' } as ResolvedProfile
  let revision = 2
  const snapshot = () => ({
    profile: 'local-dev',
    revision,
    executionRevision: 2,
    configured: false,
    provider: null,
    effect: 'new-sessions' as const,
  })
  const service = { get: async () => snapshot() } as ConfigurationService
  const application = await configurationApplication({
    service,
    profile,
    activate: async () => {
      throw new Error('presentation must not activate execution')
    },
  })
  revision = 3
  expect(application.present(snapshot()).effect).toBe('new-sessions')
  expect(application.profile()).toBe(profile)
  expect(application.present({ ...snapshot(), executionRevision: 3 }).effect).toBe('restart-required')
})
