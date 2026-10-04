import type { DatabaseSync } from 'node:sqlite'
import { CoreError } from '@agnes/core'

/** A durable acquisition identity, independent of reclaimable writer-lease generations. */
export interface SessionOwnerIdentity {
  sessionKey: string
  writerRunId: string
  ownerEpoch: number
}
export interface SessionOwnerEvidence {
  owner: SessionOwnerIdentity
  closed?: { finalSeq: number }
}
export interface SessionOwnerEvidenceStore {
  readSessionOwnerEvidence(sessionKey: string): SessionOwnerEvidence | undefined
  /** Host calls only after this exact owner's runtime, descendants and capabilities have drained. */
  recordSessionOwnerClosed(owner: SessionOwnerIdentity, finalSeq: number): Promise<void>
}

export function sqliteSessionOwnerEvidence(
  db: DatabaseSync,
  tx: <T>(fn: () => T) => T,
  head: (key: string) => number,
) {
  const get = db.prepare('SELECT * FROM session_owner_evidence WHERE session_key=?')
  function readSessionOwnerEvidence(sessionKey: string): SessionOwnerEvidence | undefined {
    const row = get.get(sessionKey)
    if (!row) return undefined
    return {
      owner: { sessionKey, writerRunId: String(row.writer_run_id), ownerEpoch: Number(row.owner_epoch) },
      ...(row.closed_final_seq === null ? {} : { closed: { finalSeq: Number(row.closed_final_seq) } }),
    }
  }
  return {
    readSessionOwnerEvidence,
    /** Invoked inside the SAME FULL transaction as storage.open's writer acquisition. */
    acquired(sessionKey: string, writerRunId: string): number {
      const ownerEpoch = (readSessionOwnerEvidence(sessionKey)?.owner.ownerEpoch ?? 0) + 1
      if (!Number.isSafeInteger(ownerEpoch)) throw new CoreError('E_STORAGE_FAULT', 'Owner epoch exhausted')
      const inserted = db
        .prepare(`INSERT INTO session_owner_evidence(session_key,writer_run_id,owner_epoch,closed_final_seq)
        VALUES(?,?,?,NULL) ON CONFLICT(session_key) DO UPDATE SET
        writer_run_id=excluded.writer_run_id,owner_epoch=excluded.owner_epoch,closed_final_seq=NULL`)
        .run(sessionKey, writerRunId, ownerEpoch)
      if (Number(inserted.changes) !== 1)
        throw new CoreError('E_STORAGE_FAULT', 'Owner acquisition was not recorded')
      return ownerEpoch
    },
    async recordSessionOwnerClosed(owner: SessionOwnerIdentity, finalSeq: number): Promise<void> {
      if (
        !Number.isSafeInteger(owner.ownerEpoch) ||
        owner.ownerEpoch < 1 ||
        !Number.isSafeInteger(finalSeq) ||
        finalSeq < 0
      )
        throw new CoreError('E_ENVELOPE', 'Invalid owner close head')
      db.exec('PRAGMA synchronous=FULL; PRAGMA fullfsync=ON')
      try {
        tx(() => {
          const current = readSessionOwnerEvidence(owner.sessionKey)
          if (
            !current ||
            current.owner.writerRunId !== owner.writerRunId ||
            current.owner.ownerEpoch !== owner.ownerEpoch
          )
            throw new CoreError('E_WRITER_LEASE', 'Owner close identity is no longer current')
          // Exact repeats remain usable even after a later authorized purge removed the ledger.
          if (current.closed) {
            if (current.closed.finalSeq !== finalSeq)
              throw new CoreError('E_RELATION', 'Owner close head conflicts')
            return
          }
          if (
            !db.prepare('SELECT 1 FROM sessions WHERE session_key=?').get(owner.sessionKey) ||
            db.prepare('SELECT 1 FROM writer_claims WHERE session_key=?').get(owner.sessionKey) ||
            head(owner.sessionKey) !== finalSeq
          )
            throw new CoreError('E_RELATION', 'Owner close requires the exact released ledger head')
          // Sealed retirement members cannot later reopen to consume pending state. Do not
          // publish a close receipt that the exact tree proof can never accept.
          if (
            db.prepare('SELECT 1 FROM session_retirement_members WHERE session_key=?').get(owner.sessionKey)
          )
            for (const row of db
              .prepare(
                "SELECT register,data FROM registers WHERE session_key=? AND register IN ('op.state','inbox')",
              )
              .all(owner.sessionKey)) {
              if (row.register === 'op.state' && row.data !== 'null')
                throw new CoreError('E_RELATION', 'Sealed owner has active program state')
              if (row.register === 'inbox') {
                const data = JSON.parse(String(row.data)) as { items?: unknown } | null
                if (!Array.isArray(data?.items) || data.items.length)
                  throw new CoreError('E_RELATION', 'Sealed owner has pending input')
              }
            }
          const recorded = db
            .prepare(
              'UPDATE session_owner_evidence SET closed_final_seq=? WHERE session_key=? AND owner_epoch=?',
            )
            .run(finalSeq, owner.sessionKey, owner.ownerEpoch)
          if (Number(recorded.changes) !== 1)
            throw new CoreError('E_STORAGE_FAULT', 'Owner closure was not recorded')
        })
      } finally {
        db.exec('PRAGMA synchronous=NORMAL')
      }
    },
  }
}
