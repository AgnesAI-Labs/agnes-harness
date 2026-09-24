import { jcs } from '@agnes/protocol'
import { sha256Hex, utf8 } from '../request/hash.js'
import { CoreError, type Event, type Seq, type SessionKey } from '../types.js'
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

function digestCanonical(value: unknown): { digest: string; bytes: number } {
  const canonical = jcs(value)
  return { digest: sha256Hex(canonical), bytes: utf8(canonical).byteLength }
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
): Promise<IntegrityState> {
  let state = { ...EMPTY_STATE }
  while (state.lastSeq < lastSeq) {
    if (state.lastSeq > 0) await yieldPage?.()
    const rows = await storage.scanIntegrity(key, {
      fromSeq: state.lastSeq + 1,
      toSeq: lastSeq,
      limit: INTEGRITY_PAGE_SIZE,
    })
    if (rows.length === 0) fail('ledger ended before advertised sequence', state.lastSeq + 1)
    state = verifyIntegrityRows(rows, state)
    onPage?.(rows.map((row) => row.event))
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
