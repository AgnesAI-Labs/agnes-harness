import type { OpState } from '@agnes/protocol'
import { CoreError, type Event, type Lane, type PreparedEvent, type Seq, type SessionKey } from '../types.js'

/** The most rows one adapter scan call returns. */
export const SCAN_PAGE_MAX = 500

/**
 * A scan never returns fewer rows than it matched without saying so:
 * (a) `limit` at or under SCAN_PAGE_MAX is a page: the first `limit` matching rows;
 * (b) `limit` absent or above SCAN_PAGE_MAX asks for every matching row: up to SCAN_PAGE_MAX of them
 *     come back whole, and more than that is an E_SCAN_TRUNCATED error, never a cut result.
 * A `limit` that is not a positive safe integer is E_SCAN_UNBOUNDED, as is a scan with neither
 * `limit` nor `toSeq`. Callers that need more than one page read through scanPages / scanAll.
 */
export type ScanQuery = {
  fromSeq?: Seq
  toSeq?: Seq
  type?: string | string[]
  lane?: Lane
  order?: 'asc' | 'desc'
  limit?: number
}

/**
 * The one spelling of a case (b) overflow. Where the scan was aimed is in the message as well as the
 * detail, because only code and message survive the worker boundary; both are numbers and enums.
 */
export function scanTruncated(q: ScanQuery): CoreError {
  const detail = {
    pageMax: SCAN_PAGE_MAX,
    requested: q.limit ?? 'all',
    fromSeq: q.fromSeq ?? 'start',
    toSeq: q.toSeq ?? 'end',
    order: q.order ?? 'asc',
  }
  const at = Object.entries(detail)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ')
  return new CoreError('E_SCAN_TRUNCATED', `scan matched more than ${SCAN_PAGE_MAX} rows (${at})`, detail)
}

/** A materialized register cell. `data === null` is the tombstone: the key is gone. */
export type RegisterRow = { register: string; key: string; seq: Seq; data: unknown }

export type IntegrityMode = 'anchor' | 'chain'
export type IntegrityMetadata = {
  mode: IntegrityMode
  previousDigest: string | null
  digest: string
}
export type IntegrityCommit = IntegrityMetadata & { seq: Seq }
export type IntegrityRow = {
  /** The physical owner; a child scan also contains rows owned by its immutable parent prefix. */
  sessionKey: SessionKey
  event: Event
  integrity: IntegrityMetadata | null
}
export type IntegrityScanQuery = { fromSeq: Seq; toSeq: Seq; limit: number }

/**
 * One atomic append. `ts` and `id` are already minted by core; storage only assigns `seq`,
 * inside the same transaction that writes the register rows.
 */
export type CommitTx = {
  events: PreparedEvent[]
  /** Omitted only by legacy/rollback writers. New core appends always provide one entry per event. */
  integrity?: IntegrityCommit[]
  expectedWriterRunId: string
  expectedRegisterSeq?: { register: string; key: string; seq: Seq | null }
  /** Non-authoritative fold checkpoint, committed atomically with the events it describes. */
  foldCache?: FoldCacheRecord
  /**
   * Renew on write. A held lease is extended by its ttl; a lapsed one of this writer's own, or a
   * missing row, is taken again only while no other writer holds the row and the ledger is still at
   * `expectedLastSeq`. Otherwise the commit is refused with E_WRITER_LEASE.
   */
  claim?: LeaseClaim
  /**
   * The program counter's register cell, written in the same transaction as `events` at the seq of
   * the batch's last row; null removes it. A batch that carries it must carry at least one row.
   */
  opState?: OpWrite
}

/** One lane's program-counter value, written as a register cell rather than as a ledger row. */
export type OpWrite = { lane: Lane; data: OpState | null }

/** What storage committed: the rows' seqs and, when the batch wrote one, the op cell's seq. */
export type CommitReceipt = { firstSeq: Seq; seqs: Seq[]; opState?: { seq: Seq } }

export type LeaseClaim = { ttlMs: number; expectedLastSeq: Seq }

export type FoldCacheRecord = {
  version: 2
  seq: Seq
  payload: string
  checksum: string
  integrity: { lastSeq: Seq; legacyThroughSeq: Seq; headDigest: string | null }
}

export type OpenResult = {
  lastSeq: Seq
  formatVersion: number
  created?: boolean
  parent?: { key: SessionKey; boundarySeq: Seq }
}

export interface StorageAdapter {
  open(key: SessionKey, claim: { writerRunId: string; ttlMs: number }): Promise<OpenResult>
  commit(key: SessionKey, tx: CommitTx): Promise<CommitReceipt>
  /** With a claim, a lapsed or missing lease is taken back as a claimed commit would take it. */
  renew(key: SessionKey, writerRunId: string, claim?: LeaseClaim): Promise<void>
  release(key: SessionKey, writerRunId: string): Promise<void>
  scan(key: SessionKey, q: ScanQuery): Promise<Event[]>
  scanIntegrity(key: SessionKey, q: IntegrityScanQuery): Promise<IntegrityRow[]>
  registers(key: SessionKey): Promise<RegisterRow[]>
  /** Optional for legacy adapters; absence means every open takes the cold path. */
  foldCache?(key: SessionKey): Promise<FoldCacheRecord | undefined>
  /** Remove a session only after Core proves this open created it and storage verifies its writer lease. */
  discardNewSession?(key: SessionKey, expectedWriterRunId: string, claim?: LeaseClaim): Promise<void>
  createChild(parentKey: SessionKey, boundarySeq: Seq, childKey: SessionKey): Promise<void>
  close(): Promise<void>
}

// The one place a register cache key is spelled, and it is reached only from RegisterMap below.
// NUL is used because it cannot occur in a register name, a lane name, a jobId or a harness entry
// id, so the two halves can never collide, and it is written as an escape so the separator survives
// copying the file around. Nothing outside this file holds a register cache keyed by a raw string,
// so there is no second place a separator could be interpolated: two spellings of the same
// composite key silently lose register cells on the resume path.
//
// It is deliberately absent from the package's root export: reachable from outside, it is all a
// caller needs to build a second, differently spelled register map on top of the public surface,
// which is the very thing RegisterMap exists to make impossible.
export function cacheKey(register: string, key: string): string {
  return `${register}\u0000${key}`
}

/**
 * The materialized register cells, addressed by their two halves. Callers never see the composite
 * key, so there is nowhere else for one to be spelled: a cache keyed by a raw string is what invites
 * a second spelling, and two spellings of the same key silently lose cells on the resume path.
 */
export class RegisterMap {
  // Hard-private, not TS-private: a TS-private field is erased at runtime, so a write through an
  // `as never` cast lands in the backing Map without going through apply(). Such a cell shows up in
  // values() but not in get(), because only get() spells the key — the write side put a raw string
  // there. #cells makes that write a syntax-level impossibility rather than a convention.
  readonly #cells = new Map<string, RegisterRow>()

  get(register: string, key: string): RegisterRow | undefined {
    return this.#cells.get(cacheKey(register, key))
  }

  /** Applies one materialized row in commit order; a tombstone removes the cell. */
  apply(row: RegisterRow): void {
    const k = cacheKey(row.register, row.key)
    if (isRegisterTombstone(row.register, row.data)) this.#cells.delete(k)
    else this.#cells.set(k, row)
  }

  /** Discards every cell and re-folds from `rows`, which is what reseeding a cache means. */
  replaceAll(rows: Iterable<RegisterRow>): void {
    this.#cells.clear()
    for (const r of rows) this.apply(r)
  }

  values(): RegisterRow[] {
    return [...this.#cells.values()]
  }
}

/**
 * The key half of a register cell. Most registers are per-lane; artifact jobs are keyed by job id
 * and harness entries by their kind/id pair, both of which live inside the event data.
 *
 * The kind/id pair is joined with the same NUL the composite key uses, and for the same reason one
 * level down: a slash occurs in neither half by accident but is not forbidden in either, and under a
 * slash `{kind:'a/b', id:'c'}` and `{kind:'a', id:'b/c'}` both spell `a/b/c` and share one cell.
 */
export function registerKey(e: Event): string {
  const d = e.data as Record<string, unknown> | null
  switch (e.register) {
    case 'artifact/job':
      return String(d?.jobId ?? '')
    case 'harness/entry':
      return `${String(d?.kind ?? '')}\u0000${String(d?.id ?? '')}`
    default:
      return e.lane ?? 'main'
  }
}

/**
 * Whether a register write erases its cell. Most registers say so with `data: null`, but a
 * harness/entry cell is keyed by `kind` / `id` read out of `data`, so a null payload cannot name the
 * key it is removing; its tombstone carries the key alongside an explicit flag instead. Every write
 * path — storage commit, the log's cache, the reducer's fold — asks this one function, so the three
 * cannot disagree about which rows are gone.
 */
export function isRegisterTombstone(register: string, data: unknown): boolean {
  if (data === null) return true
  return (
    register === 'harness/entry' &&
    typeof data === 'object' &&
    (data as { tombstone?: unknown }).tombstone === true
  )
}
