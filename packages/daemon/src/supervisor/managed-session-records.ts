import type { TableHandle } from '@agnes/daemon-foundation/storage/table'
import type { ManagedSessionRetention } from '@agnes/extension-api'

export interface ManagedSessionRecord {
  sessionId: string
  owner: string
  startKey: string
  bundle: string
  workspace: string
  retention: ManagedSessionRetention
  permission: 'default' | 'full-access'
  /** `route\0model`, or null for the deployment default. */
  model: string | null
  memoryWrites: boolean
  skillInstalls: boolean
  started: boolean
  archived: boolean
}

type Row = {
  session_id: string
  owner: string
  start_key: string
  bundle: string
  workspace: string
  retention: string
  permission: string
  model: string | null
  memory_writes: number
  skill_installs: number
  started: number
  archived: number
}

const record = (row: Row): ManagedSessionRecord => ({
  sessionId: row.session_id,
  owner: row.owner,
  startKey: row.start_key,
  bundle: row.bundle,
  workspace: row.workspace,
  retention: row.retention === 'ephemeral' ? 'ephemeral' : 'task',
  permission: row.permission === 'full-access' ? 'full-access' : 'default',
  model: row.model,
  memoryWrites: row.memory_writes !== 0,
  skillInstalls: row.skill_installs !== 0,
  started: row.started === 1,
  archived: row.archived === 1,
})

/**
 * The key of a workspace grant: the package and one of its plugin rows. Row ids are author-chosen, so a
 * row alone would let a later package that declares the same id inherit the grant. `#` separates the
 * parts because a package id never contains it, so `${packageId}#` prefixes only that package's keys.
 * Not NUL: the storage adapter refuses NUL in a bound TEXT parameter.
 */
export const grantKey = (packageId: string, owner: string) => `${packageId}#${owner}`

/**
 * Which plugin row manages which session, the workspaces the owner authorized for each row, and the
 * send keys each row used. New tables only: no existing table changes shape.
 */
export class ManagedSessionRecords {
  /** Session keys being created as managed ones, before their record exists; process memory only. */
  readonly opening = new Set<string>()

  constructor(private readonly table: TableHandle) {
    table.exec(`CREATE TABLE IF NOT EXISTS managed_sessions (
      session_id TEXT PRIMARY KEY, owner TEXT NOT NULL, start_key TEXT NOT NULL, bundle TEXT NOT NULL,
      workspace TEXT NOT NULL, retention TEXT NOT NULL, permission TEXT NOT NULL,
      model TEXT, memory_writes INTEGER NOT NULL DEFAULT 1,
      skill_installs INTEGER NOT NULL DEFAULT 1, started INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0, UNIQUE (owner, start_key)
    )`)
    table.exec(`CREATE TABLE IF NOT EXISTS managed_session_sends (
      owner TEXT NOT NULL, session_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, state TEXT NOT NULL,
      PRIMARY KEY (owner, session_id, idempotency_key)
    )`)
    table.exec(`CREATE TABLE IF NOT EXISTS managed_session_grants (
      owner TEXT NOT NULL, workspace TEXT NOT NULL, PRIMARY KEY (owner, workspace)
    )`)
  }

  get(sessionId: string): ManagedSessionRecord | undefined {
    const row = this.table.get<Row>('SELECT * FROM managed_sessions WHERE session_id = ?', [sessionId])
    return row ? record(row) : undefined
  }

  byStartKey(owner: string, startKey: string): ManagedSessionRecord | undefined {
    const row = this.table.get<Row>('SELECT * FROM managed_sessions WHERE owner = ? AND start_key = ?', [
      owner,
      startKey,
    ])
    return row ? record(row) : undefined
  }

  list(owner: string): ManagedSessionRecord[] {
    return this.table
      .all<Row>('SELECT * FROM managed_sessions WHERE owner = ? ORDER BY rowid', [owner])
      .map(record)
  }

  insert(value: Omit<ManagedSessionRecord, 'started' | 'archived'>): void {
    this.table.exec(
      `INSERT INTO managed_sessions
         (session_id, owner, start_key, bundle, workspace, retention, permission, model, memory_writes,
          skill_installs)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      [
        value.sessionId,
        value.owner,
        value.startKey,
        value.bundle,
        value.workspace,
        value.retention,
        value.permission,
        value.model,
        value.memoryWrites ? 1 : 0,
        value.skillInstalls ? 1 : 0,
      ],
    )
  }

  markStarted(sessionId: string): void {
    this.table.exec('UPDATE managed_sessions SET started = 1 WHERE session_id = ?', [sessionId])
  }

  markArchived(sessionId: string): void {
    this.table.exec('UPDATE managed_sessions SET archived = 1 WHERE session_id = ?', [sessionId])
  }

  sendState(owner: string, sessionId: string, key: string): 'pending' | 'sent' | undefined {
    const row = this.table.get<{ state: string }>(
      'SELECT state FROM managed_session_sends WHERE owner = ? AND session_id = ? AND idempotency_key = ?',
      [owner, sessionId, key],
    )
    return row?.state === 'sent' ? 'sent' : row ? 'pending' : undefined
  }

  setSend(owner: string, sessionId: string, key: string, state: 'pending' | 'sent' | undefined): void {
    if (state === undefined)
      this.table.exec(
        'DELETE FROM managed_session_sends WHERE owner = ? AND session_id = ? AND idempotency_key = ?',
        [owner, sessionId, key],
      )
    else
      this.table.exec(
        `INSERT INTO managed_session_sends (owner, session_id, idempotency_key, state) VALUES (?, ?, ?, ?)
         ON CONFLICT (owner, session_id, idempotency_key) DO UPDATE SET state = excluded.state`,
        [owner, sessionId, key, state],
      )
  }

  granted(owner: string, workspace: string): boolean {
    return (
      this.table.get('SELECT 1 FROM managed_session_grants WHERE owner = ? AND workspace = ?', [
        owner,
        workspace,
      ]) !== undefined
    )
  }

  grants(owner: string): string[] {
    return this.table
      .all<{ workspace: string }>(
        'SELECT workspace FROM managed_session_grants WHERE owner = ? ORDER BY workspace',
        [owner],
      )
      .map((row) => row.workspace)
  }

  grant(owner: string, workspace: string): void {
    this.table.exec(
      'INSERT INTO managed_session_grants (owner, workspace) VALUES (?, ?) ON CONFLICT DO NOTHING',
      [owner, workspace],
    )
  }

  /** Every grant key that holds at least one grant. */
  grantOwners(): string[] {
    return this.table
      .all<{ owner: string }>('SELECT DISTINCT owner FROM managed_session_grants ORDER BY owner')
      .map((row) => row.owner)
  }

  /** Every grant of one grant key. */
  revokeAll(owner: string): void {
    this.table.exec('DELETE FROM managed_session_grants WHERE owner = ?', [owner])
  }

  revoke(owner: string, workspace: string): void {
    this.table.exec('DELETE FROM managed_session_grants WHERE owner = ? AND workspace = ?', [
      owner,
      workspace,
    ])
  }
}
