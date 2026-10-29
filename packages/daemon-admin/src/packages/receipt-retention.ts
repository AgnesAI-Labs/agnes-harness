/** Recovery and dedupe receipts survive for seven days after reaching a terminal state. */
export const RECEIPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
export const OPERATION_CAPACITY = 10_000

export type RetainedOperation = {
  state: 'running' | 'completed' | 'failed' | 'unknown'
  review: { expires: number }
  /** Absent on records written before retention was introduced. */
  terminalAt?: number
  code?: string
}

/** Called only under the store's write lock; the caller persists changes with its normal save. */
export function sweepReceipts(operations: Record<string, RetainedOperation>, now: number): boolean {
  let changed = false
  let scanned = 0
  // The admission cap also bounds the sweep, including a sweep made under capacity pressure.
  for (const key in operations) {
    if (!Object.hasOwn(operations, key)) continue
    if (scanned++ >= OPERATION_CAPACITY) break
    const op = operations[key]
    if (!op) continue
    if (op.state === 'running') {
      if (op.review.expires > now) continue
      op.state = 'unknown'
      op.code = 'OUTCOME_UNKNOWN'
      op.terminalAt = now
      changed = true
    }
    if (op.terminalAt === undefined) {
      // The review expiry cannot prove when a long-running operation actually finished.
      op.terminalAt = now
      changed = true
    }
    if (now >= Math.max(op.review.expires, op.terminalAt + RECEIPT_RETENTION_MS)) {
      delete operations[key]
      changed = true
    }
  }
  return changed
}
