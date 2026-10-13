import { jcsWrite } from '@agnes/protocol'
import { createSha256, type Sha256Stream } from '../request/hash.js'
import { CoreError, type Event, type Seq, type SessionKey } from '../types.js'
import type { IntegrityCommit, IntegrityMetadata, IntegrityRow, StorageAdapter } from './storage.js'

export const LEDGER_INTEGRITY_ALGORITHM = 'agnes-ledger-jcs-sha256-v1' as const
export const INTEGRITY_PAGE_SIZE = 500

export type IntegrityState = {
  lastSeq: Seq
  legacyThroughSeq: Seq
  headDigest: string | null
}

/** Milliseconds a verification spent reading pages, checking digests and handing pages to the fold. */
export type LedgerTiming = { readMs: number; verifyMs: number; foldMs: number }

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

export function verifyIntegrityRows(
  rows: readonly IntegrityRow[],
  initial: IntegrityState = EMPTY_STATE,
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
    let expected: string
    try {
      if (integrity.mode === 'anchor') {
        if (state.headDigest !== null || integrity.previousDigest !== null)
          fail('invalid ledger anchor position', event.seq)
        expected = anchorDigest(row.sessionKey, state.legacyThroughSeq, event).digest
      } else if (integrity.mode === 'chain') {
        if (
          state.headDigest === null ||
          integrity.previousDigest === null ||
          !DIGEST.test(integrity.previousDigest) ||
          !sameDigest(integrity.previousDigest, state.headDigest)
        )
          fail('ledger chain predecessor mismatch', event.seq)
        expected = chainDigest(row.sessionKey, integrity.previousDigest, event).digest
      } else fail('unknown ledger integrity mode', event.seq)
    } catch (error) {
      if (error instanceof LedgerIntegrityFailure) throw error
      fail('stored event cannot be canonicalized', event.seq)
    }
    if (!sameDigest(integrity.digest, expected)) fail('ledger digest mismatch', event.seq)
    state = { ...state, lastSeq: event.seq, headDigest: integrity.digest }
  }
  return state
}

/**
 * `yieldPage`, when given, is awaited between two pages; it is never called after the last one.
 * `onPage` receives each page's events in order, only after that page has been verified.
 */
export async function verifyLedger(
  storage: StorageAdapter,
  key: SessionKey,
  lastSeq: Seq,
  yieldPage?: () => void | Promise<void>,
  onPage?: (events: Event[]) => void,
  timing?: LedgerTiming,
): Promise<IntegrityState> {
  let state = { ...EMPTY_STATE }
  while (state.lastSeq < lastSeq) {
    if (state.lastSeq > 0) await yieldPage?.()
    const readAt = performance.now()
    const rows = await storage.scanIntegrity(key, {
      fromSeq: state.lastSeq + 1,
      toSeq: lastSeq,
      limit: INTEGRITY_PAGE_SIZE,
    })
    const verifyAt = performance.now()
    if (timing) timing.readMs += verifyAt - readAt
    if (rows.length === 0) fail('ledger ended before advertised sequence', state.lastSeq + 1)
    state = verifyIntegrityRows(rows, state)
    const foldAt = performance.now()
    if (timing) timing.verifyMs += foldAt - verifyAt
    onPage?.(rows.map((row) => row.event))
    if (timing) timing.foldMs += performance.now() - foldAt
  }
  if (state.lastSeq !== lastSeq) fail('ledger exceeds advertised sequence', state.lastSeq)
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
