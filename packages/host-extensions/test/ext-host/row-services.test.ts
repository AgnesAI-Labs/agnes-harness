import { Context, type Fiber } from '@agnes/cordis'
import type { ResourceEntry, SlotContext } from '@agnes/extension-api'
import { serviceFixture } from '@agnes/extension-api/testkit'
import type { RowOrigin } from '@agnes/plugin-runtime/host'
import { describe, expect, it } from 'vitest'
import type { KernelPorts, RegMeta } from '../../src/ext-host/ports.js'
import { pluginRowSource } from '../../src/ext-host/row-extension-host.js'
import { createRowServiceHost } from '../../src/ext-host/row-services.js'
import { ServiceRegistry } from '../../src/ext-host/services.js'

const origin: RowOrigin = Object.freeze({
  trustTier: 'third-party',
  packageId: 'acme/panel',
  snapshotId: 'snapshot-1',
  rowId: 'ext:acme/panel',
  exportName: 'panel',
  declaredProvides: [],
})

describe('Cordis row service contribution', () => {
  it('rejects a context without a verified row', async () => {
    const root = new Context()
    const bridge = createRowServiceHost(() => ({ version: '1.0.0' }))
    bridge.installRoot(root, { lookup: () => undefined })
    const unverified = root.plugin((ctx) => ctx.services.register(serviceFixture()))
    await expect(unverified).rejects.toThrow(/verified row/)
  })

  it('publishes a service after Host activation and revokes it with its row', async () => {
    const root = new Context()
    const origins = new WeakMap<Fiber, RowOrigin>()
    const bridge = createRowServiceHost(() => ({ version: '1.0.0' }))
    bridge.installRoot(root, { lookup: (fiber) => origins.get(fiber) })
    const def = serviceFixture()
    const owner = pluginRowSource(origin.rowId)
    let captured: Context | undefined
    const row = root.plugin((ctx) => {
      origins.set(ctx.fiber, origin)
      captured = ctx
      ctx.services.register(def)
    })
    await row
    const registry = new ServiceRegistry()
    expect(registry.registrations(owner)).toEqual([])
    bridge.activate({ services: registry } as unknown as KernelPorts)
    const source = registry.registrations(owner)
    expect(source).toEqual([`service:${owner}/fixture.echo`])
    expect(registry.resolve(owner, def.name)?.version).toBe('1.0.0')
    origins.delete((captured as Context).fiber)
    expect(() => captured?.services.register(def)).toThrow(/verified row/)
    expect(() => registry.resolve(owner, def.name)?.assertAlive()).toThrow(/closed/)
    await row.dispose()
    expect(registry.registrations(owner)).toEqual([])
    origins.set((captured as Context).fiber, origin)
    expect(() => captured?.services.register(def)).toThrow(/closed/)
  })

  it('validates a resource and releases the row-owned registration on dispose', async () => {
    const root = new Context()
    const origins = new WeakMap<Fiber, RowOrigin>()
    const bridge = createRowServiceHost(() => ({ version: '1.0.0' }))
    bridge.installRoot(root, { lookup: (fiber) => origins.get(fiber) })
    const held = new Map<string, string>()
    bridge.activate({
      resources: {
        register(entry: ResourceEntry, meta: RegMeta) {
          held.set(entry.id, meta.source)
          return () => {
            held.delete(entry.id)
          }
        },
      },
    } as unknown as KernelPorts)
    const row = root.plugin((ctx) => {
      origins.set(ctx.fiber, origin)
      expect(() => ctx.resources.register({} as never)).toThrow(/invalid resource/)
      ctx.resources.register({ id: 'helper', kind: 'skill', name: 'helper', description: 'test' })
    })
    await row
    expect(held.get('helper')).toBe(pluginRowSource(origin.rowId))
    await row.dispose()
    expect(held.size).toBe(0)
  })

  it('validates slot output and denies a callback after its row loses ownership', async () => {
    const root = new Context()
    const origins = new WeakMap<Fiber, RowOrigin>()
    const bridge = createRowServiceHost(() => ({ version: '1.0.0' }))
    bridge.installRoot(root, { lookup: (fiber) => origins.get(fiber) })
    let invoke: ((ctx: SlotContext) => unknown) | undefined
    bridge.activate({
      slots: {
        register(_slot: string, fill: (ctx: SlotContext) => unknown) {
          invoke = fill
          return () => {
            invoke = undefined
          }
        },
      },
    } as unknown as KernelPorts)
    let rowContext: Context | undefined
    const row = root.plugin((ctx) => {
      origins.set(ctx.fiber, origin)
      rowContext = ctx
      ctx.slots.register('status.line', () => ({ text: 'ready', level: 'info' }))
    })
    await row
    const context = {
      session: { key: 's', lane: 'main', workspaceRoot: '/workspace' },
      surface: 'web',
      trigger: { kind: 'turn_end' },
      projections: { readOwn: async () => ({ status: 'unavailable' }) },
    } as unknown as SlotContext
    expect(await invoke?.(context)).toEqual({ text: 'ready', level: 'info' })
    const retiredCallback = invoke
    origins.delete((rowContext as Context).fiber)
    expect(() => invoke?.(context)).toThrow(/closed/)
    await row.dispose()
    expect(invoke).toBeUndefined()
    origins.set((rowContext as Context).fiber, origin)
    expect(() => retiredCallback?.(context)).toThrow(/closed/)
  })

  it('compiles a row projection and rejects its callbacks after unmount', async () => {
    const root = new Context()
    const origins = new WeakMap<Fiber, RowOrigin>()
    const bridge = createRowServiceHost(() => ({ version: '1.0.0' }))
    bridge.installRoot(root, { lookup: (fiber) => origins.get(fiber) })
    let projection: { init(): unknown; apply(state: unknown, event: unknown): unknown } | undefined
    bridge.activate({
      projections: {
        register(def: { init(): unknown; apply(state: unknown, event: unknown): unknown }) {
          projection = def
          return () => {
            projection = undefined
          }
        },
      },
    } as unknown as KernelPorts)
    let rowContext: Context | undefined
    const row = root.plugin((ctx) => {
      origins.set(ctx.fiber, origin)
      rowContext = ctx
      ctx.projections.register({
        name: 'counter',
        stateVersion: 1,
        stateSchema: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'] },
        inputEventTypes: ['counter.tick'],
        maxStateBytes: 1024,
        init: () => ({ count: 0 }),
        apply: (state) => ({ count: state.count + 1 }),
      })
      expect(() =>
        ctx.projections.register({
          name: 'counter',
          stateVersion: 1,
          stateSchema: { type: 'object' },
          inputEventTypes: ['counter.tick'],
          maxStateBytes: 1024,
          init: () => ({}),
          apply: (state) => state,
        }),
      ).toThrow(/already registered/)
    })
    await row
    expect(projection?.init()).toEqual({ count: 0 })
    origins.delete((rowContext as Context).fiber)
    expect(() => projection?.init()).toThrow(/closed/)
    await row.dispose()
    expect(projection).toBeUndefined()
  })
})
