import type { ExtensionAPI, ResourceEntry, ToolDef } from '@agnes/extension-api'
import { describe, expect, it, vi } from 'vitest'
import type { McpServerConfig } from '../../../src/mcp/config.js'
import { mcpLocalToolPrefix } from '../../../src/mcp/naming.js'
import type { McpConnection, RemoteToolIndexRow } from '../../../src/mcp/register.js'
import type { McpCatalogHub } from '../src/catalog-hub.js'
import { mcpServerExtension } from '../src/extension.js'

function fakeApi() {
  const tools: ToolDef[] = []
  const resources: ResourceEntry[] = []
  const disposed: string[] = []
  return {
    api: {
      registerTool: (tool: ToolDef) => {
        tools.push(tool)
        return () => disposed.push(`tool:${tool.name}`)
      },
      registerResource: (resource: ResourceEntry) => {
        resources.push(resource)
        return () => disposed.push(`resource:${resource.id}`)
      },
      ctx: { log: { debug() {}, info() {}, warn() {}, error() {} } },
    } as unknown as ExtensionAPI,
    disposed,
    resources,
    tools,
  }
}

/** A fake `McpConnection` whose `onClose`/`onToolsChanged` listeners the test fires directly, mirroring
 * `supervisor.test.ts`'s helper of the same shape. */
function fakeConnection(
  id: string,
  toolNames: readonly string[] = ['ping'],
): McpConnection & { fireToolsChanged(): void; closed: boolean; closeCount: number } {
  const toolsChangedListeners = new Set<() => void>()
  const conn = {
    id,
    closed: false,
    closeCount: 0,
    async listTools() {
      return toolNames.map((name) => ({ name, description: name, inputSchema: { type: 'object' } }))
    },
    async callTool(name: string) {
      return { content: [{ type: 'text' as const, text: `ok ${name}` }] }
    },
    async close() {
      conn.closed = true
      conn.closeCount += 1
    },
    onClose(_listener: () => void) {
      return () => undefined
    },
    onToolsChanged(listener: () => void) {
      toolsChangedListeners.add(listener)
      return () => toolsChangedListeners.delete(listener)
    },
    fireToolsChanged() {
      for (const listener of [...toolsChangedListeners]) listener()
    },
  }
  return conn
}

function fakeCatalogHub(): McpCatalogHub & {
  upserts: { serverId: string; rows: readonly RemoteToolIndexRow[]; claimant?: object }[]
  removed: string[]
  removedBy: (object | undefined)[]
} {
  const upserts: { serverId: string; rows: readonly RemoteToolIndexRow[]; claimant?: object }[] = []
  const removed: string[] = []
  const removedBy: (object | undefined)[] = []
  return {
    upsert(serverId, rows, claimant) {
      upserts.push({ serverId, rows, ...(claimant ? { claimant } : {}) })
    },
    remove(serverId, claimant) {
      removed.push(serverId)
      removedBy.push(claimant)
    },
    clear() {},
    search() {
      return []
    },
    get() {
      return undefined
    },
    upserts,
    removed,
    removedBy,
  }
}

const cfg: McpServerConfig = { id: 'gh', transport: 'stdio', cmd: ['gh-mcp'], defer: true }
const GH_PREFIX = mcpLocalToolPrefix('gh')

describe('mcpServerExtension', () => {
  it('returns the disposer synchronously, without waiting for the connection to land (the row must not block application)', () => {
    const { api } = fakeApi()
    const connect = vi.fn(async () => fakeConnection('gh'))
    const factory = mcpServerExtension(cfg, { catalogHub: fakeCatalogHub(), connect })

    const result = factory(api)

    expect(result).not.toBeInstanceOf(Promise)
    expect(typeof result).toBe('function')
    // The factory returned before `connect` had any chance to resolve -- it may not even have been
    // invoked synchronously, but it is certainly still pending.
    expect(connect).toHaveBeenCalledTimes(1)
  })

  it('registers the remote catalog and the catalog hub once the connection and first sync land', async () => {
    const { api, tools, resources } = fakeApi()
    const conn = fakeConnection('gh', ['ping', 'pong'])
    const connect = vi.fn(async () => conn)
    const catalogHub = fakeCatalogHub()
    const factory = mcpServerExtension(cfg, { catalogHub, connect })

    factory(api)

    await vi.waitFor(() =>
      expect(tools.map((tool) => tool.name)).toEqual([`${GH_PREFIX}ping`, `${GH_PREFIX}pong`]),
    )
    expect(resources.map((resource) => resource.id)).toEqual(['gh'])
    expect(catalogHub.upserts).toHaveLength(1)
    expect(catalogHub.upserts[0]?.serverId).toBe('gh')
    expect(catalogHub.upserts[0]?.rows.map((row) => row.name)).toEqual([
      `${GH_PREFIX}ping`,
      `${GH_PREFIX}pong`,
    ])
  })

  it('a non-deferred server never contributes rows to the catalog hub (eager tools are already disclosed directly)', async () => {
    const { api, tools } = fakeApi()
    const eagerCfg: McpServerConfig = { ...cfg, defer: false }
    const conn = fakeConnection('gh', ['ping'])
    const connect = vi.fn(async () => conn)
    const catalogHub = fakeCatalogHub()
    const factory = mcpServerExtension(eagerCfg, { catalogHub, connect })

    factory(api)

    await vi.waitFor(() => expect(tools).toHaveLength(1))
    expect(catalogHub.upserts).toEqual([])
  })

  it('dispose closes the connection, unregisters the tools/resource, and releases the catalog hub claim', async () => {
    const { api, tools, resources, disposed } = fakeApi()
    const conn = fakeConnection('gh', ['ping'])
    const connect = vi.fn(async () => conn)
    const catalogHub = fakeCatalogHub()
    const factory = mcpServerExtension(cfg, { catalogHub, connect })
    const dispose = factory(api) as () => void
    await vi.waitFor(() => expect(tools).toHaveLength(1))
    void resources

    dispose()

    // `catalogHub.removed` is the last thing `mcpServerExtension`'s disposer sets (see the
    // dispose-ordering doc comment in extension.ts), so waiting for it also guarantees the
    // connection close and tool/resource unregistration above it in `handle.dispose()` already ran.
    await vi.waitFor(() => expect(catalogHub.removed).toEqual(['gh']))
    expect(conn.closed).toBe(true)
    expect(disposed).toContain(`tool:${GH_PREFIX}ping`)
    expect(disposed).toContain('resource:gh')
  })

  it('returns an awaitable disposer that settles after connection and catalog cleanup', async () => {
    const { api, tools } = fakeApi()
    const conn = fakeConnection('gh')
    let finishClose: (() => void) | undefined
    conn.close = async () => {
      await new Promise<void>((resolve) => {
        finishClose = resolve
      })
      conn.closed = true
      conn.closeCount += 1
    }
    const catalogHub = fakeCatalogHub()
    const dispose = mcpServerExtension(cfg, {
      catalogHub,
      connect: async () => conn,
    })(api) as () => Promise<void>
    await vi.waitFor(() => expect(tools).toHaveLength(1))
    const pending = dispose()
    expect(pending).toBeInstanceOf(Promise)
    expect(dispose()).toBe(pending)
    expect(catalogHub.removed).toEqual([])
    finishClose?.()
    await pending
    expect(conn.closed).toBe(true)
    expect(catalogHub.removed).toEqual(['gh'])
  })

  it('a tools/list_changed re-sync does not close the still-live connection (ownsConnection: false regression)', async () => {
    // Design doc 2026-09-21-resource-rows-design.md line 33 literally says
    // `registerRemoteToolsStrict(…, { ownsConnection: true })`. That is wrong for this wiring: the
    // same connection is reused across repeated re-syncs, and `superviseConnection`'s `enqueueSync`
    // disposes the *previous* registration only after the *next* one is already in place. If the
    // previous registration owned the connection, disposing it would close the connection the new
    // (still current) registration is actively using. `mcpServerExtension` deliberately passes
    // `ownsConnection: false` instead -- this test is the regression guard for that deviation.
    const { api, tools } = fakeApi()
    const conn = fakeConnection('gh', ['ping'])
    const connect = vi.fn(async () => conn)
    const catalogHub = fakeCatalogHub()
    const factory = mcpServerExtension(cfg, { catalogHub, connect })
    factory(api)
    await vi.waitFor(() => expect(tools).toHaveLength(1))

    conn.fireToolsChanged()

    await vi.waitFor(() => expect(catalogHub.upserts).toHaveLength(2))
    expect(conn.closed).toBe(false)
    expect(conn.closeCount).toBe(0)
  })

  it('dispose waits for an in-flight tools/list_changed re-sync to finish before releasing the catalog hub claim', async () => {
    // Regression guard for the dispose-ordering fix described in extension.ts's doc comment: if
    // `catalogHub.remove` ran eagerly (before `handle.dispose()` drains the sync chain), a
    // last-second `tools/list_changed` re-sync racing the dispose could call `onCatalog` (re-adding
    // this server's rows) *after* the eager `remove()` already ran, leaving a ghost entry nothing
    // ever cleans up.
    const { api } = fakeApi()
    let resolveSecondListTools: ((tools: unknown[]) => void) | undefined
    let listToolsCalls = 0
    const toolsChangedListeners = new Set<() => void>()
    const conn: McpConnection = {
      id: 'gh',
      async listTools() {
        listToolsCalls += 1
        if (listToolsCalls === 1)
          return [{ name: 'ping', description: 'ping', inputSchema: { type: 'object' } }]
        // The second call (triggered by fireToolsChanged below) hangs until the test resolves it.
        return new Promise((resolve) => {
          resolveSecondListTools = resolve as (tools: unknown[]) => void
        })
      },
      async callTool() {
        return { content: [] }
      },
      async close() {},
      onClose: () => () => undefined,
      onToolsChanged(listener) {
        toolsChangedListeners.add(listener)
        return () => toolsChangedListeners.delete(listener)
      },
    }
    const connect = vi.fn(async () => conn)
    const catalogHub = fakeCatalogHub()
    const factory = mcpServerExtension(cfg, { catalogHub, connect })
    const dispose = factory(api) as () => void
    await vi.waitFor(() => expect(catalogHub.upserts).toHaveLength(1))

    for (const listener of [...toolsChangedListeners]) listener()
    await vi.waitFor(() => expect(listToolsCalls).toBe(2))

    dispose()

    // The in-flight re-sync from list_changed has not resolved yet -- the catalog hub claim must not
    // have been released.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(catalogHub.removed).toEqual([])

    resolveSecondListTools?.([{ name: 'ping', description: 'ping', inputSchema: { type: 'object' } }])

    await vi.waitFor(() => expect(catalogHub.removed).toEqual(['gh']))
    // The in-flight sync's onCatalog did complete (a second upsert) before the claim was released.
    expect(catalogHub.upserts).toHaveLength(2)
  })

  it('the production sleep aborts promptly when disposed mid-backoff, instead of waiting out the whole delay', async () => {
    // supervisor.test.ts always injects an instant fake `sleep`; this exercises the one production
    // implementation `mcpServerExtension` actually wires in (abortableSleep in extension.ts), which
    // nothing else covers.
    const { api } = fakeApi()
    const connect = vi.fn(async (): Promise<McpConnection> => {
      throw new Error('boom')
    })
    const catalogHub = fakeCatalogHub()
    const policy = { initialDelayMs: 10_000, maxDelayMs: 10_000, maxAttempts: 10 }
    const factory = mcpServerExtension(cfg, { catalogHub, connect, policy })
    const dispose = factory(api) as () => void
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(1))

    dispose()

    // `handle.dispose()` awaits the pending backoff sleep before it resolves and releases the catalog
    // hub claim. If `abortableSleep` did not observe the abort signal, this would only settle after
    // the full 10s delay instead.
    await vi.waitFor(() => expect(catalogHub.removed).toEqual(['gh']), { timeout: 2_000 })
    // No reconnect attempt was made after dispose.
    expect(connect).toHaveBeenCalledTimes(1)
  })
  it('claims and releases catalog rows with one per-instance claimant, distinct across instances of the same server', async () => {
    const catalogHub = fakeCatalogHub()
    const mount = async () => {
      const { api, tools } = fakeApi()
      const dispose = mcpServerExtension(cfg, {
        catalogHub,
        connect: vi.fn(async () => fakeConnection('gh')),
      })(api) as () => void
      await vi.waitFor(() => expect(tools).toHaveLength(1))
      return dispose
    }
    const first = await mount()
    const second = await mount()
    first()
    await vi.waitFor(() => expect(catalogHub.removedBy).toHaveLength(1))
    const [a, b] = catalogHub.upserts
    expect(a?.claimant).toBeDefined()
    expect(b?.claimant).toBeDefined()
    // Two instances for the same server id never share a claimant...
    expect(a?.claimant).not.toBe(b?.claimant)
    // ...and an instance releases with the same claimant it claimed with.
    expect(catalogHub.removedBy[0]).toBe(a?.claimant)
    second()
  })

  it('hands onFirstAttempt the first attempt outcome: settled once tools are registered, or on failure', async () => {
    const ok = fakeApi()
    let okReady: Promise<{ error?: unknown }> | undefined
    mcpServerExtension(cfg, {
      catalogHub: fakeCatalogHub(),
      connect: vi.fn(async () => fakeConnection('gh')),
      onFirstAttempt: (ready) => {
        okReady = ready
      },
    })(ok.api)
    expect(okReady).toBeDefined()
    expect(await okReady).toEqual({})
    // Settling means the tools are already there, not merely that the socket opened.
    expect(ok.tools.map((tool) => tool.name)).toEqual([`${GH_PREFIX}ping`])

    const failed = fakeApi()
    let failedReady: Promise<{ error?: unknown }> | undefined
    const dispose = mcpServerExtension(cfg, {
      catalogHub: fakeCatalogHub(),
      connect: vi.fn(async (): Promise<McpConnection> => {
        throw new Error('down')
      }),
      policy: { initialDelayMs: 10_000, maxDelayMs: 10_000, maxAttempts: 10 },
      onFirstAttempt: (ready) => {
        failedReady = ready
      },
    })(failed.api) as () => void
    expect((await failedReady)?.error).toBeInstanceOf(Error)
    expect(failed.tools).toEqual([])
    dispose()
  })

  it('reports connecting then ready with real catalog numbers, even for an eager (non-deferred) server', async () => {
    // onCatalog is gated by cfg.defer; onStatus's catalog numbers, wired through onRemoteCatalog, are
    // not - a server whose tools are eagerly disclosed still needs a live status for the admin page.
    const eagerCfg: McpServerConfig = { id: 'gh', transport: 'stdio', cmd: ['gh-mcp'], defer: false }
    const events: unknown[] = []
    const { api } = fakeApi()
    mcpServerExtension(eagerCfg, {
      catalogHub: fakeCatalogHub(),
      connect: vi.fn(async () => fakeConnection('gh', ['ping', 'pong'])),
      onStatus: (event) => events.push(event),
    })(api)
    await vi.waitFor(() => expect(events).toHaveLength(2))
    expect(events[0]).toEqual({ state: 'connecting' })
    expect(events[1]).toMatchObject({ state: 'ready', toolCount: 2 })
    expect(typeof (events[1] as { catalogRevision: string }).catalogRevision).toBe('string')
  })

  it('reports unavailable, with the failure, once reconnection gives up', async () => {
    const events: unknown[] = []
    const dispose = mcpServerExtension(cfg, {
      catalogHub: fakeCatalogHub(),
      connect: vi.fn(async (): Promise<McpConnection> => {
        throw new Error('down')
      }),
      policy: { initialDelayMs: 1, maxDelayMs: 1, maxAttempts: 1 },
      onStatus: (event) => events.push(event),
    })(fakeApi().api) as () => void
    await vi.waitFor(() =>
      expect(events.at(-1)).toMatchObject({ state: 'unavailable', error: new Error('down') }),
    )
    dispose()
  })
})
