import { DatabaseSync } from 'node:sqlite'
import type { MessageRef } from '../adapter.js'

export type RefPart = { ref: MessageRef; contentHash: string }
export type RefRow = { ref: MessageRef; contentHash: string }
export type DeliveryRefRow = RefRow & {
  parts: RefPart[]
  complete: boolean
  isUpdate: boolean
}

type StoredRef = { content_hash: string; parts_json: string; complete: number; is_update: number }
type LegacyRef = {
  session_key: string
  node_id: string
  chat_id: string
  message_id: string
  card_biz_id: string | null
  content_hash: string
  updated_at: number
}

const darwin = process.platform === 'darwin' // guards-allow-platform: F_FULLFSYNC is darwin-only.

/** Durable outbound progress, scoped by both chat route and actual daemon session identity. */
export class RefStore {
  private readonly db: DatabaseSync
  private readonly clock: () => number
  private closed = false

  constructor(path: string, options: { clock?: () => number } = {}) {
    this.clock = options.clock ?? Date.now
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    // WAL survives a power loss uncorrupted only if checkpoints reach the medium; on darwin that
    // takes F_FULLFSYNC.
    if (darwin) this.db.exec('PRAGMA checkpoint_fullfsync = ON')
    this.migrate()
  }

  private migrate(): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.exec(`CREATE TABLE IF NOT EXISTS refs_v2 (
      session_key TEXT NOT NULL,
      session_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      parts_json TEXT NOT NULL,
      complete INTEGER NOT NULL,
      is_update INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (session_key, session_id, node_id)
    )`)
      const columns = this.db.prepare('PRAGMA table_info(refs_v2)').all() as Array<{ name: string }>
      if (!columns.some((column) => column.name === 'is_update')) {
        this.db.exec('ALTER TABLE refs_v2 ADD COLUMN is_update INTEGER NOT NULL DEFAULT 0')
      }
      this.db.exec(`CREATE TABLE IF NOT EXISTS ref_sessions (
        session_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        retired_at INTEGER,
        PRIMARY KEY (session_key, session_id)
      )`)
      const legacyExists = this.db
        .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'refs'")
        .get()
      if (legacyExists !== undefined) {
        const insert = this.db.prepare(`INSERT OR IGNORE INTO refs_v2
          (session_key, session_id, node_id, content_hash, parts_json, complete, is_update, updated_at)
          VALUES (?, ?, ?, ?, ?, 1, 0, ?)`)
        const activate = this.db.prepare(
          'INSERT OR IGNORE INTO ref_sessions (session_key, session_id, retired_at) VALUES (?, ?, NULL)',
        )
        for (const row of this.db.prepare('SELECT * FROM refs').all() as LegacyRef[]) {
          const ref: MessageRef = {
            chatId: row.chat_id,
            messageId: row.message_id,
            ...(row.card_biz_id === null ? {} : { cardBizId: row.card_biz_id }),
          }
          insert.run(
            row.session_key,
            row.session_key,
            row.node_id,
            row.content_hash,
            JSON.stringify([{ ref, contentHash: row.content_hash }]),
            row.updated_at,
          )
          activate.run(row.session_key, row.session_key)
        }
        this.db.exec('DROP TABLE refs')
      }
      this.db.exec('CREATE INDEX IF NOT EXISTS refs_v2_updated_at ON refs_v2(updated_at)')
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  get(sessionKey: string, nodeId: string, sessionId = sessionKey): RefRow | undefined {
    const state = this.getState(sessionKey, nodeId, sessionId)
    return state === undefined ? undefined : { ref: state.ref, contentHash: state.contentHash }
  }

  getState(sessionKey: string, nodeId: string, sessionId = sessionKey): DeliveryRefRow | undefined {
    const row = this.db
      .prepare(
        'SELECT content_hash, parts_json, complete, is_update FROM refs_v2 WHERE session_key = ? AND session_id = ? AND node_id = ?',
      )
      .get(sessionKey, sessionId, nodeId) as StoredRef | undefined
    return row === undefined ? undefined : fromStored(row)
  }

  put(
    sessionKey: string,
    nodeId: string,
    ref: MessageRef,
    contentHash: string,
    sessionId = sessionKey,
  ): void {
    this.putProgress(sessionKey, sessionId, nodeId, contentHash, [{ ref, contentHash }], true, false)
  }

  putProgress(
    sessionKey: string,
    sessionId: string,
    nodeId: string,
    contentHash: string,
    parts: RefPart[],
    complete: boolean,
    isUpdate: boolean,
    activate = true,
  ): boolean {
    if (parts.length === 0 || this.closed) return false
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db
        .prepare(`INSERT INTO refs_v2
      (session_key, session_id, node_id, content_hash, parts_json, complete, is_update, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_key, session_id, node_id) DO UPDATE SET
        content_hash = excluded.content_hash,
        parts_json = excluded.parts_json,
        complete = excluded.complete,
        is_update = excluded.is_update,
        updated_at = excluded.updated_at`)
        .run(
          sessionKey,
          sessionId,
          nodeId,
          contentHash,
          JSON.stringify(parts),
          complete ? 1 : 0,
          isUpdate ? 1 : 0,
          this.clock(),
        )
      if (activate) {
        this.db
          .prepare(`INSERT INTO ref_sessions (session_key, session_id, retired_at)
        VALUES (?, ?, NULL)
        ON CONFLICT(session_key, session_id) DO UPDATE SET retired_at = NULL`)
          .run(sessionKey, sessionId)
      }
      this.db.exec('COMMIT')
      return true
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  forSession(sessionKey: string, sessionId = sessionKey): Map<string, DeliveryRefRow> {
    const rows = this.db
      .prepare(
        'SELECT node_id, content_hash, parts_json, complete, is_update FROM refs_v2 WHERE session_key = ? AND session_id = ? ORDER BY node_id',
      )
      .all(sessionKey, sessionId) as Array<StoredRef & { node_id: string }>
    return new Map(rows.map((row) => [row.node_id, fromStored(row)]))
  }

  retireSession(sessionKey: string, sessionId: string): void {
    if (this.closed) return
    this.db
      .prepare(`INSERT INTO ref_sessions (session_key, session_id, retired_at)
      VALUES (?, ?, ?)
      ON CONFLICT(session_key, session_id) DO UPDATE SET retired_at = excluded.retired_at`)
      .run(sessionKey, sessionId, this.clock())
  }

  /** Only explicitly retired session namespaces are eligible; stable active refs never age out. */
  gc(cutoffMs: number): number {
    if (this.closed) return 0
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = this.db
        .prepare(`DELETE FROM refs_v2
        WHERE EXISTS (
          SELECT 1 FROM ref_sessions s
          WHERE s.session_key = refs_v2.session_key
            AND s.session_id = refs_v2.session_id
            AND s.retired_at IS NOT NULL
            AND s.retired_at < ?
        )`)
        .run(cutoffMs)
      this.db
        .prepare(`DELETE FROM ref_sessions
        WHERE retired_at IS NOT NULL AND retired_at < ?
          AND NOT EXISTS (
            SELECT 1 FROM refs_v2 r
            WHERE r.session_key = ref_sessions.session_key AND r.session_id = ref_sessions.session_id
          )`)
        .run(cutoffMs)
      this.db.exec('COMMIT')
      return Number(result.changes)
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }
}

function fromStored(row: StoredRef): DeliveryRefRow {
  const parts = JSON.parse(row.parts_json) as RefPart[]
  const first = parts[0]
  if (first === undefined) throw new Error('outbound ref row has no parts')
  return {
    ref: first.ref,
    contentHash: row.content_hash,
    parts,
    complete: row.complete === 1,
    isUpdate: row.is_update === 1,
  }
}
