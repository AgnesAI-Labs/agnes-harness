import type { DatabaseSync } from 'node:sqlite'
import { CoreError } from '@agnes/core'
import { preparedStatement } from './prepared-statements.js'

/** Called inside the session creation/append transaction; never rewrites historical events. */
export function recordStoredHead(db: DatabaseSync, key: string, seq: number, digest: string | null): void {
  preparedStatement(
    db,
    'UPDATE sessions SET head_version = 1, head_seq = ?, head_digest = ? WHERE session_key = ?',
  ).run(seq, digest, key)
}

/** An atomic append watermark detects a removed tail. It never replaces full chain verification. */
export function assertStoredHead(db: DatabaseSync, key: string, seen = new Set<string>()): void {
  if (seen.has(key) || seen.size >= 64) throw new CoreError('E_LEDGER_INTEGRITY', 'invalid session ancestry')
  seen.add(key)
  const session = preparedStatement(
    db,
    'SELECT parent_key, head_version, head_seq, head_digest FROM sessions WHERE session_key = ?',
  ).get(key) as
    | { parent_key: string | null; head_version: number; head_seq: number | null; head_digest: string | null }
    | undefined
  const tail = preparedStatement(
    db,
    'SELECT seq, integrity_digest AS digest FROM events WHERE session_key = ? ORDER BY seq DESC LIMIT 1',
  ).get(key) as { seq: number; digest: string | null } | undefined
  if (
    !session ||
    (session.head_version !== 0 && session.head_version !== 1) ||
    (session.head_seq === null && session.head_version === 1) ||
    (session.head_seq !== null &&
      (session.head_seq !== (tail?.seq ?? 0) || session.head_digest !== (tail?.digest ?? null)))
  )
    throw new CoreError('E_LEDGER_INTEGRITY', 'stored ledger head does not match its append watermark')
  // A version-zero history still goes through authoritative chain verification in SessionLog.open.
  if (session.parent_key) assertStoredHead(db, session.parent_key, seen)
}
