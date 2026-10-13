import { type BatchSpec, type BatchStatus, inspectJsonData } from '@agnes/protocol'
import { ensure, type TableHandle } from '../storage/table.js'
import type { EnumeratedItem, ItemKind } from './enumerate.js'
import { singleLine } from './spec.js'

export type BatchState = BatchStatus['status']
export type ItemState = 'pending' | 'running' | 'done' | 'invalid' | 'failed' | 'skipped' | 'cancelled'
export const ITEM_STATES: readonly ItemState[] = [
  'pending',
  'running',
  'done',
  'invalid',
  'failed',
  'skipped',
  'cancelled',
]
const BATCH_STATES: ReadonlySet<string> = new Set<BatchState>([
  'running',
  'completed',
  'cancelled',
  'budget_exhausted',
  'failed',
])
type SettledState = 'done' | 'invalid' | 'failed' | 'cancelled'
const SETTLED_STATES: ReadonlySet<string> = new Set<SettledState>(['done', 'invalid', 'failed', 'cancelled'])

/** A stored answer larger than this (as JSON) is kept as `invalid` instead. */
export const MAX_OUTPUT_BYTES = 256 * 1024
export const MAX_ERROR_CHARS = 1000
/** In an item error, what follows this is the model's (clipped) reply: kept for errors.jsonl only. */
export const REPLY_MARK = '; reply: '
/** The protocol's limit on `BatchStatus.reason`. */
export const MAX_REASON_CHARS = 1024
const MAX_PAGE = 1000
const MAX_LIST = 50
/** Rows per INSERT when a batch is recorded: 8 parameters each, far below SQLite's parameter limit. */
const INSERT_CHUNK = 200

export type BatchRow = Readonly<{
  id: string
  principalId: string
  root: string
  origin?: string
  spec: BatchSpec
  dirRel: string
  outRel: string
  concurrency: number
  itemTimeoutMs: number
  status: BatchState
  reason?: string
  spent: number
  createdAt: number
  updatedAt: number
}>
export type NewBatch = Omit<BatchRow, 'status' | 'reason' | 'spent' | 'updatedAt'>
export type ItemRow = Readonly<{
  batchId: string
  ordinal: number
  path: string
  kind: ItemKind
  bytes: number
  status: ItemState
  repairs: number
  jobId?: string
  sessionKey?: string
  output?: unknown
  error?: string
  credits: number
  startedAt?: number
  updatedAt: number
}>

type RawBatch = {
  id: string
  principal_id: string
  root: string
  origin: string | null
  spec: string
  dir_rel: string
  out_rel: string
  concurrency: number
  item_timeout_ms: number
  status: BatchState
  reason: string | null
  spent: number
  created_at: number
  updated_at: number
}
type RawItem = {
  batch_id: string
  ordinal: number
  path: string
  kind: ItemKind
  bytes: number
  status: ItemState
  repairs: number
  job_id: string | null
  session_key: string | null
  output: string | null
  error: string | null
  credits: number
  started_at: number | null
  updated_at: number
}

const toBatch = (raw: RawBatch): BatchRow => ({
  id: raw.id,
  principalId: raw.principal_id,
  root: raw.root,
  ...(raw.origin !== null ? { origin: raw.origin } : {}),
  spec: JSON.parse(raw.spec) as BatchSpec,
  dirRel: raw.dir_rel,
  outRel: raw.out_rel,
  concurrency: raw.concurrency,
  itemTimeoutMs: raw.item_timeout_ms,
  status: raw.status,
  ...(raw.reason !== null ? { reason: raw.reason } : {}),
  spent: raw.spent,
  createdAt: raw.created_at,
  updatedAt: raw.updated_at,
})
const toItem = (raw: RawItem): ItemRow => ({
  batchId: raw.batch_id,
  ordinal: raw.ordinal,
  path: raw.path,
  kind: raw.kind,
  bytes: raw.bytes,
  status: raw.status,
  repairs: raw.repairs,
  ...(raw.job_id !== null ? { jobId: raw.job_id } : {}),
  ...(raw.session_key !== null ? { sessionKey: raw.session_key } : {}),
  ...(raw.output !== null ? { output: JSON.parse(raw.output) as unknown } : {}),
  ...(raw.error !== null ? { error: raw.error } : {}),
  credits: raw.credits,
  ...(raw.started_at !== null ? { startedAt: raw.started_at } : {}),
  updatedAt: raw.updated_at,
})

/** Cuts text to at most `max` UTF-16 units without leaving half of a surrogate pair. */
export function clipText(text: string, max: number): string {
  if (text.length <= max) return text
  const last = text.charCodeAt(max - 1)
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max)
}

const limit = (n: number, max: number): number =>
  Number.isFinite(n) ? Math.min(max, Math.max(1, Math.floor(n))) : 1
const credit = (n: number | undefined): number | undefined =>
  n === undefined ? undefined : Number.isFinite(n) && n > 0 ? n : 0

/**
 * Batch and item state; the only source of truth for a batch, kept beside the daemon's jobs table.
 * Items are keyed by (batch id, ordinal) and move one way: pending -> running -> done | invalid |
 * failed | cancelled (a pending item may settle directly); skipped items are settled when recorded.
 * A settled item never changes again, so repeating any write is harmless. A batch moves once from
 * running to its outcome. Answers and errors are bounded here, whoever the caller is.
 */
export class BatchRepo {
  constructor(
    private readonly table: TableHandle,
    private readonly clock: () => number,
  ) {
    // Created on first use like the daemon's other tables; a later column is added by probing for it.
    ensure(
      table,
      `CREATE TABLE IF NOT EXISTS batches (
        id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, root TEXT NOT NULL, origin TEXT,
        spec TEXT NOT NULL, dir_rel TEXT NOT NULL, out_rel TEXT NOT NULL,
        concurrency INTEGER NOT NULL, item_timeout_ms INTEGER NOT NULL,
        status TEXT NOT NULL, reason TEXT, spent REAL NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      )`,
    )
    ensure(
      table,
      `CREATE TABLE IF NOT EXISTS batch_items (
        batch_id TEXT NOT NULL, ordinal INTEGER NOT NULL, path TEXT NOT NULL, kind TEXT NOT NULL,
        bytes INTEGER NOT NULL, status TEXT NOT NULL, repairs INTEGER NOT NULL DEFAULT 0,
        job_id TEXT, session_key TEXT, output TEXT, error TEXT, credits REAL NOT NULL DEFAULT 0,
        started_at INTEGER, updated_at INTEGER NOT NULL,
        PRIMARY KEY (batch_id, ordinal)
      )`,
    )
    ensure(table, 'CREATE INDEX IF NOT EXISTS batch_items_status ON batch_items (batch_id, status, ordinal)')
    ensure(table, 'CREATE INDEX IF NOT EXISTS batches_principal ON batches (principal_id, created_at)')
  }

  /** Records a batch and its numbered items in one transaction; false when the id is already taken. */
  create(batch: NewBatch, items: readonly EnumeratedItem[]): boolean {
    return this.table.transaction(() => {
      if (this.get(batch.id)) return false
      const now = this.clock()
      this.table.exec(
        `INSERT INTO batches (id, principal_id, root, origin, spec, dir_rel, out_rel, concurrency,
           item_timeout_ms, status, reason, spent, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', NULL, 0, ?, ?)`,
        [
          batch.id,
          batch.principalId,
          batch.root,
          batch.origin ?? null,
          JSON.stringify(batch.spec),
          batch.dirRel,
          batch.outRel,
          batch.concurrency,
          batch.itemTimeoutMs,
          batch.createdAt,
          now,
        ],
      )
      for (let start = 0; start < items.length; start += INSERT_CHUNK) {
        const chunk = items.slice(start, start + INSERT_CHUNK)
        this.table.exec(
          `INSERT INTO batch_items (batch_id, ordinal, path, kind, bytes, status, repairs, error, credits, updated_at)
           VALUES ${chunk.map(() => '(?, ?, ?, ?, ?, ?, 0, ?, 0, ?)').join(', ')}`,
          chunk.flatMap((item, index) => [
            batch.id,
            start + index + 1,
            item.path,
            item.kind,
            Math.max(0, Math.floor(item.bytes)),
            item.skip ? 'skipped' : 'pending',
            item.skip ?? null,
            now,
          ]),
        )
      }
      return true
    })
  }

  get(id: string): BatchRow | undefined {
    const raw = this.table.get<RawBatch>('SELECT * FROM batches WHERE id = ?', [id])
    return raw ? toBatch(raw) : undefined
  }

  running(): BatchRow[] {
    return this.table
      .all<RawBatch>("SELECT * FROM batches WHERE status = 'running' ORDER BY created_at, id")
      .map(toBatch)
  }

  /** Finished batches that still hold pending or running items: a clean-up a stopped process left undone. */
  unsettledFinished(): BatchRow[] {
    return this.table
      .all<RawBatch>(
        `SELECT * FROM batches WHERE status != 'running' AND EXISTS (
           SELECT 1 FROM batch_items WHERE batch_items.batch_id = batches.id AND batch_items.status IN ('pending', 'running')
         ) ORDER BY created_at, id`,
      )
      .map(toBatch)
  }

  listFor(principalId: string, max: number): BatchRow[] {
    return this.table
      .all<RawBatch>('SELECT * FROM batches WHERE principal_id = ? ORDER BY created_at DESC, id LIMIT ?', [
        principalId,
        limit(max, MAX_LIST),
      ])
      .map(toBatch)
  }

  counts(id: string): Record<ItemState, number> {
    const counts = Object.fromEntries(ITEM_STATES.map((state) => [state, 0])) as Record<ItemState, number>
    for (const row of this.table.all<{ status: ItemState; n: number }>(
      'SELECT status, COUNT(*) AS n FROM batch_items WHERE batch_id = ? GROUP BY status',
      [id],
    ))
      counts[row.status] = row.n
    return counts
  }

  inflight(id: string): ItemRow[] {
    return this.table
      .all<RawItem>("SELECT * FROM batch_items WHERE batch_id = ? AND status = 'running' ORDER BY ordinal", [
        id,
      ])
      .map(toItem)
  }

  nextPending(id: string, max: number): ItemRow[] {
    return this.table
      .all<RawItem>(
        "SELECT * FROM batch_items WHERE batch_id = ? AND status = 'pending' ORDER BY ordinal LIMIT ?",
        [id, limit(max, MAX_PAGE)],
      )
      .map(toItem)
  }

  /** Items after `afterOrdinal` in order: a cursor that stays valid while items settle. */
  page(id: string, afterOrdinal: number, max: number): ItemRow[] {
    return this.table
      .all<RawItem>('SELECT * FROM batch_items WHERE batch_id = ? AND ordinal > ? ORDER BY ordinal LIMIT ?', [
        id,
        afterOrdinal,
        limit(max, MAX_PAGE),
      ])
      .map(toItem)
  }

  /** Item count and credits per state for the items after `afterOrdinal`, without reading their rows. */
  tally(id: string, afterOrdinal: number): Array<{ status: ItemState; items: number; credits: number }> {
    return this.table.all<{ status: ItemState; items: number; credits: number }>(
      `SELECT status, COUNT(*) AS items, COALESCE(SUM(credits), 0) AS credits FROM batch_items
       WHERE batch_id = ? AND ordinal > ? GROUP BY status`,
      [id, afterOrdinal],
    )
  }

  /** The most frequent cause among failed and invalid items, without any reply the model wrote. */
  commonError(id: string): string | undefined {
    return this.table.get<{ cause: string }>(
      `SELECT CASE WHEN instr(error, ?) > 0 THEN substr(error, 1, instr(error, ?) - 1) ELSE error END AS cause
       FROM batch_items WHERE batch_id = ? AND status IN ('failed', 'invalid') AND error IS NOT NULL
       GROUP BY cause ORDER BY COUNT(*) DESC, cause LIMIT 1`,
      [REPLY_MARK, REPLY_MARK, id],
    )?.cause
  }

  /** Whether some item of the batch failed with exactly this error. */
  hasFailure(id: string, error: string): boolean {
    return (
      this.table.get(
        `SELECT 1 AS found FROM batch_items WHERE batch_id = ? AND status = 'failed' AND error = ? LIMIT 1`,
        [id, error],
      ) !== undefined
    )
  }

  /**
   * Starts a pending item, or records a repair run of a running one. False when the item is settled
   * or skipped, when the call would lower its repair count (a stale retry), or when it names another
   * job for the repair count already recorded.
   */
  markRunning(
    id: string,
    ordinal: number,
    run: { jobId: string; sessionKey: string; repairs: number; startedAt: number },
  ): boolean {
    return this.table.transaction(() => {
      const current = this.table.get<{ status: ItemState; repairs: number; job_id: string | null }>(
        'SELECT status, repairs, job_id FROM batch_items WHERE batch_id = ? AND ordinal = ?',
        [id, ordinal],
      )
      if (!current) return false
      // A running item takes a later repair run, or the same run again; never another job for the same run.
      const again = run.repairs === current.repairs && run.jobId === current.job_id
      if (
        current.status !== 'pending' &&
        !(current.status === 'running' && (run.repairs > current.repairs || again))
      )
        return false
      this.table.exec(
        `UPDATE batch_items SET status = 'running', job_id = ?, session_key = ?, repairs = ?, started_at = ?,
           updated_at = ? WHERE batch_id = ? AND ordinal = ?`,
        [run.jobId, run.sessionKey, run.repairs, run.startedAt, this.clock(), id, ordinal],
      )
      return true
    })
  }

  /**
   * Settles a pending or running item once; a settled item never changes again (false). An answer that
   * is not bounded plain JSON is not stored: a `done` item carrying one becomes `invalid`.
   */
  settle(
    id: string,
    ordinal: number,
    result: { status: SettledState; output?: unknown; error?: string; credits?: number },
  ): boolean {
    if (!SETTLED_STATES.has(result.status))
      throw new Error(`not a settled item state: ${String(result.status)}`)
    let status: SettledState = result.status
    let error = result.error
    let output: string | null = null
    if (result.output !== undefined) {
      const inspected = inspectJsonData(result.output, MAX_OUTPUT_BYTES)
      if (inspected.ok) output = JSON.stringify(inspected.value)
      else if (status === 'done') {
        status = 'invalid'
        error = `invalid_output: the answer is not plain JSON of at most ${MAX_OUTPUT_BYTES / 1024} KiB (${singleLine(inspected.reason)})`
      }
    }
    return this.table.transaction(() => {
      const current = this.table.get<{ status: ItemState; credits: number }>(
        'SELECT status, credits FROM batch_items WHERE batch_id = ? AND ordinal = ?',
        [id, ordinal],
      )
      if (!current || (current.status !== 'pending' && current.status !== 'running')) return false
      const now = this.clock()
      const credits = credit(result.credits) ?? current.credits
      this.table.exec(
        'UPDATE batch_items SET status = ?, output = ?, error = ?, credits = ?, updated_at = ? WHERE batch_id = ? AND ordinal = ?',
        [
          status,
          output,
          error === undefined ? null : clipText(error, MAX_ERROR_CHARS),
          credits,
          now,
          id,
          ordinal,
        ],
      )
      this.table.exec('UPDATE batches SET spent = spent + ?, updated_at = ? WHERE id = ?', [
        credits - current.credits,
        now,
        id,
      ])
      return true
    })
  }

  cancelPending(id: string, reason: string): void {
    this.table.exec(
      "UPDATE batch_items SET status = 'cancelled', error = ?, updated_at = ? WHERE batch_id = ? AND status = 'pending'",
      [clipText(reason, MAX_ERROR_CHARS), this.clock(), id],
    )
  }

  /** Records the batch outcome once; false when the batch is unknown or already finished. */
  setStatus(id: string, status: BatchState, reason?: string): boolean {
    if (!BATCH_STATES.has(status)) throw new Error(`not a batch state: ${String(status)}`)
    if (status === 'running') return false
    return this.table.transaction(() => {
      if (
        this.table.get<{ status: BatchState }>('SELECT status FROM batches WHERE id = ?', [id])?.status !==
        'running'
      )
        return false
      this.table.exec('UPDATE batches SET status = ?, reason = ?, updated_at = ? WHERE id = ?', [
        status,
        reason === undefined ? null : clipText(reason, MAX_REASON_CHARS),
        this.clock(),
        id,
      ])
      return true
    })
  }
}
