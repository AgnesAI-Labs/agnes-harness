import type { DatabaseSync } from 'node:sqlite'
import type { VerifiedHead } from '@agnes/core-ledger/log/verified-head'

export const VERIFIED_HEAD_DDL = `CREATE TABLE IF NOT EXISTS ledger_verified_head_v1 (
  session_key TEXT PRIMARY KEY, through_seq INTEGER NOT NULL, head_digest TEXT NOT NULL,
  legacy_through_seq INTEGER NOT NULL, algorithm TEXT NOT NULL, verified_full_at_ms INTEGER NOT NULL,
  written_at_ms INTEGER NOT NULL, checkpoint_digest TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ledger_integrity_failure_v1 (session_key TEXT PRIMARY KEY, seq INTEGER)`

type Row = {
  session_key: string
  through_seq: number
  head_digest: string
  legacy_through_seq: number
  algorithm: string
  verified_full_at_ms: number
  written_at_ms: number
  checkpoint_digest: string
}

/**
 * Where a full verification has reached, per session: a position in the ledger, never folded state
 * (the old fold cache was removed on purpose). Core checks a checkpoint against the stored rows
 * before it uses one, so this store only has to keep the furthest one it was given.
 */
export function verifiedHeadStore(
  db: DatabaseSync,
  parentOf: (key: string) => { key: string; boundarySeq: number } | undefined,
) {
  const failure = db.prepare('SELECT seq FROM ledger_integrity_failure_v1 WHERE session_key = ?')
  const seal = db.prepare('INSERT OR IGNORE INTO ledger_integrity_failure_v1 VALUES (?, ?)')
  const read = db.prepare('SELECT * FROM ledger_verified_head_v1 WHERE session_key = ?')
  // Only forward, in the one statement, so two writers racing cannot move it back.
  const upsert = db.prepare(`INSERT INTO ledger_verified_head_v1 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_key) DO UPDATE SET through_seq = excluded.through_seq, head_digest = excluded.head_digest,
      legacy_through_seq = excluded.legacy_through_seq, algorithm = excluded.algorithm,
      verified_full_at_ms = excluded.verified_full_at_ms, written_at_ms = excluded.written_at_ms,
      checkpoint_digest = excluded.checkpoint_digest
    WHERE excluded.through_seq >= ledger_verified_head_v1.through_seq OR ?`)
  const remove = db.prepare('DELETE FROM ledger_verified_head_v1 WHERE session_key = ?')
  const digestAt = db.prepare('SELECT integrity_digest FROM events WHERE session_key = ? AND seq = ?')
  const integrityDigestAt = (key: string, seq: number): string | null | undefined => {
    const own = digestAt.get(key, seq) as { integrity_digest: string | null } | undefined
    if (own) return own.integrity_digest
    // A child stores none of its parent's rows: its prefix is read from the parent, up to the boundary.
    const parent = parentOf(key)
    return parent && seq <= parent.boundarySeq ? integrityDigestAt(parent.key, seq) : undefined
  }
  return {
    async readIntegrityFailure(key: string): Promise<{ seq?: number } | undefined> {
      const row = failure.get(key) as { seq: number | null } | undefined
      return row ? (row.seq === null ? {} : { seq: row.seq }) : undefined
    },
    async writeIntegrityFailure(key: string, value: { seq?: number }): Promise<void> {
      seal.run(key, value.seq ?? null)
    },
    async readVerifiedHead(key: string): Promise<VerifiedHead | undefined> {
      const r = read.get(key) as Row | undefined
      return (
        r && {
          sessionKey: r.session_key,
          throughSeq: r.through_seq,
          headDigest: r.head_digest,
          legacyThroughSeq: r.legacy_through_seq,
          algorithm: r.algorithm as VerifiedHead['algorithm'],
          verifiedFullAtMs: r.verified_full_at_ms,
          writtenAtMs: r.written_at_ms,
          checkpointDigest: r.checkpoint_digest,
        }
      )
    },
    async writeVerifiedHead(h: VerifiedHead, opts?: { force?: boolean }): Promise<void> {
      upsert.run(
        h.sessionKey,
        h.throughSeq,
        h.headDigest,
        h.legacyThroughSeq,
        h.algorithm,
        h.verifiedFullAtMs,
        h.writtenAtMs,
        h.checkpointDigest,
        opts?.force ? 1 : 0,
      )
    },
    async deleteVerifiedHead(key: string): Promise<void> {
      remove.run(key)
    },
    async integrityDigestAt(key: string, seq: number): Promise<string | null | undefined> {
      return integrityDigestAt(key, seq)
    },
  }
}
