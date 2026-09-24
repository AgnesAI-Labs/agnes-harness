import type { ConfigurationService, ResolvedProfile } from '@agnes/host'
import { expect, it, vi } from 'vitest'
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
  const activate = vi.fn(async () => undefined)
  const application = await configurationApplication({
    service,
    profile: initial,
    reloadProfile: async () => next,
    activate,
  })
  revision = 1
  expect(application.present(snapshot()).effect).toBe('restart-required')
  expect((await application.apply(snapshot())).effect).toBe('new-sessions')
  expect(application.profile().hash).toBe('new')
  expect(activate).toHaveBeenCalledTimes(1)
  revision = 2
  next = { ...next, dataDir: '/different-storage' }
  expect((await application.apply(snapshot())).effect).toBe('restart-required')
  expect(application.profile().dataDir).toBe('/data')
  expect(activate).toHaveBeenCalledTimes(1)
  const stale = snapshot()
  revision = 3
  expect((await application.apply(stale)).effect).toBe('restart-required')
  expect(activate).toHaveBeenCalledTimes(1)
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
    provider: {
      package: '@agnes/ai',
      adapters: ['@agnes/ai'],
      routes: [
        { route: 'deepseek', api: 'openai-chat', models: [{ id: 'deepseek-v4-flash', slot: 'primary' }] },
      ],
    },
  } as unknown as ResolvedProfile
  const activate = vi.fn(async () => undefined)
  const application = await configurationApplication({
    service,
    profile: initial,
    reloadProfile: async () => next,
    activate,
  })
  revision = 1
  expect((await application.apply(snapshot())).effect).toBe('new-sessions')
  expect(activate).toHaveBeenCalledTimes(1)
  expect(application.profile().provider.routes).toHaveLength(1)
})
