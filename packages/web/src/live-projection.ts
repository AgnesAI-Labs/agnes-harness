import type { UITimeline } from '@agnes/protocol'
import {
  type Client,
  type LedgerEvent,
  PreviewMerger,
  type Session,
  UIProjectionSync,
  type UIProjectionWindow,
} from '@agnes/sdk/browser'

/** Web keeps the protocol's bounded opening and a modest history page. */
export const WEB_OPENING = { maxNodes: 500, maxBytes: 1_048_576 } as const
export const WEB_HISTORY_LIMIT = 100
/** Pages loaded on their own to find a pending approval that lies before the loaded window. */
export const APPROVAL_SEARCH_PAGES = 3

export type LiveProjectionSink = {
  /** An authoritative timeline from the daemon: an opening, a patch or a history page. */
  timeline(value: UITimeline, window: UIProjectionWindow): void
  /** The same timeline with streamed text laid over it locally; only the transcript needs repainting. */
  stream(value: UITimeline): void
  /** Each later ledger event, once. */
  event(event: LedgerEvent): void
  error(error: unknown): void
}

export type LiveProjection = {
  start(): Promise<void>
  stop(): Promise<void>
  refresh(): void
  resync(): Promise<void>
  loadEarlier(): Promise<boolean>
  hasEarlier(): boolean
  /** Whether the loaded window starts at the first node, so its first user message is the task's. */
  atStart(): boolean
}

/**
 * Drives one Web session from a bounded opening and incremental patches. Streamed text is never in
 * those: a streaming node arrives empty, tagged with its inference, and the text comes from the
 * session's previews, merged locally and laid over every timeline the daemon installs.
 */
export function createLiveProjection(
  session: Pick<Session, 'events' | 'onPreview' | 'projectUIOpening' | 'projectUIHistory' | 'projectUIPatch'>,
  connection: Pick<Client, 'connectionState' | 'on'>,
  sink: LiveProjectionSink,
): LiveProjection {
  const merger = new PreviewMerger()
  let authoritative: UITimeline | undefined
  let shown: UITimeline | undefined
  let window: UIProjectionWindow | undefined
  const continuity = new Map<string, { text: string; thinking?: string }>()

  // The SDK resets offset accounting after reconnect. Keep only the last displayed text while
  // the new authoritative opening is empty; the first fresh preview or committed result replaces it.
  const display = (value: UITimeline): UITimeline => {
    const projected = merger.apply(value)
    if (continuity.size === 0) {
      shown = projected
      return projected
    }
    let nodes: UITimeline['nodes'] | undefined
    const retained = new Set<string>()
    for (const [index, node] of projected.nodes.entries()) {
      if (node.kind !== 'assistant' || !node.streaming || !node.effectId) continue
      const previous = continuity.get(node.effectId)
      if (!previous) continue
      if (node.text || node.thinking) continue
      retained.add(node.effectId)
      nodes ??= [...projected.nodes]
      nodes[index] = {
        ...node,
        text: previous.text,
        ...(previous.thinking ? { thinking: previous.thinking } : {}),
      }
    }
    for (const effectId of continuity.keys()) if (!retained.has(effectId)) continuity.delete(effectId)
    shown = nodes ? { ...projected, nodes } : projected
    return shown
  }

  const sync = new UIProjectionSync(
    session,
    {
      timeline(value, at) {
        window = at
        authoritative = value
        sink.timeline(display(value), at)
      },
      preview(p) {
        if (!merger.add(p) || !authoritative) return
        continuity.delete(p.effectId)
        // Only a node already on screen repaints; one still on its way gets the text when it lands.
        if (!authoritative.nodes.some((node) => node.kind === 'assistant' && node.effectId === p.effectId))
          return
        sink.stream(display(authoritative))
      },
      event: (event) => sink.event(event),
      error: (error) => sink.error(error),
    },
    {
      surface: 'web',
      opening: WEB_OPENING,
      historyLimit: WEB_HISTORY_LIMIT,
      isolate: 'share',
      openingFailure: 'reject',
      connection,
    },
  )
  // A new connection or worker generation may have ended any stream this client was following.
  const offReconnected = connection.on('reconnected', () => {
    continuity.clear()
    for (const node of shown?.nodes ?? []) {
      if (node.kind !== 'assistant' || !node.streaming || !node.effectId) continue
      if (node.text || node.thinking)
        continuity.set(node.effectId, {
          text: node.text,
          ...(node.thinking ? { thinking: node.thinking } : {}),
        })
    }
    merger.reset()
  })

  return {
    start: () => sync.start(),
    stop: () => {
      offReconnected()
      continuity.clear()
      shown = undefined
      return sync.stop()
    },
    refresh: () => sync.refresh(),
    resync: () => sync.resync(),
    loadEarlier: () => sync.loadEarlier(),
    hasEarlier: () => window?.hasEarlier === true,
    atStart: () => window?.startIndex === 0,
  }
}

/**
 * Whether a pending approval is parked on the session while none of the loaded nodes shows it: its
 * node lies before the loaded window.
 */
export function approvalOutsideWindow(value: UITimeline): boolean {
  if (!value.opState?.parked) return false
  return !value.nodes.some((node) => node.kind === 'approval' && node.state === 'pending')
}

/**
 * Loads earlier pages until the pending approval is in the window, or `limit` pages were read, or
 * there is nothing earlier. Answers whether the approval is now loaded.
 */
export async function findApproval(
  live: Pick<LiveProjection, 'loadEarlier' | 'hasEarlier'>,
  current: () => UITimeline | undefined,
  limit = Number.POSITIVE_INFINITY,
): Promise<boolean> {
  for (let page = 0; page < limit; page++) {
    const value = current()
    if (!value || !approvalOutsideWindow(value)) return value !== undefined
    if (!live.hasEarlier() || !(await live.loadEarlier())) return false
  }
  const value = current()
  return value !== undefined && !approvalOutsideWindow(value)
}
