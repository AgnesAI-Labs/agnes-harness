import type { DatabaseSync } from 'node:sqlite'
import { CoreError } from '@agnes/core'

/** An atomic append watermark detects a removed tail. It never replaces full chain verification. */
export function assertStoredHead(db: DatabaseSync, key: string, seen = new Set<string>()): void {
  if (seen.has(key) || seen.size >= 64) throw new CoreError('E_LEDGER_INTEGRITY', 'invalid session ancestry')
  seen.add(key)
  const head = db.prepare('SELECT seq, digest FROM ledger_heads WHERE session_key = ?').get(key) as
    | { seq: number; digest: string | null }
    | undefined
  const tail = db
    .prepare(
      'SELECT seq, integrity_digest AS digest FROM events WHERE session_key = ? ORDER BY seq DESC LIMIT 1',
    )
    .get(key) as { seq: number; digest: string | null } | undefined
  if ((head || tail) && (!head || !tail || head.seq !== tail.seq || head.digest !== tail.digest))
    throw new CoreError('E_LEDGER_INTEGRITY', 'stored ledger head does not match its append watermark')
  const parent = db.prepare('SELECT parent_key FROM sessions WHERE session_key = ?').get(key) as
    | { parent_key: string | null }
    | undefined
  if (parent?.parent_key) assertStoredHead(db, parent.parent_key, seen)
}
