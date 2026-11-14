import type { TableHandle } from '@agnes/daemon-foundation/storage/table'
import type { ManagedSessionRetention } from '@agnes/extension-api'
import { grantKey } from '@agnes/plugin-runtime/host'
import { MANAGED_INPUT_TABLES } from './managed-session-inputs.js'

export interface ManagedSessionRecord {
  sessionId: string
  owner: string
  startKey: string
  bundle: string
  workspace: string
  retention: ManagedSessionRetention
  permission: 'default' | 'full-access'
  /** JSON `{route, model}`: SQLite TEXT cannot carry the NUL a joined key would need. Null is the deployment default. */
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

/** The task a session was opened for; `inputDigest` is null for a session opened before bindings existed. */
export interface ManagedSessionBinding {
  sessionId: string
  taskId: string
  taskGeneration: number
  inputDigest: string | null
}

/**
 * Which package and plugin row manages which session, the workspaces the owner authorized for each,
 * and the send keys each used, all under a `grantKey`. New tables only: no existing table changes shape.
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
    for (const ddl of MANAGED_INPUT_TABLES) table.exec(ddl)
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

  /** With a binding, the record and the binding are written in one transaction. */
  insert(
    value: Omit<ManagedSessionRecord, 'started' | 'archived'>,
    binding?: Omit<ManagedSessionBinding, 'sessionId'>,
  ): void {
    const write = () =>
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
    if (!binding) {
      write()
      return
    }
    this.table.transaction(() => {
      write()
      // A record that lost to another session's (owner, start_key) was ignored: no binding to orphan.
      if (this.get(value.sessionId) === undefined) return
      this.table.exec(
        `INSERT INTO managed_session_bindings (session_id, task_id, task_generation, input_digest)
         VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        [value.sessionId, binding.taskId, binding.taskGeneration, binding.inputDigest],
      )
    })
  }

  binding(sessionId: string): ManagedSessionBinding | undefined {
    const row = this.table.get<{
      session_id: string
      task_id: string
      task_generation: number
      input_digest: string | null
    }>('SELECT * FROM managed_session_bindings WHERE session_id = ?', [sessionId])
    return row
      ? {
          sessionId: row.session_id,
          taskId: row.task_id,
          taskGeneration: row.task_generation,
          inputDigest: row.input_digest,
        }
      : undefined
  }

  /** Binds a session opened before bindings existed; false when it already has one or has no record. */
  bindLate(binding: ManagedSessionBinding & { inputDigest: null }): boolean {
    return this.table.transaction(() => {
      if (this.get(binding.sessionId) === undefined || this.binding(binding.sessionId) !== undefined)
        return false
      this.table.exec(
        `INSERT INTO managed_session_bindings (session_id, task_id, task_generation, input_digest)
         VALUES (?, ?, ?, NULL)`,
        [binding.sessionId, binding.taskId, binding.taskGeneration],
      )
      return true
    })
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

  /**
   * A removed package's grants, send keys, bindings and owner inputs go, and its records move to an owner no `grantKey` can
   * produce: a package id never starts with `~`, and the session id keeps `(owner, start_key)` unique
   * however often the id is installed and removed again. The records stay, because a record also
   * marks its session and every descendant as managed. Compared with `substr`, not LIKE: a package
   * id may contain `_`.
   */
  releasePackage(packageId: string): void {
    const prefix = grantKey(packageId, '')
    const match = 'substr(owner, 1, length(?)) = ?'
    this.table.transaction(() => {
      this.table.exec(`DELETE FROM managed_session_grants WHERE ${match}`, [prefix, prefix])
      this.table.exec(`DELETE FROM managed_session_sends WHERE ${match}`, [prefix, prefix])
      // Before the records move away from the prefix. Owner inputs are never pruned by time, only here.
      const sessions = `SELECT session_id FROM managed_sessions WHERE ${match}`
      this.table.exec(`DELETE FROM managed_session_bindings WHERE session_id IN (${sessions})`, [
        prefix,
        prefix,
      ])
      this.table.exec(`DELETE FROM managed_session_inputs WHERE ${match} OR session_id IN (${sessions})`, [
        prefix,
        prefix,
        prefix,
        prefix,
      ])
      this.table.exec(`UPDATE managed_sessions SET owner = '~' || session_id WHERE ${match}`, [
        prefix,
        prefix,
      ])
    })
  }

  revoke(owner: string, workspace: string): void {
    this.table.exec('DELETE FROM managed_session_grants WHERE owner = ? AND workspace = ?', [
      owner,
      workspace,
    ])
  }
}
