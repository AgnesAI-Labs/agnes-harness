import { Context } from '@agnes/cordis'
import { defineProviderKind } from '@agnes/extension-api'
import { expect, it } from 'vitest'
import {
  ProviderRegistry,
  installProviderRegistry,
  providerSource,
} from '../../src/assemble/provider-registry.js'
import {
  readProviderSelection,
  readProviderSelections,
  applyProviderPreset,
} from '../../src/assemble/provider-selection.js'
import { installLoops } from '../../src/assemble/loops.js'
import { installToolProviders } from '../../src/assemble/tool-providers.js'
import { installModelAdapters } from '../../src/assemble/model-adapters.js'
import { installCompactionEngines } from '../../src/assemble/compaction-engines.js'
import { installSandboxProviders } from '../../src/adapters/sandbox-providers.js'
import { createPersistenceProviderRegistry } from '../../src/adapters/storage-provider.js'

const kind = defineProviderKind<{ id: string; version: string; ready: boolean }>({
  kind: 'test',
  validate(provider) {
    if (!provider.ready) throw new Error('not ready')
  },
  capabilities: () => ['compute'],
})

it('owns registrations by fiber, refuses duplicates and exposes immutable selected metadata', async () => {
  const root = new Context()
  const registry = installProviderRegistry(root, kind)
  let released = false
  const plugin = root.plugin((ctx) => {
    ctx.providers.register(kind, '@test/provider', { id: 'one', version: '1', ready: true })
    ctx.effect(() => () => {
      released = true
    })
  })
  await expect.poll(() => registry.catalog().length).toBe(1)
  expect(() => registry.register('@test/duplicate', { id: 'one', version: '2', ready: true })).toThrow(
    'duplicate',
  )
  expect(() => registry.register('@test/invalid', { id: 'bad', version: '1', ready: false })).toThrow(
    'not ready',
  )
  root.providers.select('test', { provider: 'one' }, 'profile')
  const [entry] = root.providers.catalog()
  expect(entry).toEqual({
    kind: 'test',
    id: 'one',
    version: '1',
    sourcePackage: '@test/provider',
    capabilities: ['compute'],
    restartRequired: false,
    active: true,
    selectedFor: ['profile'],
  })
  expect(Object.isFrozen(entry?.capabilities)).toBe(true)
  await plugin.dispose()
  expect(released).toBe(true)
  expect(root.providers.catalog()).toEqual([])
  expect(() => registry.resolve('one')).toThrow('install and enable')
  await root.fiber.dispose()
})

it('requires an explicit version when ambiguous and refuses version mismatches without fallback', async () => {
  const registry = new ProviderRegistry(defineProviderKind({ ...kind, versioned: true }))
  registry.register('@test/provider', { id: 'one', version: '1', ready: true })
  expect(registry.resolve('one').version).toBe('1')
  registry.register('@test/provider', { id: 'one', version: '2', ready: true })
  expect(() => registry.resolve('one')).toThrow('set test.version')
  expect(registry.resolve({ provider: 'one', version: '2' }).version).toBe('2')
  expect(() => registry.resolve({ provider: 'one', version: '3' })).toThrow('change test.provider')
  await registry.dispose()
  expect(registry.catalog()).toEqual([])
  expect(() => registry.register('@test/provider', { id: 'new', version: '1', ready: true })).toThrow(
    'disposed',
  )
})

it('combines named registries and retains their public catalog shapes and restart markers', async () => {
  const root = new Context()
  installLoops(root)
  installToolProviders(root)
  installModelAdapters(root)
  installCompactionEngines(root)
  installSandboxProviders(root)
  const persistence = createPersistenceProviderRegistry(undefined, undefined)
  root.providers.add(persistence)
  root.providers.select('persistence', 'sqlite', 'process')
  expect(root.providers.catalog()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: 'loop', id: 'agnes.default', restartRequired: false }),
      expect.objectContaining({ kind: 'tool-runtime', id: 'default', restartRequired: false }),
      expect.objectContaining({ kind: 'persistence', id: 'sqlite', restartRequired: true, active: true }),
    ]),
  )
  expect(root.loops.catalog()[0]).not.toHaveProperty('kind')
  expect(root.toolRuntimes.catalog()[0]).not.toHaveProperty('active')
  const origins = { lookup: () => ({ packageId: '@test/owner', trustTier: 'trusted' }) } as never
  const plugin = root.plugin((ctx) => {
    expect(() => providerSource(ctx, origins, '@test/wrong', true)).toThrow('does not match')
  })
  await plugin
  const providers = root.providers
  await root.fiber.dispose()
  expect(providers.catalog()).toEqual([])
})

it('normalizes canonical selections and aliases, preserves profile precedence and rejects conflicting config', () => {
  expect(readProviderSelection('loop', { id: 'echo', version: '1' })).toEqual({
    provider: 'echo',
    version: '1',
  })
  expect(readProviderSelection('compaction', { engine: 'short' })).toEqual({ provider: 'short' })
  expect(() => readProviderSelection('loop', { provider: 'one', id: 'two' })).toThrow('requires')
  const profile = {
    loop: { id: 'pinned', version: '1' },
    packages: [
      { enabled: true, config: { loop: { provider: 'echo' }, 'tool-policy': { provider: 'read-only' } } },
    ],
  } as never
  const selections = readProviderSelections(profile)
  expect(selections.loop).toEqual({ provider: 'pinned', version: '1' })
  expect(
    readProviderSelections({
      composition: { compaction: null },
      packages: [{ enabled: true, config: { compaction: { provider: 'default' } } }],
    } as never).compaction,
  ).toBeUndefined()
  expect(applyProviderPreset({ name: 'standard', approval: { timeout_ms: 10 } }, selections)).toMatchObject({
    approval: { policy: 'read-only', timeout_ms: 10 },
  })
  expect(() =>
    readProviderSelections({
      packages: [
        { enabled: true, config: { sandbox: { provider: 'one' } } },
        { enabled: true, config: { sandbox: { provider: 'two' } } },
      ],
    } as never),
  ).toThrow('at most one')
})
