import type {
  CommandJournal,
  JournalBinding,
  JournalIdentity,
  JournalResult,
  JournalState,
} from '../local/ports.js'
import { ensure, type TableHandle } from './table.js'

type Row = {
  binding_algorithm: string
  binding_digest: string
  kind: string
  generation: number | null
  result: string | null
}

type AckRow = { result: string | null; acked_at: number | null }

const validDigest = (value: string): boolean => /^[0-9a-f]{64}$/.test(value)

const canonicalResult = (result: JournalResult): string => JSON.stringify(result)

const decodeResult = (text: string): JournalResult | undefined => {
  try {
    const value = JSON.parse(text) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    const row = value as Record<string, unknown>
    if (row.seq !== undefined && (!Number.isSafeInteger(row.seq) || (row.seq as number) < 1)) return undefined
    if (Object.keys(row).some((key) => key !== 'seq' && key !== 'result' && key !== 'compact'))
      return undefined
    if (row.compact !== undefined) {
      const compact = row.compact as Record<string, unknown>
      if (!compact || typeof compact !== 'object' || Array.isArray(compact)) return undefined
      if (compact.state === 'unknown') {
        if (Object.keys(compact).some((key) => key !== 'state')) return undefined
      } else if (
        (compact.state !== 'completed' && compact.state !== 'failed') ||
        !Number.isSafeInteger(compact.endSeq) ||
        (compact.endSeq as number) < 1 ||
        Object.keys(compact).some((key) => key !== 'state' && key !== 'endSeq')
      )
        return undefined
    }
    return value as JournalResult
  } catch {
    return undefined
  }
}

/** Durable server-side exactly-once admission journal. It stores hashes and receipts, never payloads. */
export class PersistentCommandJournal implements CommandJournal {
  constructor(
    private readonly table: TableHandle,
    private readonly clock: () => number = () => Date.now(),
    private readonly retentionMs = 24 * 3600_000,
  ) {
    if (!Number.isSafeInteger(retentionMs) || retentionMs <= 0)
      throw new RangeError('command journal retention must be a positive integer')
    ensure(
      table,
      `CREATE TABLE IF NOT EXISTS command_journal (
        principal_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        command_id TEXT NOT NULL,
        binding_algorithm TEXT NOT NULL,
        binding_digest TEXT NOT NULL,
        kind TEXT NOT NULL,
        generation INTEGER,
        received_at INTEGER NOT NULL,
        result TEXT,
        result_at INTEGER,
        acked_at INTEGER,
        PRIMARY KEY (principal_id, client_id, session_id, command_id)
      )`,
    )
    ensure(table, 'CREATE INDEX IF NOT EXISTS command_journal_acked_at ON command_journal (acked_at)')
  }

  async begin(identity: JournalIdentity, binding: JournalBinding): Promise<JournalState> {
    return this.table.transaction(() => {
      const existing = this.read(identity)
      if (!existing) {
        this.table.exec(
          `INSERT INTO command_journal
           (principal_id, client_id, session_id, command_id, binding_algorithm, binding_digest,
            kind, generation, received_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            identity.principalId,
            identity.clientId,
            identity.sessionId,
            identity.commandId,
            binding.algorithm,
            binding.digest,
            binding.kind,
            binding.generation,
            this.clock(),
          ],
        )
        return { state: 'new' }
      }
      if (
        existing.binding_algorithm !== 'agnes-command-jcs-sha256-v1' ||
        !validDigest(existing.binding_digest) ||
        (existing.generation !== null &&
          (!Number.isSafeInteger(existing.generation) || existing.generation < 1))
      )
        return { state: 'corrupt' }
      if (
        existing.binding_algorithm !== binding.algorithm ||
        existing.binding_digest !== binding.digest ||
        existing.kind !== binding.kind ||
        existing.generation !== binding.generation
      )
        return { state: 'conflict' }
      if (existing.result === null) return { state: 'uncertain' }
      const result = decodeResult(existing.result)
      return result ? { state: 'complete', result } : { state: 'corrupt' }
    })
  }

  async complete(identity: JournalIdentity, result: JournalResult): Promise<void> {
    this.table.transaction(() => {
      const existing = this.read(identity)
      if (!existing) throw new Error('command journal row missing at completion')
      const encoded = canonicalResult(result)
      if (existing.result !== null) {
        if (existing.result !== encoded) throw new Error('command journal receipt conflict')
        return
      }
      this.table.exec(
        `UPDATE command_journal SET result = ?, result_at = ?
         WHERE principal_id = ? AND client_id = ? AND session_id = ? AND command_id = ? AND result IS NULL`,
        [encoded, this.clock(), ...this.params(identity)],
      )
    })
  }

  async abandon(identity: JournalIdentity): Promise<void> {
    this.table.transaction(() => {
      this.table.exec(
        `DELETE FROM command_journal
         WHERE principal_id = ? AND client_id = ? AND session_id = ? AND command_id = ? AND result IS NULL`,
        this.params(identity),
      )
    })
  }

  async ack(identity: JournalIdentity): Promise<boolean> {
    return this.table.transaction(() => {
      const existing = this.table.get<AckRow>(
        `SELECT result, acked_at FROM command_journal
         WHERE principal_id = ? AND client_id = ? AND session_id = ? AND command_id = ?`,
        this.params(identity),
      )
      if (!existing || existing.result === null) return false
      if (existing.acked_at === null)
        this.table.exec(
          `UPDATE command_journal SET acked_at = ?
           WHERE principal_id = ? AND client_id = ? AND session_id = ? AND command_id = ?`,
          [this.clock(), ...this.params(identity)],
        )
      return true
    })
  }

  async gc(now: number): Promise<number> {
    return this.table.transaction(() => {
      const before = this.table.get<{ n: number }>(
        'SELECT COUNT(*) AS n FROM command_journal WHERE acked_at IS NOT NULL AND acked_at < ?',
        [now - this.retentionMs],
      )?.n
      this.table.exec('DELETE FROM command_journal WHERE acked_at IS NOT NULL AND acked_at < ?', [
        now - this.retentionMs,
      ])
      return before ?? 0
    })
  }

  private read(identity: JournalIdentity): Row | undefined {
    return this.table.get<Row>(
      `SELECT binding_algorithm, binding_digest, kind, generation, result FROM command_journal
       WHERE principal_id = ? AND client_id = ? AND session_id = ? AND command_id = ?`,
      this.params(identity),
    )
  }

  private params(identity: JournalIdentity): unknown[] {
    return [identity.principalId, identity.clientId, identity.sessionId, identity.commandId]
  }
}
