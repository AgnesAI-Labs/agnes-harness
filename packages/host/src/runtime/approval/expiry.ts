import { approvalDeadlineMs, type Timers } from '@agnes/core'
import type { HostSession } from './host.js'

/**
 * The host owns the wake-up, while core owns the fact that gets written. Nothing is scheduled while
 * no approval is pending; a new one is noticed as its `approval/asked` row commits. The wake-up is
 * pinned to the earliest deadline, but never more than MAX_WAKE_MS away: the deadline is wall-clock
 * time and the timer is not, so a sleeping machine or a clock change is caught up within that bound.
 */
const MAX_WAKE_MS = 30_000
const MIN_WAKE_MS = 10
const ERROR_RETRY_MS = 100

type ExpirableSession = Pick<HostSession, 'key' | 'lane' | 'state' | 'expireApprovals'> & {
  d: {
    clock: () => number
    timers?: Timers
    log: { observeCommitted(types: readonly string[], notify: () => void): () => void }
  }
}

export type ApprovalExpiryController = {
  /** Stops future wake-ups and drains one expiry operation already admitted to core. */
  close(): Promise<void>
}

export type ApprovalExpiryOptions = {
  onError?: (error: unknown) => void
}

function nextWakeMs(session: ExpirableSession): number | undefined {
  const now = session.d.clock()
  let earliest: number | undefined
  for (const approval of session.state.pendingApprovals.values()) {
    if (approval.lane !== session.lane) continue
    const expiresAt = approval.pending?.expiresAt
    if (typeof expiresAt !== 'string') continue
    // Read exactly as core reads it: a deadline core cannot parse is one it already treats as due.
    const at = approvalDeadlineMs(expiresAt)
    if (Number.isNaN(at)) return MIN_WAKE_MS
    if (earliest === undefined || at < earliest) earliest = at
  }
  if (earliest === undefined) return undefined
  return Math.max(MIN_WAKE_MS, Math.min(MAX_WAKE_MS, earliest - now))
}

/**
 * Starts the one scheduler shared by every entry point that opens a Host session. `expireApprovals`
 * already serializes against approval decisions; this controller adds a second guard so a timer
 * firing during a slow storage append cannot create a second in-flight expiry call. Storage
 * failures are reported and retried, never translated into an apparent successful expiry.
 */
export async function startApprovalExpiry(
  session: ExpirableSession,
  options: ApprovalExpiryOptions = {},
): Promise<ApprovalExpiryController> {
  const timers = session.d.timers ?? {
    setTimeout: (fn: () => void, ms: number) => globalThis.setTimeout(fn, ms),
    clearTimeout: (handle: unknown) => globalThis.clearTimeout(handle as number),
  }
  let stopped = false
  let timer: { handle: unknown } | undefined
  let running: Promise<void> | undefined

  const clearWake = (): void => {
    if (!timer) return
    timers.clearTimeout(timer.handle)
    timer = undefined
  }

  const schedule = (retry: boolean): void => {
    if (stopped) return
    clearWake()
    const ms = retry ? ERROR_RETRY_MS : nextWakeMs(session)
    if (ms === undefined) return
    const handle = timers.setTimeout(() => {
      timer = undefined
      void run()
    }, ms)
    timer = { handle }
    // A live session is owned by its Host/daemon; the scheduler must not keep an otherwise idle
    // process alive while the owner is winding down. Fitted test timers do not need this method.
    const unref = (handle as { unref?: () => void } | null | undefined)?.unref
    unref?.call(handle)
  }

  let initial = true
  const run = async (): Promise<void> => {
    if (stopped || running) return
    const isInitial = initial
    initial = false
    let retry = false
    const operation = (async (): Promise<void> => {
      try {
        await session.expireApprovals()
      } catch (error) {
        retry = true
        try {
          options.onError?.(error)
        } catch {
          // Diagnostics must not kill the retry loop when an application logger is closing.
        }
        if (isInitial) throw error
      }
    })()
    running = operation
    try {
      await operation
    } finally {
      if (running === operation) running = undefined
      if (!isInitial) schedule(retry)
    }
  }

  // This first call is awaited by Host.createSession. A reopened session therefore settles
  // already-expired persisted approvals before its handle is handed to a caller. A storage failure
  // is propagated for startup cleanup; later failures are reported and retried by the timer.
  const unobserve = session.d.log.observeCommitted(['approval/asked'], () => schedule(false))
  try {
    await run()
  } catch (error) {
    unobserve()
    throw error
  }
  schedule(false)

  return {
    async close(): Promise<void> {
      stopped = true
      unobserve()
      clearWake()
      const active = running
      if (active) await active.catch(() => undefined)
    },
  }
}
