import {
  SqliteToolIndex,
  type ToolIndex,
  type ToolIndexHit,
  type ToolIndexRow,
} from '../../../src/mcp/index-table.js'
import type { TableHandle } from '../../../src/seam-init.js'

/**
 * Host-private handle over the shared cross-server tool index (stage 2b, D110′). Created once at
 * Host assembly and handed to `agnes/mcp-search` and every MCP server row through
 * `buildEcosystemContext`, so `tool_search`/`tool_describe` stay a single cross-server surface even
 * though each server's tools are now registered by its own independent row.
 *
 * `upsert`/`remove`/`clear` are the cross-server duplicate-name guard the old single-extension loop
 * got for free by registering every server through one shared `claimedNames` set (register.ts's
 * `registerRemoteToolsStrict`); split across independent rows, nothing else would notice two
 * servers exposing the same tool name until the second one silently overwrote the first row's index
 * entry.
 *
 * `search`/`get` delegate straight to the wrapped index with no ownership check -- they exist so
 * `agnes/mcp-search` can depend on this one handle instead of also reaching for the raw `ToolIndex`,
 * matching the design's "one handle, handed to mcp-search and every MCP row alike". Read access
 * needs no per-server authority; only the write side does.
 */
export type McpCatalogHub = Readonly<{
  /**
   * Registers `serverId`'s current tool catalog. Rejects (and writes nothing) if any row's name is
   * already claimed by a different server; the caller's own registration must not proceed either --
   * see `registerRemoteToolsStrict`'s own `claimedNames` check for the equivalent single-extension
   * behavior this preserves per-server.
   */
  upsert(serverId: string, rows: readonly ToolIndexRow[], claimant?: object): void
  /**
   * Releases every name `serverId` currently owns. A `serverId` with no rows is a no-op.
   *
   * With `claimant`, releases only if `serverId`'s current claim was made by that same claimant.
   * An MCP server update replaces its row under the same row id (MCP-ROWS step 3: one row, not the
   * tree), so the outgoing and incoming row instances share a `serverId`; the outgoing instance's
   * disposal is asynchronous and can land after the incoming instance already upserted. Without the
   * claimant check that late `remove` would wipe the new instance's rows.
   */
  remove(serverId: string, claimant?: object): void
  /** Releases every claim and clears the underlying index. Called once at Host assembly, mirroring
   * the single-extension loop's own boot-time `deps.index.clear()`. */
  clear(): void
  /** Read-through to the wrapped index; see `ToolIndex.search`. */
  search(query: string, limit: number): ToolIndexHit[]
  /** Read-through to the wrapped index; see `ToolIndex.get`. */
  get(name: string): ToolIndexRow | undefined
}>

export class McpCatalogNameConflictError extends Error {
  constructor(
    readonly toolName: string,
    readonly claimedBy: string,
  ) {
    super(`MCP tool name already claimed by another server: ${toolName} (owned by ${claimedBy})`)
    this.name = 'McpCatalogNameConflictError'
  }
}

export function createMcpCatalogHub(index: ToolIndex): McpCatalogHub {
  /** Tool name -> the one serverId that currently owns it. */
  const owners = new Map<string, string>()
  /** serverId -> whoever made its latest upsert (only when the caller passed a claimant). */
  const claimants = new Map<string, object>()

  return Object.freeze({
    upsert(serverId, rows, claimant) {
      const conflict = rows.find((row) => {
        const owner = owners.get(row.name)
        return owner !== undefined && owner !== serverId
      })
      if (conflict) throw new McpCatalogNameConflictError(conflict.name, owners.get(conflict.name) as string)
      // Replace this server's prior claim set atomically: a name it owned before but no longer
      // contributes (a tool the server removed) must leave both the index and `owners`, not linger
      // as a stale claim that blocks every other server from ever using that name again.
      const stale = [...owners].filter(([, owner]) => owner === serverId).map(([name]) => name)
      const keep = new Set(rows.map((row) => row.name))
      const toRemove = stale.filter((name) => !keep.has(name))
      if (toRemove.length) {
        index.delete(toRemove)
        for (const name of toRemove) owners.delete(name)
      }
      index.upsert([...rows])
      for (const row of rows) owners.set(row.name, serverId)
      if (claimant) claimants.set(serverId, claimant)
      else claimants.delete(serverId)
    },
    remove(serverId, claimant) {
      if (claimant && claimants.has(serverId) && claimants.get(serverId) !== claimant) return
      claimants.delete(serverId)
      const owned = [...owners].filter(([, owner]) => owner === serverId).map(([name]) => name)
      if (owned.length === 0) return
      index.delete(owned)
      for (const name of owned) owners.delete(name)
    },
    clear() {
      index.clear()
      owners.clear()
      claimants.clear()
    },
    search(query, limit) {
      return index.search(query, limit)
    },
    get(name) {
      return index.get(name)
    },
  })
}

/** Just what `mcpCatalogHubFor` reads from a `SeamInitContext`. */
export type McpCatalogHubContext = Readonly<{
  signal: AbortSignal
  adapters: Readonly<{ storage: Readonly<{ table(name: string): TableHandle }> }>
}>

/** One hub per Host, keyed by that Host's abort signal. */
const hubsByHost = new WeakMap<AbortSignal, McpCatalogHub>()

/**
 * The one `McpCatalogHub` for the Host a context came from (stage 2b, D110'): created -- and its
 * index cleared -- on the first call in that Host, the same instance on every later call, including
 * across extension reloads. This is how the design's "created once at Host assembly, handed to
 * agnes/mcp-search and every MCP row" holds without Host core importing @agnes/base, which
 * host/test/boundary.test.ts forbids: Host only passes each consumer its `SeamInitContext` (bundled
 * factories and dynamic rows alike, see host's `DynamicExtension`), and every consumer asks here.
 *
 * Keyed by `ctx.signal` because Host creates exactly one AbortController per `assemble()` and hands
 * its signal to every context it builds, reloads included -- stable within a Host, distinct across
 * Hosts. A module-level singleton would instead be shared by every Host in the process (several
 * test hosts in one worker would see each other's catalogs). The WeakMap entry goes away with the
 * Host.
 *
 * Invariants a caller must keep:
 * - `ctx.adapters.storage` is owner-scoped, and the first call binds the hub to its caller's scope.
 *   Every consumer must therefore be owned by `@agnes/base` (mcp-search is; step 3's MCP rows must
 *   use `spec.package: '@agnes/base'`), or the hub would land in whichever package asked first.
 * - The backing table is the `tool_index` table agnes/mcp-client used to write, so no data migration
 *   is needed. The first call clears it, and nothing else writes that table any more.
 */
export function mcpCatalogHubFor(ctx: McpCatalogHubContext): McpCatalogHub {
  const existing = hubsByHost.get(ctx.signal)
  if (existing) return existing
  const hub = createMcpCatalogHub(new SqliteToolIndex(ctx.adapters.storage.table('tool_index')))
  // The index table outlives the process; a killed Host's rows are stale. Cleared once per Host.
  hub.clear()
  hubsByHost.set(ctx.signal, hub)
  return hub
}
