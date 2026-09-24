import { mcpLocalToolPrefix } from '@agnes/base'
import { MemTable } from '@agnes/base/testkit'
import type { McpServerDefinitionInput } from '@agnes/protocol'
import { describe, expect, it, vi } from 'vitest'
import { type McpServerSnapshotEntry, mcpServerRowsFromDefinitions } from '../src/mcp-server-rows.js'

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

  it('declares exactly what its one server registers: its own tool prefix and the mcp resource kind', () => {
    const { rows } = mcpServerRowsFromDefinitions([stdioEntry('gh'), stdioEntry('my.server-2')], fakeOpener)
    // The prefix is register.ts's tool naming for that server id -- both call the same
    // mcpLocalToolPrefix() (design 2026-09-23-mcp-tool-name-collision-design.md §0.4), so the ext
    // host lets this row register its own server's tools and nothing else.
    expect(rows.map((row) => row.manifest.capabilities)).toEqual([
      { tools: { prefix: mcpLocalToolPrefix('gh') }, resources: ['mcp'] },
      { tools: { prefix: mcpLocalToolPrefix('my.server-2') }, resources: ['mcp'] },
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
