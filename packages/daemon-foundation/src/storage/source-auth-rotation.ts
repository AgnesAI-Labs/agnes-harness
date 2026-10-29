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
  constructor(private readonly table: TableHandle) {
    if (
      table.get(
        "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'source_auth_keyring_v2'",
      )
    )
      throw new Error(
        'E_DATA_DIR_STALE: source_auth_keyring_v2 found in the daemon tables; back up and delete the data directory',
      )
    ensure(table, DDL)
  }

  configure(configured: readonly SourceAuthCredential[], now: number): void {
    const current = configured[0]
    if (!current) return
    this.table.transaction(() => {
      const row = this.row()
      if (!row) {
        const previous = configured[1]
        this.table.exec(
          `INSERT INTO source_auth_keyring_v3
           (singleton, current_credential_id, current_key_id, previous_credential_id, previous_key_id, rotated_at)
           VALUES (1, ?, ?, ?, ?, ?)`,
          [current.credentialId, keyId(), previous?.credentialId ?? null, previous ? keyId() : null, now],
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
