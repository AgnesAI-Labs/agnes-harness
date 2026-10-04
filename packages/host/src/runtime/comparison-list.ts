import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { ComparisonListParams, ComparisonListResult } from '@agnes/protocol'
import { type ComparisonRecord, comparisonPhase } from '@agnes/runtime-comparison'
import { comparisonTransaction } from './comparison-journal-store.js'
import { ComparisonJournalError } from './comparison-journal-types.js'

type Row = {
  list_seq: number
  created_at: number | null
  updated_at: number | null
  body: string
}

/** Stable insertion order is separate from wall-clock time and coordinator revisions. */
export function createComparisonListing(db: DatabaseSync, clock: () => number) {
  db.exec(`CREATE TABLE IF NOT EXISTS comparison_listing (
    principal TEXT NOT NULL, id TEXT NOT NULL, list_seq INTEGER NOT NULL,
    created_at INTEGER, updated_at INTEGER,
    PRIMARY KEY(principal,id), UNIQUE(principal,list_seq)
  );
  CREATE TABLE IF NOT EXISTS comparison_listing_heads (
    principal TEXT PRIMARY KEY NOT NULL, seq INTEGER NOT NULL
  );`)
  const advance = db.prepare(`INSERT INTO comparison_listing_heads(principal,seq) VALUES(?,1)
    ON CONFLICT(principal) DO UPDATE SET seq=seq+1 RETURNING seq`)
  const nextSeq = (principal: string): number => {
    const seq = (advance.get(principal) as { seq: number }).seq
    if (!Number.isSafeInteger(seq) || seq >= Number.MAX_SAFE_INTEGER)
      throw new ComparisonJournalError('COMPARISON_INDEX_EXHAUSTED', 'Comparison listing sequence exhausted')
    return seq
  }
  const legacy = db.prepare(
    'INSERT INTO comparison_listing(principal,id,list_seq,updated_at) VALUES(?,?,?,?)',
  )
  comparisonTransaction(db, () => {
    const missing = db
      .prepare(`SELECT principal,id FROM comparisons c WHERE json_extract(c.body,'$.retirement.state') IS NOT 'removed' AND NOT EXISTS (
      SELECT 1 FROM comparison_listing l WHERE l.principal=c.principal AND l.id=c.id
    ) ORDER BY rowid`)
      .all() as { principal: string; id: string }[]
    for (const row of missing) legacy.run(row.principal, row.id, nextSeq(row.principal), null)
  })
  const insert = db.prepare(
    'INSERT INTO comparison_listing(principal,id,list_seq,created_at,updated_at) VALUES(?,?,?,?,?)',
  )
  const update = db.prepare('UPDATE comparison_listing SET updated_at=? WHERE principal=? AND id=?')
  const head = db.prepare('SELECT COALESCE(MAX(list_seq),0) AS seq FROM comparison_listing WHERE principal=?')
  const select = db.prepare(`SELECT l.list_seq,l.created_at,l.updated_at,c.body
    FROM comparison_listing l JOIN comparisons c ON c.principal=l.principal AND c.id=l.id
    WHERE l.principal=? AND l.list_seq<=? AND l.list_seq<? AND json_extract(c.body,'$.retirement.state') IS NOT 'removed' ORDER BY l.list_seq DESC LIMIT ?`)
  const invalid = (): never => {
    throw new ComparisonJournalError('COMPARISON_INVALID_CURSOR', 'Invalid comparison list cursor')
  }
  return {
    /** Called inside the successful coordinator CAS transaction, never by reads. */
    changed(principal: string, id: string, created: boolean): void {
      const now = clock()
      if (!Number.isSafeInteger(now) || now < 0)
        throw new ComparisonJournalError('COMPARISON_INVALID_TIME', 'Invalid comparison metadata clock')
      if (created) insert.run(principal, id, nextSeq(principal), now, now)
      else if (update.run(now, principal, id).changes !== 1)
        legacy.run(principal, id, nextSeq(principal), now)
    },
    list(principal: string, params: ComparisonListParams = {}): ComparisonListResult {
      const limit = params.limit ?? 25
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) invalid()
      const owner = createHash('sha256').update(principal).digest('hex')
      let through: number
      let before: number
      if (params.cursor !== undefined) {
        try {
          if (params.cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(params.cursor)) invalid()
          const cursor = JSON.parse(Buffer.from(params.cursor, 'base64url').toString('utf8')) as {
            version: unknown
            owner: unknown
            through: number
            before: number
          }
          if (
            cursor.version !== 1 ||
            cursor.owner !== owner ||
            !Number.isSafeInteger(cursor.through) ||
            cursor.through < 1 ||
            !Number.isSafeInteger(cursor.before) ||
            cursor.before < 1 ||
            cursor.before > cursor.through
          )
            invalid()
          through = cursor.through
          before = cursor.before
        } catch {
          return invalid()
        }
      } else {
        through = (head.get(principal) as { seq: number }).seq
        if (!Number.isSafeInteger(through) || through >= Number.MAX_SAFE_INTEGER) invalid()
        before = through + 1
      }
      const rows = select.all(principal, through, before, limit + 1) as Row[]
      const page = rows.slice(0, limit)
      const last = page.at(-1)
      return {
        items: page.map((row) => {
          const record = JSON.parse(row.body) as ComparisonRecord
          return {
            id: record.id,
            revision: record.revision,
            phase: comparisonPhase(record),
            ...(record.retirement ? { storageState: record.retirement.state } : {}),
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            roundCount: record.rounds.length,
            inspectable: Boolean(record.baseline && record.lanes.left && record.lanes.right),
            lanes: (['left', 'right'] as const).flatMap((side) => {
              const lane = record.lanes[side]
              return lane ? [{ side, runtime: lane.runtime }] : []
            }),
          }
        }),
        nextCursor:
          rows.length > limit && last
            ? Buffer.from(JSON.stringify({ version: 1, owner, through, before: last.list_seq })).toString(
                'base64url',
              )
            : null,
      }
    },
  }
}
