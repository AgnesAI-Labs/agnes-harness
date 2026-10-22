import { boundedTimelinePage, type Event, leanEvents, projectUI, turnsForNodes } from '@agnes/core'
import {
  type SessionVersionIssue,
  type SessionViewNotice,
  type SessionViewResult,
  sessionVersionNotice,
} from '@agnes/protocol'
import { classifyGenerationFailure } from '../generation/seam-pins.js'

const PAGE = 500
const MAX_BYTES = 8 * 1024 * 1024

/** What one read may spend before it returns the rows scanned so far with a marker. */
export const SESSION_VIEW_SCAN_BUDGET = Object.freeze({
  events: 100_000,
  bytes: 64 * 1024 * 1024,
  timeMs: 15_000,
})

type ScanBudget = Record<keyof typeof SESSION_VIEW_SCAN_BUDGET, number>
type ScanStop = NonNullable<SessionViewResult['history']['scan']>['reason']

export type SessionRowsReader = (
  sessionKey: string,
  query: { fromSeq?: number; toSeq?: number; limit: number; order?: 'asc' | 'desc' },
) => Promise<Event[]>

type Rows = {
  events: Event[]
  issue?: SessionVersionIssue
  reason?: string
  /** Why the read ended before it reached the end it was walking toward. */
  stopped?: ScanStop
}

const eventBytes = (event: Event): number => Buffer.byteLength(JSON.stringify(event), 'utf8')

/**
 * Settles with the read, or with the reason the caller stopped waiting. A reader that never returns
 * cannot hold the view past its deadline or the caller's cancel; its late result is dropped.
 */
async function settled<T>(
  pending: Promise<T>,
  signal: AbortSignal | undefined,
  deadline: number,
): Promise<{ value: T } | { stop: 'time' | 'cancelled' }> {
  if (signal?.aborted) return { stop: 'cancelled' }
  const left = deadline - Date.now()
  if (left <= 0) return { stop: 'time' }
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const stop = new Promise<{ stop: 'time' | 'cancelled' }>((resolve) => {
    timer = setTimeout(() => resolve({ stop: 'time' }), left)
    onAbort = () => resolve({ stop: 'cancelled' })
    signal?.addEventListener('abort', onAbort, { once: true })
  })
  pending.catch(() => undefined)
  try {
    return await Promise.race([pending.then((value) => ({ value })), stop])
  } finally {
    clearTimeout(timer)
    if (onAbort) signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * One session's recorded conversation, projected from its rows alone. Nothing here opens the
 * session, restores a generation or pin, takes a lock or writes: a session this build cannot
 * continue is still read. Rows are decoded page by page; when a page cannot be decoded, the rows
 * on the readable side of it are kept and the failure is reported as a notice instead of guessing
 * what is beyond it.
 *
 * The scan is budgeted (events, encoded bytes, time), and a read that does not return is abandoned at
 * the deadline or the caller's cancel. A session over the budget is shown by its newest rows, read
 * backwards from the end, so the latest conversation stays reachable; `history.scan` names the rows
 * that were read (`fromSeq`..`throughSeq`) and why the rest were not. A page may overshoot a budget by
 * at most one event.
 */
export async function readSessionView(
  read: SessionRowsReader,
  sessionKey: string,
  options: {
    maxNodes?: number
    signal?: AbortSignal
    budget?: Partial<ScanBudget>
  } = {},
): Promise<SessionViewResult> {
  const budget = { ...SESSION_VIEW_SCAN_BUDGET, ...options.budget }
  const { signal } = options
  // Each pass gets the whole time budget: the newest-rows pass starts after a pass that ran out of it.
  const fetcher =
    (deadline = Date.now() + budget.timeMs): Fetch =>
    (query) =>
      settled(read(sessionKey, query), signal, deadline)
  let probe: Awaited<ReturnType<Fetch>> | undefined
  try {
    probe = await fetcher()({ limit: 1, order: 'desc' })
  } catch (error) {
    // A record that cannot be decoded is reported by the pass that reads it; anything else is the caller's.
    failure(error)
  }
  const newest = probe && 'value' in probe ? (probe.value[0]?.seq ?? 0) : 0
  let rows: Rows
  if (probe && 'stop' in probe) rows = { events: [], stopped: probe.stop }
  else {
    const head = newest <= budget.events ? await scanForward(fetcher(), budget, signal) : undefined
    // A prefix that ran out of budget would hide the conversation people are looking for.
    rows =
      head && (!head.stopped || head.stopped === 'cancelled')
        ? head
        : await scanBackward(fetcher(), budget, signal, newest)
  }
  const first = rows.events[0]?.seq ?? 1
  const { events, issue, reason, stopped } = rows
  const lastSeq = events.at(-1)?.seq ?? 0
  const full = await projectUI(events, { sessionKey, surface: 'web', afterSeq: first - 1 })
  // Nothing is running behind a read: no busy state, no approval to answer.
  const nodes = full.nodes.filter((node) => node.kind !== 'approval' || node.state !== 'pending')
  const page = boundedTimelinePage(nodes, nodes.length, options.maxNodes ?? 200, MAX_BYTES)
  const notice: SessionViewNotice | undefined = issue ? noticeFor(issue, sessionKey, reason) : undefined
  return {
    sessionId: sessionKey,
    readOnly: true,
    lastSeq,
    timeline: {
      sessionId: sessionKey,
      upto: lastSeq,
      generation: 1,
      opState: null,
      nodes: page.nodes,
      // Forking needs a live parent; a read has none.
      turns: turnsForNodes(full.turns, page.nodes, false).map((turn) => ({ ...turn, forkable: false })),
      ...(full.usage ? { usage: full.usage } : {}),
    },
    history: {
      hasEarlier: page.hasEarlier,
      startIndex: page.startIndex,
      totalNodes: page.totalNodes,
      ...(stopped ? { scan: { reason: stopped, fromSeq: first, throughSeq: lastSeq } } : {}),
    },
    ...(notice ? { notice } : {}),
  }
}

/** The ledger reads a stored view needs; lean pages when the adapter has them. */
export type SessionViewStorage = {
  scan(key: string, query: Parameters<SessionRowsReader>[1]): Promise<Event[]>
  scanLean?(key: string, query: Parameters<SessionRowsReader>[1]): Promise<Event[]>
}

/** What a preview may spend: small enough to answer before the session is opened anywhere. */
export const STORED_VIEW_BUDGET = Object.freeze({ events: 2000, bytes: 8 * 1024 * 1024, timeMs: 750 })

/**
 * One session's view read straight from a storage adapter with the preview budget. The Host and the
 * daemon both answer `session.view` through this, so their rows, budget and projection cannot drift.
 */
export function readStoredSessionView(
  storage: SessionViewStorage,
  sessionKey: string,
  options: { maxNodes?: number; signal?: AbortSignal } = {},
): Promise<SessionViewResult> {
  const read = storage.scanLean?.bind(storage) ?? storage.scan.bind(storage)
  return readSessionView(
    async (key, query) =>
      leanEvents(
        await read(key, {
          ...(query.fromSeq === undefined ? {} : { fromSeq: query.fromSeq }),
          ...(query.toSeq === undefined ? {} : { toSeq: query.toSeq }),
          limit: query.limit,
          order: query.order ?? 'asc',
        }),
      ),
    sessionKey,
    { budget: STORED_VIEW_BUDGET, ...options },
  )
}

type Fetch = (query: Parameters<SessionRowsReader>[1]) => ReturnType<typeof settled<Event[]>>

function exhausted(count: number, bytes: number, budget: ScanBudget): ScanStop | undefined {
  return count >= budget.events ? 'events' : bytes >= budget.bytes ? 'bytes' : undefined
}

/** Reads from seq 1 until the end or a budget; the rows it keeps are the oldest ones. */
async function scanForward(fetch: Fetch, budget: ScanBudget, signal: AbortSignal | undefined): Promise<Rows> {
  const events: Event[] = []
  let bytes = 0
  for (let fromSeq = 1; ; ) {
    const stopped = signal?.aborted ? 'cancelled' : exhausted(events.length, bytes, budget)
    if (stopped) return { events, stopped }
    let result: Awaited<ReturnType<Fetch>>
    try {
      result = await fetch({ fromSeq, limit: PAGE })
    } catch (error) {
      return { events, ...failure(error) }
    }
    if ('stop' in result) return { events, stopped: result.stop }
    if (result.value.length === 0) return { events }
    for (const event of result.value) {
      // A gap would silently drop history; what follows it is not trusted.
      if (event.seq !== fromSeq) return { events, issue: 'corrupt', reason: 'E_FORMAT_CORRUPT' }
      const over = exhausted(events.length, bytes, budget)
      if (over) return { events, stopped: over }
      events.push(event)
      bytes += eventBytes(event)
      fromSeq += 1
    }
  }
}

/** Reads from the newest row toward seq 1 until the start or a budget; the rows it keeps are the newest. */
async function scanBackward(
  fetch: Fetch,
  budget: ScanBudget,
  signal: AbortSignal | undefined,
  newest: number,
): Promise<Rows> {
  const events: Event[] = []
  let bytes = 0
  const done = (rest: Omit<Rows, 'events'> = {}): Rows => ({ events: events.reverse(), ...rest })
  for (let toSeq = newest; toSeq >= 1; ) {
    const stopped = signal?.aborted ? 'cancelled' : exhausted(events.length, bytes, budget)
    if (stopped) return done({ stopped })
    let result: Awaited<ReturnType<Fetch>>
    try {
      result = await fetch({ toSeq, limit: PAGE, order: 'desc' })
    } catch (error) {
      return done(failure(error))
    }
    if ('stop' in result) return done({ stopped: result.stop })
    if (result.value.length === 0) return done()
    for (const event of result.value) {
      if (event.seq !== toSeq) return done({ issue: 'corrupt', reason: 'E_FORMAT_CORRUPT' })
      const over = exhausted(events.length, bytes, budget)
      if (over) return done({ stopped: over })
      events.push(event)
      bytes += eventBytes(event)
      toSeq -= 1
    }
  }
  return done()
}

function failure(error: unknown): Pick<Rows, 'issue' | 'reason'> {
  const issue = classifyGenerationFailure(error)
  if (!issue) throw error
  const reason = (error instanceof Error ? error.message : String(error)).match(/E_[A-Z0-9_]+/)?.[0]
  return { issue, ...(reason ? { reason } : {}) }
}

function noticeFor(issue: SessionVersionIssue, sessionId: string, reason?: string): SessionViewNotice {
  const notice = sessionVersionNotice(issue, { sessionId, ...(reason ? { reason } : {}) })
  return { code: notice.code, issue, actions: [...notice.actions], localized: notice.message }
}
