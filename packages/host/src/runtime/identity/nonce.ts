import type { DatabaseSync } from 'node:sqlite'

/** Internal durable owner operation; no SQL or transaction callback crosses the service SPI. */
export interface IdentityNonceOwner {
  consumePair(input: {
    clientId: string
    keyId: string
    nonce: string
    now: number
    expiresAt: number
  }): boolean
}

/** Replay owner for verified remote ingress proofs; consumed only after channel and signature checks. */
export function createIdentityIngressReplayOwner(database: DatabaseSync, now: () => number) {
  database.exec(
    'CREATE TABLE IF NOT EXISTS runtime_identity_ingress_replay (issuer TEXT NOT NULL,ingress TEXT NOT NULL,expires_at INTEGER NOT NULL,PRIMARY KEY(issuer,ingress))',
  )
  return (issuer: string, ingress: string, expiresAt: string): boolean => {
    const expiry = Date.parse(expiresAt)
    if (!issuer || !ingress || !Number.isSafeInteger(expiry) || expiry <= now()) return false
    database.exec('BEGIN IMMEDIATE')
    try {
      database.prepare('DELETE FROM runtime_identity_ingress_replay WHERE expires_at <= ?').run(now())
      const result = database
        .prepare('INSERT OR IGNORE INTO runtime_identity_ingress_replay VALUES (?,?,?)')
        .run(issuer, ingress, expiry)
      database.exec('COMMIT')
      return result.changes === 1
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }
}

/** Uses the original nonce table and keeps both old client and verified-key namespaces. */
export function createIdentityNonceOwner(database: DatabaseSync): IdentityNonceOwner {
  database.exec('BEGIN IMMEDIATE')
  try {
    database.exec(`CREATE TABLE IF NOT EXISTS auth_nonces (
      client_id TEXT NOT NULL, nonce TEXT NOT NULL, seen_at INTEGER NOT NULL,
      PRIMARY KEY (client_id, nonce)
    )`)
    const columns = database.prepare('PRAGMA table_info(auth_nonces)').all()
    if (!columns.some((column) => column.name === 'expires_at')) {
      database.exec('ALTER TABLE auth_nonces ADD COLUMN expires_at INTEGER')
      // Old rows did not retain the signed timestamp. Keep the full possible skew interval.
      database.exec('UPDATE auth_nonces SET expires_at = seen_at + 600000 WHERE expires_at IS NULL')
    }
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
  return {
    consumePair(input) {
      if (
        !/^[a-f0-9]{32}$/.test(input.nonce) ||
        !input.keyId ||
        !Number.isSafeInteger(input.now) ||
        input.now < 0 ||
        Object.is(input.now, -0) ||
        !Number.isSafeInteger(input.expiresAt) ||
        input.expiresAt <= input.now
      )
        throw new Error('invalid nonce admission')
      const namespaces = [...new Set([input.clientId, `source-key:${input.keyId}`])]
      database.exec('BEGIN IMMEDIATE')
      try {
        database
          .prepare('DELETE FROM auth_nonces WHERE COALESCE(expires_at, seen_at + 600000) <= ?')
          .run(input.now)
        const seen = database.prepare('SELECT 1 FROM auth_nonces WHERE client_id = ? AND nonce = ?')
        if (namespaces.some((namespace) => seen.get(namespace, input.nonce))) {
          database.exec('ROLLBACK')
          return false
        }
        const insert = database.prepare(
          'INSERT INTO auth_nonces (client_id, nonce, seen_at, expires_at) VALUES (?, ?, ?, ?)',
        )
        for (const namespace of namespaces) insert.run(namespace, input.nonce, input.now, input.expiresAt)
        database.exec('COMMIT')
        return true
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    },
  }
}
