import type { UINode, UITimeline } from '@agnes/protocol'
import type { Component } from '../component.js'
import { tt } from '../locale-extended.js'
import { groupRuns } from '../tool-groups.js'

export const TIMELINE_RESERVED_ROWS = 5

type Entry = { signature: string; nodes: UINode[]; view: Component }
type LocalEntry = { afterSeq: number; view: Component }

/** A fullscreen viewport over core's projected nodes; it never reduces ledger events itself. */
export class Timeline implements Component {
  private entries = new Map<string, Entry>()
  private ordered: Entry[] = []
  private local: LocalEntry[] = []
  private upto = 0
  private offset = 0
  private sessionId: string | undefined
  private hasEarlier = false
  private maxOffset = 0
  // Where the last frame drew each clickable head: its row among all rows, and the first row shown.
  private heads: Array<{ row: number; view: Component }> = []
  private shownFrom = 0
  // How many entries there were when the user scrolled away from the bottom: anything past that is new.
  private leftAt: number | undefined

  constructor(
    private readonly o: {
      rows(): number
      reservedRows?(): number
      locale?: string
      nodeView(node: UINode): Component
      /** One view for a run of consecutive read-only tool calls; without it every call keeps its own card. */
      groupView?(nodes: UINode[]): Component
      /** Startup banner, part of the scrollable viewport but not the exit transcript. */
      top?: Component
    },
  ) {}

  apply(timeline: UITimeline, options: { opening?: boolean; hasEarlier?: boolean } = {}): void {
    if (this.sessionId !== timeline.sessionId) {
      this.sessionId = timeline.sessionId
      this.entries = new Map()
      this.local = []
      this.toBottom()
      this.maxOffset = 0
      this.hasEarlier = false
    }
    const next = new Map<string, Entry>()
    const ordered: Entry[] = []
    for (const nodes of this.o.groupView ? groupRuns(timeline.nodes) : timeline.nodes.map((n) => [n])) {
      const first = nodes[0] as UINode
      const signature = JSON.stringify(nodes)
      const previous = this.entries.get(first.id)
      const entry =
        previous?.signature === signature
          ? previous
          : { signature, nodes: structuredClone(nodes), view: this.build(structuredClone(nodes)) }
      next.set(first.id, entry)
      ordered.push(entry)
    }
    this.entries = next
    this.ordered = ordered
    this.upto = timeline.upto
    this.hasEarlier = options.hasEarlier ?? this.hasEarlier
  }

  private build(nodes: UINode[]): Component {
    return nodes.length > 1 && this.o.groupView
      ? this.o.groupView(nodes)
      : this.o.nodeView(nodes[0] as UINode)
  }

  /** Whether the startup banner is what the viewport currently opens with (nothing to show above it). */
  showsWelcome(): boolean {
    return this.ordered.length === 0 && this.local.length === 0 && !this.hasEarlier
  }

  /** Adds connection-local transcript content without manufacturing a projected UINode. */
  appendLocal(sessionId: string, view: Component, afterSeq = this.upto): void {
    if (this.sessionId === undefined) this.sessionId = sessionId
    if (this.sessionId !== sessionId) return
    this.local.push({ afterSeq: Math.max(this.upto, afterSeq), view })
    this.toBottom()
  }

  /** The footer line for a user reading above the bottom while entries have arrived since they left it. */
  newOutputHint(hasDraft: boolean): string | undefined {
    if (this.offset === 0 || this.leftAt === undefined || this.size <= this.leftAt) return undefined
    return tt(hasDraft ? 'scroll.newBelowCtrl' : 'scroll.newBelow', this.o.locale ?? 'en')
  }

  /** End jumps back to the newest rows and follows new output again; with a draft only Ctrl-End does, since End moves the cursor. */
  jumpKey(key: string, hasDraft: boolean): boolean {
    if (key !== 'ctrl-end' && (key !== 'end' || hasDraft)) return false
    this.toBottom()
    return true
  }

  private toBottom(): void {
    this.offset = 0
    this.leftAt = undefined
  }

  private get size(): number {
    return this.ordered.length + this.local.length
  }

  scroll(delta: number): boolean {
    const before = this.offset
    if (Number.isFinite(delta)) this.offset = Math.max(0, this.offset - Math.trunc(delta))
    if (before === 0 && this.offset > 0) this.leftAt = this.size
    else if (this.offset === 0) this.leftAt = undefined
    return delta < 0 && this.hasEarlier && this.offset >= this.maxOffset
  }

  /** A click on screen row `row` of the viewport: toggles the card whose head is drawn there. */
  click(row: number): boolean {
    const head = this.heads.find((h) => h.row === row + this.shownFrom)
    head?.view.clickHead?.()
    return head !== undefined
  }

  invalidate(): void {
    this.o.top?.invalidate()
    for (const entry of this.ordered) entry.view.invalidate()
    for (const entry of this.local) entry.view.invalidate()
  }

  /** Rebuilds projected views after a presentation-only theme switch, preserving order and scroll. */
  refreshViews(): void {
    const next = new Map<string, Entry>()
    this.ordered = this.ordered.map((entry) => {
      const replacement = { ...entry, view: this.build(structuredClone(entry.nodes)) }
      next.set((entry.nodes[0] as UINode).id, replacement)
      return replacement
    })
    this.entries = next
    this.invalidate()
  }

  private content(width: number, plain: boolean): string[] {
    const content: string[] = []
    let localIndex = 0
    const rows = (view: Component) => (plain ? view.transcript?.(width) : undefined) ?? view.render(width)
    const pushLocal = () => content.push(...rows((this.local[localIndex++] as LocalEntry).view))
    if (!plain) this.heads = []
    for (const entry of this.ordered) {
      const seq = entry.nodes[0]?.seq ?? Number.POSITIVE_INFINITY
      while ((this.local[localIndex]?.afterSeq ?? Number.POSITIVE_INFINITY) < seq) pushLocal()
      if (!plain && entry.view.clickHead) this.heads.push({ row: content.length, view: entry.view })
      content.push(...rows(entry.view))
    }
    while (localIndex < this.local.length) pushLocal()
    return content
  }

  /** Current loaded conversation only: no new history read, UI chrome or row-archive side effects. */
  transcript(width: number): string[] {
    return this.content(width, true)
  }

  render(width: number): string[] {
    const content = this.content(width, false)
    const showWelcome = content.length === 0 && !this.hasEarlier
    const rows = [
      ...(this.hasEarlier ? [tt('timeline.earlierHistory', this.o.locale ?? 'en')] : []),
      ...(showWelcome ? (this.o.top?.render(width) ?? []) : []),
      ...content,
    ]
    const window = Math.max(1, this.o.rows() - (this.o.reservedRows?.() ?? TIMELINE_RESERVED_ROWS))
    this.maxOffset = Math.max(0, rows.length - window)
    this.offset = Math.min(this.offset, this.maxOffset)
    const end = rows.length - this.offset
    this.shownFrom = Math.max(0, end - window)
    const prefix = rows.length - content.length
    for (const head of this.heads) head.row += prefix
    return rows.slice(this.shownFrom, end)
  }
}
