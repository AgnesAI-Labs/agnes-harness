import { CoreError, type Event, type Seq, type SessionKey } from '@agnes/core-common/types'
import { pageYield } from './fork-seed.js'
import {
  type IntegrityState,
  LedgerIntegrityFailure,
  type VerificationOptions,
  verifyIntegrityRowCooperatively,
  verifyLedger,
} from './integrity.js'
import type { IntegrityRow, StorageAdapter } from './storage.js'
import { decideCheckpoint } from './verified-head.js'

/** One background full verification: its duration and the rows it hashed, with no content. */
export type FullVerifyReport = { ms: number; rows: number; outcome: 'ok' | 'failed'; seq?: Seq }

/** Rehash the prefix in small pages, yielding behind pending I/O and between large rows. */
export async function verifyCheckpointPrefix(
  storage: StorageAdapter,
  key: SessionKey,
  head: { throughSeq: number; headDigest: string | null; legacyThroughSeq: number },
  signal: AbortSignal,
  onReport?: (report: FullVerifyReport) => void,
): Promise<void> {
  const started = performance.now()
  const deadline = started + 600_000
  let rows = 0
  const check = () => {
    if (signal.aborted) throw new CoreError('E_CLOSED', 'session closed')
    if (performance.now() > deadline)
      throw new CoreError('E_STORAGE_FAULT', 'history verification hard timeout')
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
      await waitForVerification(
        new Promise<void>((resolve) => {
          if (typeof globalThis.setImmediate === 'function') globalThis.setImmediate(resolve)
          else globalThis.setTimeout(resolve, 0)
        }),
        signal,
      )
      await waitForVerification(Promise.resolve(pageYield()), signal)
      check()
      const page = await backgroundPage(
        storage,
        key,
        {
          fromSeq: state.lastSeq + 1,
          toSeq: head.throughSeq,
          limit: 32,
        },
        signal,
      )
      if (page.length === 0)
        throw new LedgerIntegrityFailure('ledger ended before advertised sequence', {
          seq: state.lastSeq + 1,
        })
      if (page.length > 32 || (page.at(-1)?.event.seq ?? 0) > head.throughSeq)
        throw new LedgerIntegrityFailure('ledger exceeds advertised page or sequence')
      for (const row of page) {
        state = await verifyIntegrityRowCooperatively(row, state, async () => {
          await waitForVerification(Promise.resolve(pageYield()), signal)
          check()
        })
        rows++
        await waitForVerification(Promise.resolve(pageYield()), signal)
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

/**
 * Cold opens fold the prefix and hash only the tail; live rechecks need only the tail. Neither hashes the
 * prefix: `hashPrefix` makes a ledger without a usable checkpoint hash every row, for an explicit full
 * verification (one with a checkpoint rehashes its prefix with `verifyCheckpointPrefix`).
 */
export async function verifyCheckpointHistory(
  storage: StorageAdapter,
  key: SessionKey,
  lastSeq: Seq,
  options: VerificationOptions,
  onPage?: (events: Event[]) => void,
  hashPrefix = false,
) {
  // An unreadable checkpoint uses the no-checkpoint cold path; full hashing is separate.
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
    hashPrefix,
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

/** A blocked provider must not pin a closed session or leave attestations waiting forever. */
async function backgroundPage(
  storage: StorageAdapter,
  key: SessionKey,
  query: { fromSeq: number; toSeq: number; limit: number },
  signal: AbortSignal,
): Promise<IntegrityRow[]> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  const stopped = new Promise<never>((_, reject) => {
    abort = () => reject(new CoreError('E_CLOSED', 'session closed'))
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    timer = setTimeout(
      () => reject(new CoreError('E_STORAGE_FAULT', 'history verification idle timeout')),
      30_000,
    )
  })
  try {
    return await Promise.race([storage.scanIntegrity(key, query), stopped])
  } finally {
    clearTimeout(timer)
    if (abort) signal.removeEventListener('abort', abort)
  }
}
