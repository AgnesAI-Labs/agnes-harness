import { describe, expect, it } from 'vitest'
import { SqliteToolIndex } from '../../../src/mcp/index-table.js'
import { MemFts } from '../../../testkit/mem-fts.js'
import { MemTable } from '../../../testkit/mem-table.js'
import { createMcpCatalogHub, McpCatalogNameConflictError, mcpCatalogHubFor } from '../src/catalog-hub.js'

function row(name: string) {
  return { name, description: name, schema: '{}' }
}

describe('createMcpCatalogHub', () => {
  it('upserts one server catalog into the shared index', () => {
    const index = new MemFts()
    const hub = createMcpCatalogHub(index)
    hub.upsert('alpha', [row('a'), row('b')])
    expect(index.get('a')).toBeDefined()
    expect(index.get('b')).toBeDefined()
  })

  it('rejects a second server claiming an already-owned tool name and writes nothing for it', () => {
    const index = new MemFts()
    const hub = createMcpCatalogHub(index)
    hub.upsert('alpha', [row('shared')])
    expect(() => hub.upsert('beta', [row('shared')])).toThrow(McpCatalogNameConflictError)
    // alpha's original row is untouched by the rejected attempt.
    expect(index.get('shared')).toEqual(row('shared'))
  })

  it('the same server re-claiming its own name is not a conflict', () => {
    const index = new MemFts()
    const hub = createMcpCatalogHub(index)
    hub.upsert('alpha', [row('a')])
    expect(() => hub.upsert('alpha', [row('a')])).not.toThrow()
  })

  it('remove releases exactly one server and its tool names become claimable again', () => {
    const index = new MemFts()
    const hub = createMcpCatalogHub(index)
    hub.upsert('alpha', [row('a')])
    hub.upsert('beta', [row('b')])
    hub.remove('alpha')
    expect(index.get('a')).toBeUndefined()
    expect(index.get('b')).toBeDefined()
    // 'a' is claimable again now that alpha released it.
    expect(() => hub.upsert('beta', [row('a')])).not.toThrow()
  })

  it('remove on a server with no rows is a no-op', () => {
    const index = new MemFts()
    const hub = createMcpCatalogHub(index)
    hub.upsert('alpha', [row('a')])
    expect(() => hub.remove('never-registered')).not.toThrow()
    expect(index.get('a')).toBeDefined()
  })

  it('a re-upsert that drops a previously-owned name releases that claim, not just adds the new ones', () => {
    const index = new MemFts()
    const hub = createMcpCatalogHub(index)
    hub.upsert('alpha', [row('a'), row('b')])
    // alpha no longer contributes 'b'.
    hub.upsert('alpha', [row('a')])
    expect(index.get('b')).toBeUndefined()
    // 'b' is claimable by another server now.
    expect(() => hub.upsert('beta', [row('b')])).not.toThrow()
  })

  it('clear releases every claim and empties the index', () => {
    const index = new MemFts()
    const hub = createMcpCatalogHub(index)
    hub.upsert('alpha', [row('a')])
    hub.clear()
    expect(index.get('a')).toBeUndefined()
    // 'a' is claimable again after clear.
    expect(() => hub.upsert('beta', [row('a')])).not.toThrow()
  })

  it('get reads through to the wrapped index, with no ownership check', () => {
    const index = new MemFts()
    const hub = createMcpCatalogHub(index)
    hub.upsert('alpha', [row('a')])
    expect(hub.get('a')).toEqual(row('a'))
    expect(hub.get('missing')).toBeUndefined()
  })

  it('search reads through to the wrapped index', () => {
    const index = new MemFts()
    const hub = createMcpCatalogHub(index)
    hub.upsert('alpha', [row('alpha_ping'), row('beta_pong')])
    expect(hub.search('ping', 5).map((hit) => hit.name)).toEqual(['alpha_ping'])
  })
})

describe('createMcpCatalogHub claimants (MCP-ROWS step 3: an update replaces a row under the same server id)', () => {
  it("a late remove from the outgoing row instance does not wipe the incoming instance's claim", () => {
    const index = new MemFts()
    const hub = createMcpCatalogHub(index)
    const outgoing = {}
    const incoming = {}
    hub.upsert('gh', [row('mcp_gh_old')], outgoing)
    // The incoming instance syncs before the outgoing one's asynchronous disposal finishes.
    hub.upsert('gh', [row('mcp_gh_new')], incoming)
    hub.remove('gh', outgoing)
    expect(index.get('mcp_gh_new')).toEqual(row('mcp_gh_new'))
    // The claim's own holder can still release it.
    hub.remove('gh', incoming)
    expect(index.get('mcp_gh_new')).toBeUndefined()
  })

  it('a remove without a claimant still releases unconditionally', () => {
    const index = new MemFts()
    const hub = createMcpCatalogHub(index)
    hub.upsert('gh', [row('mcp_gh_a')], {})
    hub.remove('gh')
    expect(index.get('mcp_gh_a')).toBeUndefined()
  })
})

/** A context like the one Host builds: one signal per Host, storage scoped to one table store. */
function hostContext(table = new MemTable('tool_index')) {
  const controller = new AbortController()
  return {
    table,
    ctx: { signal: controller.signal, adapters: { storage: { table: () => table } } },
  }
}

describe('mcpCatalogHubFor', () => {
  it('returns the same hub for every context of one Host, including a freshly built one', () => {
    const { ctx } = hostContext()
    const first = mcpCatalogHubFor(ctx)
    // Host builds a new context object per extension load; only the signal is shared.
    const rebuilt = { signal: ctx.signal, adapters: { storage: { table: ctx.adapters.storage.table } } }
    expect(mcpCatalogHubFor(rebuilt)).toBe(first)
  })

  it('gives each Host its own hub, so two hosts in one process never share a catalog', () => {
    const a = mcpCatalogHubFor(hostContext().ctx)
    const b = mcpCatalogHubFor(hostContext().ctx)
    expect(a).not.toBe(b)
    a.upsert('alpha', [row('mcp_alpha_ping')])
    expect(b.get('mcp_alpha_ping')).toBeUndefined()
  })

  it('clears stale rows once, on the first call in a Host, and never again', () => {
    const table = new MemTable('tool_index')
    // A row a previous, killed Host left in the durable table.
    new SqliteToolIndex(table).upsert([row('mcp_stale_tool')])
    const { ctx } = hostContext(table)

    const hub = mcpCatalogHubFor(ctx)
    expect(hub.get('mcp_stale_tool')).toBeUndefined()

    hub.upsert('alpha', [row('mcp_alpha_ping')])
    // A later call in the same Host (another row, a reload) must not wipe live claims.
    expect(mcpCatalogHubFor(ctx).get('mcp_alpha_ping')).toEqual(row('mcp_alpha_ping'))
  })
})
