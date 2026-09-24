import type { ConnectionStatusEvent, McpServerOpener } from '@agnes/base'
import type { Host } from '@agnes/host'
import {
  type McpStatus,
  type McpTool,
  type McpToolCatalogPage,
  validateResourceControlData,
} from '@agnes/protocol'
import {
  type McpServerRowsResult,
  type McpServerSnapshotEntry,
  mcpServerRowsFromDefinitions,
} from './mcp-server-rows.js'

/** The part of Host this runtime drives. */
export type McpRowHost = Readonly<{ extensionRows: Host['extensionRows'] }>

/** One server's live catalog, kept for `tools()` pagination independent of the status frame the
 *  daemon already has - the same content, read back on demand instead of streamed. */
type Catalog = Readonly<{
  revision: string
  catalogRevision: string
  tools: readonly Readonly<{ name: string; description: string; inputSchema: Record<string, unknown> }>[]
}>

const observedAt = (): string => new Date().toISOString()

/**
 * Turns one server's live `ConnectionStatusEvent` into the full `McpStatus` the daemon's journal
 * expects, filling in what a single event does not itself carry: which definition revision this row
 * is running, and a timestamp. `revision` is this row's own mount identity input, not a live read -
 * a row survives unchanged across `apply()` calls exactly because its revision did not change, so
 * whichever revision is current when the event fires is the one this status is about.
 */
function toMcpStatus(serverId: string, revision: string, event: ConnectionStatusEvent): McpStatus {
  if (event.state === 'ready')
    return {
      serverId,
      connectionState: 'ready',
      observedRevision: revision,
      catalogRevision: event.catalogRevision,
      toolCount: event.toolCount,
      observedAt: observedAt(),
    }
  if (event.state === 'unavailable') {
    const code =
      event.reason === 'exhausted'
        ? 'MCP_RECONNECT_EXHAUSTED'
        : event.reason === 'lost'
          ? 'MCP_CONNECTION_LOST'
          : 'MCP_CONNECT_FAILED'
    return {
      serverId,
      connectionState: 'unavailable',
      observedRevision: null,
      catalogRevision: null,
      toolCount: 0,
      observedAt: observedAt(),
      lastSafeError: {
        code,
        // SafeError.message has a 256-char protocol limit; an arbitrary error's own message can be longer.
        message: String(event.error).slice(0, 256),
      },
    }
  }
  return {
    serverId,
    connectionState: 'connecting',
    observedRevision: null,
    catalogRevision: null,
    toolCount: 0,
    observedAt: observedAt(),
  }
}

/** A skipped entry never becomes a row, so no connection status event will ever describe it: this is
 *  its only status, synthesized once per `apply()` straight from `mcpServerRowsFromDefinitions`'s
 *  reason (design §3.3 - "按快照不挂行 → 立即...返回 disabled 或 unavailable"). */
function statusForSkip(serverId: string, reason: string): McpStatus {
  const base = {
    serverId,
    observedRevision: null,
    catalogRevision: null,
    toolCount: 0,
    observedAt: observedAt(),
  }
  if (reason === 'disabled') return { ...base, connectionState: 'disabled' }
  if (reason.startsWith('trust is '))
    return {
      ...base,
      connectionState: 'unavailable',
      lastSafeError: { code: 'MCP_UNTRUSTED_REVISION', message: reason },
    }
  if (reason.startsWith('oauth secretBinding'))
    return {
      ...base,
      connectionState: 'unavailable',
      lastSafeError: { code: 'MCP_OAUTH_UNSUPPORTED', message: 'sessions do not connect OAuth servers' },
    }
  return {
    ...base,
    connectionState: 'unavailable',
    lastSafeError: { code: 'MCP_DEFINITION_INVALID', message: reason },
  }
}

export type McpRowApplyResult = Readonly<{
  /** The `ext:` row ids now on the tree for these entries, one per server. */
  rowIds: readonly string[]
  skipped: McpServerRowsResult['skipped']
  /** Every server this apply() was given, with its settled status: the observed outcome for a
   *  (re)started row once its first attempt's result landed or the cap elapsed (§3.8, D120), an
   *  unchanged row's carried-over status, or a skipped entry's synthesized one. This is what
   *  `resourceMcpApply` returns to the daemon synchronously - no wait for an async status frame. */
  statuses: ReadonlyMap<string, McpStatus>
}>

/** Keeps the tree's MCP rows equal to one resource snapshot's MCP entries. */
export type McpRowRuntime = Readonly<{
  apply(entries: readonly McpServerSnapshotEntry[]): Promise<McpRowApplyResult>
  /** This server's last-known status, or `undefined` if it has never been part of any applied
   *  snapshot. Read after an out-of-band status frame, or by a caller that only has a serverId. */
  status(serverId: string): McpStatus | undefined
  /** A page of this server's live tool catalog, or `undefined` if it has no row, no successful sync
   *  yet, or `expectedRevision` no longer matches its current one (the daemon's own guard against
   *  serving a page from a revision the journal has already moved past). */
  tools(serverId: string, expectedRevision: string, cursor?: string): McpToolCatalogPage | undefined
  /** Forces this server's row to remount and reconnect on the *next* `apply()`, even when its
   *  definition revision is unchanged (design §3.3 - the epoch a `resourceMcpReconnect` command
   *  needs, since `superviseConnection`'s own backoff has no external "reconnect now" once it is
   *  past its first attempt, and gives up for good after `maxAttempts`). A no-op until the next
   *  apply(); has no effect on a server apply() has never seen. */
  reconnect(serverId: string): void
}>

/**
 * The shared session worker's MCP supply (stage 2b step 3, D107'): one Host `ext:` row per server,
 * derived from the resource snapshot the worker already reads. Boot and every `resource.stale`
 * reload call the same `apply`, with the snapshot's full entry list.
 *
 * Each call derives every row afresh and hands Host the complete set: the non-MCP rows as they are,
 * plus these. Host reuses a row whose identity did not change and swaps only a row whose did -- an
 * edited definition changes its `revision`, hence its row identity -- so one server's edit remounts
 * that server's row alone, a removed server's row unmounts, and the rest keep their connections.
 * Rows are prepared without `config` on purpose: see `mcpServerRowsFromDefinitions`.
 *
 * `apply` resolves once the rows it (re)mounted finished their first connection attempt, or after
 * `firstAttemptTimeoutMs`: the caller runs it at a turn boundary, so a server enabled or edited before
 * a turn is usable in that turn, as it was when the resource manager connected everything up front
 * (design §3.8, D120). Host's own apply never waits on a connection (D118).
 *
 * Which rows are "ours" is tracked here rather than matched by id prefix: `agnes/mcp-*` also names
 * other builtin extensions. Only a successful apply replaces that set; a rejected apply leaves Host on
 * its previous rows (Host restores them itself) and this runtime on its previous set, so the caller's
 * retry starts from the same place. Callers serialize `apply` (boot runs before any reload can start,
 * and reloads are single-flighted by the worker's resource slot).
 */
export function createMcpRowRuntime(
  deps: Readonly<{
    host: McpRowHost
    opener: McpServerOpener
    /** Update the Windows worker's private executable policy before any newly enabled row starts. */
    beforeApply?(entries: readonly McpServerSnapshotEntry[]): Promise<void>
    /** Upper bound on waiting for started rows' first connection attempts (design §3.8, D120). */
    firstAttemptTimeoutMs?: number
    /** Every server's live `McpStatus` as it changes, including a skip's synthesized one (design
     *  §3.2) - the daemon's only source of MCP status once management-plane connections are gone.
     *  `apply()`'s own return also carries the settled-by-then value; this is for everything after. */
    onStatus?(serverId: string, status: McpStatus): void
  }>,
): McpRowRuntime {
  let owned: ReadonlySet<string> = new Set()
  // The daemon-authored revision each present server is currently mounted at - not necessarily what
  // the row was actually identity-mounted under, see `epochs` below - so a status event (which does
  // not itself carry one) can still be turned into a complete McpStatus. Rebuilt on every apply().
  const revisions = new Map<string, string>()
  // Bumped by reconnect(); folded into the identity mcpServerRowsFromDefinitions mounts a server's
  // row under, so a forced reconnect remounts (and thus reconnects) even when the daemon's own
  // revision for this server has not changed. Never reported as this server's `observedRevision` -
  // `revisions` above keeps the real one for that.
  const epochs = new Map<string, number>()
  // Every present server's last-known status, kept across apply() calls: an unchanged row fires no
  // fresh event, so its status here is exactly the one still-accurate answer for it.
  const statuses = new Map<string, McpStatus>()
  const catalogs = new Map<string, Catalog>()
  const cap = deps.firstAttemptTimeoutMs ?? FIRST_ATTEMPT_TIMEOUT_MS
  return Object.freeze({
    async apply(entries: readonly McpServerSnapshotEntry[]): Promise<McpRowApplyResult> {
      await deps.beforeApply?.(entries)
      const present = new Set(entries.map((entry) => entry.definition.serverId))
      for (const serverId of [...revisions.keys()])
        if (!present.has(serverId)) {
          revisions.delete(serverId)
          statuses.delete(serverId)
          catalogs.delete(serverId)
          epochs.delete(serverId)
        }
      for (const entry of entries) revisions.set(entry.definition.serverId, entry.revision)
      // A row's extension starts while Host applies it, so by the time Host's apply resolves this
      // holds exactly the rows Host (re)mounted in this call -- never an unchanged row.
      const started: Promise<unknown>[] = []
      const mounting = entries.map((entry) => {
        const epoch = epochs.get(entry.definition.serverId)
        return epoch === undefined ? entry : { ...entry, revision: `${entry.revision}#${epoch}` }
      })
      const { rows, skipped } = mcpServerRowsFromDefinitions(mounting, deps.opener, {
        onFirstAttempt: (_serverId, ready) => started.push(ready),
        onStatus: (serverId, event) => {
          const revision = revisions.get(serverId)
          if (revision === undefined) return
          const status = toMcpStatus(serverId, revision, event)
          statuses.set(serverId, status)
          if (event.state === 'ready')
            catalogs.set(serverId, { revision, catalogRevision: event.catalogRevision, tools: event.tools })
          deps.onStatus?.(serverId, status)
        },
      })
      const others = deps.host.extensionRows.current().filter((row) => !owned.has(row.id))
      const prepared = rows.map((dynamic) =>
        deps.host.extensionRows.prepare({ extensionId: dynamic.spec.id, dynamic }),
      )
      await deps.host.extensionRows.apply([...others, ...prepared])
      const rowIds = Object.freeze(prepared.map((row) => row.id))
      owned = new Set(rowIds)
      await settledWithin(started, cap)
      for (const { serverId, reason } of skipped) {
        const status = statusForSkip(serverId, reason)
        statuses.set(serverId, status)
        catalogs.delete(serverId)
        deps.onStatus?.(serverId, status)
      }
      const settled = new Map<string, McpStatus>()
      for (const serverId of present) {
        const status = statuses.get(serverId)
        if (status) settled.set(serverId, status)
      }
      return Object.freeze({ rowIds, skipped, statuses: settled })
    },
    status: (serverId) => statuses.get(serverId),
    tools(serverId, expectedRevision, cursor) {
      const catalog = catalogs.get(serverId)
      if (!catalog || catalog.revision !== expectedRevision) return undefined
      return catalogPage(serverId, catalog.catalogRevision, catalog.tools, cursor)
    },
    reconnect(serverId) {
      epochs.set(serverId, (epochs.get(serverId) ?? 0) + 1)
    },
  })
}

/** The old resource manager's worst case before a turn could start: 10s connect + 10s catalog. */
const FIRST_ATTEMPT_TIMEOUT_MS = 20_000
/** Matches the protocol schema's `McpToolCatalogPage.items` cap. */
const PAGE_SIZE = 100

/** Waits until every attempt settled or `ms` elapsed, whichever comes first. Never rejects. */
async function settledWithin(attempts: readonly Promise<unknown>[], ms: number): Promise<void> {
  if (!attempts.length) return
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    Promise.allSettled(attempts),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms)
    }),
  ])
  clearTimeout(timer)
}

/** A decimal-offset cursor over an already-sorted tool list; same semantics as the retired
 *  management-plane manager's own (`resource-control-runtime/src/mcp.ts`'s `catalogPage`), kept here
 *  independently since row-based and manager-based catalogs are now different data. */
function catalogPage(
  serverId: string,
  catalogRevision: string,
  tools: Catalog['tools'],
  cursor?: string,
): McpToolCatalogPage {
  const offset = cursor === undefined ? 0 : /^(?:0|[1-9][0-9]*)$/.test(cursor) ? Number(cursor) : -1
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > tools.length)
    throw new TypeError('invalid MCP tool cursor')
  const slice = tools.slice(offset, offset + PAGE_SIZE)
  // A remote server's raw inputSchema was never re-checked against the protocol's own narrower
  // McpInputSchema shape (only against register.ts's own tool-parameter rules); this pagination
  // response is protocol-typed, so a tool whose schema does not fit is skipped here rather than
  // corrupting or failing the whole page - the model-facing tool call path is unaffected either way.
  // The cursor still advances by the raw slice, not the filtered count, so a dropped tool is skipped
  // exactly once rather than making the next page re-attempt (and re-drop) it.
  const items = slice.filter((tool): tool is McpTool => validateResourceControlData('McpTool', tool).ok)
  return Object.freeze({
    serverId,
    catalogRevision,
    items: [...items],
    ...(offset + slice.length < tools.length ? { nextCursor: String(offset + slice.length) } : {}),
  })
}
