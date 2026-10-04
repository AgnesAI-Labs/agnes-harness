import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { type IntegrityRow, verifyIntegrityRows } from '@agnes/core'
import type { ComparisonRecord, Side } from '@agnes/runtime-comparison'
import type { ClosedSessionTree } from '../adapters/session-retirement-proof.js'
import { ARTIFACT_REF_EXTRACTOR_VERSION, collectLedgerDigests } from '../artifact-ledger-refs.js'
import { comparisonTransaction } from './comparison-journal-store.js'
import { ComparisonJournalError } from './comparison-journal-types.js'

export interface ComparisonTreeArchive {
  proof: Omit<ClosedSessionTree, 'purged'>
  members: Array<{ sessionKey: string; rows: IntegrityRow[] }>
}
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
function fail(message: string): never {
  throw new ComparisonJournalError('COMPARISON_ARCHIVE_INVALID', message)
}
function validate(value: ComparisonTreeArchive): void {
  if (
    !value?.proof?.rootSessionKey ||
    !value.proof.retirementId ||
    !Number.isSafeInteger(value.proof.epoch) ||
    value.proof.epoch < 0 ||
    !Array.isArray(value.members) ||
    !Array.isArray(value.proof.members) ||
    value.members.length !== value.proof.members.length ||
    value.members.length === 0
  )
    fail('Tree archive membership is incomplete')
  const keys = new Set(value.members.map((member) => member.sessionKey))
  if (
    new Set(value.proof.members.map((member) => member.sessionKey)).size !== value.proof.members.length ||
    keys.size !== value.members.length ||
    !keys.has(value.proof.rootSessionKey)
  )
    fail('Tree archive membership conflicts')
  for (const member of value.proof.members) {
    const source = value.members.find((row) => row.sessionKey === member.sessionKey)
    if (
      !source ||
      !member.owner?.writerRunId ||
      !Number.isSafeInteger(member.finalSeq) ||
      member.finalSeq < 0 ||
      (member.sessionKey === value.proof.rootSessionKey
        ? member.kind !== 'root' || member.parentKey !== null
        : member.kind !== 'delegated' || member.parentKey === null) ||
      !Array.isArray(source.rows) ||
      source.rows.length !== member.finalSeq ||
      member.owner.sessionKey !== member.sessionKey ||
      !Number.isSafeInteger(member.owner.ownerEpoch) ||
      member.owner.ownerEpoch < 1
    )
      fail('Tree archive does not match owner final heads')
    const allowed = new Set<string>([member.sessionKey])
    let cursor = member
    while (cursor.parentKey !== null) {
      const parent = value.proof.members.find((row) => row.sessionKey === cursor.parentKey)
      if (!parent || allowed.has(parent.sessionKey)) fail('Tree archive lineage is invalid')
      allowed.add(parent.sessionKey)
      cursor = parent
    }
    if (cursor.sessionKey !== value.proof.rootSessionKey) fail('Tree archive root is invalid')
    for (const [index, row] of source.rows.entries())
      if (row.event.seq !== index + 1 || !allowed.has(row.sessionKey))
        fail('Tree archive physical source is invalid')
    verifyIntegrityRows(source.rows)
  }
}

/** Complete delegated histories, including fresh children and inherited physical prefix rows. */
export function createComparisonTreeArchive(
  db: DatabaseSync,
  readRecord: (principal: string, id: string) => ComparisonRecord | undefined,
) {
  db.exec(`CREATE TABLE IF NOT EXISTS comparison_tree_archives (
    principal TEXT NOT NULL,id TEXT NOT NULL,side TEXT NOT NULL,digest TEXT NOT NULL,
    bytes INTEGER NOT NULL,body TEXT NOT NULL,roots TEXT NOT NULL,roots_digest TEXT NOT NULL,
    roots_version TEXT NOT NULL,PRIMARY KEY(principal,id,side))`)
  return {
    scoped(principal: string) {
      function read(id: string, side: Side): ComparisonTreeArchive | undefined {
        const row = db
          .prepare('SELECT * FROM comparison_tree_archives WHERE principal=? AND id=? AND side=?')
          .get(principal, id, side)
        if (!row) return undefined
        const body = String(row.body)
        if (Buffer.byteLength(body) !== row.bytes || hash(body) !== row.digest)
          fail('Tree archive checksum mismatch')
        const value = JSON.parse(body) as ComparisonTreeArchive
        validate(value)
        return value
      }
      return {
        read,
        write(id: string, side: Side, value: ComparisonTreeArchive): void {
          validate(value)
          const body = JSON.stringify(value)
          if (
            Buffer.byteLength(body) > 256 * 1024 * 1024 ||
            value.members.reduce((n, member) => n + member.rows.length, 0) > 100_000
          )
            fail('Tree archive exceeds its explicit storage limit')
          const roots = new Set<string>()
          for (const member of value.members)
            for (const row of member.rows) collectLedgerDigests(row.event.data, roots)
          const rootEvidence = JSON.stringify([...roots].sort())
          const digest = hash(body)
          comparisonTransaction(db, () => {
            const record = readRecord(principal, id)
            if (
              !record?.retirement ||
              !['releasing', 'released'].includes(record.retirement.state) ||
              record.retirement.epoch !== value.proof.epoch ||
              record.lanes[side]?.sessionId !== value.proof.rootSessionKey
            )
              fail('Tree archive does not match comparison retirement')
            const previous = read(id, side)
            if (previous) {
              if (JSON.stringify(previous) !== body) fail('Tree archive cannot be replaced')
              return
            }
            db.prepare(`INSERT INTO comparison_tree_archives
              (principal,id,side,digest,bytes,body,roots,roots_digest,roots_version) VALUES(?,?,?,?,?,?,?,?,?)`).run(
              principal,
              id,
              side,
              digest,
              Buffer.byteLength(body),
              body,
              rootEvidence,
              hash(`${ARTIFACT_REF_EXTRACTOR_VERSION}\n${digest}\n${rootEvidence}`),
              ARTIFACT_REF_EXTRACTOR_VERSION,
            )
          })
        },
      }
    },
  }
}
