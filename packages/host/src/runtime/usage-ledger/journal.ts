import { closeSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { jcs } from '@agnes/protocol'
import { type AttemptRef, canonicalJsonDigest, validateRuntime } from '@agnes/protocol/runtime'
import { createPrivateDirectorySync, createPrivateFileSync } from '@agnes/system-node'

export class UsageLedgerConflict extends Error {}
/** Delivery journal only: no balances, prices, credentials or authorization decisions. */
export function openUsageLedgerJournal(path: string) {
  if (!existsSync(dirname(path))) createPrivateDirectorySync(dirname(path))
  if (!existsSync(path)) closeSync(createPrivateFileSync(path))
  const db = new DatabaseSync(path)
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS deliveries (
      attempt TEXT PRIMARY KEY, effect TEXT UNIQUE NOT NULL, fingerprint TEXT NOT NULL,
      request TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0
    );`)
  return {
    prepare(attempt: AttemptRef, effect: string, fingerprint: string) {
      const key = canonicalJsonDigest(attempt)
      db.prepare('INSERT OR IGNORE INTO deliveries(attempt,effect,fingerprint,request) VALUES(?,?,?,?)').run(
        key,
        effect,
        fingerprint,
        jcs(attempt),
      )
      const old = db
        .prepare('SELECT fingerprint,done FROM deliveries WHERE attempt=? AND effect=?')
        .get(key, effect)
      if (!old || old.fingerprint !== fingerprint) throw new UsageLedgerConflict('delivery changed')
      return old.done === 1
    },
    complete(attempt: AttemptRef) {
      db.prepare('UPDATE deliveries SET done=1 WHERE attempt=?').run(canonicalJsonDigest(attempt))
    },
    pending(): AttemptRef[] {
      return db
        .prepare('SELECT request FROM deliveries WHERE done=0 ORDER BY attempt')
        .all()
        .map((row) => {
          const parsed = validateRuntime('AttemptRef', JSON.parse(String(row.request)))
          if (!parsed.ok) throw new Error('corrupt usage delivery journal')
          return parsed.value
        })
    },
    close: () => db.close(),
  }
}
