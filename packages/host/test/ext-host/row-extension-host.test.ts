import { Context, type Fiber } from '@agnes/cordis'
import {
  EXTENSION_ID_PATTERN,
  type PluginExtensionAPI,
  type SkillInstallPort,
  type ToolDef,
} from '@agnes/extension-api'
import type { RowOrigin } from '@agnes/plugin-runtime/host'
import { describe, expect, it, vi } from 'vitest'
import { createExtensionOrder, mergeExtensionStatus } from '../../src/ext-host/extension-status-book.js'
import type { ExtensionStatus } from '../../src/ext-host/managed-host.js'
import type { KernelPorts } from '../../src/ext-host/ports.js'
import {
  createRowExtensionHost,
  pluginRowSource,
  type RowExtensionActivation,
} from '../../src/ext-host/row-extension-host.js'
import type { SkillInstallBridge } from '../../src/resources/skill-install-port.js'
import { fixtureTool } from '../fixtures/tool.js'

const log = { debug() {}, info() {}, warn() {}, error() {} }
const platform = Object.freeze({
  shell: 'posix',
  fs: Object.freeze({ caseSensitive: true, pathSep: '/' }),
  terminal: Object.freeze({ color: false }),
} as const)
const info = { agnesVersion: '0.0.0', apiVersion: '1.0.0', profileName: 'test' }
const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

function fakeKernel() {
  const tools = new Map<string, string>()
  const definitions = new Map<string, ToolDef>()
  const hooks: { event: string; source: string; hookRank?: number }[] = []
  const events: { type: string; source: string }[] = []
  const leak = new Set<string>()
  const ports = {
    tools: {
      add(def: ToolDef, meta: { source: string }) {
        if (tools.has(def.name)) throw new Error(`E_REGISTRY_DUPLICATE: ${def.name}`)
        tools.set(def.name, meta.source)
        definitions.set(def.name, def)
        return () => {
          if (!leak.has(def.name)) tools.delete(def.name)
        }
      },
    },
    hooks: {
      on(event: string, _handler: unknown, meta: { source: string; hookRank?: number }) {
        const entry = {
          event,
          source: meta.source,
          ...(meta.hookRank === undefined ? {} : { hookRank: meta.hookRank }),
        }
        hooks.push(entry)
        return () => {
          const index = hooks.indexOf(entry)
          if (index >= 0) hooks.splice(index, 1)
        }
      },
    },
    projections: {},
    extEvents: {
      async append(type: string, _data: unknown, meta: { source: string }) {
        events.push({ type, source: meta.source })
        return 1
      },
    },
    registrations: (source: string) => [
      ...[...tools].filter(([, owner]) => owner === source).map(([name]) => `tool:${name}`),
      ...hooks.filter((entry) => entry.source === source).map((entry) => `hook:${entry.event}`),
    ],
  } as unknown as KernelPorts
  return { ports, tools, definitions, hooks, events, leak }
}

function setup(
  overrides: Partial<RowExtensionActivation> = {},
  skillInstall?: SkillInstallBridge,
  mcpManage?: import('../../src/resources/mcp-manage-port.js').McpManageBridge,
  pluginManage?: import('../../src/resources/plugin-manage-port.js').PluginManageBridge,
) {
  const kernel = fakeKernel()
  const audit: { kind: string; detail: Record<string, unknown> }[] = []
  const order = createExtensionOrder()
  const host = createRowExtensionHost({
    ...(skillInstall ? { skillInstall } : {}),
    ...(mcpManage ? { mcpManage } : {}),
    ...(pluginManage ? { pluginManage } : {}),
    info,
    log,
    order,
    audit: (kind, detail) => void audit.push({ kind, detail }),
    describePackage: () => ({ version: '1.2.3', integrity: 'sha256-int' }),
  })
  const shutdowns: { source: string; toolsAtCall: string[] }[] = []
  const activation: RowExtensionActivation = {
    ports: kernel.ports,
    platform,
    shutdown: async (source) => {
      shutdowns.push({ source, toolsAtCall: kernel.ports.registrations(source) })
    },
    reservedTool: () => false,
    governance: new Map(),
    ...overrides,
  }
  const origins = new Map<string, Readonly<RowOrigin>>()
  const lookup = { lookup: (fiber: Fiber) => origins.get(fiber.name) }
  const root = new Context()
  host.installRoot(root, lookup)
  const originFor = (name: string, rowId: string, trustTier: RowOrigin['trustTier'] = 'third-party') =>
    origins.set(
      name,
      Object.freeze({
        trustTier,
        packageId: '@acme/tools',
        snapshotId: `snapshot-${name}`,
        rowId,
        exportName: 'plugin',
        declaredProvides: [],
      }),
    )
  const mount = async (
    name: string,
    rowId: string,
    apply: (ctx: any, agnes: PluginExtensionAPI) => unknown,
  ) => {
    originFor(name, rowId)
    const fiber = root.plugin({
      name,
      inject: ['extension'],
      async apply(ctx: any) {
        await apply(ctx, ctx.extension())
      },
    } as any)
    // A row that throws leaves its failure on the fiber; some cases look at the listing it leaves.
    await fiber.await().catch(() => undefined)
    // Not the fiber itself: an async function would adopt it as a thenable and rethrow its failure.
    return { dispose: () => fiber.dispose(), restart: () => fiber.restart() }
  }
  const kinds = (kind: string) => audit.filter((entry) => entry.kind === kind)
  return { host, kernel, audit, kinds, activation, origins, originFor, root, mount, shutdowns }
}

const tool = (name: string) => fixtureTool(name)

describe('plugin Skill install request port', () => {
  it('stamps row identity and expires an escaped callback after tool completion', async () => {
    const bridge = vi.fn<SkillInstallBridge>(async () => ({ proposalId: 'proposal', state: 'prepared' }))
    const t = setup({}, bridge)
    t.host.activate(t.activation)
    let escaped: SkillInstallPort | undefined
    const fiber = await t.mount('installer', 'ext:acme/installer', (_ctx, agnes) => {
      agnes.registerTool({
        ...tool('install_skill'),
        async execute(_args, ctx) {
          escaped = ctx.skillInstall
          await ctx.skillInstall!.request({ action: 'status', proposalId: 'proposal' })
          return { content: [] }
        },
      })
    })
    const context = {
      signal: new AbortController().signal,
      session: { depth: 0, key: 'owner', toolUseId: 'call' },
    }
    await t.kernel.definitions.get('install_skill')!.execute({}, context as never)
    expect(bridge.mock.calls[0]?.[0]).toMatchObject({
      packageId: '@acme/tools',
      snapshotId: 'snapshot-installer',
      rowId: 'ext:acme/installer',
      sessionKey: 'owner',
      toolUseId: 'call',
      leaseId: expect.any(String),
    })
    await expect(escaped!.request({ action: 'status', proposalId: 'proposal' })).rejects.toThrow('expired')
    expect(bridge).toHaveBeenCalledTimes(1)
    await fiber.dispose()
  })

  it('refuses subagent requests before reaching the daemon', async () => {
    const bridge = vi.fn<SkillInstallBridge>()
    const t = setup({}, bridge)
    t.host.activate(t.activation)
    const fiber = await t.mount('installer', 'ext:acme/installer', (_ctx, agnes) => {
      agnes.registerTool({
        ...tool('install_skill'),
        async execute(_args, ctx) {
          await ctx.skillInstall!.request({ action: 'status', proposalId: 'proposal' })
          return { content: [] }
        },
      })
    })
    await expect(
      t.kernel.definitions.get('install_skill')!.execute({}, {
        signal: new AbortController().signal,
        session: { depth: 1, key: 'child', toolUseId: 'call' },
      } as never),
    ).rejects.toThrow('Subagents')
    expect(bridge).not.toHaveBeenCalled()
    await fiber.dispose()
  })
})

describe('plugin MCP management request port', () => {
  it('stamps row identity and expires an escaped callback after tool completion', async () => {
    const bridge = vi.fn<import('../../src/resources/mcp-manage-port.js').McpManageBridge>(async () => ({
      proposalId: 'proposal',
      state: 'prepared',
    }))
    const t = setup({}, undefined, bridge)
    t.host.activate(t.activation)
    let escaped: NonNullable<import('@agnes/extension-api').ToolContext['mcpManage']> | undefined
    const fiber = await t.mount('installer', 'ext:acme/installer', (_ctx, agnes) => {
      agnes.registerTool({
        ...tool('manage_mcp'),
        async execute(_args, ctx) {
          escaped = ctx.mcpManage
          if (!ctx.mcpManage) throw new Error('Missing MCP port')
          await ctx.mcpManage.request({ action: 'status', proposalId: 'proposal' })
          return { content: [] }
        },
      })
    })
    const context = {
      signal: new AbortController().signal,
      session: { depth: 0, key: 'owner', toolUseId: 'call' },
    }
    const registered = t.kernel.definitions.get('manage_mcp')
    if (!registered) throw new Error('Missing MCP tool')
    await registered.execute({}, context as never)
    expect(bridge.mock.calls[0]?.[0]).toMatchObject({
      packageId: '@acme/tools',
      snapshotId: 'snapshot-installer',
      rowId: 'ext:acme/installer',
      sessionKey: 'owner',
      toolUseId: 'call',
      leaseId: expect.any(String),
    })
    if (!escaped) throw new Error('Missing escaped port')
    await expect(escaped.request({ action: 'status', proposalId: 'proposal' })).rejects.toThrow('expired')
    expect(bridge).toHaveBeenCalledTimes(1)
    await fiber.dispose()
  })

  it('aborts a pending request when its plugin row unloads', async () => {
    let enter: (signal: AbortSignal) => void = () => {}
    const entered = new Promise<AbortSignal>((resolve) => {
      enter = resolve
    })
    const bridge: import('../../src/resources/mcp-manage-port.js').McpManageBridge = async (
      _input,
      signal,
    ) => {
      enter(signal)
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
      return { state: 'cancelled' }
    }
    const t = setup({}, undefined, bridge)
    t.host.activate(t.activation)
    const fiber = await t.mount('installer', 'ext:acme/installer', (_ctx, agnes) => {
      agnes.registerTool({
        ...tool('manage_mcp'),
        async execute(_args, ctx) {
          if (!ctx.mcpManage) throw new Error('Missing MCP port')
          await ctx.mcpManage.request({ action: 'list' })
          return { content: [] }
        },
      })
    })
    const registered = t.kernel.definitions.get('manage_mcp')
    if (!registered) throw new Error('Missing MCP tool')
    const pending = registered.execute({}, {
      signal: new AbortController().signal,
      session: { depth: 0, key: 'owner', toolUseId: 'call' },
    } as never)
    const rejected = expect(pending).rejects.toThrow()
    const signal = await entered
    await fiber.dispose()
    await rejected
    expect(signal.aborted).toBe(true)
    expect(t.kernel.tools.has('manage_mcp')).toBe(false)
  })

  it('refuses subagent requests before reaching the daemon', async () => {
    const bridge = vi.fn<import('../../src/resources/mcp-manage-port.js').McpManageBridge>()
    const t = setup({}, undefined, bridge)
    t.host.activate(t.activation)
    const fiber = await t.mount('installer', 'ext:acme/installer', (_ctx, agnes) => {
      agnes.registerTool({
        ...tool('manage_mcp'),
        async execute(_args, ctx) {
          if (!ctx.mcpManage) throw new Error('Missing MCP port')
          await ctx.mcpManage.request({ action: 'status', proposalId: 'proposal' })
          return { content: [] }
        },
      })
    })
    const registered = t.kernel.definitions.get('manage_mcp')
    if (!registered) throw new Error('Missing MCP tool')
    await expect(
      registered.execute({}, {
        signal: new AbortController().signal,
        session: { depth: 1, key: 'child', toolUseId: 'call' },
      } as never),
    ).rejects.toThrow('Subagents')
    expect(bridge).not.toHaveBeenCalled()
    await fiber.dispose()
  })
})

describe('plugin plugin management request port', () => {
  it('stamps row identity and expires an escaped callback after tool completion', async () => {
    const bridge = vi.fn<import('../../src/resources/plugin-manage-port.js').PluginManageBridge>(
      async () => ({
        proposalId: 'proposal',
        state: 'prepared',
      }),
    )
    const t = setup({}, undefined, undefined, bridge)
    t.host.activate(t.activation)
    let escaped: NonNullable<import('@agnes/extension-api').ToolContext['pluginManage']> | undefined
    const fiber = await t.mount('installer', 'ext:acme/installer', (_ctx, agnes) => {
      agnes.registerTool({
        ...tool('manage_plugin'),
        async execute(_args, ctx) {
          escaped = ctx.pluginManage
          if (!ctx.pluginManage) throw new Error('Missing plugin port')
          await ctx.pluginManage.request({ action: 'status', proposalId: 'proposal' })
          return { content: [] }
        },
      })
    })
    const context = {
      signal: new AbortController().signal,
      session: { depth: 0, key: 'owner', toolUseId: 'call' },
    }
    const registered = t.kernel.definitions.get('manage_plugin')
    if (!registered) throw new Error('Missing plugin tool')
    await registered.execute({}, context as never)
    expect(bridge.mock.calls[0]?.[0]).toMatchObject({
      packageId: '@acme/tools',
      snapshotId: 'snapshot-installer',
      rowId: 'ext:acme/installer',
      sessionKey: 'owner',
      toolUseId: 'call',
      leaseId: expect.any(String),
    })
    if (!escaped) throw new Error('Missing escaped port')
    await expect(escaped.request({ action: 'status', proposalId: 'proposal' })).rejects.toThrow('expired')
    expect(bridge).toHaveBeenCalledTimes(1)
    await fiber.dispose()
  })

  it('aborts a pending request when its plugin row unloads', async () => {
    let enter: (signal: AbortSignal) => void = () => {}
    const entered = new Promise<AbortSignal>((resolve) => {
      enter = resolve
    })
    const bridge: import('../../src/resources/plugin-manage-port.js').PluginManageBridge = async (
      _input,
      signal,
    ) => {
      enter(signal)
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
      return { state: 'cancelled' }
    }
    const t = setup({}, undefined, undefined, bridge)
    t.host.activate(t.activation)
    const fiber = await t.mount('installer', 'ext:acme/installer', (_ctx, agnes) => {
      agnes.registerTool({
        ...tool('manage_plugin'),
        async execute(_args, ctx) {
          if (!ctx.pluginManage) throw new Error('Missing plugin port')
          await ctx.pluginManage.request({ action: 'list' })
          return { content: [] }
        },
      })
    })
    const registered = t.kernel.definitions.get('manage_plugin')
    if (!registered) throw new Error('Missing plugin tool')
    const pending = registered.execute({}, {
      signal: new AbortController().signal,
      session: { depth: 0, key: 'owner', toolUseId: 'call' },
    } as never)
    const rejected = expect(pending).rejects.toThrow()
    const signal = await entered
    await fiber.dispose()
    await rejected
    expect(signal.aborted).toBe(true)
    expect(t.kernel.tools.has('manage_plugin')).toBe(false)
  })

  it('refuses subagent requests before reaching the daemon', async () => {
    const bridge = vi.fn<import('../../src/resources/plugin-manage-port.js').PluginManageBridge>()
    const t = setup({}, undefined, undefined, bridge)
    t.host.activate(t.activation)
    const fiber = await t.mount('installer', 'ext:acme/installer', (_ctx, agnes) => {
      agnes.registerTool({
        ...tool('manage_plugin'),
        async execute(_args, ctx) {
          if (!ctx.pluginManage) throw new Error('Missing plugin port')
          await ctx.pluginManage.request({ action: 'status', proposalId: 'proposal' })
          return { content: [] }
        },
      })
    })
    const registered = t.kernel.definitions.get('manage_plugin')
    if (!registered) throw new Error('Missing plugin tool')
    await expect(
      registered.execute({}, {
        signal: new AbortController().signal,
        session: { depth: 1, key: 'child', toolUseId: 'call' },
      } as never),
    ).rejects.toThrow('Subagents')
    expect(bridge).not.toHaveBeenCalled()
    await fiber.dispose()
  })
})

describe('pluginRowSource', () => {
  it('is a valid extension id derived from the row id', () => {
    const source = pluginRowSource('ext:acme/tools')
    expect(source).toMatch(/^plugin\/[0-9a-f]{16}$/)
    expect(EXTENSION_ID_PATTERN.test(source)).toBe(true)
    expect(pluginRowSource('ext:acme/tools')).toBe(source)
    expect(pluginRowSource('ext:acme/other')).not.toBe(source)
  })
})

describe('registration and wind-down', () => {
  it('registers a tool and an observe hook and lists the row', async () => {
    const t = setup()
    t.host.activate(t.activation)
    await t.mount('row-a', 'ext:acme/a', (_ctx, agnes) => {
      agnes.registerTool(tool('tool_a') as never)
      agnes.on('session_start', () => {})
    })
    await tick()
    const source = pluginRowSource('ext:acme/a')
    expect(t.kernel.tools.get('tool_a')).toBe(source)
    expect(t.kernel.hooks).toEqual([{ event: 'session_start', source }])
    expect(t.kinds('extension.registered').map((e) => e.detail.name)).toEqual(['tool_a', 'session_start'])
    expect(t.kinds('extension.loaded')).toHaveLength(1)
    const [entry] = t.host.statusEntries()
    expect(entry?.status).toMatchObject({
      id: source,
      package: '@acme/tools',
      version: '1.2.3',
      integrity: 'sha256-int',
      trust: 'trusted',
      loaded: true,
      revision: 'snapshot-row-a',
    })
    expect(t.host.leaseFor(source)).toBeDefined()
  })

  it('winds a row down in four steps when it unmounts', async () => {
    const t = setup()
    t.host.activate(t.activation)
    const fiber = await t.mount('row-a', 'ext:acme/a', (_ctx, agnes) => {
      agnes.registerTool(tool('tool_a') as never)
      agnes.on('shutdown', () => {})
    })
    const source = pluginRowSource('ext:acme/a')
    await fiber.dispose()
    await tick()

    // 1 shutdown was dispatched while the registrations still existed, 2 released, 3 nothing left.
    expect(t.shutdowns).toEqual([{ source, toolsAtCall: ['tool:tool_a', 'hook:shutdown'] }])
    expect(t.kernel.ports.registrations(source)).toEqual([])
    expect(t.kinds('extension.revoked')).toEqual([
      expect.objectContaining({ detail: expect.objectContaining({ id: source, cleanupPending: false }) }),
    ])
    expect(t.kinds('extension.revoke_failed')).toEqual([])
    expect(t.host.statusEntries()[0]?.status.loaded).toBe(false)
    expect(t.host.leaseFor(source)).toBeUndefined()
  })

  it('reports a registration that would not release', async () => {
    const t = setup()
    t.host.activate(t.activation)
    t.kernel.leak.add('tool_a')
    const fiber = await t.mount('row-a', 'ext:acme/a', (_ctx, agnes) => {
      agnes.registerTool(tool('tool_a') as never)
    })
    await fiber.dispose()
    await tick()
    expect(t.kinds('extension.revoke_failed')).toHaveLength(1)
    expect(t.kinds('extension.revoked')[0]?.detail.cleanupPending).toBe(true)
    expect(t.host.statusEntries()[0]?.status.error).toEqual({
      code: 'E_EXT_LOAD',
      message: 'extension cleanup incomplete',
    })
  })

  it('does not let an evicted row take its row id back', async () => {
    const t = setup()
    t.host.activate(t.activation)
    let lateCtx: any
    await t.mount('row-old', 'ext:acme/a', (ctx, agnes) => {
      lateCtx = ctx
      agnes.registerTool(tool('tool_a') as never)
    })
    await t.mount('row-new', 'ext:acme/a', (_ctx, agnes) => {
      agnes.registerTool(tool('tool_a') as never)
    })
    await t.host.settled()
    // The outgoing tree's row is still mounted and asks again, for instance from a timer.
    expect(() => lateCtx.extension()).toThrow(/replaced/)
    await t.host.settled()
    expect(t.kernel.ports.registrations(pluginRowSource('ext:acme/a'))).toEqual(['tool:tool_a'])
    expect(t.kinds('extension.revoked')).toHaveLength(1)
  })

  it('evicts an incumbent with the same row id before the newcomer registers', async () => {
    const t = setup()
    t.host.activate(t.activation)
    const first = await t.mount('row-old', 'ext:acme/a', (_ctx, agnes) => {
      agnes.registerTool(tool('tool_a') as never)
      agnes.on('session_start', () => {})
    })
    // A candidate tree mounts the same row while the old one is still live: same names, no clash.
    await t.mount('row-new', 'ext:acme/a', (_ctx, agnes) => {
      agnes.registerTool(tool('tool_a') as never)
      agnes.on('session_start', () => {})
    })
    await t.host.settled()
    const source = pluginRowSource('ext:acme/a')
    expect(t.kernel.ports.registrations(source)).toEqual(['tool:tool_a', 'hook:session_start'])
    expect(t.kinds('extension.revoked')).toHaveLength(1)

    // The old tree retiring afterwards must not take the newcomer's registrations with it.
    await first.dispose()
    await tick()
    expect(t.kernel.ports.registrations(source)).toEqual(['tool:tool_a', 'hook:session_start'])
    expect(t.kinds('extension.revoked')).toHaveLength(1)
    expect(t.host.replacedBy('a')).toBeUndefined()
  })

  it('rebuilds its registrations when the row restarts', async () => {
    const t = setup()
    t.host.activate(t.activation)
    const fiber = await t.mount('row-a', 'ext:acme/a', (_ctx, agnes) => {
      agnes.registerTool(tool('tool_a') as never)
    })
    await fiber.restart()
    await tick()
    expect(t.kernel.ports.registrations(pluginRowSource('ext:acme/a'))).toEqual(['tool:tool_a'])
    expect(t.kinds('extension.registered')).toHaveLength(2)
    expect(t.kinds('extension.revoked')).toHaveLength(1)
    expect(t.host.statusEntries()).toHaveLength(1)
  })

  it('keeps every disposer working after the row is gone', async () => {
    const t = setup()
    t.host.activate(t.activation)
    let dispose: (() => void) | undefined
    const fiber = await t.mount('row-a', 'ext:acme/a', (_ctx, agnes) => {
      dispose = agnes.registerTool(tool('tool_a') as never) as () => void
    })
    await fiber.dispose()
    await tick()
    expect(() => dispose?.()).not.toThrow()
    expect(t.kernel.ports.registrations(pluginRowSource('ext:acme/a'))).toEqual([])
  })
})

describe('who may call ctx.extension()', () => {
  it('refuses the root, an unattested fiber and a builtin row', async () => {
    const t = setup()
    t.host.activate(t.activation)
    const ask = (ctx: Context) => (ctx as unknown as { extension(): unknown }).extension()
    expect(() => ask(t.root)).toThrow(/third-party/)
    let builtinError: unknown
    t.originFor('row-b', 'ext:agnes/x', 'builtin')
    const fiber = t.root.plugin({
      name: 'row-b',
      inject: ['extension'],
      apply(ctx: Context) {
        try {
          ask(ctx)
        } catch (error) {
          builtinError = error
        }
      },
    } as any)
    await fiber.await()
    expect((builtinError as Error).message).toMatch(/third-party/)
    let unattested: unknown
    const other = t.root.plugin({
      name: 'no-origin',
      inject: ['extension'],
      apply(ctx: Context) {
        try {
          ask(ctx)
        } catch (error) {
          unattested = error
        }
      },
    } as any)
    await other.await()
    expect((unattested as Error).message).toMatch(/third-party/)
  })

  it('gives a nested plugin its row and hands back one API per row', async () => {
    const t = setup()
    t.host.activate(t.activation)
    const seen: PluginExtensionAPI[] = []
    await t.mount('row-a', 'ext:acme/a', async (ctx, agnes) => {
      seen.push(agnes, ctx.extension())
      const child = ctx.plugin({
        name: 'child',
        inject: ['extension'],
        apply(childCtx: any) {
          seen.push(childCtx.extension())
        },
      })
      await child.await()
    })
    expect(seen).toHaveLength(3)
    expect(new Set(seen).size).toBe(1)
    expect(seen[0]?.ctx.extId).toBe(pluginRowSource('ext:acme/a'))
    expect(seen[0]?.ctx.trust).toBe('trusted')
  })
})

describe('fixed rules', () => {
  it('opens tools, all 17 hook events (via registerHook) and events; keeps slots/services/projections/resources refused', async () => {
    const t = setup()
    t.host.activate(t.activation)
    const codes: Record<string, string> = {}
    await t.mount('row-a', 'ext:acme/a', (_ctx, agnes) => {
      const api = agnes as unknown as Record<string, (...a: unknown[]) => unknown>
      const attempt = (label: string, run: () => unknown) => {
        try {
          run()
          codes[label] = 'allowed'
        } catch (error) {
          codes[label] = (error as { code: string }).code
        }
      }
      // `on` stays the simplified observe-only entry: non-observe events are still refused there.
      attempt('tool_call', () => agnes.on('tool_call' as never, () => undefined as never))
      attempt('context', () => agnes.on('context' as never, () => undefined as never))
      attempt('before_provider_headers', () =>
        agnes.on('before_provider_headers' as never, (() => {}) as never),
      )
      attempt('compact', () => agnes.on('compact', () => {}))
      // registerHook opens every one of the 17 events, transform/intercept-category included -
      // the same events `on` above just refused.
      attempt('registerHook:tool_call', () => api.registerHook?.('tool_call', () => ({ allow: true })))
      attempt('registerHook:context', () => api.registerHook?.('context', () => ({})))
      attempt('registerHook:before_provider_headers', () =>
        api.registerHook?.('before_provider_headers', () => ({})),
      )
      attempt('registerSlot', () => api.registerSlot?.('status.line', () => null))
      attempt('registerService', () => api.registerService?.({}))
      attempt('registerProjection', () => api.registerProjection?.({}))
      attempt('registerResource', () => api.registerResource?.({}))
    })
    expect(codes).toEqual({
      tool_call: 'E_CAPABILITY_UNDECLARED',
      context: 'E_CAPABILITY_UNDECLARED',
      before_provider_headers: 'E_CAPABILITY_UNDECLARED',
      compact: 'allowed',
      'registerHook:tool_call': 'allowed',
      'registerHook:context': 'allowed',
      'registerHook:before_provider_headers': 'allowed',
      registerSlot: 'E_CAPABILITY_UNDECLARED',
      registerService: 'E_CAPABILITY_UNDECLARED',
      registerProjection: 'E_CAPABILITY_UNDECLARED',
      registerResource: 'E_CAPABILITY_UNDECLARED',
    })
  })

  it('refuses registration once the row is gone', async () => {
    const t = setup()
    t.host.activate(t.activation)
    let api: PluginExtensionAPI | undefined
    const row = await t.mount('row-a', 'ext:acme/a', (_ctx, agnes) => {
      api = agnes
    })
    await row.dispose()
    await tick()
    expect(() => api?.registerTool(tool('late') as never)).toThrow(/closed|revoked/)
    expect(t.kernel.tools.size).toBe(0)
  })

  it('reserves a builtin tool name for the row that replaces the builtin', async () => {
    const t = setup({
      reservedTool: (name, rowId) => name === 'grep' && rowId !== 'ext:agnes/tools-search',
    })
    t.host.activate(t.activation)
    let outsider: unknown
    await t.mount('row-a', 'ext:acme/a', (_ctx, agnes) => {
      try {
        agnes.registerTool(tool('grep') as never)
      } catch (error) {
        outsider = error
      }
    })
    expect((outsider as { code: string }).code).toBe('E_CAPABILITY_UNDECLARED')
    expect(t.kernel.tools.has('grep')).toBe(false)
    await t.mount('row-b', 'ext:agnes/tools-search', (_ctx, agnes) => {
      agnes.registerTool(tool('grep') as never)
    })
    expect(t.kernel.tools.get('grep')).toBe(pluginRowSource('ext:agnes/tools-search'))
    expect(t.host.replacedBy('agnes/tools-search')).toBe(pluginRowSource('ext:agnes/tools-search'))
  })

  it('stamps ledger events with the Host-chosen source and needs a live kernel', async () => {
    const t = setup()
    let appended: Promise<unknown> | undefined
    await t.mount('row-a', 'ext:acme/a', (_ctx, agnes) => {
      expect(() => agnes.events.append('note', { a: 1 })).toThrow(/no active session/)
    })
    t.host.activate(t.activation)
    await t.mount('row-b', 'ext:acme/b', (_ctx, agnes) => {
      appended = agnes.events.append('note', { a: 1 })
    })
    await appended
    expect(t.kernel.events).toEqual([
      { type: `x/${pluginRowSource('ext:acme/b')}/note`, source: pluginRowSource('ext:acme/b') },
    ])
  })
})

describe('before the kernel exists', () => {
  it('keeps registrations back and lists nothing until the kernel is up', async () => {
    const t = setup()
    const fiber = await t.mount('row-a', 'ext:acme/a', (_ctx, agnes) => {
      agnes.registerTool(tool('tool_a') as never)
      agnes.on('session_start', () => {})
    })
    expect(t.kernel.tools.size).toBe(0)
    expect(t.host.statusEntries()).toEqual([])
    expect(t.audit).toEqual([])
    expect(t.host.leaseFor(pluginRowSource('ext:acme/a'))).toBeDefined()

    t.host.activate(t.activation)
    const source = pluginRowSource('ext:acme/a')
    expect(t.kernel.ports.registrations(source)).toEqual(['tool:tool_a', 'hook:session_start'])
    expect(t.host.statusEntries()[0]?.status.loaded).toBe(true)
    expect(t.kinds('extension.loaded')).toHaveLength(1)
    await fiber.dispose()
    await tick()
    expect(t.kernel.ports.registrations(source)).toEqual([])
  })

  it('drops what a row cancelled or unmounted while waiting', async () => {
    const t = setup()
    const fiber = await t.mount('row-a', 'ext:acme/a', (_ctx, agnes) => {
      agnes.registerTool(tool('cancelled') as never)()
      agnes.registerTool(tool('kept') as never)
    })
    const other = await t.mount('row-b', 'ext:acme/b', (_ctx, agnes) => {
      agnes.registerTool(tool('gone') as never)
    })
    await other.dispose()
    t.host.activate(t.activation)
    expect([...t.kernel.tools.keys()]).toEqual(['kept'])
    await fiber.dispose()
  })

  it('reports a waiting registration that turns out to be refused, without failing the Host', async () => {
    const t = setup({ reservedTool: (name) => name === 'grep' })
    await t.mount('row-a', 'ext:acme/a', (_ctx, agnes) => {
      agnes.registerTool(tool('grep') as never)
      agnes.registerTool(tool('fine') as never)
    })
    expect(() => t.host.activate(t.activation)).not.toThrow()
    expect([...t.kernel.tools.keys()]).toEqual(['fine'])
    expect(t.kinds('extension.failed')).toHaveLength(1)
    expect(t.kinds('extension.loaded')).toHaveLength(0)
    expect(t.host.statusEntries()[0]?.status.error?.code).toBe('E_CAPABILITY_UNDECLARED')
  })
})

describe('replacing a governance builtin', () => {
  const governance = new Map([['ext:agnes/privacy', ['session_start', 'shutdown']]])
  const row = (plugin: string, disabled = false) => ({ id: 'ext:agnes/privacy', plugin, disabled })

  it('needs every hook the builtin declared', async () => {
    const t = setup({ governance })
    t.host.activate(t.activation)
    await t.mount('row-a', 'ext:agnes/privacy', (_ctx, agnes) => {
      agnes.on('session_start', () => {})
    })
    expect(() => t.host.assertReplacements([row('@acme/tools@snap/plugin')], t.root)).toThrow(/shutdown/)
    await t.mount('row-b', 'ext:agnes/privacy', (_ctx, agnes) => {
      agnes.on('session_start', () => {})
      agnes.on('shutdown', () => {})
    })
    expect(() => t.host.assertReplacements([row('@acme/tools@snap/plugin')], t.root)).not.toThrow()
  })

  it('has nothing to say about the builtin itself, a disabled row or a row that never asked', () => {
    const t = setup({ governance })
    t.host.activate(t.activation)
    expect(() => t.host.assertReplacements([row('builtin:@agnes/base/privacy')], t.root)).not.toThrow()
    expect(() => t.host.assertReplacements([row('@acme/tools@snap/plugin', true)], t.root)).not.toThrow()
    expect(() => t.host.assertReplacements([row('@acme/tools@snap/plugin')], t.root)).toThrow(/session_start/)
  })

  it('does not credit a candidate with what a row of another tree registered', async () => {
    const t = setup({ governance })
    t.host.activate(t.activation)
    await t.mount('row-a', 'ext:agnes/privacy', (_ctx, agnes) => {
      agnes.on('session_start', () => {})
      agnes.on('shutdown', () => {})
    })
    expect(() => t.host.assertReplacements([row('@acme/tools@snap/plugin')], t.root)).not.toThrow()
    // A candidate whose row never asked for the facade holds nothing, whatever the old tree's row holds.
    const candidateRoot = new Context()
    expect(() => t.host.assertReplacements([row('@acme/tools@snap/plugin')], candidateRoot)).toThrow(
      /must register hooks: session_start, shutdown/,
    )
  })

  it('stops counting a hook the row released again', async () => {
    const t = setup({ governance })
    t.host.activate(t.activation)
    await t.mount('row-a', 'ext:agnes/privacy', (_ctx, agnes) => {
      agnes.on('session_start', () => {})
      const release = agnes.on('shutdown', () => {}) as unknown as () => void
      release()
    })
    expect(() => t.host.assertReplacements([row('@acme/tools@snap/plugin')], t.root)).toThrow(/shutdown/)
  })

  it('refuses any replacement of a builtin whose manifest could not be read', () => {
    const t = setup({ governance: new Map([['ext:agnes/privacy', 'unreadable' as const]]) })
    t.host.activate(t.activation)
    expect(() => t.host.assertReplacements([row('@acme/tools@snap/plugin')], t.root)).toThrow(
      /manifest cannot be read/,
    )
  })

  it('is silent while the kernel is not up', () => {
    const t = setup({ governance })
    expect(() => t.host.assertReplacements([row('@acme/tools@snap/plugin')], t.root)).not.toThrow()
  })

  it('inherits the replaced builtin’s fixed hookRank; an ordinary third-party row id gets none', async () => {
    const t = setup({ governance })
    t.host.activate(t.activation)
    await t.mount('row-privacy', 'ext:agnes/privacy', (_ctx, agnes) => {
      agnes.on('session_start', () => {})
    })
    await t.mount('row-other', 'ext:acme/other', (_ctx, agnes) => {
      agnes.on('session_start', () => {})
    })
    const [privacyEntry, otherEntry] = t.kernel.hooks
    expect(privacyEntry?.hookRank).toBeTypeOf('number')
    expect(otherEntry?.hookRank).toBeUndefined()
  })
})

describe('the merged status listing', () => {
  const status = (id: string, loaded = true): ExtensionStatus => ({
    id,
    package: '@x/y',
    version: '1.0.0',
    trust: 'builtin',
    loaded,
  })

  it('keeps first-seen order across both stores and names a replacement', () => {
    const managed = [
      { order: 0, status: status('agnes/mcp-search') },
      { order: 2, status: status('agnes/tools-core', false) },
    ]
    const rows = [{ order: 1, status: { ...status('plugin/abc'), trust: 'trusted' as const } }]
    const merged = mergeExtensionStatus([managed, rows], (id) =>
      id === 'agnes/tools-core' ? 'plugin/abc' : undefined,
    )
    expect(merged.map((s) => s.id)).toEqual(['agnes/mcp-search', 'plugin/abc', 'agnes/tools-core'])
    expect(merged[2]).toMatchObject({ loaded: false, replacedBy: 'plugin/abc' })
    expect(merged[0]).not.toHaveProperty('replacedBy')
  })

  it('keeps a row where it was first seen when it mounts again', async () => {
    const t = setup()
    t.host.activate(t.activation)
    const a = await t.mount('row-a', 'ext:acme/a', () => {})
    await t.mount('row-b', 'ext:acme/b', () => {})
    await a.dispose()
    await tick()
    await t.mount('row-a2', 'ext:acme/a', () => {})
    expect(t.host.statusEntries().map((e) => e.status.id)).toEqual([
      pluginRowSource('ext:acme/a'),
      pluginRowSource('ext:acme/b'),
    ])
  })
})

describe('hook leases', () => {
  it('lets the kernel find the lease of a source that has no managed record', async () => {
    const t = setup()
    t.host.activate(t.activation)
    const fiber = await t.mount('row-a', 'ext:acme/a', () => {})
    const source = pluginRowSource('ext:acme/a')
    expect(t.host.leaseFor(source)?.scope).toMatchObject({ toolPrefix: '', events: true })
    expect(t.host.leaseFor('plugin/ffffffffffffffff')).toBeUndefined()
    await fiber.dispose()
    await tick()
    expect(t.host.leaseFor(source)).toBeUndefined()
  })
})

describe('an installed row that throws', () => {
  it('is listed as failed', async () => {
    const t = setup()
    t.host.activate(t.activation)
    const failing = vi.fn()
    await t.mount('row-a', 'ext:acme/a', (_ctx, agnes) => {
      agnes.registerTool(tool('tool_a') as never)
      failing()
      throw new Error('boom')
    })
    await tick()
    expect(failing).toHaveBeenCalled()
    expect(t.kinds('extension.failed')).toHaveLength(1)
    expect(t.host.statusEntries()[0]?.status).toMatchObject({ loaded: false, error: { code: 'E_EXT_LOAD' } })
  })
})
