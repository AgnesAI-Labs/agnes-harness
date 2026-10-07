import { MCP_COMPAT_PREFIX, mcpLegacyToolName, mcpPublicToolName } from '@agnes/base'
import { MemTable } from '@agnes/base/testkit'
import type { McpServerDefinitionInput } from '@agnes/protocol'
import * as workerResources from '@agnes/resource-control-worker'
import { describe, expect, it, vi } from 'vitest'
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
    // Distinct servers get distinct ids.
    expect(rows[0]?.spec.id).not.toBe(rows[1]?.spec.id)
  })

  it('declares exactly what its one server uses: its own tool prefix, the mcp resource kind, and the artifact store for spilled output', () => {
    const { rows } = mcpServerRowsFromDefinitions([stdioEntry('gh'), stdioEntry('my.server-2')], fakeOpener)
    // The row grant is the compatibility prefix. Stable names and legacy aliases both start with
    // it. The registrar still emits only this server's own names.
    expect(rows.map((row) => row.manifest.capabilities)).toEqual([
      { tools: { prefix: MCP_COMPAT_PREFIX }, resources: ['mcp'], artifacts: true },
      { tools: { prefix: MCP_COMPAT_PREFIX }, resources: ['mcp'], artifacts: true },
    ])
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
    const fakeCtx = {
      signal: new AbortController().signal,
      adapters: { storage: { table: () => table } },
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
    const factory = await cold.factory({
      signal: new AbortController().signal,
      adapters: { storage: { table: () => table } },
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
    expect([...tools]).toEqual([mcpPublicToolName('pinned', 'ping'), mcpLegacyToolName('pinned', 'ping')])
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
