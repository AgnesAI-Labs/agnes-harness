import { isMcpServerRowId, type McpConnection, mcpPublicToolName, mcpStablePrefix } from '@agnes/base'
import { MemNamespace, MemTable } from '@agnes/base/testkit'
import type { McpServerDefinitionInput } from '@agnes/protocol'
import * as workerResources from '@agnes/resource-control-worker'
import { describe, expect, it, vi } from 'vitest'
import { withMcpCatalogReadScope } from '../src/mcp-catalog-scope.js'
import { leaseMcpConnection } from '../src/mcp-connection-pool.js'
import { type McpServerSnapshotEntry, mcpServerRowsFromDefinitions } from '../src/mcp-server-rows.js'
import { generationExtensionRestorer } from '../src/runtime-generation-restore.js'

function stdioEntry(
  serverId: string,
  revision = 'r1',
  state: Partial<Pick<McpServerSnapshotEntry, 'desired' | 'trust'>> = {},
): McpServerSnapshotEntry {
  return {
    definition: {
      serverId,
      displayName: serverId,
      transport: { kind: 'stdio', executable: `/usr/local/bin/${serverId}-mcp`, args: [] },
      secretBinding: { kind: 'stdio-env', env: { TOKEN: `secret://mcp/${serverId}-token` } },
    } as McpServerDefinitionInput,
    revision,
    desired: state.desired ?? 'enabled',
    trust: state.trust ?? 'trusted',
  }
}

function oauthEntry(serverId: string): McpServerSnapshotEntry {
  return {
    definition: {
      serverId,
      displayName: serverId,
      transport: { kind: 'http', url: 'https://mcp.example.com/mcp' },
      secretBinding: { kind: 'oauth' },
    } as McpServerDefinitionInput,
    revision: 'r1',
    desired: 'enabled',
    trust: 'trusted',
  }
}

const fakeOpener = { connect: vi.fn(async () => ({ id: 'x' }) as never) }

describe('mcpServerRowsFromDefinitions', () => {
  it('derives one row per non-oauth definition, id shaped ext:agnes/mcp-<slug>-<hash8>', () => {
    const { rows, skipped } = mcpServerRowsFromDefinitions(
      [stdioEntry('gh'), stdioEntry('linear')],
      fakeOpener,
    )
    expect(skipped).toEqual([])
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row.spec.id).toMatch(/^agnes\/mcp-[a-z0-9-]+-[0-9a-f]{8}$/)
      expect(row.manifest.id).toBe(row.spec.id)
      expect(row.spec.package).toBe('@agnes/base')
    }
    for (const row of rows) expect(isMcpServerRowId(`ext:${row.spec.id}`)).toBe(true)
    for (const id of ['ext:agnes/mcp-search', 'ext:agnes/mcp-gh-xyz', 'agnes/mcp-gh-12345678'])
      expect(isMcpServerRowId(id)).toBe(false)
    // Distinct servers get distinct ids.
    expect(rows[0]?.spec.id).not.toBe(rows[1]?.spec.id)
  })

  it('declares exactly what its one server uses: its own tool prefix, the mcp resource kind, and the artifact store for spilled output', () => {
    const { rows } = mcpServerRowsFromDefinitions([stdioEntry('gh'), stdioEntry('my.server-2')], fakeOpener)
    // Distinct server prefixes prevent one row from registering another server's tools.
    expect(rows.map((row) => row.manifest.capabilities)).toEqual([
      { tools: { prefix: mcpStablePrefix('gh') }, resources: ['mcp'], artifacts: true },
      { tools: { prefix: mcpStablePrefix('my.server-2') }, resources: ['mcp'], artifacts: true },
    ])
    for (const [index, id] of ['gh', 'my.server-2'].entries()) {
      const prefix = rows[index]!.manifest.capabilities.tools!.prefix
      expect(mcpPublicToolName(id, 'ping').startsWith(prefix)).toBe(true)
      const other = index === 0 ? 'my.server-2' : 'gh'
      expect(mcpPublicToolName(other, 'ping').startsWith(prefix)).toBe(false)
    }
  })

  it('is idempotent: the same snapshot (by value) always derives the same ids and specs', () => {
    const entries = [stdioEntry('gh'), stdioEntry('linear', 'r7')]
    const first = mcpServerRowsFromDefinitions(entries, fakeOpener)
    const second = mcpServerRowsFromDefinitions(
      entries.map((e) => ({ ...e })),
      fakeOpener,
    )
    const shape = (r: typeof first.rows) => r.map(({ spec, manifest }) => ({ spec, manifest }))
    expect(shape(second.rows)).toEqual(shape(first.rows))
  })

  it("a definition edit (new revision) mounts as a distinct row instead of reusing the old id's spec", () => {
    const before = mcpServerRowsFromDefinitions([stdioEntry('gh', 'r1')], fakeOpener).rows[0]
    const after = mcpServerRowsFromDefinitions([stdioEntry('gh', 'r2')], fakeOpener).rows[0]
    // Same extension id (same server)...
    expect(after?.spec.id).toBe(before?.spec.id)
    // ...but a different spec.revision, so the row importer sees a changed row, not a reused one.
    expect(after?.spec.revision).not.toBe(before?.spec.revision)
  })

  it('skips an oauth-bound definition instead of turning it into a row (D105/D109)', () => {
    const { rows, skipped } = mcpServerRowsFromDefinitions(
      [stdioEntry('gh'), oauthEntry('remote')],
      fakeOpener,
    )
    expect(rows.map((r) => r.spec.id)).toEqual([expect.stringMatching(/^agnes\/mcp-gh-/)])
    expect(skipped).toEqual([{ serverId: 'remote', reason: expect.stringContaining('oauth') }])
  })

  it('becomes a row only when enabled and trusted -- the same servers the resource manager would connect', () => {
    const { rows, skipped } = mcpServerRowsFromDefinitions(
      [
        stdioEntry('on'),
        stdioEntry('off', 'r1', { desired: 'disabled' }),
        stdioEntry('pending', 'r1', { trust: 'untrusted' }),
        stdioEntry('refused', 'r1', { trust: 'rejected' }),
      ],
      fakeOpener,
    )
    expect(rows.map((r) => r.spec.id)).toEqual([expect.stringMatching(/^agnes\/mcp-on-/)])
    expect(skipped).toEqual([
      { serverId: 'off', reason: 'disabled' },
      { serverId: 'pending', reason: 'trust is untrusted' },
      { serverId: 'refused', reason: 'trust is rejected' },
    ])
  })

  it('skips a definition that fails schema re-validation, without failing the rest of the batch', () => {
    const bad = stdioEntry('broken')
    const invalid = {
      ...bad,
      definition: { ...bad.definition, secretBinding: { kind: 'stdio-env', env: { TOKEN: 'not-a-ref' } } },
    } as McpServerSnapshotEntry
    const { rows, skipped } = mcpServerRowsFromDefinitions([stdioEntry('gh'), invalid], fakeOpener)
    expect(rows.map((r) => r.spec.id)).toEqual([expect.stringMatching(/^agnes\/mcp-gh-/)])
    expect(skipped).toEqual([{ serverId: 'broken', reason: expect.stringContaining('schema') }])
  })

  it("a factory's connect closes over its own server's definition, not another row's", async () => {
    const opener = {
      connect: vi.fn(async (definition: McpServerDefinitionInput) => ({ id: definition.serverId }) as never),
    }
    const { rows } = mcpServerRowsFromDefinitions([stdioEntry('gh'), stdioEntry('linear')], opener)
    // Duck-typed: only the members mcpServerExtension's own factory actually calls.
    const fakeApi = {
      registerTool: () => () => undefined,
      registerResource: () => () => undefined,
      ctx: { log: { debug() {}, info() {}, warn() {}, error() {} } },
    }
    const table = new MemTable('tool_index')
    const ns = new MemNamespace()
    const fakeCtx = {
      signal: new AbortController().signal,
      adapters: { storage: { table: () => table, namespace: () => ns } },
      secrets: () => '',
      profile: {},
      log: { debug() {}, info() {}, warn() {}, error() {} },
    }

    for (const row of rows) {
      // DynamicExtension.factory's general type allows undefined/a Promise (SeamInitContext-driven
      // factories built by other callers may need that); this one is always a plain sync
      // ExtensionFactory -- mcpServerExtension's own factory never returns either.
      const factory = row.factory(fakeCtx as never) as unknown as (api: typeof fakeApi) => void
      factory(fakeApi)
    }
    await vi.waitFor(() => expect(opener.connect).toHaveBeenCalledTimes(2))
    const connected = opener.connect.mock.calls.map(([definition]) => definition.serverId).sort()
    expect(connected).toEqual(['gh', 'linear'])
  })
})

it('reconstructs a cold generation MCP factory from SecretRefs and refuses unknown factory kinds', async () => {
  const entry = stdioEntry('pinned', 'original-revision')
  const row = mcpServerRowsFromDefinitions([entry], fakeOpener).rows[0]
  if (!row?.generation) throw new Error('missing MCP resource factory metadata')
  const restore = generationExtensionRestorer({
    env: {},
    profile: { name: 'local-dev', dataDir: '/synthetic-resource-data' },
    createSecrets: () => {
      throw new Error('SecretRefs must be resolved only when connecting')
    },
  } as unknown as Parameters<typeof generationExtensionRestorer>[0])
  const rebuilt = await restore(structuredClone(row.generation))
  expect(rebuilt.spec).toEqual(row.spec)
  expect(rebuilt.generation).toEqual(row.generation)
  expect(JSON.stringify(rebuilt.generation)).toContain('secret://mcp/pinned-token')
  expect(() => restore({ kind: 'unknown', data: {} })).toThrow('E_GENERATION_FACTORY_KIND')
  expect(() => restore({ kind: 'mcp-server', data: {} })).toThrow('E_GENERATION_MCP_DEFINITION')
  let release!: () => void
  const catalog = new Promise<void>((resolve) => {
    release = resolve
  })
  let listing = false,
    closed = false
  const tools = new Set<string>()
  const connection = {
    id: 'pinned',
    async listTools() {
      listing = true
      await catalog
      return [{ name: 'ping', description: 'Ping', inputSchema: { type: 'object' } }]
    },
    async callTool() {
      return { content: [] }
    },
    async close() {
      closed = true
    },
    onClose: () => () => undefined,
    onToolsChanged: () => () => undefined,
  }
  const opener = vi
    .spyOn(workerResources, 'createMcpServerOpener')
    .mockReturnValue({ connect: async () => connection })
  let finish: (() => Promise<void>) | undefined
  try {
    const cold = await restore(structuredClone(row.generation))
    const log = { debug() {}, info() {}, warn() {}, error() {} }
    const table = new MemTable('tool_index')
    const ns = new MemNamespace()
    const factory = await cold.factory({
      signal: new AbortController().signal,
      adapters: { storage: { table: () => table, namespace: () => ns } },
      profile: {},
      log,
    } as never)
    if (!factory) throw new Error('missing cold factory')
    let activated = false
    const activation = Promise.resolve(
      factory({
        ctx: { log },
        registerTool: (tool: { name: string }) => {
          tools.add(tool.name)
          return () => tools.delete(tool.name)
        },
        registerResource: () => () => undefined,
      } as never),
    ).then((dispose) => {
      activated = true
      return dispose
    })
    finish = async () => {
      const dispose = await activation
      await dispose?.()
    }
    await vi.waitFor(() => expect(listing).toBe(true))
    expect(activated).toBe(false)
    release()
    const dispose = await activation
    expect([...tools]).toEqual([mcpPublicToolName('pinned', 'ping')])
    await dispose?.()
    expect(tools.size).toBe(0)
    expect(closed).toBe(true)
  } finally {
    release()
    await finish?.()
    opener.mockRestore()
  }
})

it('shares effective MCP boundaries across generations and releases independent leases after rotation', async () => {
  let credential = 'first'
  const closed: string[] = []
  const opened: string[] = []
  const opener = {
    connect: async () => {
      throw new Error('prepared connect required')
    },
    prepare: async () => {
      const value = credential
      return {
        key: value,
        connect: async () => {
          opened.push(value)
          return {
            id: 'pooled',
            listTools: async () => [],
            callTool: async () => ({ content: [{ type: 'text' as const, text: value }] }),
            close: async () => {
              closed.push(value)
            },
          }
        },
      }
    },
  }
  const definition = stdioEntry('pooled').definition
  const signal = new AbortController().signal
  const one = await leaseMcpConnection(opener, 'revision', definition, signal)
  const two = await leaseMcpConnection(opener, 'revision', definition, signal)
  credential = 'rotated'
  const three = await leaseMcpConnection(opener, 'revision', definition, signal)
  expect(opened).toEqual(['first', 'rotated'])
  await one.close()
  expect(closed).toEqual([])
  expect(await two.callTool('ping', {}, { signal })).toMatchObject({ content: [{ text: 'first' }] })
  expect(await three.callTool('ping', {}, { signal })).toMatchObject({ content: [{ text: 'rotated' }] })
  await two.close()
  expect(closed).toEqual(['first'])
  await three.close()
  await three.close()
  expect(closed).toEqual(['first', 'rotated'])
})

function catalogFixture() {
  const toolsChanged = new Set<() => void>()
  const resourcesChanged = new Set<() => void>()
  const transportClosed = new Set<() => void>()
  let reads = 0
  let closes = 0
  let load: McpConnection['listTools'] = async () => [
    { name: 'first', description: 'first', inputSchema: { type: 'object' } },
  ]
  const opener = {
    connect: async () => ({
      id: 'catalog',
      listTools: (options?: Parameters<McpConnection['listTools']>[0]) => {
        reads++
        return load(options)
      },
      callTool: async () => ({ content: [] }),
      close: async () => {
        closes++
      },
      onToolsChanged: (listener: () => void) => {
        toolsChanged.add(listener)
        return () => {
          toolsChanged.delete(listener)
        }
      },
      onResourcesChanged: (listener: () => void) => {
        resourcesChanged.add(listener)
        return () => {
          resourcesChanged.delete(listener)
        }
      },
      onClose: (listener: () => void) => {
        transportClosed.add(listener)
        return () => {
          transportClosed.delete(listener)
        }
      },
    }),
  }
  const definition = { ...stdioEntry('catalog').definition, secretBinding: { kind: 'none' as const } }
  return {
    opener,
    definition,
    toolsChanged,
    resourcesChanged,
    transportClosed,
    reads: () => reads,
    closes: () => closes,
    load: (next: McpConnection['listTools']) => {
      load = next
    },
    lease: () => leaseMcpConnection(opener, 'revision', definition, new AbortController().signal),
  }
}

describe('publication-scoped MCP catalogs', () => {
  it('isolates each Host result and expires the result at the publication boundary', async () => {
    const f = catalogFixture(),
      one = await f.lease(),
      two = await f.lease()
    try {
      await withMcpCatalogReadScope(async () => {
        const result = await one.listTools({})
        if (!result[0]) throw new Error('missing first tool')
        result[0].inputSchema.changed = true
        expect((await two.listTools())[0]?.inputSchema).toEqual({ type: 'object' })
        expect(f.reads()).toBe(1)
      })()
      await withMcpCatalogReadScope(async () => {
        await two.listTools()
      })()
      expect(f.reads()).toBe(2)
      await one.close()
      expect(f.closes()).toBe(0)
      await two.listTools()
      expect(f.reads()).toBe(3)
    } finally {
      await Promise.all([one.close(), two.close()])
    }
    expect(f.closes()).toBe(1)
    expect(f.toolsChanged.size).toBe(0)
    expect(f.resourcesChanged.size).toBe(0)
  })

  it('invalidates once before all Host listeners handle the same change notification', async () => {
    const f = catalogFixture(),
      one = await f.lease(),
      two = await f.lease()
    const pending: Promise<unknown>[] = []
    one.onToolsChanged?.(() => {
      pending.push(one.listTools())
    })
    two.onToolsChanged?.(() => {
      pending.push(two.listTools())
    })
    try {
      await withMcpCatalogReadScope(async () => {
        await one.listTools()
        f.load(async () => [{ name: 'updated', description: 'updated', inputSchema: {} }])
        for (const listener of [...f.toolsChanged]) listener()
        await Promise.all(pending)
        expect(f.reads()).toBe(2)
        expect((await one.listTools())[0]?.name).toBe('updated')
        for (const listener of [...f.resourcesChanged]) listener()
        await two.listTools()
        expect(f.reads()).toBe(3)
      })()
    } finally {
      await Promise.all([one.close(), two.close()])
    }
  })

  it('does not publish a stale in-flight result into a newer notification epoch', async () => {
    const f = catalogFixture(),
      one = await f.lease(),
      two = await f.lease()
    let release!: (tools: Awaited<ReturnType<McpConnection['listTools']>>) => void
    f.load(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    try {
      await withMcpCatalogReadScope(async () => {
        const old = one.listTools()
        await vi.waitFor(() => expect(release).toBeTypeOf('function'))
        for (const listener of [...f.toolsChanged]) listener()
        f.load(async () => [{ name: 'new', description: 'new', inputSchema: {} }])
        expect((await two.listTools())[0]?.name).toBe('new')
        release([{ name: 'old', description: 'old', inputSchema: {} }])
        expect((await old)[0]?.name).toBe('old')
        expect((await one.listTools())[0]?.name).toBe('new')
        expect(f.reads()).toBe(2)
      })()
    } finally {
      release?.([])
      await Promise.all([one.close(), two.close()])
    }
  })

  it('retries failed reads and does not reuse a disconnected connection catalog', async () => {
    const f = catalogFixture(),
      one = await f.lease()
    try {
      await withMcpCatalogReadScope(async () => {
        f.load(async () => {
          throw new Error('network failed')
        })
        await expect(one.listTools()).rejects.toThrow('network failed')
        f.load(async () => [])
        expect(await one.listTools()).toEqual([])
        expect(f.reads()).toBe(2)
        for (const listener of [...f.transportClosed]) listener()
        f.load(async () => {
          throw new Error('closed transport')
        })
        await expect(one.listTools()).rejects.toThrow('closed transport')
      })()
    } finally {
      await one.close()
    }
  })

  it('does not cache a failed catalog validation or retain a failed publication scope', async () => {
    const f = catalogFixture(),
      one = await f.lease()
    try {
      await expect(
        withMcpCatalogReadScope(async () => {
          f.load(async () => null as never)
          await expect(one.listTools()).rejects.toThrow('tool catalog is not an array')
          f.load(async () => [])
          expect(await one.listTools()).toEqual([])
          throw new Error('publication failed')
        })(),
      ).rejects.toThrow('publication failed')
      f.load(async () => [{ name: 'fresh', description: 'fresh', inputSchema: {} }])
      expect((await one.listTools())[0]?.name).toBe('fresh')
      expect(f.reads()).toBe(3)
    } finally {
      await one.close()
    }
  })

  it('never shares catalogs between different revisions or opener boundaries', async () => {
    const f = catalogFixture(),
      other = catalogFixture(),
      one = await f.lease()
    const two = await leaseMcpConnection(
      f.opener,
      'other-revision',
      f.definition,
      new AbortController().signal,
    )
    const third = await other.lease()
    try {
      await withMcpCatalogReadScope(async () => {
        await one.listTools()
        await two.listTools()
        await third.listTools()
        expect(f.reads()).toBe(2)
        expect(other.reads()).toBe(1)
      })()
    } finally {
      await Promise.all([one.close(), two.close(), third.close()])
    }
  })

  it('keeps explicit deadlines and cancellation independent from the default catalog', async () => {
    const f = catalogFixture(),
      one = await f.lease(),
      controller = new AbortController()
    try {
      await withMcpCatalogReadScope(async () => {
        await one.listTools()
        f.load(async (options) => {
          expect(options?.timeoutMs).toBe(5)
          return []
        })
        expect(await one.listTools({ timeoutMs: 5 })).toEqual([])
        f.load(
          (options) =>
            new Promise((_, reject) => {
              options?.signal?.addEventListener(
                'abort',
                () => reject(new DOMException('aborted', 'AbortError')),
                { once: true },
              )
            }),
        )
        const cancelled = one.listTools({ signal: controller.signal })
        controller.abort()
        await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
        expect((await one.listTools())[0]?.name).toBe('first')
        expect(f.reads()).toBe(3)
      })()
    } finally {
      await one.close()
    }
  })

  it('does not retain cached authority in tasks that outlive their apply scope', async () => {
    const f = catalogFixture(),
      one = await f.lease()
    let resume!: () => void
    const gate = new Promise<void>((resolve) => {
      resume = resolve
    })
    let late!: Promise<unknown>
    try {
      await withMcpCatalogReadScope(async () => {
        await one.listTools()
        late = (async () => {
          await gate
          return one.listTools()
        })()
      })()
      f.load(async () => [{ name: 'after', description: 'after', inputSchema: {} }])
      resume()
      expect(await late).toMatchObject([{ name: 'after' }])
      expect(f.reads()).toBe(2)
    } finally {
      resume()
      await one.close()
    }
  })
})

it('refuses a lease and cleans up when internal catalog listener setup fails', async () => {
  let stopped = 0
  let closed = 0
  const definition = {
    ...stdioEntry('listener-failure').definition,
    secretBinding: { kind: 'none' as const },
  }
  const opener = {
    connect: async () => ({
      id: 'listener-failure',
      listTools: async () => [],
      callTool: async () => ({ content: [] }),
      close: async () => {
        closed++
        throw new Error('close failed')
      },
      onToolsChanged: () => () => {
        stopped++
      },
      onResourcesChanged: () => {
        throw new Error('listener failed')
      },
    }),
  }
  await expect(
    leaseMcpConnection(opener, 'revision', definition, new AbortController().signal),
  ).rejects.toThrow('listener failed')
  expect(stopped).toBe(1)
  expect(closed).toBe(1)
})
