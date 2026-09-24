import { createHash } from 'node:crypto'
import type { WorkspaceDirectory } from '@agnes/host'
import { rpcError, type WorkspaceEntry } from '@agnes/protocol'
import type { SessionWorkspacePort } from './lister.js'
import { ensure, type TableHandle } from './table.js'

export type { WorkspaceEntry } from '@agnes/protocol'

export function workspaceIdFor(path: string): string {
  return createHash('sha256').update(path, 'utf8').digest('hex')
}

type WorkspaceRow = Omit<WorkspaceEntry, 'sessionCount' | 'available' | 'workspaceId' | 'revision'> & {
  workspaceId: string
  revision: number
}

export interface WorkspaceStore {
  put(directory: WorkspaceDirectory, registeredAt: string): WorkspaceRow
  touch(path: string, usedAt: string): void
  rows(): WorkspaceRow[]
}

export class WorkspaceIndex implements WorkspaceStore {
  constructor(private readonly table: TableHandle) {
    ensure(
      table,
      `CREATE TABLE IF NOT EXISTS workspace_registry (
        path TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        registered_at TEXT NOT NULL,
        last_used_at TEXT
      )`,
    )
    // Existing daemon databases predate explicit authority revisions. Migrate in place, then derive
    // ids from the already canonical paths instead of treating any new cwd as registration.
    try {
      table.exec('ALTER TABLE workspace_registry ADD COLUMN workspace_id TEXT')
    } catch {
      // Column already exists.
    }
    try {
      table.exec('ALTER TABLE workspace_registry ADD COLUMN revision INTEGER NOT NULL DEFAULT 1')
    } catch {
      // Column already exists.
    }
    for (const row of table.all<{ path: string; workspace_id: string | null }>(
      'SELECT path, workspace_id FROM workspace_registry',
    ))
      if (!row.workspace_id)
        table.exec('UPDATE workspace_registry SET workspace_id = ? WHERE path = ?', [
          workspaceIdFor(row.path),
          row.path,
        ])
  }

  put(directory: WorkspaceDirectory, registeredAt: string): WorkspaceRow {
    const workspaceId = workspaceIdFor(directory.path)
    this.table.exec(
      `INSERT INTO workspace_registry
         (path, name, workspace_id, revision, registered_at, last_used_at)
       VALUES (?, ?, ?, 1, ?, NULL)
       ON CONFLICT(path) DO UPDATE SET name = excluded.name`,
      [directory.path, directory.name, workspaceId, registeredAt],
    )
    const row = this.table.get<SqlWorkspaceRow>(
      'SELECT path, name, workspace_id, revision, last_used_at FROM workspace_registry WHERE path = ?',
      [directory.path],
    )
    if (!row) throw new Error('workspace registration was not persisted')
    return fromSqlRow(row)
  }

  touch(path: string, usedAt: string): void {
    this.table.exec('UPDATE workspace_registry SET last_used_at = ? WHERE path = ?', [usedAt, path])
  }

  rows(): WorkspaceRow[] {
    return this.table
      .all<SqlWorkspaceRow>(
        'SELECT path, name, workspace_id, revision, last_used_at FROM workspace_registry ORDER BY path',
      )
      .map(fromSqlRow)
  }
}

type SqlWorkspaceRow = {
  path: string
  name: string
  workspace_id: string
  revision: number
  last_used_at: string | null
}

function fromSqlRow(row: SqlWorkspaceRow): WorkspaceRow {
  return {
    path: row.path,
    name: row.name,
    workspaceId: row.workspace_id,
    revision: row.revision,
    lastUsedAt: row.last_used_at,
  }
}

export class MemoryWorkspaceStore implements WorkspaceStore {
  private readonly entries = new Map<string, WorkspaceRow>()

  put(directory: WorkspaceDirectory, _registeredAt: string): WorkspaceRow {
    const existing = this.entries.get(directory.path)
    const entry: WorkspaceRow = {
      path: directory.path,
      name: directory.name,
      workspaceId: workspaceIdFor(directory.path),
      revision: existing?.revision ?? 1,
      lastUsedAt: existing?.lastUsedAt ?? null,
    }
    this.entries.set(directory.path, entry)
    return { ...entry }
  }

  touch(path: string, usedAt: string): void {
    const existing = this.entries.get(path)
    if (existing) this.entries.set(path, { ...existing, lastUsedAt: usedAt })
  }

  rows(): WorkspaceRow[] {
    return [...this.entries.values()].map((entry) => ({ ...entry }))
  }
}

export type WorkspaceBindingRecord = Readonly<{
  sessionKey: string
  workspaceId: string
  revision: number
  canonicalRoot: string
}>

export interface WorkspaceBindingStore {
  get(sessionKey: string): WorkspaceBindingRecord | undefined
  putIfAbsent(binding: WorkspaceBindingRecord): WorkspaceBindingRecord
  keys(): string[]
}

export class WorkspaceBindingIndex implements WorkspaceBindingStore {
  constructor(private readonly table: TableHandle) {
    ensure(
      table,
      `CREATE TABLE IF NOT EXISTS workspace_bindings (
        session_key TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        canonical_root TEXT NOT NULL
      )`,
    )
  }

  get(sessionKey: string): WorkspaceBindingRecord | undefined {
    const row = this.table.get<{
      session_key: string
      workspace_id: string
      revision: number
      canonical_root: string
    }>(
      'SELECT session_key, workspace_id, revision, canonical_root FROM workspace_bindings WHERE session_key = ?',
      [sessionKey],
    )
    return row
      ? {
          sessionKey: row.session_key,
          workspaceId: row.workspace_id,
          revision: row.revision,
          canonicalRoot: row.canonical_root,
        }
      : undefined
  }

  putIfAbsent(binding: WorkspaceBindingRecord): WorkspaceBindingRecord {
    this.table.exec(
      `INSERT INTO workspace_bindings (session_key, workspace_id, revision, canonical_root)
       VALUES (?, ?, ?, ?) ON CONFLICT(session_key) DO NOTHING`,
      [binding.sessionKey, binding.workspaceId, binding.revision, binding.canonicalRoot],
    )
    const persisted = this.get(binding.sessionKey)
    if (!persisted) throw new Error('workspace binding was not persisted')
    return persisted
  }

  keys(): string[] {
    return this.table
      .all<{ session_key: string }>('SELECT session_key FROM workspace_bindings ORDER BY session_key')
      .map((row) => row.session_key)
  }
}

export class MemoryWorkspaceBindings implements WorkspaceBindingStore {
  private readonly entries = new Map<string, WorkspaceBindingRecord>()

  get(sessionKey: string): WorkspaceBindingRecord | undefined {
    const binding = this.entries.get(sessionKey)
    return binding ? { ...binding } : undefined
  }

  putIfAbsent(binding: WorkspaceBindingRecord): WorkspaceBindingRecord {
    const existing = this.entries.get(binding.sessionKey)
    if (existing) return { ...existing }
    this.entries.set(binding.sessionKey, { ...binding })
    return { ...binding }
  }

  keys(): string[] {
    return [...this.entries.keys()]
  }
}

declare const workspaceBindingBrand: unique symbol

/** Nominal daemon-only authority. The brand is deliberately absent from the serialized frame. */
export type WorkspaceBindingEnvelope = WorkspaceBindingRecord & {
  readonly version: 1
  readonly [workspaceBindingBrand]: true
}

const issuedBindings = new WeakSet<object>()

function issueBinding(binding: WorkspaceBindingRecord): WorkspaceBindingEnvelope {
  const envelope = Object.freeze({ version: 1 as const, ...binding }) as WorkspaceBindingEnvelope
  issuedBindings.add(envelope)
  return envelope
}

export function assertWorkspaceBindingEnvelope(value: unknown): asserts value is WorkspaceBindingEnvelope {
  if (!value || typeof value !== 'object' || !issuedBindings.has(value as object))
    throw new TypeError('workspace binding was not issued by the daemon authority')
}

export type WorkspaceDirectoryResolver = (path: string) => Promise<WorkspaceDirectory>

export class SessionWorkspaceConflictError extends Error {
  constructor(
    readonly sessionKey: string,
    readonly existingPath: string,
    readonly requestedPath: string,
  ) {
    super(`session workspace binding conflicts for ${sessionKey}`)
    this.name = 'SessionWorkspaceConflictError'
  }
}

/** Registered authority and durable history remain separate: history never creates an authority row. */
export class WorkspaceCatalog {
  private readonly usedSessionKeys: Set<string>
  private readonly boundListeners = new Set<(workspaceId: string, root: string) => void>()

  constructor(
    private readonly store: WorkspaceStore,
    private readonly sessions: Pick<SessionWorkspacePort, 'put' | 'keys' | 'get' | 'metadata'>,
    private readonly resolve: WorkspaceDirectoryResolver,
    private readonly clock: () => number = () => Date.now(),
    private readonly bindings: WorkspaceBindingStore = new MemoryWorkspaceBindings(),
  ) {
    this.usedSessionKeys = new Set(bindings.keys())
  }

  /** Filesystem normalization only. This method does not grant authority. */
  validate(path: string): Promise<WorkspaceDirectory> {
    return this.resolve(path)
  }

  sessionPath(sessionKey: string): string | undefined {
    return this.bindings.get(sessionKey)?.canonicalRoot
  }

  /** Observes successful session bindings. A listener cannot veto or alter the binding. */
  onBound(listener: (workspaceId: string, root: string) => void): () => void {
    this.boundListeners.add(listener)
    return () => {
      this.boundListeners.delete(listener)
    }
  }

  private notifyBound(binding: WorkspaceBindingRecord): void {
    for (const listener of this.boundListeners) {
      try {
        listener(binding.workspaceId, binding.canonicalRoot)
      } catch {}
    }
  }

  async add(path: string): Promise<WorkspaceEntry> {
    const directory = await this.resolve(path)
    const row = this.store.put(directory, new Date(this.clock()).toISOString())
    return this.entry(row, this.sessionAggregate(), true)
  }

  async authorizeAndBind(sessionKey: string, path: string): Promise<WorkspaceBindingEnvelope> {
    const directory = await this.resolve(path)
    const row = this.store.rows().find((candidate) => candidate.path === directory.path)
    if (!row) throw this.notRegistered()
    await this.assertFresh(row)
    const requested: WorkspaceBindingRecord = {
      sessionKey,
      workspaceId: row.workspaceId,
      revision: row.revision,
      canonicalRoot: row.path,
    }
    const persisted = this.bindings.putIfAbsent(requested)
    this.assertSameBinding(requested, persisted)
    this.sessions.put(sessionKey, row.path)
    if (!this.usedSessionKeys.has(sessionKey)) {
      this.usedSessionKeys.add(sessionKey)
      this.store.touch(row.path, new Date(this.clock()).toISOString())
    }
    this.notifyBound(persisted)
    return issueBinding(persisted)
  }

  async restoreBinding(sessionKey: string, requestedPath?: string): Promise<WorkspaceBindingEnvelope> {
    const binding = this.bindings.get(sessionKey)
    if (!binding)
      throw rpcError('SEMANTIC_REJECTED', {
        code: 'WORKSPACE_NOT_FOUND',
        sessionId: sessionKey,
        reason: 'session has no authoritative workspace binding',
      })
    const row = this.store.rows().find((candidate) => candidate.workspaceId === binding.workspaceId)
    if (
      !row ||
      row.revision !== binding.revision ||
      row.path !== binding.canonicalRoot ||
      workspaceIdFor(row.path) !== row.workspaceId
    )
      throw rpcError('SEMANTIC_REJECTED', {
        code: 'WORKSPACE_STALE',
        sessionId: sessionKey,
        reason: 'workspace registry revision no longer matches the session binding',
      })
    await this.assertFresh(row)
    if (requestedPath) {
      const requested = await this.resolve(requestedPath)
      if (requested.path !== binding.canonicalRoot)
        throw new SessionWorkspaceConflictError(sessionKey, binding.canonicalRoot, requested.path)
    }
    this.notifyBound(binding)
    return issueBinding(binding)
  }

  async list(): Promise<{ items: WorkspaceEntry[] }> {
    const aggregate = this.sessionAggregate()
    const items = await Promise.all(
      this.store.rows().map(async (row) => {
        let available = false
        try {
          await this.assertFresh(row)
          available = true
        } catch {
          available = false
        }
        return this.entry(row, aggregate, available)
      }),
    )
    items.sort(
      (left, right) =>
        (right.lastUsedAt ?? '').localeCompare(left.lastUsedAt ?? '') || left.path.localeCompare(right.path),
    )
    return { items }
  }

  async bind(
    workspaceId: string | undefined,
    fallbackPath: string,
  ): Promise<{ workspaceId: string; path: string }> {
    let row: WorkspaceRow | undefined
    if (workspaceId) row = this.store.rows().find((candidate) => candidate.workspaceId === workspaceId)
    else {
      const fallback = await this.resolve(fallbackPath)
      row = this.store.rows().find((candidate) => candidate.path === fallback.path)
    }
    if (!row) throw this.notRegistered()
    await this.assertFresh(row)
    return { workspaceId: row.workspaceId, path: row.path }
  }

  private entry(
    row: WorkspaceRow,
    aggregate: Map<string, { count: number; lastUsedAt: string | null }>,
    available: boolean,
  ): WorkspaceEntry {
    const fromSessions = aggregate.get(row.path)
    return {
      ...row,
      lastUsedAt:
        [row.lastUsedAt, fromSessions?.lastUsedAt]
          .filter((value): value is string => value !== null && value !== undefined)
          .sort()
          .at(-1) ?? null,
      sessionCount: fromSessions?.count ?? 0,
      available,
    }
  }

  private async assertFresh(row: WorkspaceRow): Promise<void> {
    const resolved = await this.resolve(row.path).catch(() => undefined)
    if (!resolved || resolved.path !== row.path || workspaceIdFor(row.path) !== row.workspaceId)
      throw rpcError('SEMANTIC_REJECTED', {
        code: 'WORKSPACE_STALE',
        reason: 'registered workspace no longer resolves to its canonical root',
      })
  }

  private assertSameBinding(requested: WorkspaceBindingRecord, persisted: WorkspaceBindingRecord): void {
    if (
      requested.workspaceId !== persisted.workspaceId ||
      requested.revision !== persisted.revision ||
      requested.canonicalRoot !== persisted.canonicalRoot
    )
      throw new SessionWorkspaceConflictError(
        requested.sessionKey,
        persisted.canonicalRoot,
        requested.canonicalRoot,
      )
  }

  private notRegistered(): ReturnType<typeof rpcError> {
    return rpcError('SEMANTIC_REJECTED', {
      code: 'WORKSPACE_NOT_FOUND',
      reason: 'workspace is not registered',
    })
  }

  private sessionAggregate(): Map<string, { count: number; lastUsedAt: string | null }> {
    const aggregate = new Map<string, { count: number; lastUsedAt: string | null }>()
    for (const key of this.sessions.keys()) {
      const path = this.sessions.get(key)
      if (!path) continue
      const current = aggregate.get(path) ?? { count: 0, lastUsedAt: null }
      const createdAt = this.sessions.metadata(key)?.createdAt || null
      aggregate.set(path, {
        count: current.count + 1,
        lastUsedAt:
          createdAt && (!current.lastUsedAt || createdAt > current.lastUsedAt)
            ? createdAt
            : current.lastUsedAt,
      })
    }
    return aggregate
  }
}
