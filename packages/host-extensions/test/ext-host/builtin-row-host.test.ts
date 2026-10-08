import { ecosystem } from '@agnes/base'
import type {
  ExtensionAPI,
  ExtensionFactory,
  ExtensionManifest,
  HookContext,
  ToolContext,
  ToolDef,
} from '@agnes/extension-api'
import { serviceFixture } from '@agnes/extension-api/testkit'
import { describe, expect, it, vi } from 'vitest'
import { createBuiltinRowHost } from '../../src/ext-host/builtin-row-host.js'
import { ExtensionOwners } from '../../src/ext-host/extension-owners.js'
import { createExtensionOrder, mergeExtensionStatus } from '../../src/ext-host/extension-status-book.js'
import type { ExtensionSpec } from '../../src/ext-host/managed-host.js'
import type { KernelPorts } from '../../src/ext-host/ports.js'
import { ServiceRegistry } from '../../src/ext-host/services.js'

const log = { debug() {}, info() {}, warn() {}, error() {} }
const platform = Object.freeze({
  shell: 'posix',
  fs: Object.freeze({ caseSensitive: true, pathSep: '/' }),
  terminal: Object.freeze({ color: false }),
} as const)
const info = { agnesVersion: '0.0.0', apiVersion: '1.0.0', profileName: 'test' }
const ROW = 'ext:agnes/tools-search'
const ID = 'agnes/tools-search'

const manifest = (extra: Record<string, unknown> = {}): ExtensionManifest =>
  ({
    id: ID,
    version: '0.1.0',
    apiRange: '^1.0',
    entry: './index.js',
    capabilities: { tools: { prefix: '', names: ['grep', 'find'] }, hooks: ['shutdown'], ...extra },
  }) as ExtensionManifest

const spec: ExtensionSpec = {
  id: ID,
  package: '@agnes/base',
  packageVersion: '1.0.0',
  dir: '/nowhere',
  trust: 'builtin',
  enabled: true,
  integrity: 'sha256-x',
  revision: 'rev-1',
}

type AnyHandler = (payload: unknown, hctx: HookContext) => unknown
type AnyFill = (sctx: unknown) => unknown

function fakeKernel() {
  const tools = new Map<string, string>()
  // The proxy-wrapped definitions, so a test can call what the kernel would call.
  const toolDefs = new Map<string, ToolDef>()
  // Tool names whose kernel disposer throws, to leave a registration behind on unload.
  const stuck = new Set<string>()
  const hooks: { event: string; source: string; handler: AnyHandler }[] = []
  const slots = new Map<string, { source: string; fill: AnyFill }>()
  const services = new ServiceRegistry()
  const events: { type: string; data: unknown }[] = []
  const ports = {
    services,
    tools: {
      add(def: ToolDef, meta: { source: string }) {
        if (tools.has(def.name)) throw new Error(`E_REGISTRY_DUPLICATE: ${def.name}`)
        tools.set(def.name, meta.source)
        toolDefs.set(def.name, def)
        return () => {
          if (stuck.has(def.name)) throw new Error('disposer failed')
          tools.delete(def.name)
        }
      },
    },
    hooks: {
      on(event: string, handler: AnyHandler, meta: { source: string }) {
        const entry = { event, source: meta.source, handler }
        hooks.push(entry)
        return () => void hooks.splice(hooks.indexOf(entry), 1)
      },
    },
    slots: {
      register(slot: string, fill: AnyFill, meta: { source: string }) {
        slots.set(slot, { source: meta.source, fill })
        return () => void slots.delete(slot)
      },
    },
    extEvents: {
      async append(type: string, data: unknown) {
        events.push({ type, data })
        return events.length
      },
    },
    projections: {},
    registrations: (source: string) => [
      ...[...tools].filter(([, owner]) => owner === source).map(([name]) => `tool:${name}`),
      ...hooks.filter((entry) => entry.source === source).map((entry) => `hook:${entry.event}`),
      ...[...slots].filter(([, entry]) => entry.source === source).map(([slot]) => `slot:${slot}`),
      ...services.registrations(source),
    ],
  } as unknown as KernelPorts
  return { ports, tools, toolDefs, stuck, hooks, slots, services, events }
}

function setup(options: { ceiling?: readonly string[]; clock?: () => number } = {}) {
  const kernel = fakeKernel()
  const audit: { kind: string; detail: Record<string, unknown> }[] = []
  const shutdowns: { source: string; registrations: string[] }[] = []
  const owners = new ExtensionOwners()
  const order = createExtensionOrder()
  const host = createBuiltinRowHost({
    owners,
    order,
    ports: kernel.ports,
    platform,
    shutdown: async (source) => {
      shutdowns.push({ source, registrations: kernel.ports.registrations(source) })
    },
    loader: { import: async () => ({}) },
    ceiling: options.ceiling ?? ['tools', 'hooks', 'events', 'artifacts'],
    info,
    log,
    audit: (kind, detail) => void audit.push({ kind, detail }),
    ...(options.clock ? { clock: options.clock } : {}),
  })
  const load = (factory: ExtensionFactory, overrides: Partial<{ manifest: ExtensionManifest }> = {}) =>
    host.load({
      rowId: ROW,
      spec,
      embedded: overrides.manifest ?? manifest(),
      factory: () => factory,
    })
  const kinds = (kind: string) => audit.filter((entry) => entry.kind === kind)
  return { host, kernel, audit, kinds, owners, order, shutdowns, load }
}

const tool = (name: string) => ({
  name,
  description: name,
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  meta: {
    isReadOnly: true,
    isDestructive: false,
    isConcurrencySafe: true,
    isOpenWorld: false,
    replay: 'safe',
    costHint: undefined,
    deferLoading: false,
    requiresApproval: 'never',
  },
  async execute() {
    return { content: [{ type: 'text', text: name }] }
  },
})

describe('a builtin extension supplied through the shared row host', () => {
  it('registers under the extension id and lists as loaded with its lease', async () => {
    const t = setup()
    const handle = await t.load((agnes) => {
      agnes.registerTool(tool('grep') as never)
    })
    expect(handle.loaded).toBe(true)
    expect(t.kernel.tools.get('grep')).toBe(ID)
    const [entry] = t.host.statusEntries()
    expect(entry?.status).toMatchObject({
      id: ID,
      package: '@agnes/base',
      version: '0.1.0',
      trust: 'builtin',
      loaded: true,
      integrity: 'sha256-x',
      revision: 'rev-1',
    })
    expect(entry?.status.lease).toBeDefined()
    expect(t.host.leaseFor(ID)).toBeDefined()
    expect(t.kinds('extension.loaded')).toHaveLength(1)
  })

  it('applies the capability ceiling at admission and reports a failure without throwing', async () => {
    const t = setup({ ceiling: ['tools'] })
    const handle = await t.load(() => undefined, { manifest: manifest({ artifacts: true }) })
    expect(handle.loaded).toBe(false)
    expect(handle.error?.code).toBe('E_CEILING_EXCEEDED')
    expect(t.host.statusEntries()[0]?.status).toMatchObject({
      loaded: false,
      error: { code: 'E_CEILING_EXCEEDED' },
    })
    expect(t.kinds('extension.failed')).toHaveLength(1)
    expect(t.kernel.tools.size).toBe(0)
  })

  it('leaves nothing behind when the factory throws after registering', async () => {
    const t = setup()
    const handle = await t.load((agnes) => {
      agnes.registerTool(tool('grep') as never)
      throw new Error('boom')
    })
    expect(handle.loaded).toBe(false)
    expect(handle.error?.code).toBe('E_EXT_LOAD')
    expect(t.kernel.tools.size).toBe(0)
    expect(t.host.statusEntries()[0]?.status.loaded).toBe(false)
    expect(t.host.leaseFor(ID)).toBeUndefined()
    expect(t.kinds('extension.failed')).toHaveLength(1)
    expect(t.kinds('extension.revoked')).toHaveLength(0)
  })

  it('turns a factory that cannot even be constructed into one empty failed extension', async () => {
    const t = setup()
    for (const construct of [
      () => ecosystem['agnes/subagent']({ profile: { preset: {} } } as never),
      () => ecosystem['agnes/computer-use']({ profile: { preset: {} } } as never),
    ]) {
      const handle = await t.host.load({ rowId: ROW, spec, embedded: manifest(), factory: construct })
      expect(handle.loaded).toBe(false)
      expect(handle.error?.code).toBe('E_EXT_LOAD')
      expect(t.kernel.tools.size).toBe(0)
      expect(t.host.leaseFor(ID)).toBeUndefined()
    }
    expect(t.kinds('extension.failed')).toHaveLength(2)
    expect(t.kinds('extension.revoked')).toHaveLength(0)
  })

  it('hands a row over to its successor as a clean unload, though both register under one id', async () => {
    const t = setup()
    const first = await t.load((agnes) => {
      agnes.registerTool(tool('grep') as never)
    })
    expect(first.loaded).toBe(true)
    const second = await t.load((agnes) => {
      agnes.registerTool(tool('grep') as never)
    })
    expect(second.loaded).toBe(true)
    await t.owners.settled()
    expect(t.kinds('extension.revoke_failed')).toEqual([])
    expect(t.kinds('extension.revoked')).toHaveLength(1)
    expect(t.kinds('extension.revoked')[0]?.detail.cleanupPending).toBe(false)
    expect(t.kernel.tools.get('grep')).toBe(ID)
    await second.release('operator')
    expect(t.kernel.tools.size).toBe(0)
  })

  it('refuses to load over registrations somebody else holds under the same id', async () => {
    const t = setup()
    t.kernel.tools.set('other', ID)
    const handle = await t.load(() => undefined)
    expect(handle.loaded).toBe(false)
    expect(t.kinds('extension.failed')[0]?.detail.message).toMatch(/second extension/)
  })

  it('runs the four unload steps once: shutdown with handlers, release, residue check, revoked audit', async () => {
    const t = setup()
    const ran: string[] = []
    const handle = await t.load((agnes) => {
      agnes.registerTool(tool('grep') as never)
      agnes.registerHook('shutdown', () => {})
      return () => void ran.push('own-disposer')
    })
    await handle.release('operator')
    await handle.release('operator')
    expect(t.shutdowns).toHaveLength(1)
    expect(t.shutdowns[0]?.source).toBe(ID)
    expect(ran).toEqual(['own-disposer'])
    expect(t.kernel.tools.size).toBe(0)
    expect(t.kernel.hooks).toHaveLength(0)
    const revoked = t.kinds('extension.revoked')
    expect(revoked).toHaveLength(1)
    expect(revoked[0]?.detail).toMatchObject({
      id: ID,
      package: '@agnes/base',
      reason: 'operator',
      cleanupPending: false,
    })
    expect(t.host.statusEntries()[0]?.status).toMatchObject({
      loaded: false,
      error: { code: 'E_LEASE_EXPIRED' },
    })
    expect(t.host.statusEntries()[0]?.status.lease).toBeUndefined()
  })

  it('keeps the lease visible to the shutdown dispatch and drops it afterwards', async () => {
    const t = setup()
    let leaseDuringShutdown: unknown
    const host2 = createBuiltinRowHost({
      owners: new ExtensionOwners(),
      order: createExtensionOrder(),
      ports: t.kernel.ports,
      platform,
      shutdown: async (source) => {
        await Promise.resolve()
        leaseDuringShutdown = host2.leaseFor(source)
      },
      loader: { import: async () => ({}) },
      ceiling: ['tools', 'hooks'],
      info,
      log,
    })
    const handle = await host2.load({ rowId: ROW, spec, embedded: manifest(), factory: () => () => {} })
    await handle.release('operator')
    expect(leaseDuringShutdown).toBeDefined()
    expect(host2.leaseFor(ID)).toBeUndefined()
  })

  it('releases registrations before the shutdown dispatch finishes but hands it the handlers it needs', async () => {
    const t = setup()
    const handle = await t.load((agnes) => {
      agnes.registerHook('shutdown', () => {})
    })
    const release = handle.release('operator')
    // The registrations are gone right away so a successor may register the same names.
    expect(t.kernel.hooks).toHaveLength(0)
    await release
    // The dispatch was started while the source's hook was still registered.
    expect(t.shutdowns[0]?.registrations).toEqual(['hook:shutdown'])
  })

  it('evicts a same-row incumbent synchronously, so the successor can register the same names', async () => {
    const t = setup()
    await t.load((agnes) => {
      agnes.registerTool(tool('grep') as never)
    })
    const second = await t.load((agnes) => {
      agnes.registerTool(tool('grep') as never)
    })
    await t.owners.settled()
    expect(second.loaded).toBe(true)
    expect(t.kernel.tools.get('grep')).toBe(ID)
    expect(t.host.statusEntries()).toHaveLength(1)
    expect(t.host.statusEntries()[0]?.status.loaded).toBe(true)
    expect(t.kinds('extension.revoked')).toHaveLength(1)
  })

  it('does not let a stale row disposer take down a newer owner', async () => {
    const t = setup()
    const first = await t.load((agnes) => {
      agnes.registerTool(tool('grep') as never)
    })
    await t.load((agnes) => {
      agnes.registerTool(tool('grep') as never)
    })
    await first.release('operator')
    expect(t.kernel.tools.get('grep')).toBe(ID)
    expect(t.host.statusEntries()[0]?.status.loaded).toBe(true)
  })

  it('reports incomplete cleanup', async () => {
    const t = setup()
    const handle = await t.load((agnes) => {
      agnes.registerTool(tool('grep') as never)
    })
    t.kernel.tools.set('leftover', ID)
    await handle.release('operator')
    expect(t.kinds('extension.revoke_failed')).toHaveLength(1)
    expect(t.kinds('extension.revoked')[0]?.detail.cleanupPending).toBe(true)
  })

  it('records isolation choices on the extension the selector names', async () => {
    const t = setup()
    const handle = await t.host.load({
      rowId: ROW,
      spec,
      embedded: manifest(),
      factory: () => {
        t.host.setIsolation(ID, { mode: 'off', backend: 'in-process', fallback: false })
        return () => {}
      },
    })
    expect(handle.loaded).toBe(true)
    expect(t.host.statusEntries()[0]?.status.isolation).toEqual({
      mode: 'off',
      backend: 'in-process',
      fallback: false,
    })
  })

  it('ignores an isolation report that arrives after the row was retired', async () => {
    const t = setup()
    const handle = await t.load(() => () => {})
    await handle.release('operator')
    await t.owners.settled()
    const before = JSON.stringify(t.host.statusEntries())
    t.host.setIsolation(ID, { mode: 'off', backend: 'in-process', fallback: false })
    expect(JSON.stringify(t.host.statusEntries())).toBe(before)
    expect(t.host.statusEntries()[0]?.status.isolation).toBeUndefined()
  })

  it('turns a live extension whose runtime died into one failed listing and releases it once', async () => {
    const t = setup()
    let disposed = 0
    const handle = await t.load((agnes) => {
      agnes.registerTool(tool('grep') as never)
      return () => void disposed++
    })
    await t.host.fail(ID, new Error('child crashed'))
    expect(t.host.statusEntries()[0]?.status).toMatchObject({ loaded: false, error: { code: 'E_EXT_LOAD' } })
    expect(t.host.statusEntries()[0]?.status.lease).toBeUndefined()
    expect(t.kernel.tools.size).toBe(0)
    expect(disposed).toBe(1)
    expect(t.kinds('extension.failed')).toHaveLength(1)
    // Nothing is left to unload: a later release of the row is not a revocation.
    await handle.release('shutdown')
    await t.owners.settled()
    expect(t.kinds('extension.revoked')).toHaveLength(0)
    expect(disposed).toBe(1)
  })

  it('ignores a failure report for an extension that is not live', async () => {
    const t = setup()
    await t.host.fail(ID, new Error('nobody home'))
    const handle = await t.load(() => () => {})
    await handle.release('operator')
    await t.owners.settled()
    await t.host.fail(ID, new Error('too late'))
    expect(t.kinds('extension.failed')).toHaveLength(0)
    expect(t.kinds('extension.revoked')).toHaveLength(1)
  })

  it('keeps the first-seen position in the merged listing across reloads', async () => {
    const t = setup()
    t.order.next()
    const first = await t.load(() => () => {})
    const positionOf = () => t.host.statusEntries()[0]?.order
    const before = positionOf()
    t.order.next()
    await first.release('operator')
    await t.load(() => () => {})
    expect(positionOf()).toBe(before)
    const merged = mergeExtensionStatus([t.host.statusEntries()], () => undefined)
    expect(merged.map((s) => s.id)).toEqual([ID])
  })

  it('a stale wind-down never overwrites a newer record listing', async () => {
    const t = setup()
    await t.load(() => () => {})
    await t.load(() => () => {})
    await t.owners.settled()
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(t.host.statusEntries()[0]?.status.loaded).toBe(true)
  })
})

const HOUR = 3600_000
const DAY = 24 * HOUR
const FIFTY_YEARS = 50 * 365 * DAY
const T0 = Date.UTC(2026, 0, 1)
const FULL_CEILING = ['tools', 'hooks', 'slots', 'services', 'events']
const { handler: _serviceHandler, ...serviceCap } = serviceFixture()

const fullManifest = (budget?: number): ExtensionManifest =>
  ({
    id: ID,
    version: '0.1.0',
    apiRange: '^1.0',
    entry: './index.js',
    capabilities: {
      tools: { prefix: '', names: ['grep', 'find'] },
      hooks: ['shutdown', 'context'],
      slots: ['status.line'],
      events: true,
      services: [serviceCap],
    },
    ...(budget === undefined ? {} : { lease: { budget } }),
  }) as ExtensionManifest

/** Loads an extension that reaches every proxied entry point, and hands back a way to call each. */
async function loadFull(
  t: ReturnType<typeof setup>,
  options: { budget?: number; registration?: 'factory' | 'lifetime' } = {},
) {
  let api: ExtensionAPI | undefined
  const handle = await t.host.load({
    rowId: ROW,
    spec,
    embedded: fullManifest(options.budget),
    ...(options.registration ? { registration: options.registration } : {}),
    factory: () => (agnes) => {
      api = agnes
      agnes.registerTool(tool('grep') as never)
      agnes.registerHook('context', () => ({}))
      agnes.registerSlot('status.line', () => null)
      agnes.registerService(serviceFixture() as never)
    },
  })
  if (!api) throw new Error('factory did not run')
  const captured = api
  const execute = t.kernel.toolDefs.get('grep')?.execute
  const context = t.kernel.hooks.find((entry) => entry.event === 'context')?.handler
  const fill = t.kernel.slots.get('status.line')?.fill
  if (!execute || !context || !fill) throw new Error('registrations missing')
  const service = t.kernel.services.resolve(ID, serviceCap.name)
  if (!service) throw new Error('service missing')
  const entries = {
    execute: () => execute({}, {} as ToolContext),
    context: () => context({}, { signal: new AbortController().signal } as HookContext),
    fill: () => fill({}),
    append: () => captured.events.append('tick', { at: 1 }),
    serviceAlive: () => service.assertAlive(),
    serviceRunning: () => service.assertRunning(),
  }
  return { handle, api: captured, entries }
}

async function refusal(call: () => unknown): Promise<{ code?: string; message?: string }> {
  try {
    await call()
  } catch (error) {
    return error as { code?: string; message?: string }
  }
  throw new Error('expected the call to be refused')
}

describe('a builtin row lease is bound to the row, not to time', () => {
  it('keeps every proxied entry point working a year after load', async () => {
    let now = T0
    const t = setup({ ceiling: FULL_CEILING, clock: () => now })
    const { handle, entries } = await loadFull(t)
    expect(handle.loaded).toBe(true)
    for (const at of [T0 + DAY + 1, T0 + 30 * DAY, T0 + 365 * DAY]) {
      now = at
      for (const call of Object.values(entries)) await call()
      expect(Date.parse(t.host.leaseFor(ID)?.expiresAt ?? '')).toBeGreaterThan(now + FIFTY_YEARS)
    }
    expect(t.kernel.events).toHaveLength(3)
  })

  it('lets a lifetime row register a year after load', async () => {
    let now = T0
    const t = setup({ ceiling: FULL_CEILING, clock: () => now })
    const { api } = await loadFull(t, { registration: 'lifetime' })
    now = T0 + 365 * DAY
    api.registerTool(tool('find') as never)
    expect(t.kernel.tools.get('find')).toBe(ID)
  })

  it('refuses every entry point with a revoked lease once the row is released', async () => {
    let now = T0
    const t = setup({ ceiling: FULL_CEILING, clock: () => now })
    const { handle, api, entries } = await loadFull(t, { registration: 'lifetime' })
    now = T0 + 365 * DAY
    await handle.release('operator')
    const calls = { ...entries, register: () => api.registerTool(tool('find') as never) }
    const seen: Record<string, [string | undefined, string | undefined]> = {}
    for (const [name, call] of Object.entries(calls)) {
      const error = await refusal(call)
      seen[name] = [error.code, error.message]
    }
    const revoked = ['E_LEASE_EXPIRED', 'E_LEASE_EXPIRED: lease revoked']
    expect(seen).toEqual(Object.fromEntries(Object.keys(calls).map((name) => [name, revoked])))
    expect(t.host.leaseFor(ID)).toBeUndefined()
  })

  it('revokes the lease of a row generation that a reload replaced', async () => {
    const t = setup({ ceiling: FULL_CEILING })
    const first = await loadFull(t)
    const second = await t.load(() => () => {})
    expect(second.loaded).toBe(true)
    await t.owners.settled()
    const error = await refusal(first.entries.execute)
    expect([error.code, error.message]).toEqual(['E_LEASE_EXPIRED', 'E_LEASE_EXPIRED: lease revoked'])
  })

  it('still refuses a registration left behind by a failed cleanup', async () => {
    const t = setup({ ceiling: FULL_CEILING })
    const { handle, entries } = await loadFull(t)
    t.kernel.stuck.add('grep')
    await handle.release('operator')
    expect(t.kinds('extension.revoke_failed')).toHaveLength(1)
    expect(t.kinds('extension.revoked')[0]?.detail.cleanupPending).toBe(true)
    expect(t.kernel.tools.get('grep')).toBe(ID)
    const error = await refusal(entries.execute)
    expect([error.code, error.message]).toEqual(['E_LEASE_EXPIRED', 'E_LEASE_EXPIRED: lease revoked'])
  })

  it('still spends the declared budget with no time limit', async () => {
    let now = T0
    const t = setup({ ceiling: FULL_CEILING, clock: () => now })
    const { entries } = await loadFull(t, { budget: 2 })
    now = T0 + 30 * DAY
    await entries.execute()
    await entries.execute()
    const error = await refusal(entries.execute)
    expect([error.code, error.message]).toEqual([
      'E_LEASE_EXPIRED',
      'E_LEASE_EXPIRED: lease budget exhausted',
    ])
  })

  it('starts no timer to keep the lease alive', async () => {
    vi.useFakeTimers()
    try {
      const t = setup({ ceiling: FULL_CEILING })
      const before = vi.getTimerCount()
      const { handle } = await loadFull(t)
      expect(handle.loaded).toBe(true)
      expect(vi.getTimerCount()).toBe(before)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('a builtin row generation taken over while its factory is being prepared', () => {
  it('issues no lease and leaves the successor lease listed', async () => {
    let now = T0
    const t = setup({ ceiling: FULL_CEILING, clock: () => now })
    let release!: () => void
    const prepared = new Promise<void>((resolve) => {
      release = resolve
    })
    const stale = t.host.load({
      rowId: ROW,
      spec,
      embedded: fullManifest(),
      factory: async () => {
        await prepared
        return () => undefined
      },
    })
    now = T0 + 1_000
    const successor = await t.load(() => () => undefined, { manifest: fullManifest() })
    expect(successor.loaded).toBe(true)
    const listed = t.host.leaseFor(ID)
    now = T0 + 5_000
    release()
    expect((await stale).loaded).toBe(false)
    await t.owners.settled()
    expect(t.host.leaseFor(ID)).toEqual(listed)
    expect(t.host.statusEntries()[0]?.status.loaded).toBe(true)
  })
})
