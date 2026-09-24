import { randomBytes } from 'node:crypto'
import { ensure, type TableHandle } from './table.js'

const DDL = `CREATE TABLE IF NOT EXISTS source_auth_keyring_v3 (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  current_credential_id TEXT NOT NULL,
  current_key_id TEXT NOT NULL,
  previous_credential_id TEXT,
  previous_key_id TEXT,
  rotated_at INTEGER NOT NULL
)`

type Row = {
  current_credential_id: string
  current_key_id: string
  previous_credential_id: string | null
  previous_key_id: string | null
  rotated_at: number
}

export type SourceAuthCredential = { credentialId: string; secret: string }

const keyId = () => randomBytes(16).toString('hex')

/**
 * Persists only non-secret credential references and random opaque key ids. Secret material,
 * including hashes or MACs that could serve as offline password verifiers, never crosses this
 * storage boundary.
 */
export class SourceAuthRotation {
  private readonly migratedFromVerifier: boolean
  private readonly migratedCurrentKeyId: string | undefined

  constructor(private readonly table: TableHandle) {
    // v2 contained a salted verifier. Remove it during migration instead of retaining material that
    // can be used to test guesses offline. Creating v3 and dropping v2 are one transaction so a
    // failed migration cannot destroy the only durable rotation marker.
    this.migratedFromVerifier = !!table.get(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'source_auth_keyring_v2'",
    )
    let v2Current: unknown
    if (this.migratedFromVerifier)
      try {
        // Do not use PRAGMA-based schema introspection: Host's package-table security boundary
        // deliberately refuses every PRAGMA. Older/incomplete v2 shapes simply have no id to carry.
        v2Current = table.get<{ current_key_id?: unknown }>(
          'SELECT current_key_id FROM source_auth_keyring_v2 WHERE singleton = 1',
        )?.current_key_id
      } catch (error) {
        if (!String(error).includes('no such column: current_key_id')) throw error
        v2Current = undefined
      }
    this.migratedCurrentKeyId =
      typeof v2Current === 'string' && /^[0-9a-f]{32}$/.test(v2Current) ? v2Current : undefined
    table.transaction(() => {
      ensure(table, DDL)
      table.exec('DROP TABLE IF EXISTS source_auth_keyring_v2')
    })
  }

  configure(configured: readonly SourceAuthCredential[], now: number): void {
    const current = configured[0]
    if (!current) return
    this.table.transaction(() => {
      const row = this.row()
      if (!row) {
        // v2 cannot be retained because its verifier enables offline guessing. Its previous-key age
        // also cannot be trusted after removal, so fail closed instead of granting a configured
        // second key a fresh grace window during migration.
        const previous = this.migratedFromVerifier ? undefined : configured[1]
        this.table.exec(
          `INSERT INTO source_auth_keyring_v3
           (singleton, current_credential_id, current_key_id, previous_credential_id, previous_key_id, rotated_at)
           VALUES (1, ?, ?, ?, ?, ?)`,
          [
            current.credentialId,
            this.migratedCurrentKeyId ?? keyId(),
            previous?.credentialId ?? null,
            previous ? keyId() : null,
            now,
          ],
        )
        return
      }
      if (row.current_credential_id === current.credentialId) return
      this.table.exec(
        `UPDATE source_auth_keyring_v3
         SET current_credential_id = ?, current_key_id = ?, previous_credential_id = ?,
             previous_key_id = ?, rotated_at = ?
         WHERE singleton = 1`,
        [current.credentialId, keyId(), row.current_credential_id, row.current_key_id, now],
      )
    })
  }

  accepted(
    configured: readonly SourceAuthCredential[],
    now: number,
    graceMs: number,
  ): Array<{ secret: string; keyId: string }> {
    const row = this.row()
    const current = configured[0]
    if (!row || !current || current.credentialId !== row.current_credential_id) return []
    const accepted = [{ secret: current.secret, keyId: row.current_key_id }]
    const previous = configured[1]
    if (
      previous &&
      previous.credentialId === row.previous_credential_id &&
      row.previous_key_id &&
      graceMs > 0 &&
      now < row.rotated_at + graceMs
    )
      accepted.push({ secret: previous.secret, keyId: row.previous_key_id })
    return accepted
  }

  private row(): Row | undefined {
    return this.table.get<Row>(
      `SELECT current_credential_id, current_key_id, previous_credential_id, previous_key_id, rotated_at
       FROM source_auth_keyring_v3 WHERE singleton = 1`,
    )
  }
}
