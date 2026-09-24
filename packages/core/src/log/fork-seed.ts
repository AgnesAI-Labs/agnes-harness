import type { SurfaceSnapshot } from '../project/surface.js'
import type { LedgerState } from '../reduce/state.js'
import type { Event, Seq } from '../types.js'
import type { SessionLogImpl } from './session-log.js'
import type { OpWrite } from './storage.js'

/** Called between two pages of a long ledger read; may wait so other work gets the event loop. */
export type PageYield = () => void | Promise<void>

// Yield at most once per slice: a macrotask between every page of a fast read would only add delay.
const SLICE_MS = 8
let lastYieldAt = 0
let replacement: PageYield | undefined

/** The yield core's own long reads use between pages. */
export const pageYield: PageYield = () => {
  if (replacement) return replacement()
  const now = performance.now()
  if (now - lastYieldAt < SLICE_MS) return
  return new Promise<void>((resolve) => {
    globalThis.setTimeout(() => {
      lastYieldAt = performance.now()
      resolve()
    }, 0)
  })
}

/** Test seam: swaps the page yield for the caller's and returns the undo. Not exported from core. */
export function replacePageYieldForTest(fn: PageYield): () => void {
  const previous = replacement
  replacement = fn
  return () => {
    replacement = previous
  }
}

/**
 * What a live parent hands a delegated child it forks at `seq`: its folded state and surface at that
 * seq. A `trigger` point also carries the chain head this process committed at that seq; a `head`
 * point is the parent's current head, whose chain state the parent log holds itself.
 */
export type ForkBase =
  | { kind: 'head'; seq: Seq; state: LedgerState; surface: SurfaceSnapshot }
  | { kind: 'trigger'; seq: Seq; state: LedgerState; surface: SurfaceSnapshot; headDigest: string }

/** Registered by a parent's tracker; answers synchronously, or not at all when it cannot seed. */
export const forkBaseProviders = new WeakMap<
  SessionLogImpl,
  (boundarySeq: Seq, lane: string) => ForkBase | undefined
>()

/** The trigger a batch opens a turn at: the seq its op write names, if that seq is in the batch. */
export function batchTrigger(events: readonly Event[], op: OpWrite | undefined): Seq | undefined {
  const first = events[0]?.seq
  const last = events.at(-1)?.seq
  if (first === undefined || last === undefined) return undefined
  const seq = op?.data?.meta.triggerSeq
  return typeof seq === 'number' && seq >= first && seq <= last ? seq : undefined
}

/**
 * A delegated child opened from its live parent, waiting for its tracker: the parent's fork point,
 * the parent rows after it up to the boundary, the child's own rows as verified at open, and the rows
 * the child committed before a tracker was attached. Every row here was verified or written by this
 * process.
 */
export type SeededLog = { base: ForkBase; inherited: Event[]; own: Event[]; tail: Event[] }
export const seededLogs = new WeakMap<SessionLogImpl, SeededLog>()

/** How a delegated child was opened; a cold open says why the live parent could not seed it. */
export type ForkPath = { path: 'live-parent' } | { path: 'cold-open'; reason: 'no-tracker' | 'no-fork-point' }
export const forkPaths = new WeakMap<SessionLogImpl, ForkPath>()
