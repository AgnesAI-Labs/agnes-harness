import type { UINode, UITurn } from '@agnes/protocol'

/**
 * A fixed conversation cut: the durable ledger seq the native transcript is held at while a
 * replay surface (for example the Jev decision graph's all-turn replay) scrubs history. The
 * cut is presentation-only; it never re-executes or mutates the session.
 */
export type ConversationCut = Readonly<{ sessionId: string; through: number }>

/** The through-seq that applies to the given session, or undefined when the view stays live. */
export function activeConversationCut(
  cut: ConversationCut | undefined,
  sessionId: string | undefined,
): number | undefined {
  if (!cut || sessionId === undefined || cut.sessionId !== sessionId) return undefined
  return cut.through
}

type ToolNode = Extract<UINode, { kind: 'tool' }>

const openTool = (node: ToolNode): ToolNode => {
  const { resultPreview: _resultPreview, resultSeq: _resultSeq, enforcement: _enforcement, ...rest } = node
  return { ...rest, status: 'running' }
}

/**
 * Node-birth approximation from an arbitrary node list: nodes the ledger had committed at the cut
 * stay, later-born nodes are hidden, and a tool whose settlement lies beyond the cut shows as
 * still running. A node without a seq (only synthesized slot fills) cannot be dated and is kept.
 *
 * Boundary: this is NOT a faithful historical view. A node born before the cut can be updated in
 * place after it — an assistant node's final text, or an approval's decision, land on the same
 * node object — and those later increments would leak through. Use it only where node contents
 * after birth are provably irrelevant (the tool reopen above is the one increment it corrects).
 * The conversation's fixed cut renders `session.projectUI(through)` instead; see
 * `createConversationCutView`.
 */
export function cutConversationNodes(nodes: readonly UINode[], through: number): UINode[] {
  return nodes
    .filter((node) => node.seq === undefined || node.seq <= through)
    .map((node) =>
      node.kind === 'tool' && node.resultSeq !== undefined && node.resultSeq > through
        ? openTool(node)
        : node,
    )
}

const openTurn = (turn: UITurn): UITurn => {
  const {
    endSeq: _endSeq,
    endedAt: _endedAt,
    durationMs: _durationMs,
    reason: _reason,
    error: _error,
    ...rest
  } = turn
  return { ...rest, status: 'running' }
}

/**
 * Turns that had already started at the cut; the turn spanning the cut is shown as open, the
 * way it actually was at that ledger position. Turns that begin later are dropped.
 */
export function cutConversationTurns(turns: readonly UITurn[] | undefined, through: number): UITurn[] {
  if (!turns) return []
  return turns
    .filter((turn) => turn.startSeq <= through)
    .map((turn) => (turn.endSeq !== undefined && turn.endSeq <= through ? turn : openTurn(turn)))
}

/** What the transcript should render while a cut is active. */
export type ConversationCutView = Readonly<{
  through: number
  /** The exact ledger position behind `nodes`; may lag `through` while playback advances. */
  projectedThrough?: number
  nodes: readonly UINode[]
  turns: readonly UITurn[]
  /** True while the projection at `through` is still on its way; nodes may show `projectedThrough`. */
  pending: boolean
  /** True when the authoritative projection failed; nodes stay empty, never future content. */
  error?: boolean
}>

/** Reads the authoritative timeline at one ledger cut; the host binds this to `session.projectUI(through)`. */
export type ConversationCutProjector = (through: number) => Promise<ConversationCutTimeline>

/** The projection fields the cut view renders from. */
export type ConversationCutTimeline = { nodes: readonly UINode[]; turns: readonly UITurn[] }

export type ConversationCutSource = {
  projectAt?: ConversationCutProjector
}

export type ConversationCutViewHandle = {
  /** The resolved view for the current cut; undefined means live (no cut). */
  view: ConversationCutView | undefined
  /** Applies (or clears with undefined) the active cut and resolves its view. */
  apply(through: number | undefined, source: ConversationCutSource): void
  dispose(): void
}

/**
 * Drives the conversation's fixed cut. The live window is never reused as a historical view: a
 * node born before the cut can carry later increments (final assistant text, tool results), so
 * until the first authoritative projection arrives the view stays empty and pending. A failed
 * read surfaces an error view rather than future content. While playback advances, a verified
 * older projection may remain visible until the newest cut is read. Reads are coalesced to one
 * in flight, and a cleared cut returns the host to live.
 */
export function createConversationCutView(
  onView: (view: ConversationCutView | undefined) => void,
  options: { delayMs?: number } = {},
): ConversationCutViewHandle {
  let generation = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let current: ConversationCutView | undefined
  let desired: { through: number; projectAt?: ConversationCutProjector } | undefined
  let verified: { through: number; timeline: ConversationCutTimeline } | undefined
  let reading: object | undefined
  const settle = (next: ConversationCutView | undefined): void => {
    current = next
    onView(next)
  }
  const reset = (): void => {
    generation++
    desired = undefined
    verified = undefined
    reading = undefined
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    if (current !== undefined) settle(undefined)
  }
  const schedule = (): void => {
    if (timer !== undefined || reading || !desired?.projectAt) return
    timer = setTimeout(() => {
      timer = undefined
      const target = desired
      if (!target?.projectAt) return
      const ticket = {}
      const epoch = generation
      reading = ticket
      let result: Promise<ConversationCutTimeline>
      try {
        result = Promise.resolve(target.projectAt(target.through))
      } catch (error) {
        result = Promise.reject(error)
      }
      result.then(
        (timeline) => {
          if (reading !== ticket || generation !== epoch) return
          reading = undefined
          if (!desired || target.through > desired.through) {
            schedule()
            return
          }
          verified = { through: target.through, timeline }
          // An older verified projection stays visible, pending, until the newest cut is read.
          const caughtUp = target.through === desired.through
          settle({
            through: desired.through,
            projectedThrough: target.through,
            pending: !caughtUp,
            nodes: timeline.nodes,
            turns: timeline.turns,
          })
          if (!caughtUp) schedule()
        },
        () => {
          if (reading !== ticket || generation !== epoch) return
          reading = undefined
          if (desired?.through === target.through)
            settle({ through: target.through, pending: false, error: true, nodes: [], turns: [] })
          else schedule()
        },
      )
    }, options.delayMs ?? 180)
  }
  return {
    get view(): ConversationCutView | undefined {
      return current
    },
    apply(through: number | undefined, source: ConversationCutSource): void {
      if (through === undefined) {
        reset()
        return
      }
      // A verified projection of the same cut is retained across re-applies.
      if (current?.through === through && !current.pending) return
      if (current && through < current.through) {
        // A backward seek cannot show a projection from a later ledger position.
        generation++
        reading = undefined
        verified = undefined
      }
      desired = { through, ...(source.projectAt ? { projectAt: source.projectAt } : {}) }
      const retained = verified?.through !== undefined && verified.through <= through ? verified : undefined
      settle({
        through,
        ...(retained ? { projectedThrough: retained.through } : {}),
        pending: true,
        nodes: retained?.timeline.nodes ?? [],
        turns: retained?.timeline.turns ?? [],
      })
      schedule()
    },
    dispose() {
      reset()
    },
  }
}

/**
 * Status line for the conversation while a replay cut is active. Presentation only; the exit
 * control stays on the replay surface that owns the cut.
 */
export function createConversationCutBanner(host: HTMLElement): {
  update(through: number | undefined, pending?: boolean, failed?: boolean, projectedThrough?: number): void
  dispose(): void
} {
  const banner = document.createElement('p')
  banner.className = 'conversation-cut-banner'
  banner.setAttribute('role', 'status')
  banner.hidden = true
  host.prepend(banner)
  return {
    update(through: number | undefined, pending = false, failed = false, projectedThrough?: number) {
      if (through === undefined) {
        banner.hidden = true
        banner.textContent = ''
        banner.title = ''
        return
      }
      banner.hidden = false
      banner.textContent = failed
        ? `回放视图 · 读取账本 #${through} 的对话内容失败；请在 Jev 流程图重试回放或点击「实时」。`
        : pending
          ? projectedThrough === undefined
            ? `回放视图 · 正在读取账本 #${through} 及之前的对话内容…`
            : `回放视图 · 正在同步至 #${through}，当前显示已确认的 #${projectedThrough}。`
          : `回放视图 · 显示账本 #${through} 及之前的对话内容；在 Jev 流程图点击「实时」恢复最新。`
      banner.title = banner.textContent
    },
    dispose() {
      banner.remove()
    },
  }
}
