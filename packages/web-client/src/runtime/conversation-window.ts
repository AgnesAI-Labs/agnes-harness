// The client's merge of one session's conversation window. The SDK delivers validated subscription
// frames in order and the caller runs the `conversation.open` and `conversation.history` queries;
// this module does no I/O. Callers feed it frames and query results and act on the steps it returns.
import type {
  ClientConversationSubscriptionFrame,
  DomainTimelineEntry,
  RuntimeConversationChange,
  RuntimeConversationWindow,
} from '@agnes/protocol/runtime'

type Timeline = RuntimeConversationWindow['native']['timeline']
type OrderEntry = RuntimeConversationWindow['order'][number]
type Replace = Extract<RuntimeConversationChange, { kind: 'replace' }>
type History = {
  readonly order: readonly OrderEntry[]
  readonly nodes: ReadonlyMap<string, Timeline['nodes'][number]>
  readonly domains: ReadonlyMap<string, DomainTimelineEntry>
  readonly turns: ReadonlyMap<string, Timeline['turns'][number]>
  /** The last loaded page's `nextPageCursor` and `complete`. */
  readonly cursor: string | null
  readonly complete: boolean
}

/** The protocol's bound on a window's `order`. */
// ponytail: loaded history is bounded by entry count only; a long merge can pass the wire's size
// budget for one window. Count members or bytes here if the merged window is ever sent or stored.
const MAX_ORDER = 10000
// ponytail: replaces received while resyncing are held up to this bound; past it the buffer is
// dropped and the next open may take one more resync to catch up.
const MAX_REPLAY = 256

export type ConversationWindowStatus = 'empty' | 'live' | 'resyncing' | 'offline'
export type WindowStep =
  | { readonly result: 'applied' | 'ignored' }
  | { readonly result: 'resync'; readonly token: number }
export type ConversationWindowMerger = {
  /**
   * Earlier history pages followed by the live window; null before the first window and while
   * isolated. Same object until something changes.
   */
  readonly window: RuntimeConversationWindow | null
  readonly status: ConversationWindowStatus
  /** Writes (card actions, composer) are allowed only while live. */
  readonly writable: boolean
  /** Binds the current subscription; frames of any other subscription are ignored. */
  subscribed(subscriptionId: string): void
  frame(frame: ClientConversationSubscriptionFrame): WindowStep
  /** Starts an open request; only the latest token's result is installed. */
  resync(): number
  opened(token: number, window: RuntimeConversationWindow): WindowStep
  /** The next history request, or null when there is nothing earlier or the window is full. */
  earlier(): { readonly token: number; readonly cursor: string } | null
  loadedEarlier(token: number, page: RuntimeConversationWindow): WindowStep
  /** Drops the window and the bound subscription at once and starts an open request. */
  revoke(): number
  disconnected(): void
}

const APPLIED: WindowStep = { result: 'applied' }
const IGNORED: WindowStep = { result: 'ignored' }

/** One session; ids unique across native nodes and domains; `order` lists each exactly once. */
function coherent(sessionId: string, window: RuntimeConversationWindow): boolean {
  const { timeline } = window.native
  if (window.sessionId !== sessionId || timeline.sessionId !== sessionId) return false
  if (window.complete && window.nextPageCursor !== null) return false
  const kinds = new Map<string, OrderEntry['kind']>()
  for (const node of timeline.nodes) kinds.set(node.id, 'native')
  for (const entry of window.domains) kinds.set(entry.id, 'domain')
  return (
    kinds.size === timeline.nodes.length + window.domains.length &&
    window.order.length === kinds.size &&
    window.order.every((entry) => kinds.get(entry.id) === entry.kind && kinds.delete(entry.id))
  )
}

/**
 * Moves the entries that left the live window into loaded history, after what it holds. Within one
 * epoch an entry leaves only by scrolling out (a removal resets the epoch), so without this a merged
 * window would show a hole between the history pages and the new live window.
 */
function fold(history: History, old: RuntimeConversationWindow, next: RuntimeConversationWindow): History {
  const kept = new Set(next.order.map((entry) => entry.id))
  const held = new Set(history.order.map((entry) => entry.id))
  const left = old.order.filter((entry) => !kept.has(entry.id))
  if (!left.length) return history
  const nodes = new Map(history.nodes)
  const domains = new Map(history.domains)
  const turns = new Map(history.turns)
  for (const node of old.native.timeline.nodes) if (!kept.has(node.id)) nodes.set(node.id, node)
  for (const entry of old.domains) if (!kept.has(entry.id)) domains.set(entry.id, entry)
  for (const turn of old.native.timeline.turns) turns.set(turn.id, turn)
  return {
    ...history,
    order: [...history.order, ...left.filter((entry) => !held.has(entry.id))],
    nodes,
    domains,
    turns,
  }
}

/** Loaded history the live window does not hold, then the live window. */
function compose(live: RuntimeConversationWindow, history: History | null): RuntimeConversationWindow {
  if (!history) return live
  // Ids are unique across kinds in a coherent window, so matching by id is matching by kind and id.
  const liveIds = new Set(live.order.map((entry) => entry.id))
  const older = history.order.filter((entry) => !liveIds.has(entry.id))
  const turns = new Map(history.turns)
  for (const turn of live.native.timeline.turns) turns.set(turn.id, turn)
  return {
    ...live,
    native: {
      ...live.native,
      timeline: {
        ...live.native.timeline,
        nodes: [
          ...older.flatMap((entry) => (entry.kind === 'native' ? (history.nodes.get(entry.id) ?? []) : [])),
          ...live.native.timeline.nodes,
        ],
        turns: [...turns.values()].sort((a, b) => a.startSeq - b.startSeq),
      },
    },
    domains: [
      ...older.flatMap((entry) => (entry.kind === 'domain' ? (history.domains.get(entry.id) ?? []) : [])),
      ...live.domains,
    ],
    order: [...older, ...live.order],
    nextPageCursor: history.cursor,
    complete: history.complete,
  }
}

export function createConversationWindow(sessionId: string): ConversationWindowMerger {
  let status: ConversationWindowStatus = 'empty'
  let subscription: string | null = null
  let live: RuntimeConversationWindow | null = null
  let history: History | null = null
  let composed: RuntimeConversationWindow | null = null
  let tokens = 0
  let opening: number | null = null
  /** The pending history request and the entry the composed window started with when it was asked. */
  let loading: { readonly token: number; readonly before: string | undefined } | null = null
  let replay: Replace[] = []

  const show = (window: RuntimeConversationWindow | null, earlier: History | null) => {
    live = window
    history = earlier
    composed = window && compose(window, earlier)
    // ponytail: a live window that pushes the composition past the order bound drops all loaded
    // history rather than trimming the oldest pages.
    if (earlier && composed && composed.order.length > MAX_ORDER) show(window, null)
  }
  const resync = () => {
    status = 'resyncing'
    opening = ++tokens
    return opening
  }
  const restart = (): WindowStep => ({ result: 'resync', token: resync() })
  const install = (window: RuntimeConversationWindow): WindowStep => {
    if (!coherent(sessionId, window)) return restart()
    show(window, null)
    opening = null
    loading = null
    replay = []
    status = 'live'
    return APPLIED
  }
  const replace = (change: Replace): WindowStep => {
    if (!live) return IGNORED
    if (status === 'resyncing') {
      if (replay.length >= MAX_REPLAY) replay = []
      replay.push(change)
      return IGNORED
    }
    const { window } = change
    if (window.epoch !== live.epoch) return restart()
    if (window.revision <= live.revision) return IGNORED
    if (change.baseOrderCursor !== live.orderCursor || !coherent(sessionId, window)) return restart()
    // A replace is the whole bounded live window; loaded history is kept and stays contiguous.
    show(window, history && fold(history, live, window))
    return APPLIED
  }

  return {
    get window() {
      return composed
    },
    get status() {
      return status
    },
    get writable() {
      return status === 'live'
    },
    subscribed(subscriptionId) {
      subscription = subscriptionId
    },
    frame(frame) {
      if (frame.subscriptionId !== subscription) return IGNORED
      switch (frame.kind) {
        // The snapshot's own `nextCursor` and `complete` are not used; the page carries its paging cursor.
        case 'snapshot':
          return install(frame.payload.page)
        case 'reset':
          return install(frame.payload.snapshot.page)
        case 'change':
          return frame.payload.kind === 'reset' ? install(frame.payload.window) : replace(frame.payload)
        default:
          status = 'offline'
          return APPLIED
      }
    },
    resync,
    opened(token, window) {
      if (token !== opening) return IGNORED
      const queued = replay
      const step = install(window)
      if (step.result !== 'applied') return step
      return queued.map(replace).find((replayed) => replayed.result === 'resync') ?? APPLIED
    },
    earlier() {
      if (!composed || composed.nextPageCursor === null || composed.order.length >= MAX_ORDER) return null
      loading = { token: ++tokens, before: composed.order[0]?.id }
      return { token: loading.token, cursor: composed.nextPageCursor }
    },
    loadedEarlier(token, page) {
      // A page ends where the window started when it was asked. Once that start has moved (entries
      // scrolled out with no history loaded, or history was dropped) it would leave a hole.
      if (token !== loading?.token || !live || composed?.order[0]?.id !== loading?.before) return IGNORED
      loading = null
      if (page.epoch !== live.epoch) return IGNORED
      if (page.native.timeline.generation !== live.native.timeline.generation || !coherent(sessionId, page))
        return restart()
      const liveIds = new Set(live.order.map((entry) => entry.id))
      const pageNodes = new Map(page.native.timeline.nodes.map((node) => [node.id, node]))
      const pageDomains = new Map(page.domains.map((entry) => [entry.id, entry]))
      const nodes = new Map(history?.nodes)
      const domains = new Map(history?.domains)
      const turns = new Map(history?.turns)
      const added: OrderEntry[] = []
      for (const entry of page.order) {
        if (liveIds.has(entry.id)) continue
        if (entry.kind === 'domain') {
          const incoming = pageDomains.get(entry.id)
          const held = domains.get(entry.id)
          if (incoming && (!held || incoming.view.revision > held.view.revision))
            domains.set(entry.id, incoming)
          if (held) continue
        } else {
          const node = pageNodes.get(entry.id)
          if (!node || nodes.has(entry.id)) continue
          nodes.set(entry.id, node)
        }
        added.push(entry)
      }
      for (const turn of page.native.timeline.turns) if (!turns.has(turn.id)) turns.set(turn.id, turn)
      const next: History = {
        order: [...added, ...(history?.order ?? [])],
        nodes,
        domains,
        turns,
        cursor: page.nextPageCursor,
        complete: page.complete,
      }
      const candidate = compose(live, next)
      if (candidate.order.length > MAX_ORDER) return IGNORED
      if (!coherent(sessionId, candidate)) return restart()
      history = next
      composed = candidate
      return APPLIED
    },
    revoke() {
      // Frames of the old subscription were authorized before the revocation.
      subscription = null
      show(null, null)
      loading = null
      replay = []
      return resync()
    },
    disconnected() {
      status = 'offline'
    },
  }
}
