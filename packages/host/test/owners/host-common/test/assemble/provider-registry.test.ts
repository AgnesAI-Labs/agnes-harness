import { defaultLoopPlugin } from '@agnes/base'
import { Context } from '@agnes/cordis'
import {
  defineKind,
  type LoopContext,
  type LoopDriver,
  loopCheckpointCodec,
  loopKind,
  type PersistenceSessionStore,
  ProviderError,
  persistenceKind,
  sandboxKind,
} from '@agnes/extension-api'
import {
  installProviderRegistry,
  ProviderRegistry,
  providerSource,
} from '@agnes/host-common/assemble/provider-registry'
import { createPersistenceProviderRegistry } from '@agnes/host-infrastructure/adapters/storage-provider'
import { installSandboxProviders } from '@agnes/host-providers/adapters/sandbox-providers'
import { installCompactionEngines } from '@agnes/host-providers/assemble/compaction-engines'
import { installLoops } from '@agnes/host-providers/assemble/loops'
import { installModelAdapters } from '@agnes/host-providers/assemble/model-adapters'
import {
  applyProviderPreset,
  readProviderSelection,
  readProviderSelections,
} from '@agnes/host-providers/assemble/provider-selection'
import { installToolProviders } from '@agnes/host-providers/assemble/tool-providers'
import { expect, it } from 'vitest'

const kind = defineKind<{ id: string; version: string; ready: boolean }>({
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
    ctx.providers.registerHost(kind, '@test/provider', { id: 'one', version: '1.0.0', ready: true })
    ctx.effect(() => () => {
      released = true
    })
  })
  await expect.poll(() => registry.catalog().length).toBe(1)
  expect(() => registry.register('@test/duplicate', { id: 'one', version: '2.0.0', ready: true })).toThrow(
    'duplicate',
  )
  expect(() => registry.register('@test/invalid', { id: 'bad', version: '1.0.0', ready: false })).toThrow(
    'not ready',
  )
  expect(() => registry.register('@test/provider', { id: 'invalid', version: '1', ready: true })).toThrow(
    ProviderError,
  )
  expect(() => root.providers.resolve(defineKind({ ...kind }), 'one')).toThrow('does not match')
  root.providers.select('test', { provider: 'one' }, 'profile')
  const [entry] = root.providers.catalog()
  expect(entry).toEqual({
    kind: 'test',
    id: 'one',
    version: '1.0.0',
    sourcePackage: '@test/provider',
    capabilities: ['compute'],
    restartRequired: false,
    required: false,
    authority: 'open' as const,
    pinned: false,
    scope: 'generation',
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
  const registry = new ProviderRegistry(defineKind({ ...kind, versioned: true }))
  registry.register('@test/provider', { id: 'one', version: '1.0.0', ready: true })
  expect(registry.resolve('one').version).toBe('1.0.0')
  registry.register('@test/provider', { id: 'one', version: '2.0.0', ready: true })
  expect(() => registry.resolve('one')).toThrow('set test.version')
  expect(registry.resolve({ provider: 'one', version: '2.0.0' }).version).toBe('2.0.0')
  expect(() => registry.resolve({ provider: 'one', version: '3.0.0' })).toThrow('change test.provider')
  await registry.dispose()
  expect(registry.catalog()).toEqual([])
  expect(() => registry.register('@test/provider', { id: 'new', version: '1.0.0', ready: true })).toThrow(
    'disposed',
  )
})

it('combines named registries and retains their public catalog shapes and restart markers', async () => {
  const root = new Context()
  installLoops(root)
  expect(root.loops.catalog()).toEqual([])
  // Every fiber of this bare tree stands for a bundled @agnes/base row.
  root.providers.verifyRows({
    lookup: () => ({ trustTier: 'builtin', packageId: 'builtin', ownerPackage: '@agnes/base' }),
  } as never)
  const loopPlugin = root.plugin(defaultLoopPlugin)
  await loopPlugin
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
  expect(root.providers.catalog().filter((entry) => entry.kind === 'tool-runtime')[0]).toHaveProperty(
    'active',
  )
  const origins = { lookup: () => ({ packageId: '@test/owner', trustTier: 'trusted' }) } as never
  const plugin = root.plugin((ctx) => {
    expect(() => providerSource(ctx, origins, '@test/wrong')).toThrow('does not match')
  })
  await plugin
  await loopPlugin.dispose()
  expect(() => root.loops.resolve({ id: 'agnes.default', version: '1.0.0' })).toThrow(
    expect.objectContaining({ code: 'E_PROVIDER_UNKNOWN', kind: 'loop' }),
  )
  const providers = root.providers
  await root.fiber.dispose()
  expect(providers.catalog()).toEqual([])
})

it('treats a root-fiber call shadow as host-owned and still refuses an unverified plugin fiber', async () => {
  const root = new Context()
  const origins = { lookup: () => undefined }
  // Cordis `extend` is the call shadow: a different object on the root fiber.
  const shadow = root.extend()
  expect(shadow).not.toBe(root)
  expect(shadow.fiber).toBe(root.fiber)
  expect(providerSource(shadow, origins, '@agnes/base')).toBe('@agnes/base')

  let sawRootFiberShadow = false
  const registry: ProviderRegistry<{ id: string; version: string; ready: boolean }> = installProviderRegistry(
    root,
    kind,
    (owner, source, provider) => {
      sawRootFiberShadow = owner !== root && owner.fiber === root.fiber
      const verified = providerSource(owner, origins, source)
      return registry.register(verified, provider, owner)
    },
  )
  root.providers.registerHost(kind, '@agnes/base', { id: 'host', version: '1.0.0', ready: true })
  expect(sawRootFiberShadow).toBe(true)
  expect(registry.catalog()[0]).toMatchObject({ id: 'host', sourcePackage: '@agnes/base' })

  let failure: unknown
  const plugin = root.plugin((ctx) => {
    try {
      expect(ctx.fiber).not.toBe(root.fiber)
      ctx.providers.registerHost(kind, '@evil/plugin', { id: 'plugin', version: '1.0.0', ready: true })
    } catch (error) {
      failure = error
    }
  })
  await plugin
  expect(failure).toMatchObject({ code: 'E_EXT_LOAD' })
  expect(String(failure)).toContain('verified plugin row')
  expect(registry.catalog().map((entry) => entry.id)).toEqual(['host'])
  await root.fiber.dispose()
})

it('derives the source package from the calling row for every kind, without a claim from the author', async () => {
  const root = new Context()
  // A registry installed with no registrar of its own is attributed the same way.
  const registry = installProviderRegistry(root, kind)
  const rows = new WeakMap<object, object>()
  root.providers.verifyRows({ lookup: (fiber: object) => rows.get(fiber) } as never)
  const provider = (id: string) => ({ id, version: '1.0.0', ready: true })
  const failures: unknown[] = []
  const mount = async (origin: object | undefined, run: (ctx: Context) => void) => {
    await root.plugin((ctx) => {
      if (origin) rows.set(ctx.fiber, origin)
      try {
        run(ctx)
      } catch (error) {
        failures.push(error)
      }
    })
  }
  await mount({ trustTier: 'third-party', packageId: '@acme/installed' }, (ctx) => {
    ctx.providers.register(kind, provider('installed'))
  })
  await mount({ trustTier: 'builtin', packageId: 'builtin', ownerPackage: '@agnes/base' }, (ctx) => {
    ctx.providers.register(kind, provider('bundled'))
  })
  expect(failures).toEqual([])
  expect(registry.catalog().map((entry) => [entry.id, entry.sourcePackage])).toEqual([
    ['bundled', '@agnes/base'],
    ['installed', '@acme/installed'],
  ])

  // An installed row cannot name another package through the Host path either.
  await mount({ trustTier: 'third-party', packageId: '@acme/installed' }, (ctx) => {
    ctx.providers.registerHost(kind, '@agnes/base', provider('claimed'))
  })
  // A bundled row whose builder stated no owner, and a fiber with no row, have no source to derive.
  await mount({ trustTier: 'builtin', packageId: 'builtin' }, (ctx) => {
    ctx.providers.register(kind, provider('ownerless'))
  })
  await mount(undefined, (ctx) => {
    ctx.providers.register(kind, provider('rowless'))
  })
  expect(() => root.providers.register(kind, provider('host'))).toThrow('verified plugin row')
  expect(failures.map(String)).toEqual([
    expect.stringContaining('does not match its plugin row'),
    expect.stringContaining('verified plugin row'),
    expect.stringContaining('verified plugin row'),
  ])
  expect(registry.catalog().map((entry) => entry.id)).toEqual(['bundled', 'installed'])
  await root.fiber.dispose()
})

it('accepts only canonical selections, ignores resolved identities and reads them from the one table', () => {
  expect(readProviderSelection('loop', { provider: 'echo', version: '1.0.0' })).toEqual({
    provider: 'echo',
    version: '1.0.0',
  })
  expect(() => readProviderSelection('compaction', { engine: 'short' })).toThrow('requires')
  expect(() => readProviderSelection('loop', { id: 'echo', version: '1.0.0' })).toThrow('requires')
  expect(() => readProviderSelection('loop', { provider: 'one', id: 'two' })).toThrow('requires')
  const profile = {
    loop: { id: 'pinned', version: '1.0.0' },
    packages: [],
    providers: { loop: { provider: 'echo' }, 'tool-policy': { provider: 'read-only', version: '1.0.0' } },
  }
  const selections = readProviderSelections(profile as never)
  expect(selections.loop).toEqual({ provider: 'echo' })
  expect(
    readProviderSelections({
      packages: [],
      composition: { providers: { 'model-adapter': { provider: [] } } },
    } as never)['model-adapter'],
  ).toBeUndefined()
  // A composition layer that chose a kind overrides the table; the default layer does not.
  expect(
    readProviderSelections({
      ...profile,
      composition: { providers: { loop: { provider: 'session', version: '2.0.0' } } },
      compositionSources: { loop: { layer: 'session', name: 'request' } },
    } as never).loop,
  ).toEqual({ provider: 'session', version: '2.0.0' })
  expect(
    readProviderSelections({
      ...profile,
      composition: { providers: { loop: { provider: 'builtin', version: '1.0.0' } } },
      compositionSources: { loop: { layer: 'default', name: 'default' } },
    } as never).loop,
  ).toEqual({ provider: 'echo' })
  expect(
    readProviderSelections({
      packages: [],
      providers: { 'model-adapter': { provider: ['chat', '@test/wire'] } },
    } as never)['model-adapter'],
  ).toEqual({ provider: ['chat', '@test/wire'] })
  expect(() =>
    readProviderSelections({
      packages: [],
      providers: { 'model-adapter': { provider: ['chat', 'chat'] } },
    } as never),
  ).toThrow('unique ids')
  expect(
    readProviderSelections({
      packages: [],
      providers: { memory: { provider: 'enterprise', version: '2.0.0' } },
    } as never).memory,
  ).toEqual({ provider: 'enterprise', version: '2.0.0' })
  expect(
    readProviderSelections({
      composition: { providers: { compaction: null } },
      packages: [],
      providers: { compaction: { provider: 'default' } },
    } as never).compaction,
  ).toBeUndefined()
  expect(applyProviderPreset({ name: 'standard', approval: { timeout_ms: 10 } }, selections)).toMatchObject({
    approval: { timeout_ms: 10 },
    providers: { 'tool-policy': { provider: 'read-only' } },
  })
  // An enabled package's own config is its plugin's data: it selects nothing.
  expect(
    readProviderSelections({
      packages: [
        { enabled: true, config: { memory: { provider: 'one' }, loop: { provider: 'one' } } },
        { enabled: true, config: { memory: { provider: 'two' }, loop: { provider: 'two' } } },
      ],
    } as never),
  ).toEqual({})
})

it.each(['loop', 'sandbox', 'persistence'] as const)(
  '%s owns asynchronous construction, cancelled late results and invalid-result cleanup',
  async (kind) => {
    for (const exit of ['abort', 'unload', 'invalid', 'reject', 'cleanup-failure'] as const) {
      const root = new Context()
      installLoops(root)
      const sandbox = installSandboxProviders(root)
      root.providers.add(createPersistenceProviderRegistry(undefined, undefined))
      const ac = new AbortController()
      let finish!: (value: unknown) => void
      let fail!: (reason: Error) => void
      let ready!: () => void
      const admitted = new Promise<void>((resolve) => {
        ready = resolve
      })
      let signal!: AbortSignal
      let disposed = 0
      let cleaned = 0
      const construct = (joined?: AbortSignal) => {
        if (!joined) throw new Error('Missing construction signal')
        signal = joined
        ready()
        return new Promise<unknown>((resolve, reject) => {
          finish = resolve
          fail = reject
        })
      }
      let unregister: () => Promise<void>
      let open: () => Promise<unknown>
      const id = 'construction'
      const close = () => {
        disposed++
        if (exit === 'cleanup-failure') throw new Error('Cleanup failed')
      }
      let instance: unknown
      if (kind === 'loop') {
        const codec = loopCheckpointCodec(1, (value) => value)
        unregister = root.providers.registerHost(loopKind, '@test/provider', {
          id,
          version: '1.0.0',
          capabilities: [],
          codec,
          create: (_ctx, joined) => construct(joined) as Promise<LoopDriver>,
          resume: (_ctx, _checkpoint, joined) => construct(joined) as Promise<LoopDriver>,
        })
        open = async () => {
          const factory = root.loops.resolve({ id, version: '1.0.0' })
          return exit === 'unload'
            ? factory.resume({} as LoopContext, codec.encode(null), ac.signal)
            : factory.create({} as LoopContext, ac.signal)
        }
        instance = {
          step: async () => ({ outcome: 'idle' }),
          checkpoint: () => codec.encode(null),
          cancel() {},
          dispose: close,
        }
      } else if (kind === 'sandbox') {
        const capabilities = { network: false, fsWrite: [], platform: ['linux' as const], available: true }
        unregister = root.providers.registerHost(sandboxKind, '@test/provider', {
          id,
          version: '1.0.0',
          capabilities,
          create: (_config, joined) =>
            construct(joined) as Promise<import('@agnes/extension-api').SandboxProviderInstance>,
          cleanup() {
            expect(disposed).toBe(exit === 'reject' ? 0 : 1)
            cleaned++
          },
        })
        open = () => sandbox.select(id, {}, ac.signal)
        instance = { id, capabilities, exec: async () => ({}), dispose: close }
      } else {
        unregister = root.providers.registerHost(persistenceKind, '@test/provider', {
          id,
          version: '1.0.0',
          state: { effect: 'restart-required' },
          capabilities: { ledger: true },
          open: (options) => construct(options.signal) as Promise<PersistenceSessionStore>,
        })
        open = async () =>
          root.providers.resolve(persistenceKind, id).open({ dataDir: '/unused', signal: ac.signal })
        instance = { open() {}, commit() {}, renew() {}, release() {}, scan() {}, registers() {}, close }
      }
      const creating = Promise.resolve().then(open)
      const outcome = expect(creating).rejects.toThrow(exit === 'reject' ? 'Factory failed' : undefined)
      await admitted
      let drained = false
      const unloading =
        exit === 'unload'
          ? unregister().then(() => {
              drained = true
            })
          : undefined
      if (exit === 'abort' || exit === 'cleanup-failure') ac.abort(new Error('Construction cancelled'))
      await Promise.resolve()
      if (exit === 'abort' || exit === 'unload') expect(signal.aborted).toBe(true)
      expect(drained).toBe(false)
      if (exit === 'reject') fail(new Error('Factory failed'))
      else if (exit === 'invalid') {
        finish(kind === 'persistence' ? { close } : { dispose: close })
      } else finish(instance)
      await outcome
      if (unloading) await unloading
      else if (exit === 'cleanup-failure')
        await expect(unregister()).rejects.toThrow('provider cleanup failed')
      else await unregister()
      expect(disposed).toBe(exit === 'reject' ? 0 : 1)
      if (kind === 'sandbox') expect(cleaned).toBe(1)
      await root.fiber.dispose()
    }
  },
)
