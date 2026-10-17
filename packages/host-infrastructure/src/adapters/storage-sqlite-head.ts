import type { DatabaseSync } from 'node:sqlite'
import { CoreError } from '@agnes/core'
import { preparedStatement } from './prepared-statements.js'

/** Earlier plugin-core ledgers have hash chains, but predate append watermarks. */
export function initializeStoredHeads(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    const columns = db.prepare('PRAGMA table_info(sessions)').all()
    if (!columns.some((column) => column.name === 'head_version')) {
      db.exec(
        'ALTER TABLE sessions ADD COLUMN head_version INTEGER NOT NULL DEFAULT 0 CHECK (head_version IN (0, 1))',
      )
      // Existing watermarks remain mandatory after this upgrade, even if later deleted.
      db.exec(
        'UPDATE sessions SET head_version = 1 WHERE session_key IN (SELECT session_key FROM ledger_heads)',
      )
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

/** Called inside the session creation/append transaction; never rewrites historical events. */
export function recordStoredHead(db: DatabaseSync, key: string, seq: number, digest: string | null): void {
  preparedStatement(
    db,
    'INSERT INTO ledger_heads (session_key, seq, digest) VALUES (?, ?, ?) ON CONFLICT(session_key) DO UPDATE SET seq = excluded.seq, digest = excluded.digest',
  ).run(key, seq, digest)
  preparedStatement(db, 'UPDATE sessions SET head_version = 1 WHERE session_key = ?').run(key)
}

/** An atomic append watermark detects a removed tail. It never replaces full chain verification. */
export function assertStoredHead(db: DatabaseSync, key: string, seen = new Set<string>()): void {
  if (seen.has(key) || seen.size >= 64) throw new CoreError('E_LEDGER_INTEGRITY', 'invalid session ancestry')
  seen.add(key)
  const head = preparedStatement(db, 'SELECT seq, digest FROM ledger_heads WHERE session_key = ?').get(key) as
    | { seq: number; digest: string | null }
    | undefined
  const tail = preparedStatement(
    db,
    'SELECT seq, integrity_digest AS digest FROM events WHERE session_key = ? ORDER BY seq DESC LIMIT 1',
  ).get(key) as { seq: number; digest: string | null } | undefined
  const session = preparedStatement(
    db,
    'SELECT parent_key, head_version FROM sessions WHERE session_key = ?',
  ).get(key) as { parent_key: string | null; head_version: number } | undefined
  if (
    !session ||
    (session.head_version !== 0 && session.head_version !== 1) ||
    (!head && session.head_version === 1) ||
    (head && (head.seq !== (tail?.seq ?? 0) || head.digest !== (tail?.digest ?? null)))
  )
    throw new CoreError('E_LEDGER_INTEGRITY', 'stored ledger head does not match its append watermark')
  // A version-zero history still goes through authoritative chain verification in SessionLog.open.
  if (session.parent_key) assertStoredHead(db, session.parent_key, seen)
}
