import { Context } from '@agnes/cordis'
import { Type } from '@sinclair/typebox'
import { describe, expect, it } from 'vitest'
import {
  createPluginRow,
  E_LEASE_DENIED,
  E_SEAM_UNAVAILABLE,
  FiberLeases,
  MultiProviderRegistry,
  SeamRuntime,
  typeBoxStandardSchema,
} from '../src/host/index.js'

describe('plugin row foundation', () => {
  it('normalizes the runtime before creating the mount identity', () => {
    const row = createPluginRow({
      id: 'seam:example',
      plugin: '@example/plugin',
      snapshotDigest: 'sha256-example',
      exportName: 'default',
      entryRevision: 'entry-1',
      extrasRevision: 'extras-1',
      mountRevision: 'mount-1',
      inject: ['beta', 'alpha'],
      isolate: { beta: 'b', alpha: 'a' },
      provides: ['example'],
    })

    expect(row.runtime).toBe('in-process')
    expect(row.disabled).toBe(false)
    expect(typeof row.mountIdentity).toBe('string')
    expect(row.mountIdentity.length).toBeGreaterThan(0)
  })

  it('does not turn compile-time platform and sandbox components into rows', () => {
    const base = {
      plugin: '@example/static',
      snapshotDigest: 'sha256-static',
      exportName: 'default',
      entryRevision: 'entry-1',
      extrasRevision: 'extras-1',
      mountRevision: 'mount-1',
    }
    expect(() => createPluginRow({ ...base, id: 'seam:platform' })).toThrow(/static component/)
    expect(() => createPluginRow({ ...base, id: 'seam:sandbox' })).toThrow(/static component/)
    expect(() => createPluginRow({ ...base, id: 'extension:escape', provides: ['seam:platform'] })).toThrow(
      /static component/,
    )
    expect(() => createPluginRow({ ...base, id: 'extension:escape', provides: ['seam:sandbox'] })).toThrow(
      /static component/,
    )
  })

  it('takes an immutable deep snapshot of plugin config', () => {
    const source = { nested: { enabled: true }, list: [{ value: 1 }] }
    const row = createPluginRow({
      id: 'extension:config-snapshot',
      plugin: '@example/config-snapshot',
      snapshotDigest: 'sha256-config-snapshot',
      exportName: 'default',
      entryRevision: 'entry-1',
      extrasRevision: 'extras-1',
      mountRevision: 'mount-1',
      config: source,
    })

    source.nested.enabled = false
    const first = source.list[0]
    if (!first) throw new Error('missing config fixture')
    first.value = 2
    expect(row.config).toEqual({ nested: { enabled: true }, list: [{ value: 1 }] })
    expect(Object.isFrozen(row.config)).toBe(true)
    expect(Object.isFrozen((row.config as { nested: object }).nested)).toBe(true)
  })
})

describe('stable seams', () => {
  it('keeps one frozen facade while its provider changes', () => {
    const seam = new SeamRuntime<{ greet(name: string): string }>('example')
    const facade = seam.facade

    expect(Object.isFrozen(facade)).toBe(true)
    expect(() => facade.greet('Ada')).toThrow(E_SEAM_UNAVAILABLE)

    const first = seam.provide({ greet: (name) => `one:${name}` })
    expect(facade.greet('Ada')).toBe('one:Ada')
    expect(() => seam.provide({ greet: () => 'duplicate' })).toThrow()

    first()
    expect(() => facade.greet('Ada')).toThrow(E_SEAM_UNAVAILABLE)
    seam.provide({ greet: (name) => `two:${name}` })
    expect(seam.facade).toBe(facade)
    expect(facade.greet('Ada')).toBe('two:Ada')
  })

  it('resolves an operational seam provider through publication before invoking it', async () => {
    let open = () => {}
    const hold = new Promise<void>((resolve) => {
      open = resolve
    })
    const events: string[] = []
    const seam = new SeamRuntime<{ greet(name: string): Promise<string> }>('example', {
      async ordinary<T>(resolve: () => () => T | Promise<T>): Promise<Awaited<T>> {
        events.push('ticket')
        await hold
        const handler = resolve()
        events.push('resolved')
        await Promise.resolve()
        return (await handler()) as Awaited<T>
      },
    })
    const releaseV1 = seam.provide({ greet: async (name) => `one:${name}` })
    const result = seam.facade.greet('Ada')
    releaseV1()
    seam.provide({ greet: async (name) => `two:${name}` })
    expect(events).toEqual(['ticket'])
    open()
    await expect(result).resolves.toBe('two:Ada')
    expect(events).toEqual(['ticket', 'resolved'])
  })

  it.each(['first access', 'cached forwarder'])(
    '%s waits across the unpublished generation gap',
    async (mode) => {
      let open = () => {}
      const hold = new Promise<void>((resolve) => {
        open = resolve
      })
      const seam = new SeamRuntime<{ greet(name: string): Promise<string> }>('example', {
        async ordinary<T>(resolve: () => () => T | Promise<T>): Promise<Awaited<T>> {
          await hold
          return (await resolve()()) as Awaited<T>
        },
      })
      const releaseV1 = seam.provide({ greet: async (name) => `one:${name}` })
      const cached = mode === 'cached forwarder' ? seam.facade.greet : undefined
      releaseV1()
      const result = (cached ?? seam.facade.greet)('Ada')
      seam.provide({ greet: async (name) => `two:${name}` })
      open()
      await expect(result).resolves.toBe('two:Ada')
    },
  )

  it('keeps listener registration synchronous because it does not dispatch business work', () => {
    const disposer = () => {}
    const seam = new SeamRuntime<{ onGrantRevoked(listener: () => void): () => void }>('approval', {
      ordinary: async () => {
        throw new Error('business dispatch should not run')
      },
    })
    seam.provide({ onGrantRevoked: () => disposer })
    expect(seam.facade.onGrantRevoked(() => {})).toBe(disposer)
  })
})

describe('multi-provider registry', () => {
  it('binds one contribution per owner and releases it deterministically', () => {
    const registry = new MultiProviderRegistry<string>()
    const owner = {}
    const dispose = registry.registerFrom(owner, ['one', 'two'])

    expect(registry.snapshot()).toEqual(['one', 'two'])
    expect(Object.isFrozen(registry.snapshot())).toBe(true)
    expect(() => registry.registerFrom(owner, ['duplicate'])).toThrow()

    dispose()
    expect(registry.snapshot()).toEqual([])
  })
})

describe('fiber leases', () => {
  it('checks the exact source fiber and releases a binding with its effect', async () => {
    const root = new Context()
    const other = new Context()
    const leases = new FiberLeases<string>()
    const lease = leases.bind(root.fiber, 'tools')

    expect(leases.require(root.fiber, 'tools')).toBe(lease)
    expect(() => leases.bind(root.fiber, 'tools')).toThrow()
    expect(() => leases.require(other.fiber, 'tools')).toThrow(E_LEASE_DENIED)

    await lease.release()
    expect(() => leases.require(root.fiber, 'tools')).toThrow(E_LEASE_DENIED)
  })
})

describe('TypeBox standard-schema adapter', () => {
  it('returns values and structured issues through the standard-schema contract', () => {
    const schema = typeBoxStandardSchema(Type.Object({ count: Type.Integer({ minimum: 1 }) }))

    expect(schema['~standard'].validate({ count: 2 })).toEqual({ value: { count: 2 } })
    const invalid = schema['~standard'].validate({ count: 0 })
    expect(('issues' in invalid && invalid.issues?.length) || 0).toBeGreaterThan(0)
  })

  it('returns TypeBox transform output rather than the encoded input', () => {
    const schema = typeBoxStandardSchema(
      Type.Transform(Type.String())
        .Decode((value) => value.length)
        .Encode((value) => String(value)),
    )
    expect(schema['~standard'].validate('agnes')).toEqual({ value: 5 })
  })
})
