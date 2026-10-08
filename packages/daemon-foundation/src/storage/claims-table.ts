import type { ClaimStore } from '../local/ports.js'
import { ensure, type TableHandle } from './table.js'

const CLAIMS_DDL = `CREATE TABLE IF NOT EXISTS auth_claims (
  bucket TEXT NOT NULL,
  value TEXT NOT NULL,
  kind TEXT NOT NULL,
  at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
)`

const NONCES_DDL = `CREATE TABLE IF NOT EXISTS auth_nonces (
  client_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  seen_at INTEGER NOT NULL,
  PRIMARY KEY (client_id, nonce)
)`

/** Persistent counterpart to MemoryClaims. The caller supplies the server-derived bucket, which
 * includes auth kind, principal, and claim kind; values alone are never a global namespace. */
export class TableClaims implements ClaimStore {
  constructor(private readonly table: TableHandle) {
    ensure(table, CLAIMS_DDL)
    ensure(table, 'CREATE INDEX IF NOT EXISTS auth_claims_bv ON auth_claims (bucket, value)')
  }

  async once(bucket: string, value: string, expiresAtMs: number, now: number): Promise<boolean> {
    return this.table.transaction(() => {
      const live =
        this.table.get<{ n: number }>(
          `SELECT COUNT(*) AS n FROM auth_claims
           WHERE bucket = ? AND value = ? AND kind = 'once' AND expires_at > ?`,
          [bucket, value, now],
        )?.n ?? 0
      if (live > 0) return false
      this.table.exec(
        `INSERT INTO auth_claims (bucket, value, kind, at, expires_at)
         VALUES (?, ?, 'once', ?, ?)`,
        [bucket, value, now, expiresAtMs],
      )
      return true
    })
  }

  async withinRateLimit(
    bucket: string,
    value: string,
    limit: number,
    windowMs: number,
    now: number,
  ): Promise<{ granted: boolean; slot: number }> {
    return this.table.transaction(() => {
      const count =
        this.table.get<{ n: number }>(
          `SELECT COUNT(*) AS n FROM auth_claims
           WHERE bucket = ? AND value = ? AND kind = 'rate' AND at > ?`,
          [bucket, value, now - windowMs],
        )?.n ?? 0
      if (count >= limit) return { granted: false, slot: count }
      this.table.exec(
        `INSERT INTO auth_claims (bucket, value, kind, at, expires_at)
         VALUES (?, ?, 'rate', ?, ?)`,
        [bucket, value, now, now + windowMs],
      )
      return { granted: true, slot: count + 1 }
    })
  }

  /** `expires_at` is an exclusive upper bound: at that exact instant a row is already stale. */
  gc(now: number): number {
    const expired =
      this.table.get<{ n: number }>('SELECT COUNT(*) AS n FROM auth_claims WHERE expires_at <= ?', [now])
        ?.n ?? 0
    if (expired > 0) this.table.exec('DELETE FROM auth_claims WHERE expires_at <= ?', [now])
    return expired
  }
}

/** Durable source-auth replay window. `client_id` is the legacy SQL column name; callers now pass
 * both the legacy client label and the verified key fingerprint during migration. Each namespace
 * is consumed atomically so competing verifications cannot both accept it. */
export class NonceTable {
  constructor(private readonly table: TableHandle) {
    ensure(table, NONCES_DDL)
  }

  consume(clientId: string, nonce: string, now: number, windowMs = 300_000): boolean {
    return this.table.transaction(() => {
      this.table.exec('DELETE FROM auth_nonces WHERE seen_at < ?', [now - windowMs])
      const seen = this.table.get('SELECT 1 FROM auth_nonces WHERE client_id = ? AND nonce = ?', [
        clientId,
        nonce,
      ])
      if (seen) return false
      this.table.exec('INSERT INTO auth_nonces (client_id, nonce, seen_at) VALUES (?, ?, ?)', [
        clientId,
        nonce,
        now,
      ])
      return true
    })
  }
}

/** Starts the production expiry sweep and returns an idempotent shutdown hook. */
export function startClaimsGc(
  claims: Pick<TableClaims, 'gc'>,
  clock: () => number,
  intervalMs = 30_000,
): () => void {
  claims.gc(clock())
  const timer = setInterval(() => claims.gc(clock()), intervalMs)
  timer.unref()
  let stopped = false
  return () => {
    if (stopped) return
    stopped = true
    clearInterval(timer)
  }
}
