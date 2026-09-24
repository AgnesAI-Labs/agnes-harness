import type { UINode, UITimeline } from '@agnes/protocol'
import type { Component } from '../component.js'

export const TIMELINE_RESERVED_ROWS = 5

type Entry = { signature: string; node: UINode; view: Component }
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

  constructor(
    private readonly o: {
      rows(): number
      reservedRows?(): number
      nodeView(node: UINode): Component
      /** Startup banner, part of the scrollable viewport but not the exit transcript. */
      top?: Component
    },
  ) {}

  apply(timeline: UITimeline, options: { opening?: boolean; hasEarlier?: boolean } = {}): void {
    if (this.sessionId !== timeline.sessionId) {
      this.sessionId = timeline.sessionId
      this.entries = new Map()
      this.local = []
      this.offset = 0
      this.maxOffset = 0
      this.hasEarlier = false
    }
    const next = new Map<string, Entry>()
    const ordered: Entry[] = []
    for (const node of timeline.nodes) {
      const signature = JSON.stringify(node)
      const previous = this.entries.get(node.id)
      const entry =
        previous?.signature === signature
          ? previous
          : { signature, node: structuredClone(node), view: this.o.nodeView(structuredClone(node)) }
      next.set(node.id, entry)
      ordered.push(entry)
    }
    this.entries = next
    this.ordered = ordered
    this.upto = timeline.upto
    this.hasEarlier = options.hasEarlier ?? this.hasEarlier
  }

  /** Adds connection-local transcript content without manufacturing a projected UINode. */
  appendLocal(sessionId: string, view: Component, afterSeq = this.upto): void {
    if (this.sessionId === undefined) this.sessionId = sessionId
    if (this.sessionId !== sessionId) return
    this.local.push({ afterSeq: Math.max(this.upto, afterSeq), view })
    this.offset = 0
  }

  scroll(delta: number): boolean {
    if (Number.isFinite(delta)) this.offset = Math.max(0, this.offset - Math.trunc(delta))
    return delta < 0 && this.hasEarlier && this.offset >= this.maxOffset
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
      const replacement = { ...entry, view: this.o.nodeView(structuredClone(entry.node)) }
      next.set(entry.node.id, replacement)
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
    for (const entry of this.ordered) {
      const seq = entry.node.seq ?? Number.POSITIVE_INFINITY
      while ((this.local[localIndex]?.afterSeq ?? Number.POSITIVE_INFINITY) < seq) pushLocal()
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
      ...(this.hasEarlier ? ['↑ Earlier history · PgUp to load'] : []),
      ...(showWelcome ? (this.o.top?.render(width) ?? []) : []),
      ...content,
    ]
    const window = Math.max(1, this.o.rows() - (this.o.reservedRows?.() ?? TIMELINE_RESERVED_ROWS))
    this.maxOffset = Math.max(0, rows.length - window)
    this.offset = Math.min(this.offset, this.maxOffset)
    const end = rows.length - this.offset
    return rows.slice(Math.max(0, end - window), end)
  }
}
