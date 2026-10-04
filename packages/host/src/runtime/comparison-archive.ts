import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { type IntegrityRow, verifyIntegrityRows } from '@agnes/core'
import type { ComparisonRecord, Side } from '@agnes/runtime-comparison'
import { ARTIFACT_REF_EXTRACTOR_VERSION, collectLedgerDigests } from '../artifact-ledger-refs.js'
import { comparisonTransaction } from './comparison-journal-store.js'
import { ComparisonJournalError } from './comparison-journal-types.js'

export interface ComparisonArchiveManifest {
  sessionId: string
  epoch: number
  throughSeq: number
  digest: string
  bytes: number
}

const digest = (text: string) => createHash('sha256').update(text).digest('hex')
const fail = (message: string): never => {
  throw new ComparisonJournalError('COMPARISON_ARCHIVE_INVALID', message)
}
const validSeq = (seq: number) => Number.isSafeInteger(seq) && seq >= 0
// Independent archive safety limit; it is not the smaller per-view projection budget.
const MAX_BYTES = 256 * 1024 * 1024
const MAX_EVENTS = 100_000

/** Private, complete root-ledger snapshots. Admission/owner closure must precede capture. */
export function createComparisonArchive(
  db: DatabaseSync,
  readRecord: (principal: string, id: string) => ComparisonRecord | undefined,
) {
  db.exec(`CREATE TABLE IF NOT EXISTS comparison_archives (
    principal TEXT NOT NULL, id TEXT NOT NULL, side TEXT NOT NULL,
    session_id TEXT NOT NULL, epoch INTEGER NOT NULL, through_seq INTEGER NOT NULL,
    digest TEXT NOT NULL, bytes INTEGER NOT NULL, body TEXT NOT NULL,
    roots TEXT NOT NULL, roots_digest TEXT NOT NULL, roots_version TEXT NOT NULL,
    PRIMARY KEY(principal,id,side))`)
  const get = db.prepare('SELECT * FROM comparison_archives WHERE principal=? AND id=? AND side=?')
  const insert = db.prepare(`INSERT INTO comparison_archives
    (principal,id,side,session_id,epoch,through_seq,digest,bytes,body,roots,roots_digest,roots_version) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
  function read(principal: string, id: string, side: Side) {
    const raw = get.get(principal, id, side)
    if (!raw) return undefined
    const body = String(raw.body)
    if (Buffer.byteLength(body) !== Number(raw.bytes) || digest(body) !== raw.digest)
      fail('Archive checksum mismatch')
    const rows = JSON.parse(body) as IntegrityRow[]
    const throughSeq = Number(raw.through_seq)
    if (!Array.isArray(rows) || rows.length !== throughSeq || !validSeq(throughSeq))
      fail('Archive prefix is incomplete')
    for (const [index, row] of rows.entries())
      if (row.event?.seq !== index + 1 || row.sessionKey !== raw.session_id)
        fail('Archive sequence is invalid')
    verifyIntegrityRows(rows)
    return {
      manifest: {
        sessionId: String(raw.session_id),
        epoch: Number(raw.epoch),
        throughSeq,
        digest: String(raw.digest),
        bytes: Number(raw.bytes),
      } satisfies ComparisonArchiveManifest,
      rows,
    }
  }
  return {
    scoped(principal: string) {
      return {
        /** Only a matching permanent retirement can publish an immutable archive. */
        write(
          id: string,
          side: Side,
          input: { sessionId: string; epoch: number; throughSeq: number; rows: readonly IntegrityRow[] },
        ): ComparisonArchiveManifest {
          if (
            !validSeq(input.epoch) ||
            !validSeq(input.throughSeq) ||
            input.throughSeq === 0 ||
            input.throughSeq > MAX_EVENTS ||
            input.rows.length !== input.throughSeq
          )
            fail('Archive must contain the entire bounded prefix')
          for (const [index, row] of input.rows.entries())
            if (row.event.seq !== index + 1 || row.sessionKey !== input.sessionId)
              fail('Archive sequence is invalid')
          verifyIntegrityRows(input.rows)
          const body = JSON.stringify(input.rows)
          const bytes = Buffer.byteLength(body)
          if (bytes > MAX_BYTES) fail('Archive exceeds its storage limit; retain the live ledger')
          const manifest = {
            sessionId: input.sessionId,
            epoch: input.epoch,
            throughSeq: input.throughSeq,
            digest: digest(body),
            bytes,
          }
          const roots = new Set<string>()
          for (const row of input.rows) collectLedgerDigests(row.event.data, roots)
          const rootEvidence = JSON.stringify([...roots].sort())
          return comparisonTransaction(db, () => {
            const record = readRecord(principal, id)
            if (
              !record?.retirement ||
              !['releasing', 'released'].includes(record.retirement.state) ||
              record.retirement.epoch !== input.epoch ||
              record.lanes[side]?.sessionId !== input.sessionId
            )
              fail('Archive does not match a retired comparison lane')
            const published = db
              .prepare(
                'SELECT body FROM comparison_journal WHERE principal=? AND id=? ORDER BY seq DESC LIMIT 1',
              )
              .get(principal, id)
            const cut = published
              ? (JSON.parse(String(published.body)) as { cuts: Record<Side, number> }).cuts[side]
              : 0
            const laneHead = record?.lanes[side]?.lastSeq ?? -1
            if (!validSeq(cut) || !validSeq(laneHead) || input.throughSeq < Math.max(cut, laneHead))
              fail('Archive must cover all published history')
            const previous = read(principal, id, side)
            if (previous) {
              if (JSON.stringify(previous.manifest) !== JSON.stringify(manifest))
                fail('An archive cannot be replaced with another prefix')
              return previous.manifest
            }
            insert.run(
              principal,
              id,
              side,
              input.sessionId,
              input.epoch,
              input.throughSeq,
              manifest.digest,
              bytes,
              body,
              rootEvidence,
              digest(`${ARTIFACT_REF_EXTRACTOR_VERSION}\n${manifest.digest}\n${rootEvidence}`),
              ARTIFACT_REF_EXTRACTOR_VERSION,
            )
            return manifest
          })
        },
        read(id: string, side: Side) {
          return read(principal, id, side)
        },
        /** Retained images remain GC roots even after their live ledger has been removed. */
        artifactRoots(id: string): ReadonlySet<string> {
          const found = new Set<string>()
          for (const side of ['left', 'right'] as const)
            for (const row of read(principal, id, side)?.rows ?? [])
              collectLedgerDigests(row.event.data, found)
          return found
        },
      }
    },
  }
}
