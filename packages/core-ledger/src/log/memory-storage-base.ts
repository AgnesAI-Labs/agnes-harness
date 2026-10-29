import type { Clock, Seq, SessionKey } from '@agnes/core-common/types'
import type { IntegrityRow } from './storage.js'
import type { VerifiedHead } from './verified-head.js'

/**
 * The state every in-memory adapter starts with (its clock and child-control format), and the part of it
 * that keeps a session's verified-head checkpoint and answers the questions about stored rows that
 * deciding on one needs. It lives apart from the ledger and child-control state so that file stays within
 * its size limit.
 */
export abstract class MemoryStorageBase {
  protected readonly clock: Clock
  protected controlFormat: number
  private readonly integrityFailures = new Map<string, { seq?: number }>()
  private readonly verifiedHeads = new Map<SessionKey, VerifiedHead>()

  constructor(opts: { clock?: Clock; childControlFormat?: number } = {}) {
    this.clock = opts.clock ?? (() => Date.now())
    this.controlFormat = opts.childControlFormat ?? 1
  }

  /** Every row of the session, a child's inherited prefix included; undefined for a session never opened. */
  protected abstract integrityRowsOf(key: SessionKey): IntegrityRow[] | undefined

  /** Forgets the checkpoint of a session that is being discarded. */
  protected dropVerifiedHead(key: SessionKey): void {
    this.verifiedHeads.delete(key)
  }

  /** Sizes are counted in characters of the JSON text, not bytes: this adapter stores no encoded form. */
  async ledgerStats(key: SessionKey): Promise<{ storedBytes: number; maxRowBytes: number }> {
    let storedBytes = 0
    let maxRowBytes = 0
    for (const row of this.integrityRowsOf(key) ?? []) {
      const size = JSON.stringify(row.event.data).length
      storedBytes += size
      if (size > maxRowBytes) maxRowBytes = size
    }
    return { storedBytes, maxRowBytes }
  }

  async readIntegrityFailure(key: string): Promise<{ seq?: number } | undefined> {
    const failure = this.integrityFailures.get(key)
    return failure && { ...failure }
  }

  async writeIntegrityFailure(key: string, failure: { seq?: number }): Promise<void> {
    this.integrityFailures.set(key, { ...failure })
  }

  async readVerifiedHead(key: SessionKey): Promise<VerifiedHead | undefined> {
    const head = this.verifiedHeads.get(key)
    return head && { ...head }
  }

  async writeVerifiedHead(head: VerifiedHead, opts?: { force?: boolean }): Promise<void> {
    const current = this.verifiedHeads.get(head.sessionKey)
    if (current && current.throughSeq > head.throughSeq && !opts?.force) return
    this.verifiedHeads.set(head.sessionKey, { ...head })
  }

  async deleteVerifiedHead(key: SessionKey): Promise<void> {
    this.verifiedHeads.delete(key)
  }

  async integrityDigestAt(key: SessionKey, seq: Seq): Promise<string | null | undefined> {
    const row = this.integrityRowsOf(key)?.find((r) => r.event.seq === seq)
    return row ? (row.integrity?.digest ?? null) : undefined
  }
}
