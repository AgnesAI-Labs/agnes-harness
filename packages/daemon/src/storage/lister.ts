// Storage-backed session lister and approval-ticket index. Both read/write through `TableHandle`,
// the same seam `lease/lease.ts` uses for `writer_claims` - neither talks to SQLite directly, and
// neither imports anything from `@agnes/core`. `StorageLister` is the future daemon (multi-process)
// form's `SessionLister`; the in-process local form keeps using `RegistryLister`
// (`local/sessions.ts`) exactly as before, unchanged - this file does not replace it, it is the
// alternate implementation for a process that has no live `SessionRegistry` to scan and has to read
// the ledger back off disk instead.
import {
  type EventEnvelope,
  readSessionTitle,
  SESSION_TITLE_EVENT,
  SessionTitleRecord,
  validateAgainst,
} from '@agnes/protocol'
import type { SessionLister, SessionMetaRow } from '../local/ports.js'
import { ensure, type TableHandle } from './table.js'

type EventGroupRow = { session_key: string; first_ts: number; last_seq: number }
type StartRow = { data: string }
type ClaimRow = { generation: number }

/**
 * `SessionLister` over the `events` table (spec §13 columns: `session_key, seq, ts, id, type, lane,
 * actor, origin, trust, register, ignorable, surface_op, source_event_seqs, data`) plus
 * `writer_claims` for the live generation.
 *
 * One row per distinct `session_key`: `MIN(ts)` for `createdAt`, `MAX(seq)` for `lastSeq`. `preset`
 * is read off the session's own `session/start` row, found by `type` rather than assumed to be the
 * lowest `seq` a caller already fetched - a dedicated `ORDER BY seq LIMIT 1` query is what actually
 * locates it. Nothing here reads `op.state` or any of core's six registers: `preset` lives in the
 * `session/start` event's own `data`, the same field `RegistryLister` reads off the live
 * `SessionImpl.preset` instead of the (non-existent) `latest('session/start')` register lookup its
 * own file's history warns against repeating.
 *
 * Pagination is a keyset cursor on `session_key` (sessions page in key order, not creation order):
 * `WHERE session_key > cursor` reads strictly after the last row already returned, so unlike an
 * offset scheme a page boundary landing mid-tie on `session_key` cannot skip or repeat a row.
 */
export class StorageLister implements SessionLister {
  constructor(
    private readonly events: TableHandle,
    private readonly claims: TableHandle,
    private readonly workspaces?: Pick<SessionWorkspacePort, 'keys' | 'get'> &
      Partial<Pick<SessionWorkspacePort, 'metadata'>>,
  ) {}

  async list(q: {
    q?: string
    cwd?: string
    cursor?: string
    limit?: number
    sessionIds?: readonly string[]
  }): Promise<{ items: SessionMetaRow[]; cursor?: string }> {
    const limit = Math.min(500, Math.max(1, q.limit ?? 50))
    if (q.sessionIds) {
      const keys = [...new Set(q.sessionIds)]
        .filter((key) => key > (q.cursor ?? ''))
        .filter((key) => !q.q || key.includes(q.q))
        .filter((key) => q.cwd === undefined || this.workspaces?.get(key) === q.cwd)
        .sort()
      const rows: EventGroupRow[] = []
      for (const key of keys) {
        const row = this.events.get<EventGroupRow>(
          `SELECT session_key, MIN(ts) AS first_ts, MAX(seq) AS last_seq FROM events
           WHERE session_key = ? GROUP BY session_key`,
          [key],
        )
        if (row) rows.push(row)
        if (rows.length > limit) break
      }
      const page = rows.slice(0, limit)
      const items = page.map((row) => this.toMetaRow(row))
      const cursor = rows.length > limit ? page.at(-1)?.session_key : undefined
      return { items, ...(cursor !== undefined ? { cursor } : {}) }
    }
    if (q.cwd !== undefined) {
      const keys = (this.workspaces?.keys() ?? [])
        .filter((key) => key > (q.cursor ?? ''))
        .filter((key) => !q.q || key.includes(q.q))
        .filter((key) => this.workspaces?.get(key) === q.cwd)
        .sort()
      const rows: EventGroupRow[] = []
      for (const key of keys) {
        const row = this.events.get<EventGroupRow>(
          `SELECT session_key, MIN(ts) AS first_ts, MAX(seq) AS last_seq FROM events
           WHERE session_key = ? GROUP BY session_key`,
          [key],
        )
        if (row) rows.push(row)
        if (rows.length > limit) break
      }
      const page = rows.slice(0, limit)
      const items = page.map((row) => this.toMetaRow(row))
      const cursor = rows.length > limit ? page.at(-1)?.session_key : undefined
      return { items, ...(cursor !== undefined ? { cursor } : {}) }
    }
    // One extra row fetched (`limit + 1`): "is there a next page" is answered by what came back, not
    // by a second COUNT(*) query.
    const rows = this.events.all<EventGroupRow>(
      `SELECT session_key, MIN(ts) AS first_ts, MAX(seq) AS last_seq FROM events
       WHERE session_key > ? AND session_key LIKE ?
       GROUP BY session_key ORDER BY session_key LIMIT ?`,
      [q.cursor ?? '', `%${q.q ?? ''}%`, limit + 1],
    )
    const page = rows.slice(0, limit)
    const items = page.map((r) => this.toMetaRow(r))
    const cursor = rows.length > limit ? page[page.length - 1]?.session_key : undefined
    return { items, ...(cursor !== undefined ? { cursor } : {}) }
  }

  private toMetaRow(r: EventGroupRow): SessionMetaRow {
    const start = this.events.get<StartRow>(
      'SELECT data FROM events WHERE session_key = ? AND type = ? ORDER BY seq LIMIT 1',
      [r.session_key, 'session/start'],
    )
    const preset = start ? ((JSON.parse(start.data) as { preset?: string | null }).preset ?? null) : null
    const generation =
      this.claims.get<ClaimRow>('SELECT generation FROM writer_claims WHERE session_key = ?', [r.session_key])
        ?.generation ?? 0
    const cwd = this.workspaces?.get(r.session_key)
    const titleRow = this.events.get<{ data: string }>(
      'SELECT data FROM events WHERE session_key = ? AND type = ? AND origin = ? AND trust = ? AND lane = ? AND ignorable = 1 ORDER BY seq DESC LIMIT 1',
      [r.session_key, SESSION_TITLE_EVENT, 'system', 'trusted', new TextEncoder().encode('main')],
    )
    const titleData: unknown = titleRow ? JSON.parse(titleRow.data) : undefined
    const title =
      this.workspaces?.metadata?.(r.session_key)?.title ??
      (validateAgainst(SessionTitleRecord, titleData).ok &&
      (titleData as SessionTitleRecord).status === 'generated'
        ? (titleData as Extract<SessionTitleRecord, { status: 'generated' }>).title
        : undefined)
    return {
      sessionId: r.session_key,
      createdAt: new Date(r.first_ts).toISOString(),
      lastSeq: r.last_seq,
      generation,
      preset,
      ...(title ? { title } : {}),
      ...(cwd !== undefined ? { cwd } : {}),
    }
  }
}

/**
 * Shared shape for the ticket -> session index intended to back `_agnes/v1/approval.decide`: a
 * ticket carried in `approval/asked{ pending: { ticket } }` has no sessionId of its own, so deciding
 * it needs a way to look the owning session back up. The local handler currently searches its open
 * registry; wiring this port through the storage-backed daemon is what will make unopened sessions
 * addressable too. The shape matches the existing `CommandJournal`/`ClaimStore` ports.
 *
 * `gc` is not on the critical path of any request; it exists so an index entry for a ticket nobody
 * ever decided (the requester walked away) does not sit forever.
 */
export interface TicketPort {
  put(ticket: string, sessionKey: string, expiresAt: number, cwd?: string): void
  get(ticket: string): string | undefined
  /** Workspace needed to reopen the owning worker after a daemon restart. Older rows may not have
   * one; callers must refuse those rather than run a continued tool in the daemon data directory. */
  cwd(ticket: string): string | undefined
  gc(now: number): number
}

/** The SQL-backed `TicketPort`, for the daemon (multi-process) form: a ticket minted by whichever
 *  worker process ran the turn has to be resolvable from any connection's process, so it cannot live
 *  in one process's memory the way the local form's index can. */
export class TicketIndex implements TicketPort {
  constructor(private readonly t: TableHandle) {
    ensure(
      t,
      'CREATE TABLE IF NOT EXISTS approval_tickets (ticket TEXT PRIMARY KEY, session_key TEXT NOT NULL, expires_at INTEGER NOT NULL, cwd TEXT)',
    )
    ensure(t, 'CREATE TABLE IF NOT EXISTS approval_ticket_schema (version INTEGER PRIMARY KEY)')
    const version = this.t.get<{ version: number | null }>(
      'SELECT MAX(version) AS version FROM approval_ticket_schema',
    )?.version
    if ((version ?? 0) < 1)
      this.t.transaction(() => {
        // Task 22 shipped a three-column table before this component had a schema marker. A direct
        // column projection is allowed by Host's owner SQL fence (PRAGMA is intentionally not), and
        // runs only for that unversioned migration. Fresh four-column tables take the success path.
        try {
          this.t.get('SELECT cwd FROM approval_tickets LIMIT 1')
        } catch (error) {
          if (!/no such column: cwd/i.test(String((error as { message?: unknown }).message ?? error)))
            throw error
          this.t.exec('ALTER TABLE approval_tickets ADD COLUMN cwd TEXT')
        }
        this.t.exec('INSERT OR IGNORE INTO approval_ticket_schema (version) VALUES (1)')
      })
  }

  put(ticket: string, sessionKey: string, expiresAt: number, cwd?: string): void {
    this.t.exec(
      'INSERT OR REPLACE INTO approval_tickets (ticket, session_key, expires_at, cwd) VALUES (?, ?, ?, ?)',
      [ticket, sessionKey, expiresAt, cwd ?? null],
    )
  }

  get(ticket: string): string | undefined {
    return this.t.get<{ session_key: string }>('SELECT session_key FROM approval_tickets WHERE ticket = ?', [
      ticket,
    ])?.session_key
  }

  cwd(ticket: string): string | undefined {
    return (
      this.t.get<{ cwd: string | null }>('SELECT cwd FROM approval_tickets WHERE ticket = ?', [ticket])
        ?.cwd ?? undefined
    )
  }

  // Strictly less-than `now`: a ticket expiring at exactly `now` still holds for this instant, the
  // same boundary convention `MemoryClaims.once` already uses (`local/ports.ts`) - `>=`/`<=` at this
  // boundary is not a difference any caller can observe on its own, so it is exactly the kind of bug
  // this file's reverse-verification (see the test) is built to catch.
  gc(now: number): number {
    const n =
      this.t.get<{ n: number }>('SELECT COUNT(*) AS n FROM approval_tickets WHERE expires_at < ?', [now])
        ?.n ?? 0
    if (n) this.t.exec('DELETE FROM approval_tickets WHERE expires_at < ?', [now])
    return n
  }
}

/** The local form's default: in-process, dies with the process - the same tradeoff `MemoryJournal`
 *  and `MemoryClaims` (`local/ports.ts`) make for their own ports. `gc` is a no-op because an
 *  embedded endpoint has the same lifetime as this map; the persistent daemon uses `TicketIndex`. */
export class MemoryTickets implements TicketPort {
  private readonly m = new Map<string, { sessionKey: string; cwd?: string }>()
  put(ticket: string, sessionKey: string, _expiresAt: number, cwd?: string): void {
    this.m.set(ticket, { sessionKey, ...(cwd === undefined ? {} : { cwd }) })
  }
  get(ticket: string): string | undefined {
    return this.m.get(ticket)?.sessionKey
  }
  cwd(ticket: string): string | undefined {
    return this.m.get(ticket)?.cwd
  }
  gc(): number {
    return 0
  }
}

/** Stable ownership of a session key by one workspace. A persisted session may be reopened by a
 * scheduler or crash-recovery pass with no client present, so its cwd cannot be reconstructed from
 * the daemon process cwd (and must never be replaced with `/`). */
export interface SessionWorkspacePort {
  put(sessionKey: string, cwd: string): void
  get(sessionKey: string): string | undefined
  /** All durable session keys, in stable order, including sessions with no live worker. */
  keys(): string[]
  /** Fold observed ledger rows into the bounded listing projection. */
  observe(sessionKey: string, event: EventEnvelope, generation?: number): void
  metadata(sessionKey: string): SessionWorkspaceMeta | undefined
  /** Catch the projection up from its persisted sequence after a workspace row is first bound. */
  refresh(sessionKey: string, source: SessionProjectionSource, generation?: number): Promise<void>
}

export type SessionWorkspaceMeta = {
  title?: string
  /** `ts` of the latest `user/message`; absent until someone chats in the session. */
  lastActiveAt?: string
  createdAt: string
  lastSeq: number
  generation: number
  preset: string | null
  profileHash: string | null
}

/** The narrow worker view needed to fill a workspace row after a late index bind. */
export type SessionProjectionSource = {
  status(): Promise<{ lastSeq: number; preset: string | null }>
  scan(q: { fromSeq: number; toSeq: number; limit?: number }): Promise<unknown[]>
}

/** Adds one nullable projection column to an existing table by direct probe; PRAGMA is outside
 * Host's owner SQL allow-list. A concurrent opener adding it first is not an error. */
function ensureColumn(t: TableHandle, column: string, definition: string): void {
  const text = (error: unknown) => String((error as { message?: unknown }).message ?? error)
  try {
    t.get(`SELECT ${column} FROM session_workspaces LIMIT 1`)
  } catch (error) {
    if (!/no such column/i.test(text(error))) throw error
    try {
      t.exec(`ALTER TABLE session_workspaces ADD COLUMN ${column} ${definition}`)
    } catch (migrationError) {
      if (!/duplicate column name/i.test(text(migrationError))) throw migrationError
    }
  }
}

function checkWorkspace(sessionKey: string, cwd: string): void {
  if (!sessionKey || sessionKey.includes('\u0000')) throw new Error('invalid session workspace key')
  if (!cwd || cwd.includes('\u0000')) throw new Error(`invalid workspace for session ${sessionKey}`)
}

/** SQL-backed session -> cwd ownership in daemon's isolated package tables. `put` is intentionally
 * insert-only: silently remapping an existing session key would make later scheduled work execute
 * against a different tree than the session was created for. */
export class SessionWorkspaceIndex implements SessionWorkspacePort {
  constructor(private readonly t: TableHandle) {
    ensure(
      t,
      `CREATE TABLE IF NOT EXISTS session_workspaces (
        session_key TEXT PRIMARY KEY,
        cwd TEXT NOT NULL,
        created_at TEXT,
        last_seq INTEGER NOT NULL DEFAULT 0,
        generation INTEGER NOT NULL DEFAULT 0,
        preset TEXT,
        profile_hash TEXT
      )`,
    )
    ensureColumn(t, 'title', 'TEXT')
    ensureColumn(t, 'last_active_at', 'TEXT')
    // The workspace table shipped before the listing projection. Migrate by direct column probes;
    // PRAGMA is intentionally outside Host's owner SQL allow-list. Each ALTER is idempotent under
    // the one-time probe because an old table has all of these columns missing.
    try {
      t.get('SELECT created_at, last_seq, generation, preset, profile_hash FROM session_workspaces LIMIT 1')
    } catch (error) {
      if (!/no such column/i.test(String((error as { message?: unknown }).message ?? error))) throw error
      for (const column of [
        'created_at TEXT',
        'last_seq INTEGER NOT NULL DEFAULT 0',
        'generation INTEGER NOT NULL DEFAULT 0',
        'preset TEXT',
        'profile_hash TEXT',
      ]) {
        try {
          t.exec(`ALTER TABLE session_workspaces ADD COLUMN ${column}`)
        } catch (alterError) {
          if (
            !/duplicate column name/i.test(
              String((alterError as { message?: unknown }).message ?? alterError),
            )
          )
            throw alterError
        }
      }
    }
  }

  put(sessionKey: string, cwd: string): void {
    checkWorkspace(sessionKey, cwd)
    this.t.transaction(() => {
      const current = this.get(sessionKey)
      if (current !== undefined && current !== cwd)
        throw new Error(`session ${sessionKey} is already bound to workspace ${current}`)
      if (current === undefined)
        this.t.exec('INSERT INTO session_workspaces (session_key, cwd) VALUES (?, ?)', [sessionKey, cwd])
    })
  }

  get(sessionKey: string): string | undefined {
    return this.t.get<{ cwd: string }>('SELECT cwd FROM session_workspaces WHERE session_key = ?', [
      sessionKey,
    ])?.cwd
  }

  keys(): string[] {
    return this.t
      .all<{ session_key: string }>('SELECT session_key FROM session_workspaces ORDER BY session_key')
      .map((row) => row.session_key)
  }

  metadata(sessionKey: string): SessionWorkspaceMeta | undefined {
    const row = this.t.get<SessionWorkspaceMeta>(
      'SELECT created_at AS createdAt, last_seq AS lastSeq, generation, preset, profile_hash AS profileHash, title, last_active_at AS lastActiveAt FROM session_workspaces WHERE session_key = ?',
      [sessionKey],
    )
    if (!row) return undefined
    return {
      createdAt: row.createdAt ?? '',
      lastSeq: row.lastSeq ?? 0,
      generation: row.generation ?? 0,
      preset: row.preset ?? null,
      profileHash: row.profileHash ?? null,
      ...(row.title ? { title: row.title } : {}),
      ...(row.lastActiveAt ? { lastActiveAt: row.lastActiveAt } : {}),
    }
  }

  observe(sessionKey: string, event: EventEnvelope, generation = 0): void {
    const current = this.metadata(sessionKey)
    if (!current) return
    let createdAt = current.createdAt
    let preset = current.preset
    let profileHash = current.profileHash
    let title = current.title
    let lastActiveAt = current.lastActiveAt
    if (event.seq > current.lastSeq) {
      const generated = readSessionTitle(event)
      if (generated?.status === 'generated') title = generated.title
      if (event.type === 'session/start' && (event.data as { key?: string })?.key === sessionKey)
        title = undefined
      if (event.type === 'user/message') lastActiveAt = event.ts
    }
    const data = event.data as { preset?: unknown; resolvedProfileHash?: unknown; to?: unknown } | null
    if (event.type === 'session/start') {
      if (!createdAt) createdAt = event.ts
      preset = typeof data?.preset === 'string' ? data.preset : null
      profileHash = typeof data?.resolvedProfileHash === 'string' ? data.resolvedProfileHash : null
    } else if (event.type === 'x/core/preset-switch' && typeof data?.to === 'string') {
      preset = data.to
    }
    this.t.exec(
      `UPDATE session_workspaces
       SET created_at = ?, last_seq = CASE WHEN last_seq < ? THEN ? ELSE last_seq END,
           generation = CASE WHEN generation < ? THEN ? ELSE generation END,
           preset = ?, profile_hash = ?, title = ?, last_active_at = ?
       WHERE session_key = ?`,
      [
        createdAt || null,
        event.seq,
        event.seq,
        generation,
        generation,
        preset,
        profileHash,
        title ?? null,
        lastActiveAt ?? null,
        sessionKey,
      ],
    )
  }

  async refresh(sessionKey: string, source: SessionProjectionSource, generation = 0): Promise<void> {
    let current = this.metadata(sessionKey)
    if (!current) return
    const status = await source.status()
    let from = Math.max(1, current.lastSeq + 1)
    const target = Math.max(current.lastSeq, status.lastSeq)
    while (from <= target) {
      const pageFrom = from
      const rows = (await source.scan({
        fromSeq: from,
        toSeq: Math.min(target, from + 499),
        limit: 500,
      })) as EventEnvelope[]
      const bySeq = new Map<number, EventEnvelope>()
      for (const event of rows) {
        if (Number.isSafeInteger(event.seq) && event.seq >= from) bySeq.set(event.seq, event)
      }
      // A source that returns no progress must not make a refresh loop forever or advance the
      // projection past rows it did not actually fold.
      while (from <= target) {
        const event = bySeq.get(from)
        if (!event) break
        this.observe(sessionKey, event, generation)
        from++
      }
      if (from === pageFrom) break
      current = this.metadata(sessionKey)
      if (!current) return
    }
    this.t.exec(
      `UPDATE session_workspaces
       SET generation = CASE WHEN generation < ? THEN ? ELSE generation END,
           preset = CASE WHEN ? IS NULL THEN preset ELSE ? END
       WHERE session_key = ?`,
      [generation, generation, status.preset, status.preset, sessionKey],
    )
  }
}

export class MemorySessionWorkspaces implements SessionWorkspacePort {
  private readonly rows = new Map<string, { cwd: string; metadata: SessionWorkspaceMeta }>()

  put(sessionKey: string, cwd: string): void {
    checkWorkspace(sessionKey, cwd)
    const current = this.rows.get(sessionKey)
    if (current !== undefined && current.cwd !== cwd)
      throw new Error(`session ${sessionKey} is already bound to workspace ${current.cwd}`)
    this.rows.set(
      sessionKey,
      current ?? {
        cwd,
        metadata: { createdAt: '', lastSeq: 0, generation: 0, preset: null, profileHash: null },
      },
    )
  }

  get(sessionKey: string): string | undefined {
    return this.rows.get(sessionKey)?.cwd
  }

  keys(): string[] {
    return [...this.rows.keys()].sort()
  }

  metadata(sessionKey: string): SessionWorkspaceMeta | undefined {
    const row = this.rows.get(sessionKey)
    return row ? { ...row.metadata } : undefined
  }

  observe(sessionKey: string, event: EventEnvelope, generation = 0): void {
    const row = this.rows.get(sessionKey)
    if (!row) return
    if (event.seq > row.metadata.lastSeq) {
      const generated = readSessionTitle(event)
      if (generated?.status === 'generated') row.metadata.title = generated.title
      if (event.type === 'session/start' && (event.data as { key?: string })?.key === sessionKey)
        delete row.metadata.title
      if (event.type === 'user/message') row.metadata.lastActiveAt = event.ts
    }
    const data = event.data as { preset?: unknown; resolvedProfileHash?: unknown; to?: unknown } | null
    if (event.seq > row.metadata.lastSeq) row.metadata.lastSeq = event.seq
    if (generation > row.metadata.generation) row.metadata.generation = generation
    if (event.type === 'session/start') {
      if (!row.metadata.createdAt) row.metadata.createdAt = event.ts
      row.metadata.preset = typeof data?.preset === 'string' ? data.preset : null
      row.metadata.profileHash =
        typeof data?.resolvedProfileHash === 'string' ? data.resolvedProfileHash : null
    } else if (event.type === 'x/core/preset-switch' && typeof data?.to === 'string') {
      row.metadata.preset = data.to
    }
  }

  async refresh(sessionKey: string, source: SessionProjectionSource, generation = 0): Promise<void> {
    let current = this.metadata(sessionKey)
    if (!current) return
    const status = await source.status()
    let from = Math.max(1, current.lastSeq + 1)
    const target = Math.max(current.lastSeq, status.lastSeq)
    while (from <= target) {
      const pageFrom = from
      const rows = (await source.scan({
        fromSeq: from,
        toSeq: Math.min(target, from + 499),
        limit: 500,
      })) as EventEnvelope[]
      const bySeq = new Map<number, EventEnvelope>()
      for (const event of rows) {
        if (Number.isSafeInteger(event.seq) && event.seq >= from) bySeq.set(event.seq, event)
      }
      while (from <= target) {
        const event = bySeq.get(from)
        if (!event) break
        this.observe(sessionKey, event, generation)
        from++
      }
      if (from === pageFrom) break
      current = this.metadata(sessionKey)
      if (!current) return
    }
    const row = this.rows.get(sessionKey)
    if (!row) return
    if (generation > row.metadata.generation) row.metadata.generation = generation
    if (status.preset !== null) row.metadata.preset = status.preset
  }
}
