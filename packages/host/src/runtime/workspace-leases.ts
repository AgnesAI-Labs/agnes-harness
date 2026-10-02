import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import type { Outcome } from '@agnes/extension-api/runtime'
import type * as Wire from '@agnes/protocol/runtime'
import { RuntimeErrorDetails, type RuntimeWireTypes, validateRuntime } from '@agnes/protocol/runtime'
import { syncCheckpointsToMedium } from '../adapters/sqlite-durability.js'

type Detail = keyof typeof RuntimeErrorDetails

const DDL = [
  `CREATE TABLE IF NOT EXISTS workspaces (
    workspace_id TEXT PRIMARY KEY,
    canonical_root TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    resource_key TEXT NOT NULL UNIQUE
  )`,
  `CREATE TABLE IF NOT EXISTS lease_epochs (
    workspace_id TEXT PRIMARY KEY,
    epoch INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS leases (
    lease_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    mode TEXT NOT NULL,
    epoch INTEGER NOT NULL,
    owner_id TEXT NOT NULL,
    generation INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    released INTEGER NOT NULL,
    mount_id TEXT NOT NULL,
    invocation_id TEXT NOT NULL,
    UNIQUE (workspace_id, invocation_id)
  )`,
  `CREATE TABLE IF NOT EXISTS file_versions (
    workspace_id TEXT NOT NULL,
    path TEXT NOT NULL,
    version INTEGER NOT NULL,
    digest TEXT,
    PRIMARY KEY (workspace_id, path)
  )`,
  `CREATE TABLE IF NOT EXISTS write_journal (
    invocation_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    path TEXT NOT NULL,
    digest TEXT NOT NULL,
    version INTEGER NOT NULL,
    state TEXT NOT NULL,
    result_json TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS byte_pins (
    pin_id TEXT PRIMARY KEY,
    digest TEXT NOT NULL,
    byte_length INTEGER NOT NULL,
    media_type TEXT NOT NULL
  )`,
]

export class StoreFault extends Error {
  readonly detail: Detail
  constructor(detail: Detail, message: string) {
    super(message)
    this.detail = detail
  }
}

export function runtimeError(detail: Detail, message: string): Wire.RuntimeError {
  const retryAdvice =
    detail === 'effect_unknown'
      ? { kind: 'reconcile' as const, ownerRef: { kind: 'reconciliation' as const, id: 'workspace-files' } }
      : { kind: 'never' as const }
  return {
    code: RuntimeErrorDetails[detail].code as Wire.RuntimeError['code'],
    detailCode: detail,
    message,
    retryAdvice,
    diagnosticId: 'workspace-files',
  }
}

export function storeOutcome<T>(body: () => T): Outcome<T> {
  try {
    return { ok: true, value: body() }
  } catch (error) {
    if (error instanceof StoreFault) return { ok: false, error: runtimeError(error.detail, error.message) }
    throw error
  }
}

export function checked<K extends keyof RuntimeWireTypes>(name: K, value: unknown): RuntimeWireTypes[K] {
  const result = validateRuntime(name, value)
  if (!result.ok) throw new StoreFault('internal_error', `${name} failed its own schema`)
  return result.value
}

export function parsed<K extends keyof RuntimeWireTypes>(name: K, value: unknown): RuntimeWireTypes[K] {
  const result = validateRuntime(name, value)
  if (!result.ok) throw new StoreFault('invalid_request', `${name} does not match its schema`)
  return result.value
}

export type WorkspaceStore = {
  readonly directory: string
  readonly now: () => number
  transaction<T>(body: () => T): T
  close(): void
}

const handles = new WeakMap<WorkspaceStore, DatabaseSync>()

function dbOf(store: WorkspaceStore): DatabaseSync {
  const db = handles.get(store)
  if (!db) throw new StoreFault('blocked', 'service is closed')
  return db
}

type WorkspaceRow = {
  workspace_id: string
  canonical_root: string
  tenant_id: string
  revision: number
  resource_key: string
}

type LeaseRow = {
  lease_id: string
  workspace_id: string
  mode: string
  epoch: number
  owner_id: string
  generation: number
  expires_at: number
  released: number
  mount_id: string
  invocation_id: string
}

export type LeaseView = {
  leaseId: string
  workspaceId: string
  mode: 'read' | 'write'
  epoch: number
  ownerId: string
  generation: number
  expiresAt: number
  released: boolean
  mountId: string
  invocationId: string
  revision: number
  canonicalRoot: string
}

export type JournalView = {
  invocationId: string
  workspaceId: string
  path: string
  digest: string
  version: number
  state: 'prepared' | 'confirmed'
  resultJson: string | null
}

export function openWorkspaceStore(options: { directory: string; now?: () => number }): WorkspaceStore {
  mkdirSync(options.directory, { recursive: true })
  const db = new DatabaseSync(`${options.directory}/leases.sqlite`)
  db.exec('PRAGMA page_size = 4096')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  syncCheckpointsToMedium(db)
  for (const statement of DDL) db.exec(statement)
  const now = options.now ?? (() => Date.now())
  const store: WorkspaceStore = {
    directory: options.directory,
    now,
    transaction(body) {
      const db = dbOf(store)
      db.exec('BEGIN IMMEDIATE')
      try {
        const value = body()
        db.exec('COMMIT')
        return value
      } catch (error) {
        try {
          db.exec('ROLLBACK')
        } catch {
          // Keep the original refusal.
        }
        throw error
      }
    },
    close() {
      const db = handles.get(store)
      handles.delete(store)
      db?.close()
    },
  }
  handles.set(store, db)
  return store
}

function workspaceRow(store: WorkspaceStore, workspaceId: string): WorkspaceRow {
  const row = dbOf(store).prepare('SELECT * FROM workspaces WHERE workspace_id = ?').get(workspaceId) as
    | WorkspaceRow
    | undefined
  if (!row) throw new StoreFault('not_found', 'workspace is not bound')
  return row
}

function leaseView(row: LeaseRow, workspace: WorkspaceRow): LeaseView {
  return {
    leaseId: row.lease_id,
    workspaceId: row.workspace_id,
    mode: row.mode === 'write' ? 'write' : 'read',
    epoch: row.epoch,
    ownerId: row.owner_id,
    generation: row.generation,
    expiresAt: row.expires_at,
    released: row.released === 1,
    mountId: row.mount_id,
    invocationId: row.invocation_id,
    revision: workspace.revision,
    canonicalRoot: workspace.canonical_root,
  }
}

export function bindWorkspace(
  store: WorkspaceStore,
  input: { workspaceId: string; canonicalRoot: string; tenantId: string; resourceKey: string },
): { revision: number; canonicalRoot: string } {
  return store.transaction(() => {
    const byPath = dbOf(store)
      .prepare('SELECT * FROM workspaces WHERE resource_key = ?')
      .get(input.resourceKey) as WorkspaceRow | undefined
    const byId = dbOf(store)
      .prepare('SELECT * FROM workspaces WHERE workspace_id = ?')
      .get(input.workspaceId) as WorkspaceRow | undefined
    if (byPath && byPath.workspace_id !== input.workspaceId)
      throw new StoreFault('revision_conflict', 'path already belongs to a workspace')
    if (byId && byId.resource_key !== input.resourceKey)
      throw new StoreFault('revision_conflict', 'version does not match')
    if (byId && byId.tenant_id !== input.tenantId)
      throw new StoreFault('permission_denied', 'workspace is outside the caller scope')
    if (byId) return { revision: byId.revision, canonicalRoot: byId.canonical_root }
    dbOf(store)
      .prepare(
        'INSERT INTO workspaces (workspace_id, canonical_root, tenant_id, revision, resource_key) VALUES (?, ?, ?, 1, ?)',
      )
      .run(input.workspaceId, input.canonicalRoot, input.tenantId, input.resourceKey)
    dbOf(store).prepare('INSERT INTO lease_epochs (workspace_id, epoch) VALUES (?, 0)').run(input.workspaceId)
    return { revision: 1, canonicalRoot: input.canonicalRoot }
  })
}

export function workspaceRoot(store: WorkspaceStore, workspaceId: string): string {
  return workspaceRow(store, workspaceId).canonical_root
}

function expireLeases(store: WorkspaceStore, workspaceId: string): void {
  dbOf(store)
    .prepare('UPDATE leases SET released = 1 WHERE workspace_id = ? AND released = 0 AND expires_at <= ?')
    .run(workspaceId, store.now())
}

export function acquireLease(
  store: WorkspaceStore,
  input: {
    workspaceId: string
    tenantId: string
    mode: 'read' | 'write'
    ownerId: string
    generation: number
    invocationId: string
    expectedRevision: number | null
    leaseMs: number
  },
): LeaseView {
  return store.transaction(() => {
    const workspace = workspaceRow(store, input.workspaceId)
    if (workspace.tenant_id !== input.tenantId)
      throw new StoreFault('permission_denied', 'workspace is outside the caller scope')
    if (input.expectedRevision !== null && input.expectedRevision !== workspace.revision)
      throw new StoreFault('revision_conflict', 'version does not match')
    const prior = dbOf(store)
      .prepare('SELECT * FROM leases WHERE workspace_id = ? AND invocation_id = ?')
      .get(input.workspaceId, input.invocationId) as LeaseRow | undefined
    if (prior) {
      if (prior.owner_id !== input.ownerId || prior.mode !== input.mode)
        throw new StoreFault('idempotency_conflict', 'invocation already holds a different lease')
      return leaseView(prior, workspace)
    }
    expireLeases(store, input.workspaceId)
    const live = dbOf(store)
      .prepare('SELECT mode FROM leases WHERE workspace_id = ? AND released = 0')
      .all(input.workspaceId) as { mode: string }[]
    if (input.mode === 'write' && live.length > 0)
      throw new StoreFault('revision_conflict', 'write lease is held')
    if (live.some((row) => row.mode === 'write'))
      throw new StoreFault('revision_conflict', 'write lease is held')
    const epochRow = dbOf(store)
      .prepare('SELECT epoch FROM lease_epochs WHERE workspace_id = ?')
      .get(input.workspaceId) as { epoch: number }
    const epoch = epochRow.epoch + 1
    dbOf(store)
      .prepare('UPDATE lease_epochs SET epoch = ? WHERE workspace_id = ?')
      .run(epoch, input.workspaceId)
    const viewIds = { leaseId: randomUUID(), mountId: randomUUID() }
    const expiresAt = store.now() + input.leaseMs
    dbOf(store)
      .prepare(
        `INSERT INTO leases (
          lease_id, workspace_id, mode, epoch, owner_id, generation, expires_at, released, mount_id, invocation_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(
        viewIds.leaseId,
        input.workspaceId,
        input.mode,
        epoch,
        input.ownerId,
        input.generation,
        expiresAt,
        viewIds.mountId,
        input.invocationId,
      )
    const inserted = dbOf(store)
      .prepare('SELECT * FROM leases WHERE lease_id = ?')
      .get(viewIds.leaseId) as LeaseRow
    return leaseView(inserted, workspace)
  })
}

export function releaseLease(
  store: WorkspaceStore,
  input: { leaseId: string; epoch: number; ownerId: string; generation: number },
): boolean {
  return store.transaction(() => {
    const row = dbOf(store).prepare('SELECT * FROM leases WHERE lease_id = ?').get(input.leaseId) as
      | LeaseRow
      | undefined
    if (!row) throw new StoreFault('not_found', 'mount lease is not live')
    if (row.owner_id !== input.ownerId || row.generation !== input.generation)
      throw new StoreFault('permission_denied', 'mount lease is not live')
    if (row.epoch !== input.epoch) throw new StoreFault('revision_conflict', 'version does not match')
    if (row.released === 1) return true
    dbOf(store).prepare('UPDATE leases SET released = 1 WHERE lease_id = ?').run(input.leaseId)
    return true
  })
}

export function anyLiveLease(store: WorkspaceStore, workspaceId: string, ownerId: string): LeaseView | null {
  expireLeases(store, workspaceId)
  const workspace = workspaceRow(store, workspaceId)
  const row = dbOf(store)
    .prepare(
      'SELECT * FROM leases WHERE workspace_id = ? AND released = 0 AND owner_id = ? ORDER BY epoch DESC LIMIT 1',
    )
    .get(workspaceId, ownerId) as LeaseRow | undefined
  return row ? leaseView(row, workspace) : null
}

export function requireLease(
  store: WorkspaceStore,
  input: { mount: Wire.MountRef; ownerId: string; writing: boolean },
): LeaseView {
  const workspace = workspaceRow(store, input.mount.workspaceId)
  if (input.mount.revision !== workspace.revision)
    throw new StoreFault('revision_conflict', 'version does not match')
  expireLeases(store, input.mount.workspaceId)
  const row = dbOf(store).prepare('SELECT * FROM leases WHERE lease_id = ?').get(input.mount.lease.leaseId) as
    | LeaseRow
    | undefined
  if (
    !row ||
    row.released === 1 ||
    row.expires_at <= store.now() ||
    row.epoch !== input.mount.lease.epoch ||
    row.mount_id !== input.mount.mountId ||
    row.workspace_id !== input.mount.workspaceId
  )
    throw new StoreFault('revoked', 'mount lease is not live')
  if (row.owner_id !== input.ownerId)
    throw new StoreFault('permission_denied', 'workspace is outside the caller scope')
  if (input.writing && row.mode !== 'write')
    throw new StoreFault('permission_denied', 'mount lease is not live')
  return leaseView(row, workspace)
}

export function fileVersion(
  store: WorkspaceStore,
  workspaceId: string,
  path: string,
): { version: number; digest: string | null } {
  const row = dbOf(store)
    .prepare('SELECT version, digest FROM file_versions WHERE workspace_id = ? AND path = ?')
    .get(workspaceId, path) as { version: number; digest: string | null } | undefined
  return row ?? { version: 0, digest: null }
}

export function putFileVersion(
  store: WorkspaceStore,
  input: { workspaceId: string; path: string; version: number; digest: string | null },
): void {
  dbOf(store)
    .prepare(
      `INSERT INTO file_versions (workspace_id, path, version, digest) VALUES (?, ?, ?, ?)
       ON CONFLICT (workspace_id, path) DO UPDATE SET version = excluded.version, digest = excluded.digest`,
    )
    .run(input.workspaceId, input.path, input.version, input.digest)
}

export function readJournal(store: WorkspaceStore, invocationId: string): JournalView | null {
  const row = dbOf(store).prepare('SELECT * FROM write_journal WHERE invocation_id = ?').get(invocationId) as
    | {
        invocation_id: string
        workspace_id: string
        path: string
        digest: string
        version: number
        state: string
        result_json: string | null
      }
    | undefined
  if (!row) return null
  return {
    invocationId: row.invocation_id,
    workspaceId: row.workspace_id,
    path: row.path,
    digest: row.digest,
    version: row.version,
    state: row.state === 'confirmed' ? 'confirmed' : 'prepared',
    resultJson: row.result_json,
  }
}

export function prepareJournal(
  store: WorkspaceStore,
  input: { invocationId: string; workspaceId: string; path: string; digest: string; version: number },
): void {
  dbOf(store)
    .prepare(
      `INSERT INTO write_journal (invocation_id, workspace_id, path, digest, version, state, result_json)
       VALUES (?, ?, ?, ?, ?, 'prepared', NULL)`,
    )
    .run(input.invocationId, input.workspaceId, input.path, input.digest, input.version)
}

export function noteJournal(store: WorkspaceStore, invocationId: string, resultJson: string): void {
  dbOf(store)
    .prepare('UPDATE write_journal SET result_json = ? WHERE invocation_id = ?')
    .run(resultJson, invocationId)
}

export function confirmJournal(store: WorkspaceStore, invocationId: string, resultJson: string): void {
  dbOf(store)
    .prepare(`UPDATE write_journal SET state = 'confirmed', result_json = ? WHERE invocation_id = ?`)
    .run(resultJson, invocationId)
}

export function dropJournal(store: WorkspaceStore, invocationId: string): void {
  dbOf(store).prepare('DELETE FROM write_journal WHERE invocation_id = ?').run(invocationId)
}

export function rememberPin(
  store: WorkspaceStore,
  input: { pinId: string; digest: string; byteLength: number; mediaType: string },
): void {
  dbOf(store)
    .prepare('INSERT INTO byte_pins (pin_id, digest, byte_length, media_type) VALUES (?, ?, ?, ?)')
    .run(input.pinId, input.digest, input.byteLength, input.mediaType)
}

export function loadPin(
  store: WorkspaceStore,
  pinId: string,
): { digest: string; byteLength: number; mediaType: string } | null {
  const row = dbOf(store)
    .prepare('SELECT digest, byte_length, media_type FROM byte_pins WHERE pin_id = ?')
    .get(pinId) as { digest: string; byte_length: number; media_type: string } | undefined
  if (!row) return null
  return { digest: row.digest, byteLength: row.byte_length, mediaType: row.media_type }
}
