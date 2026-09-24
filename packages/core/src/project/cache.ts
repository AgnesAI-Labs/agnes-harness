import type { IntegrityState } from '../log/integrity.js'
import type { FoldCacheRecord } from '../log/storage.js'
import { ChunkedMap } from '../reduce/chunked-map.js'
import type { LedgerState } from '../reduce/state.js'
import { initialState } from '../reduce/state.js'
import { canonicalJson, sha256Hex } from '../request/hash.js'
import type { Clock, Seq, SessionKey } from '../types.js'

export type EncodedLedgerState = Omit<
  LedgerState,
  | 'registers'
  | 'openTurn'
  | 'openStep'
  | 'lastTurn'
  | 'lastStep'
  | 'pendingEffects'
  | 'pendingApprovals'
  | 'decisions'
  | 'resumedRequests'
  | 'taint'
  | 'toolCalls'
> & {
  registers: {
    [K in keyof LedgerState['registers']]: Array<
      [string, LedgerState['registers'][K] extends ReadonlyMap<string, infer V> ? V : never]
    >
  }
  openTurn: Array<[string, LedgerState['openTurn'] extends ReadonlyMap<string, infer V> ? V : never]>
  openStep: Array<[string, LedgerState['openStep'] extends ReadonlyMap<string, infer V> ? V : never]>
  lastTurn: Array<[string, number]>
  lastStep: Array<[string, number]>
  pendingEffects: Array<
    [string, LedgerState['pendingEffects'] extends ReadonlyMap<string, infer V> ? V : never]
  >
  pendingApprovals: Array<
    [string, LedgerState['pendingApprovals'] extends ReadonlyMap<string, infer V> ? V : never]
  >
  decisions: Array<[string, LedgerState['decisions'] extends ReadonlyMap<string, infer V> ? V : never]>
  resumedRequests: string[]
  taint: Array<[string, boolean]>
  toolCalls: Array<[string, LedgerState['toolCalls'] extends ReadonlyMap<string, infer V> ? V : never]>
}

export function encodeLedgerState(state: LedgerState): EncodedLedgerState {
  return {
    ...state,
    registers: {
      planItems: [...state.registers.planItems],
      budgetState: [...state.registers.budgetState],
      artifactJobs: [...state.registers.artifactJobs],
      inbox: [...state.registers.inbox],
      harnessEntries: [...state.registers.harnessEntries],
    },
    openTurn: [...state.openTurn],
    openStep: [...state.openStep],
    lastTurn: [...state.lastTurn],
    lastStep: [...state.lastStep],
    pendingEffects: [...state.pendingEffects],
    pendingApprovals: [...state.pendingApprovals],
    decisions: [...state.decisions],
    resumedRequests: [...state.resumedRequests],
    taint: [...state.taint],
    toolCalls: [...state.toolCalls],
  }
}

function entries(value: unknown, name: string): Array<[string, unknown]> {
  if (!Array.isArray(value)) throw new TypeError(`fold cache ${name} is not an array`)
  return value.map((entry) => {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string')
      throw new TypeError(`fold cache ${name} has an invalid entry`)
    return [entry[0], entry[1]]
  })
}

export function decodeLedgerState(value: unknown, seq: Seq): LedgerState {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('fold cache state is invalid')
  const raw = value as Record<string, unknown>
  if (raw.lastSeq !== seq || !Number.isSafeInteger(raw.lastSeq))
    throw new TypeError('fold cache state cursor mismatch')
  if (typeof raw.creditsUsed !== 'number' || !Number.isFinite(raw.creditsUsed))
    throw new TypeError('fold cache creditsUsed is invalid')
  if (!raw.registers || typeof raw.registers !== 'object' || Array.isArray(raw.registers))
    throw new TypeError('fold cache registers are invalid')
  const registers = raw.registers as Record<string, unknown>
  const blank = initialState()
  return {
    ...blank,
    ...(raw as unknown as LedgerState),
    registers: {
      planItems: new Map(entries(registers.planItems, 'registers.planItems') as never),
      budgetState: new Map(entries(registers.budgetState, 'registers.budgetState') as never),
      artifactJobs: new Map(entries(registers.artifactJobs, 'registers.artifactJobs') as never),
      inbox: new Map(entries(registers.inbox, 'registers.inbox') as never),
      harnessEntries: new Map(entries(registers.harnessEntries, 'registers.harnessEntries') as never),
    },
    openTurn: new Map(entries(raw.openTurn, 'openTurn') as never),
    openStep: new Map(entries(raw.openStep, 'openStep') as never),
    lastTurn: new Map(entries(raw.lastTurn, 'lastTurn') as never),
    lastStep: new Map(entries(raw.lastStep, 'lastStep') as never),
    pendingEffects: new Map(entries(raw.pendingEffects, 'pendingEffects') as never),
    pendingApprovals: new Map(entries(raw.pendingApprovals, 'pendingApprovals') as never),
    decisions: ChunkedMap.from(entries(raw.decisions, 'decisions') as never),
    resumedRequests: new Set(
      entries(
        (raw.resumedRequests as unknown[] | undefined)?.map((v) => [v, true]),
        'resumedRequests',
      ).map(([key]) => key),
    ),
    taint: new Map(entries(raw.taint, 'taint') as never),
    toolCalls: ChunkedMap.from(entries(raw.toolCalls, 'toolCalls') as never),
  }
}

function cacheChecksum(key: SessionKey, record: Omit<FoldCacheRecord, 'checksum'>): string {
  return sha256Hex(canonicalJson({ algorithm: 'agnes-fold-cache-v1', sessionKey: key, ...record }))
}

export function encodeFoldCache(
  key: SessionKey,
  state: LedgerState,
  integrity: IntegrityState,
): FoldCacheRecord {
  const record = {
    version: 3 as const,
    seq: state.lastSeq,
    payload: canonicalJson(encodeLedgerState(state)),
    integrity: { ...integrity },
  }
  return { ...record, checksum: cacheChecksum(key, record) }
}

export function decodeFoldCache(
  key: SessionKey,
  record: FoldCacheRecord,
  lastSeq: Seq,
): { state: LedgerState; integrity: IntegrityState } {
  if (record.version !== 3 || !Number.isSafeInteger(record.seq) || record.seq < 0 || record.seq > lastSeq)
    throw new TypeError('fold cache envelope is invalid')
  const { checksum, ...unsigned } = record
  if (checksum !== cacheChecksum(key, unsigned)) throw new TypeError('fold cache checksum mismatch')
  if (
    record.integrity.lastSeq !== record.seq ||
    !Number.isSafeInteger(record.integrity.legacyThroughSeq) ||
    record.integrity.legacyThroughSeq < 0 ||
    record.integrity.legacyThroughSeq > record.seq ||
    (record.integrity.headDigest !== null && !/^[0-9a-f]{64}$/.test(record.integrity.headDigest))
  )
    throw new TypeError('fold cache integrity cursor is invalid')
  if (record.integrity.headDigest === null && record.integrity.legacyThroughSeq !== record.seq)
    throw new TypeError('fold cache legacy cursor is invalid')
  return {
    state: decodeLedgerState(JSON.parse(record.payload), record.seq),
    integrity: { ...record.integrity },
  }
}

/**
 * An in-memory checkpoint policy for the ledger fold. The state is never authoritative: durable
 * storage owns the event stream and a caller resumes by replaying every row after this line.
 */
export class FoldCache {
  #lastWriteSeq = 0
  #lastWriteAt: number
  readonly #writeEvery: number
  readonly #writeAfterMs: number

  constructor(opts: { writeEvery?: number; writeAfterMs?: number; clock: Clock }) {
    this.#writeEvery = opts.writeEvery ?? 200
    this.#writeAfterMs = opts.writeAfterMs ?? 5_000
    this.clock = opts.clock
    this.#lastWriteAt = opts.clock()
  }

  readonly clock: Clock

  shouldWrite(seq: Seq): boolean {
    return (
      seq - this.#lastWriteSeq >= this.#writeEvery || this.clock() - this.#lastWriteAt >= this.#writeAfterMs
    )
  }

  set(seq: Seq, state: LedgerState): void {
    if (state.lastSeq !== seq) throw new RangeError('fold cache seq does not match state')
    this.#lastWriteSeq = seq
    this.#lastWriteAt = this.clock()
  }
}
