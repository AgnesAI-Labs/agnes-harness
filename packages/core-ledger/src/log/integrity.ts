import { createSha256, type Sha256Stream } from '@agnes/core-common/request/hash'
import { CoreError, type Event, type Seq, type SessionKey } from '@agnes/core-common/types'
import { jcsChunks, jcsWrite } from '@agnes/protocol'
import type { IntegrityCommit, IntegrityMetadata, IntegrityRow, StorageAdapter } from './storage.js'

export const LEDGER_INTEGRITY_ALGORITHM = 'agnes-ledger-jcs-sha256-v1' as const
export const INTEGRITY_PAGE_SIZE = 500

export type IntegrityState = {
  lastSeq: Seq
  legacyThroughSeq: Seq
  headDigest: string | null
}

export class LedgerIntegrityFailure extends CoreError {
  constructor(message = 'ledger integrity verification failed', detail?: Record<string, unknown>) {
    super('E_LEDGER_INTEGRITY', message, detail)
    this.name = 'LedgerIntegrityFailure'
  }
}

const EMPTY_STATE: IntegrityState = { lastSeq: 0, legacyThroughSeq: 0, headDigest: null }
const DIGEST = /^[0-9a-f]{64}$/

function sameDigest(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let different = 0
  for (let i = 0; i < a.length; i++) different |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return different === 0
}

/** Small tokens are coalesced so the hash sees few large updates; large strings go through in slices. */
const FLUSH_CHARS = 64 * 1024
/** A large string is fed in slices of at most this many code units, cut between code points, so the
 * hash never converts a whole multi-megabyte token to UTF-8 at once. */
const SLICE_CHARS = 1024 * 1024

function updateSliced(hash: Sha256Stream, text: string): void {
  for (let at = 0; at < text.length; ) {
    let end = Math.min(at + SLICE_CHARS, text.length)
    const last = text.charCodeAt(end - 1)
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--
    hash.update(text.slice(at, end))
    at = end
  }
}

function digestCanonical(value: unknown): { digest: string; bytes: number } {
  const hash = createSha256()
  let pending = ''
  jcsWrite(value, (chunk) => {
    if (chunk.length >= FLUSH_CHARS) {
      if (pending) hash.update(pending)
      pending = ''
      updateSliced(hash, chunk)
      return
    }
    pending += chunk
    if (pending.length >= FLUSH_CHARS) {
      hash.update(pending)
      pending = ''
    }
  })
  if (pending) hash.update(pending)
  return { digest: hash.digestHex(), bytes: hash.bytes }
}

function anchorDigest(
  key: SessionKey,
  legacyThroughSeq: Seq,
  event: Event,
): { digest: string; bytes: number } {
  return digestCanonical({ algorithm: LEDGER_INTEGRITY_ALGORITHM, sessionKey: key, legacyThroughSeq, event })
}

function chainDigest(
  key: SessionKey,
  previousDigest: string,
  event: Event,
): { digest: string; bytes: number } {
  return digestCanonical({ algorithm: LEDGER_INTEGRITY_ALGORITHM, sessionKey: key, previousDigest, event })
}

function fail(message: string, seq?: Seq): never {
  throw new LedgerIntegrityFailure(message, seq === undefined ? undefined : { seq })
}

/**
 * Walks stored rows from `initial`. With `hash` false it checks everything but the digests themselves:
 * sequence contiguity, legacy-before-protected order, anchor placement and that each row names the
 * digest of the row before it. A changed event body, whose stored digest is untouched, passes.
 */
export function verifyIntegrityRows(
  rows: readonly IntegrityRow[],
  initial: IntegrityState = EMPTY_STATE,
  hash = true,
): IntegrityState {
  let state = { ...initial }
  for (const row of rows) {
    const { event, integrity } = row
    if (event.seq !== state.lastSeq + 1) fail('ledger sequence is not contiguous', event.seq)
    if (!integrity) {
      if (state.headDigest !== null) fail('legacy row follows protected history', event.seq)
      state = { lastSeq: event.seq, legacyThroughSeq: event.seq, headDigest: null }
      continue
    }
    if (!DIGEST.test(integrity.digest)) fail('malformed ledger digest', event.seq)
    let expected = ''
    try {
      if (integrity.mode === 'anchor') {
        if (state.headDigest !== null || integrity.previousDigest !== null)
          fail('invalid ledger anchor position', event.seq)
        if (hash) expected = anchorDigest(row.sessionKey, state.legacyThroughSeq, event).digest
      } else if (integrity.mode === 'chain') {
        if (
          state.headDigest === null ||
          integrity.previousDigest === null ||
          !DIGEST.test(integrity.previousDigest) ||
          !sameDigest(integrity.previousDigest, state.headDigest)
        )
          fail('ledger chain predecessor mismatch', event.seq)
        if (hash) expected = chainDigest(row.sessionKey, integrity.previousDigest, event).digest
      } else fail('unknown ledger integrity mode', event.seq)
    } catch (error) {
      if (error instanceof LedgerIntegrityFailure) throw error
      fail('stored event cannot be canonicalized', event.seq)
    }
    if (hash && !sameDigest(integrity.digest, expected)) fail('ledger digest mismatch', event.seq)
    state = { ...state, lastSeq: event.seq, headDigest: integrity.digest }
  }
  return state
}

export type VerificationOptions = {
  signal?: AbortSignal
  idleTimeoutMs?: number
  hardTimeoutMs?: number
  onProgress?: (progress: { verifiedSeq: number; lastSeq: number }) => void
}

/** Where a verified-head checkpoint says a full verification reached. */
export type CheckpointPrefix = { throughSeq: Seq; headDigest: string; legacyThroughSeq: Seq }

/** Rows at the end of a ledger without a checkpoint that a cold open still hashes. */
export const COLD_TAIL_ROWS = 32

/**
 * `yieldPage`, when given, is awaited between two pages; it is never called after the last one.
 * `onPage` receives each page's events in order, only after that page has been verified.
 *
 * Which rows are hashed:
 * - With a `checkpoint`, the rows up to its `throughSeq` are handed to `onPage` without being hashed, and
 *   the chain is verified onward from the head it names. Contiguity is still checked row by row there.
 *   Without an `onPage` consumer the vouched prefix is not read at all.
 * - Without one, the rows before the last `COLD_TAIL_ROWS` are read and folded the same way, with their
 *   structure checked (contiguity, order, each row naming its predecessor's digest) but no digest
 *   recomputed; the last stored digest before the tail is adopted as the chain head there. Only the tail
 *   is hashed. `hashPrefix` hashes every row instead, as an explicit full verification does.
 *
 * A prefix that was not hashed stays unverified until the background full verification hashes it.
 */
export async function verifyLedger(
  storage: StorageAdapter,
  key: SessionKey,
  lastSeq: Seq,
  yieldPage?: () => void | Promise<void>,
  onPage?: (events: Event[]) => void,
  options: VerificationOptions = {},
  checkpoint?: CheckpointPrefix,
  hashPrefix = false,
): Promise<IntegrityState> {
  let state: IntegrityState =
    checkpoint && !onPage
      ? {
          lastSeq: checkpoint.throughSeq,
          headDigest: checkpoint.headDigest,
          legacyThroughSeq: checkpoint.legacyThroughSeq,
        }
      : { ...EMPTY_STATE }
  // The last seq handled. It runs ahead of `state` while the checkpointed prefix is folded unhashed.
  let at = state.lastSeq
  const adopt = !checkpoint && !hashPrefix && lastSeq > COLD_TAIL_ROWS
  const foldUntil = checkpoint?.throughSeq ?? (adopt ? lastSeq - COLD_TAIL_ROWS : 0)
  const idle = options.idleTimeoutMs ?? 30_000
  const hard = options.hardTimeoutMs ?? 600_000
  if (![idle, hard].every((ms) => Number.isSafeInteger(ms) && ms > 0))
    throw new RangeError('verification timeouts must be positive safe integers')
  const deadline = performance.now() + hard
  const check = () => {
    if (options.signal?.aborted) throw new CoreError('E_CLOSED', 'ledger verification cancelled')
    if (performance.now() >= deadline)
      throw new CoreError('E_STORAGE_FAULT', 'ledger verification hard timeout')
  }
  const progress = () => options.onProgress?.({ verifiedSeq: state.lastSeq, lastSeq })
  check()
  progress()
  while (at < lastSeq) {
    if (at > 0) await yieldPage?.()
    check()
    const folding = at < foldUntil
    const toSeq = folding ? foldUntil : lastSeq
    const pageStarted = performance.now()
    let timer: ReturnType<typeof setTimeout> | undefined
    let abort: (() => void) | undefined
    const stopped = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new CoreError('E_STORAGE_FAULT', 'ledger verification timeout')),
        Math.min(idle, deadline - performance.now()),
      )
      abort = () => reject(new CoreError('E_CLOSED', 'ledger verification cancelled'))
      options.signal?.addEventListener('abort', abort, { once: true })
    })
    let rows: IntegrityRow[]
    try {
      rows = await Promise.race([
        storage.scanIntegrity(key, {
          fromSeq: at + 1,
          toSeq,
          limit: INTEGRITY_PAGE_SIZE,
        }),
        stopped,
      ])
    } finally {
      clearTimeout(timer)
      if (abort) options.signal?.removeEventListener('abort', abort)
    }
    check()
    if (rows.length === 0) fail('ledger ended before advertised sequence', at + 1)
    if (rows.length > INTEGRITY_PAGE_SIZE || (rows.at(-1)?.event.seq ?? 0) > toSeq)
      fail('ledger exceeds advertised page or sequence')
    if (folding && checkpoint) {
      for (const row of rows) {
        if (row.event.seq !== at + 1) fail('ledger sequence is not contiguous', row.event.seq)
        at = row.event.seq
      }
      if (at === foldUntil)
        state = {
          lastSeq: foldUntil,
          legacyThroughSeq: checkpoint.legacyThroughSeq,
          headDigest: checkpoint.headDigest,
        }
    } else {
      state = verifyIntegrityRows(rows, state, !folding)
      at = state.lastSeq
    }
    if (performance.now() - pageStarted >= idle)
      throw new CoreError('E_STORAGE_FAULT', 'ledger verification idle timeout')
    check()
    onPage?.(rows.map((row) => row.event))
    check()
    progress()
  }
  if (at !== lastSeq || state.lastSeq !== lastSeq) fail('ledger exceeds advertised sequence', at)
  return state
}

export function prepareIntegrity(
  key: SessionKey,
  events: readonly Event[],
  initial: IntegrityState,
): { entries: IntegrityCommit[]; state: IntegrityState; canonicalBytes: number } {
  let state = { ...initial }
  let canonicalBytes = 0
  const entries: IntegrityCommit[] = []
  for (const event of events) {
    if (event.seq !== state.lastSeq + 1) fail('append sequence is not contiguous', event.seq)
    let integrity: IntegrityMetadata
    if (state.headDigest === null) {
      const calculated = anchorDigest(key, state.legacyThroughSeq, event)
      canonicalBytes += calculated.bytes
      integrity = {
        mode: 'anchor',
        previousDigest: null,
        digest: calculated.digest,
      }
    } else {
      const calculated = chainDigest(key, state.headDigest, event)
      canonicalBytes += calculated.bytes
      integrity = {
        mode: 'chain',
        previousDigest: state.headDigest,
        digest: calculated.digest,
      }
    }
    entries.push({ seq: event.seq, ...integrity })
    state = { ...state, lastSeq: event.seq, headDigest: integrity.digest }
  }
  return { entries, state, canonicalBytes }
}

/** Same chain contract as verifyIntegrityRows, with cooperative hashing for very large event bodies. */
export async function verifyIntegrityRowCooperatively(
  row: IntegrityRow,
  state: IntegrityState,
  yieldCpu: () => void | Promise<void>,
): Promise<IntegrityState> {
  const next = verifyIntegrityRows([row], state, false)
  if (!row.integrity) return next
  const value =
    row.integrity.mode === 'anchor'
      ? {
          algorithm: LEDGER_INTEGRITY_ALGORITHM,
          sessionKey: row.sessionKey,
          legacyThroughSeq: state.legacyThroughSeq,
          event: row.event,
        }
      : {
          algorithm: LEDGER_INTEGRITY_ALGORITHM,
          sessionKey: row.sessionKey,
          previousDigest: row.integrity.previousDigest,
          event: row.event,
        }
  const hash = createSha256()
  let pending = ''
  try {
    for (const token of jcsChunks(value)) {
      pending += token
      if (pending.length >= FLUSH_CHARS) {
        hash.update(pending)
        pending = ''
        await yieldCpu()
      }
    }
    if (pending) hash.update(pending)
  } catch (error) {
    if (error instanceof CoreError) throw error
    fail('stored event cannot be canonicalized', row.event.seq)
  }
  if (!sameDigest(row.integrity.digest, hash.digestHex())) fail('ledger digest mismatch', row.event.seq)
  return next
}
