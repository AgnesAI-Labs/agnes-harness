import {
  HookEngine,
  HookRegistry,
  ProjectionRegistry,
  projectUI,
  ResourceRegistry,
  SlotRegistry,
  ToolRegistry,
} from '@agnes/core'
import type { ExtensionManifest, HookContext, SlotFill, ToolContext } from '@agnes/extension-api'
import { unavailableProjections } from '@agnes/extension-api'
import { projectionFixture, serviceFixture } from '@agnes/extension-api/testkit'
import { describe, expect, it, vi } from 'vitest'
import { buildExtensionAPI } from '../../src/ext-host/api-proxy.js'
import { DisposerBag } from '../../src/ext-host/disposers.js'
import { Lease, leaseFor } from '../../src/ext-host/lease.js'
import type { KernelPorts } from '../../src/ext-host/ports.js'
import { ServiceRegistry } from '../../src/ext-host/services.js'
import { fixtureTool } from '../fixtures/tool.js'

const log = { debug() {}, info() {}, warn() {}, error() {} }
const manifest = (): ExtensionManifest => ({
  id: 'fixture/proxy',
  version: '1.0.0',
  apiRange: '^1.0',
  entry: './index.ts',
  capabilities: {
    tools: { prefix: 'fx_', names: ['fx_one'] },
    hooks: ['before_step'],
    slots: ['status.line'],
    resources: ['skill'],
    events: true,
  },
  lease: { budget: 1 },
})
const platform = Object.freeze({
  shell: 'posix',
  fs: Object.freeze({ caseSensitive: true, pathSep: '/' }),
  terminal: Object.freeze({ color: false }),
} as const)
function setup(
  m = manifest(),
  overrideLease?: Lease,
  provenance: {
    packageIdentity: string
    packageVersion: string
    trust: 'builtin' | 'trusted'
  } = { packageIdentity: '@fixture/package', packageVersion: m.version, trust: 'trusted' },
) {
  let registering = true
  let now = 1000
  const tools = new ToolRegistry()
  const hookRegistry = new HookRegistry()
  const hooks = new HookEngine({ diag() {}, onFailure() {}, platform }, hookRegistry)
  // Slots/event persistence remain test adapters here; resources use the actual core registry.
  const slots = new Map<string, unknown>()
  const resources = new ResourceRegistry()
  const events: unknown[] = []
  const projectionRegistry = new ProjectionRegistry()
  const ports: KernelPorts = {
    services: new ServiceRegistry(),
    projections: {
      register: projectionRegistry.register.bind(projectionRegistry),
      async read() {
        throw new Error('test has no session')
      },
    },
    tools,
    hooks: hookRegistry,
    slots: {
      register(slot, fill) {
        slots.set(slot, fill)
        return () => {
          slots.delete(slot)
        }
      },
    },
    resources,
    extEvents: {
      async append(type, data, meta) {
        events.push({ type, data, meta })
        return events.length
      },
    },
    registrations() {
      throw new Error('not a persistence acceptance adapter')
    },
  }
  const lease = overrideLease ?? leaseFor(m, { now, ttlMs: 1000, clock: () => now })
  const bag = new DisposerBag(),
    controller = new AbortController()
  const api = buildExtensionAPI({
    manifest: m,
    ...provenance,
    lease,
    bag,
    ports,
    log,
    info: { agnesVersion: '0.0.0', apiVersion: '1.0.0', profileName: 'test' },
    platform,
    signal: controller.signal,
    isRegistering: () => registering,
  })
  return {
    api,
    lease,
    bag,
    tools,
    hooks,
    slots,
    resources,
    events,
    controller,
    ports,
    seal: () => {
      registering = false
    },
    expire: () => {
      now = 2000
    },
  }
}
const hookContext = (): HookContext => ({
  session: { key: 's', lane: 'main', workspaceRoot: '/workspace' },
  log,
  lease: { expiresAt: '2099-01-01T00:00:00Z', scope: {}, budget: { remaining: 999 } },
  signal: new AbortController().signal,
  projections: unavailableProjections,
  replayed: false,
  platform,
})

describe('complete extension API capability boundary', () => {
  it('registers all declared kinds, uses actual core tool/hook registries and disposes them', async () => {
    const h = setup()
    h.api.registerTool(fixtureTool('fx_one'))
    h.api.registerHook('before_step', () => ({}))
    h.api.registerSlot('status.line', () => ({ text: 'ready', level: 'info' }))
    h.api.registerResource({ id: 'skill', kind: 'skill', name: 'skill', description: 'description' })
    expect(h.bag.size).toBe(4)
    expect(h.tools.size).toBe(1)
    expect(h.tools.resolve('fx_one')).toMatchObject({
      packageIdentity: '@fixture/package',
      packageVersion: '1.0.0',
      executionDomain: 'workspace',
      definitionFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
    })
    expect(h.slots.size).toBe(1)
    expect(h.resources.snapshot().length).toBe(1)
    expect((await h.bag.disposeAllAsync()).failed).toBe(0)
    expect(h.tools.size + h.slots.size + h.resources.snapshot().length).toBe(0)
  })
  it('preserves classifiers while only Host-signing the exact built-in Computer Use domain', () => {
    const m = manifest()
    m.id = 'agnes/computer-use'
    const h = setup(m, undefined, {
      packageIdentity: '@agnes/base',
      packageVersion: '1.0.0',
      trust: 'builtin',
    })
    const tool = fixtureTool('fx_one')
    tool.policyVersion = 'computer-use-v1'
    tool.classify = () => ({
      isReadOnly: true,
      isDestructive: false,
      replay: 'safe',
      requiresApproval: 'never',
      approvalScopes: [],
    })
    h.api.registerTool(tool)
    expect(h.tools.resolve('fx_one')).toMatchObject({
      packageIdentity: '@agnes/base',
      packageVersion: '1.0.0',
      executionDomain: 'host-computer-use',
      policyVersion: 'computer-use-v1',
    })
    expect(h.tools.resolve('fx_one')?.classify).toBeTypeOf('function')

    const forged = setup(m, undefined, {
      packageIdentity: 'third-party',
      packageVersion: '1.0.0',
      trust: 'builtin',
    })
    forged.api.registerTool(fixtureTool('fx_one'))
    expect(forged.tools.resolve('fx_one')?.executionDomain).toBe('workspace')
  })
  it('gives a builtin-trusted registration on a ranked id its fixed hookRank, but never a trusted (non-builtin) registration under the same id', () => {
    const m = manifest()
    m.id = 'agnes/hooks-runner'
    m.capabilities.hooks = ['session_start']
    const builtin = setup(m, undefined, {
      packageIdentity: '@agnes/base',
      packageVersion: '1.0.0',
      trust: 'builtin',
    })
    builtin.api.registerHook('session_start', () => undefined)
    const builtinRank = builtin.hooks.snapshot().entries('session_start')[0]?.meta.hookRank
    expect(builtinRank).toBeTypeOf('number')

    // Same manifest id, but not Host-attested as builtin: a trusted package or plugin-runtime
    // extension cannot forge its way into the built-in layer just by writing a builtin id into its
    // own manifest (third-party-transform-directive-hooks design §3 point 3, appendix A minor-1).
    const forged = setup(m, undefined, {
      packageIdentity: 'third-party',
      packageVersion: '1.0.0',
      trust: 'trusted',
    })
    forged.api.registerHook('session_start', () => undefined)
    expect(forged.hooks.snapshot().entries('session_start')[0]?.meta.hookRank).toBeUndefined()
  })

  it('leaves an ordinary trusted extension id with no hookRank at all', () => {
    const h = setup()
    h.api.registerHook('before_step', () => ({}))
    expect(h.hooks.snapshot().entries('before_step')[0]?.meta.hookRank).toBeUndefined()
  })

  it('accepts an explicitly empty prefix, but enforces a closed names declaration', () => {
    const m = manifest()
    m.capabilities.tools = { prefix: '', names: ['read'] }
    const h = setup(m)
    h.api.registerTool(fixtureTool('read'))
    expect(() => h.api.registerTool(fixtureTool('write'))).toThrow('not declared')
  })
  it('refuses all undeclared members synchronously', () => {
    const m = manifest()
    m.capabilities = {}
    const { api } = setup(m)
    expect(() => api.registerTool(fixtureTool('fx_one'))).toThrow(/E_CAPABILITY_UNDECLARED/)
    expect(() => api.registerHook('before_step', () => ({}))).toThrow(/E_CAPABILITY_UNDECLARED/)
    expect(() => api.registerSlot('status.line', () => null)).toThrow(/E_CAPABILITY_UNDECLARED/)
    expect(() => api.registerResource({ id: 's', kind: 'skill', name: 's', description: 's' })).toThrow(
      /E_CAPABILITY_UNDECLARED/,
    )
    expect(() => api.registerService(serviceFixture())).toThrow(/E_CAPABILITY_UNDECLARED/)
    expect(() => api.registerProjection(projectionFixture())).toThrow(/E_CAPABILITY_UNDECLARED/)
    expect(() => api.events.append('event', {})).toThrow(/E_CAPABILITY_UNDECLARED/)
  })
  it('seals all four registration methods while allowing authorized runtime events', async () => {
    const h = setup()
    h.seal()
    expect(() => h.api.registerTool(fixtureTool('fx_one'))).toThrow('outside factory')
    expect(() => h.api.registerHook('before_step', () => ({}))).toThrow('outside factory')
    expect(() => h.api.registerSlot('status.line', () => null)).toThrow('outside factory')
    expect(() => h.api.registerResource({ id: 's', kind: 'skill', name: 's', description: 's' })).toThrow(
      'outside factory',
    )
    expect(await h.api.events.append('event', {})).toBe(1)
  })
  it('counts only tool execution and rejects execution and events after exhaustion', async () => {
    const h = setup()
    h.api.registerTool(fixtureTool('fx_one'))
    expect(h.api.ctx.lease.budget.remaining).toBe(1)
    const tool = h.tools.resolve('fx_one')
    if (!tool) throw new Error('expected registered tool')
    await tool.execute({}, {} as ToolContext)
    expect(h.api.ctx.lease.budget.remaining).toBe(0)
    await expect(tool.execute({}, {} as ToolContext)).rejects.toThrow(/E_LEASE_EXPIRED/)
    expect(() => h.api.events.append('event', {})).toThrow(/E_LEASE_EXPIRED/)
  })
  it('denies undeclared ToolContext capabilities before reaching their host ports', async () => {
    const h = setup()
    let projected: ToolContext | undefined
    const def = fixtureTool('fx_one')
    def.execute = async (_args, context) => {
      projected = context
      return { content: [{ type: 'text', text: 'captured' }] }
    }
    h.api.registerTool(def)
    const raw = {
      net: { fetch: vi.fn() },
      tools: { list: vi.fn(() => []), invoke: vi.fn() },
      artifacts: { put: vi.fn(), get: vi.fn(), submitJob: vi.fn(), poll: vi.fn(), cancel: vi.fn() },
      subagent: { fork: vi.fn(), spawn: vi.fn(), collect: vi.fn() },
    } as unknown as ToolContext
    await h.tools.resolve('fx_one')?.execute({}, raw)

    expect(() => projected?.net.fetch('https://example.test')).toThrow('E_CAPABILITY_UNDECLARED')
    expect(() => projected?.tools.invoke('other', {})).toThrow('E_CAPABILITY_UNDECLARED')
    expect(() => projected?.artifacts.get({ sha256: 'x', size: 1, mime: 'text/plain' })).toThrow(
      'E_CAPABILITY_UNDECLARED',
    )
    expect(() => projected?.subagent.fork('work')).toThrow('E_CAPABILITY_UNDECLARED')
    expect(raw.net.fetch).not.toHaveBeenCalled()
    expect(raw.tools.invoke).not.toHaveBeenCalled()
    expect(raw.artifacts.get).not.toHaveBeenCalled()
    expect(raw.subagent.fork).not.toHaveBeenCalled()
  })
  it('forwards declared ToolContext capabilities and restricts network hosts and ports', async () => {
    const m = manifest()
    m.capabilities = {
      ...m.capabilities,
      network: { hosts: ['example.test:8443'] },
      'tools.invoke': true,
      artifacts: true,
      subagent: true,
    }
    const h = setup(m)
    let projected: ToolContext | undefined
    const def = fixtureTool('fx_one')
    def.execute = async (_args, context) => {
      projected = context
      return { content: [{ type: 'text', text: 'captured' }] }
    }
    h.api.registerTool(def)
    const raw = {
      net: { fetch: vi.fn(async () => new Response('ok')) },
      tools: { list: vi.fn(() => []), invoke: vi.fn(async () => ({ content: [] })) },
      artifacts: {
        put: vi.fn(),
        get: vi.fn(async () => new Uint8Array()),
        submitJob: vi.fn(),
        poll: vi.fn(),
        cancel: vi.fn(),
      },
      subagent: { fork: vi.fn(async () => 'answer'), spawn: vi.fn(), collect: vi.fn() },
    } as unknown as ToolContext
    await h.tools.resolve('fx_one')?.execute({}, raw)

    await projected?.net.fetch('https://example.test:8443/path')
    await projected?.tools.invoke('other', {})
    await projected?.artifacts.get({ sha256: 'x', size: 1, mime: 'text/plain' })
    await projected?.subagent.fork('work')
    expect(() => projected?.net.fetch('https://example.test/path')).toThrow('E_CAPABILITY_UNDECLARED')
    expect(() => projected?.net.fetch('https://evil.test:8443/path')).toThrow('E_CAPABILITY_UNDECLARED')
    expect(raw.net.fetch).toHaveBeenCalledTimes(1)
    expect(raw.tools.invoke).toHaveBeenCalledTimes(1)
    expect(raw.artifacts.get).toHaveBeenCalledTimes(1)
    expect(raw.subagent.fork).toHaveBeenCalledTimes(1)
    expect(Object.isFrozen(projected)).toBe(true)
  })
  it.each(['expire', 'revoke', 'close'] as const)('rejects event append after %s', (reason) => {
    const h = setup()
    if (reason === 'expire') h.expire()
    if (reason === 'revoke') h.lease.revoke('test')
    if (reason === 'close') h.controller.abort()
    expect(() => h.api.events.append('event', {})).toThrow(/E_LEASE_EXPIRED/)
    expect(h.events).toEqual([])
  })
  it('supplies each hook its extension lease instead of the incoming session grant', async () => {
    const h = setup()
    let context: HookContext | undefined
    h.api.registerHook('before_step', (_p, ctx) => {
      context = ctx
      return {}
    })
    await h.hooks.dispatch(
      'before_step',
      () => ({ turn: 1, step: 1, depth: 0, budget: { remaining: 1, cap: null } }),
      hookContext(),
    )
    expect(context?.lease.budget.remaining).toBe(1)
    expect(context?.lease.scope.toolPrefix).toBe('fx_')
    expect(Object.isFrozen(context)).toBe(true)
  })
  it('validates slot payload and rejects calls after revocation', async () => {
    const h = setup()
    h.api.registerSlot('status.line', () => ({ text: 'x'.repeat(513), level: 'info' }))
    const fill = h.slots.get('status.line') as SlotFill<'status.line'>
    const ctx = {
      session: { key: 's', lane: 'main', workspaceRoot: '/workspace' },
      surface: 'tui' as const,
      projections: unavailableProjections,
      trigger: { kind: 'tick' as const },
    }
    expect(() => fill(ctx)).toThrow(/E_SLOT_PAYLOAD/)
    h.lease.revoke('test')
    expect(() => fill(ctx)).toThrow(/E_LEASE_EXPIRED/)
  })
  it('snapshots manifest and event data and refuses accessors without invoking them', async () => {
    const m = manifest(),
      h = setup(m)
    m.capabilities.events = false
    const data = { value: 1 }
    await h.api.events.append('event', data)
    data.value = 2
    expect(h.events[0]).toMatchObject({ type: 'x/fixture/proxy/event', data: { value: 1 } })
    let reads = 0
    expect(() =>
      h.api.events.append('event', {
        get value() {
          reads++
          return 1
        },
      }),
    ).toThrow(/E_EVENT_NAMESPACE/)
    expect(reads).toBe(0)
    expect(() => h.api.events.append('event', { value: 'x'.repeat(65536) })).toThrow(/E_EVENT_NAMESPACE/)
  })
  it('hands the assembly-time platform facts to the factory ctx and through to every hook ctx (spec §4 row 9)', async () => {
    const h = setup()
    expect(h.api.ctx.platform).toBe(platform)
    expect(Object.keys(h.api.ctx).sort()).toEqual([
      'extId',
      'info',
      'lease',
      'log',
      'platform',
      'signal',
      'trust',
      'version',
    ])
    let seen: unknown
    h.api.registerHook('before_step', (_payload, hctx) => {
      seen = hctx.platform
      return {}
    })
    h.seal()
    await h.hooks.dispatch(
      'before_step',
      () => ({ turn: 1, step: 1, depth: 0, budget: { remaining: 1, cap: null } }),
      hookContext(),
    )
    expect(seen).toBe(platform)
  })
})

it('honors narrower lease scope even when the manifest declares a capability', () => {
  const lease = new Lease({
    extId: 'fixture/proxy',
    expiresAt: new Date(2000).toISOString(),
    scope: { toolPrefix: 'other_', slots: [], events: false },
    budget: 1,
    clock: () => 1000,
  })
  const h = setup(manifest(), lease)
  expect(() => h.api.registerTool(fixtureTool('fx_one'))).toThrow('outside lease scope')
  expect(() => h.api.registerSlot('status.line', () => null)).toThrow('outside lease scope')
  expect(() => h.api.events.append('event', {})).toThrow('not granted')
  expect(h.bag.size).toBe(0)
})

it('validates resources, snapshots accepted records and preserves null slot responses', async () => {
  const h = setup()
  const resource = { id: 's', kind: 'skill' as const, name: 'original', description: 's' }
  h.api.registerResource(resource)
  resource.name = 'changed'
  expect(h.resources.snapshot().find((record) => record.entry.id === 's')?.entry).toMatchObject({
    name: 'original',
  })
  expect(() => h.api.registerResource({ ...resource, kind: 'model' })).toThrow('kind not declared')
  h.api.registerSlot('status.line', () => null)
  const fill = h.slots.get('status.line') as SlotFill<'status.line'>
  expect(
    await fill({
      session: { key: 's', lane: 'main', workspaceRoot: '/workspace' },
      surface: 'tui',
      projections: unavailableProjections,
      trigger: { kind: 'tick' },
    }),
  ).toBeNull()
})

it('propagates host cancellation into an in-flight hook context', async () => {
  const h = setup()
  let ready: () => void = () => {}
  const started = new Promise<void>((resolve) => {
    ready = resolve
  })
  let reason: unknown
  h.api.registerHook(
    'before_step',
    (_p, ctx) =>
      new Promise((resolve) => {
        ctx.signal.addEventListener(
          'abort',
          () => {
            reason = ctx.signal.reason
            resolve({})
          },
          { once: true },
        )
        ready()
      }),
  )
  const pending = h.hooks.dispatch(
    'before_step',
    () => ({ turn: 1, step: 1, depth: 0, budget: { remaining: 1, cap: null } }),
    hookContext(),
  )
  await started
  h.controller.abort('host-close')
  await pending
  expect(reason).toBe('host-close')
})

it('captures tool identity once and does not expose accessor errors', () => {
  const h = setup(),
    tool = fixtureTool('fx_one')
  let reads = 0
  Object.defineProperty(tool, 'name', {
    get() {
      return ++reads === 1 ? 'fx_one' : 'fx_other'
    },
  })
  h.api.registerTool(tool)
  expect(reads).toBe(1)
  expect(h.tools.resolve('fx_one')).toBeDefined()
  expect(h.tools.resolve('fx_other')).toBeUndefined()
  const bad = fixtureTool('fx_one')
  Object.defineProperty(bad, 'description', {
    get() {
      throw new Error('credential-test-marker')
    },
  })
  expect(() => setup().api.registerTool(bad)).toThrow('E_TOOLDEF_META: invalid tool definition')
})

it('projects an API-registered slot through the real core registry and projectUI', async () => {
  const h = setup(),
    slots = new SlotRegistry()
  h.ports.slots = slots
  h.api.registerSlot('status.line', () => ({ text: 'from extension', level: 'info' }))
  const ui = await projectUI([], {
    sessionKey: 's',
    surface: 'tui',
    fills: slots.snapshot(
      { key: 's', lane: 'main', workspaceRoot: '/workspace' },
      { remainingMs: () => 100 },
    ),
  })
  expect(ui.nodes).toContainEqual(
    expect.objectContaining({
      kind: 'slot',
      fill: {
        slot: 'status.line',
        extId: 'fixture/proxy',
        payload: { text: 'from extension', level: 'info' },
      },
    }),
  )
  await h.bag.disposeAllAsync()
  expect(slots.registrations('fixture/proxy')).toEqual([])
})
