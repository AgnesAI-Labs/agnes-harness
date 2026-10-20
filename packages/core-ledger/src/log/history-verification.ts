import { CoreError, type Event, type Seq, type SessionKey } from '@agnes/core-common/types'
import { pageYield } from './fork-seed.js'
import {
  type IntegrityState,
  LedgerIntegrityFailure,
  type VerificationOptions,
  verifyIntegrityRows,
  verifyLedger,
} from './integrity.js'
import type { StorageAdapter } from './storage.js'
import { decideCheckpoint, type VerifiedHead } from './verified-head.js'

/** One background full verification: its duration and the rows it hashed, with no content. */
export type FullVerifyReport = { ms: number; rows: number; outcome: 'ok' | 'failed'; seq?: Seq }

/** Rehash the prefix in small pages, yielding behind pending I/O and between large rows. */
export async function verifyCheckpointPrefix(
  storage: StorageAdapter,
  key: SessionKey,
  head: VerifiedHead,
  signal: AbortSignal,
  onReport?: (report: FullVerifyReport) => void,
): Promise<void> {
  const started = performance.now()
  let rows = 0
  const check = () => {
    if (signal.aborted) throw new CoreError('E_CLOSED', 'session closed')
  }
  const report = (outcome: FullVerifyReport['outcome'], seq?: Seq) => {
    try {
      onReport?.({ ms: performance.now() - started, rows, outcome, ...(seq === undefined ? {} : { seq }) })
    } catch {
      /* a report must not change the outcome */
    }
  }
  try {
    let state: IntegrityState = { lastSeq: 0, legacyThroughSeq: 0, headDigest: null }
    while (state.lastSeq < head.throughSeq) {
      await new Promise<void>((resolve) => {
        if (typeof globalThis.setImmediate === 'function') globalThis.setImmediate(resolve)
        else globalThis.setTimeout(resolve, 0)
      })
      await pageYield()
      check()
      const page = await storage.scanIntegrity(key, {
        fromSeq: state.lastSeq + 1,
        toSeq: head.throughSeq,
        limit: 32,
      })
      if (page.length === 0)
        throw new LedgerIntegrityFailure('ledger ended before advertised sequence', {
          seq: state.lastSeq + 1,
        })
      for (const row of page) {
        state = verifyIntegrityRows([row], state)
        rows++
        await pageYield()
        check()
      }
    }
    if (
      state.lastSeq !== head.throughSeq ||
      state.headDigest !== head.headDigest ||
      state.legacyThroughSeq !== head.legacyThroughSeq
    )
      throw new LedgerIntegrityFailure('ledger head differs from its checkpoint', { seq: head.throughSeq })
    report('ok')
  } catch (error) {
    if (!signal.aborted || (error instanceof CoreError && error.code === 'E_LEDGER_INTEGRITY')) {
      const seq = error instanceof CoreError ? error.detail?.seq : undefined
      report('failed', typeof seq === 'number' ? seq : undefined)
    }
    throw error
  }
}

/** Cold opens fold the prefix; live rechecks need only the tail. Both rehash the prefix afterwards. */
export async function verifyCheckpointHistory(
  storage: StorageAdapter,
  key: SessionKey,
  lastSeq: Seq,
  options: VerificationOptions,
  onPage?: (events: Event[]) => void,
) {
  // An unreadable checkpoint is not used: verify everything instead.
  const decision = await decideCheckpoint(storage, key, lastSeq).catch(
    () => ({ use: false, reason: 'unsupported' }) as const,
  )
  const state = await verifyLedger(
    storage,
    key,
    lastSeq,
    pageYield,
    onPage,
    options,
    decision.use ? decision.head : undefined,
  )
  return { decision, state }
}

/** Cancelling an opening observer must not cancel the live session's integrity gate. */
export async function waitForVerification<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work
  let abort: (() => void) | undefined
  const stopped = new Promise<never>((_, reject) => {
    abort = () => reject(new CoreError('E_CLOSED', 'ledger verification cancelled'))
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
  try {
    return await Promise.race([work, stopped])
  } finally {
    if (abort) signal.removeEventListener('abort', abort)
  }
}
