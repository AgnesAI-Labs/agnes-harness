import type { UINode, UITimeline } from '@agnes/protocol'
import { ANSI_RE } from '../ansi.js'
import type { Component } from '../component.js'
import { actionFor } from '../keymap.js'
import type { KeyName } from '../keys.js'
import { tt } from '../locale-extended.js'
import { completeBlocks } from '../markdown.js'
import { nodeText } from '../node-text.js'
import { isSettled } from '../settled.js'
import { groupable, groupRuns, silentKind } from '../tool-groups.js'

export const TIMELINE_RESERVED_ROWS = 5

type Entry = { signature: string; nodes: UINode[]; view: Component }
type LocalEntry = { afterSeq: number; view: Component }
type Item = {
  key: string
  view: Component
  settled: boolean
  effectId?: string | undefined
  nodes?: UINode[]
}
/** One entry of the loaded conversation as the pager shows it: its rows, and the text a copy takes. */
export type PagerBlock = { rows: string[]; text: string }

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
  // Split footer: the entries already handed to native scrollback. They are never handed out again,
  // whatever the projection does to them afterwards.
  private written = new Set<string>()
  // Source text of each running reply that already went out, block by block, ahead of its settling.
  private committed = new Map<string, string>()
  // Lines the next takeSettled leads with: the id of a session just switched to, and a note that the
  // loaded window starts after output this terminal never got (a long history, or a gap that outgrew it).
  private divider: string | undefined
  private omitted = false
  private idle = true
  // Card focus: the entry whose rows get marked, where its rows sit among the content, and whether the
  // next frame has to scroll it into view.
  private focus: { key: string; mark(row: string): string } | undefined
  private focusAt: { start: number; length: number } | undefined
  private reveal = false

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
      /** Split footer: settled entries leave through `takeSettled`; `render` shows only the rest. */
      split?: boolean
      /** Split footer: the streamed text of an inference that is still running, and how to draw Markdown. */
      stream?: {
        text(effectId: string): string | undefined
        markdown(source: string, width: number): string[]
      }
    },
  ) {}

  apply(timeline: UITimeline, options: { opening?: boolean; hasEarlier?: boolean } = {}): void {
    if (this.sessionId !== timeline.sessionId) {
      if (this.o.split && this.written.size > 0) this.divider = timeline.sessionId
      this.sessionId = timeline.sessionId
      this.entries = new Map()
      this.local = []
      this.written = new Set()
      this.committed = new Map()
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
    this.idle = !timeline.opState
    this.hasEarlier = options.hasEarlier ?? this.hasEarlier
    if (this.o.split && this.hasEarlier && ordered.length > 0)
      this.omitted ||= !ordered.some((e) => this.written.has((e.nodes[0] as UINode).id))
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
  /** End moves the cursor inside a draft; only with an empty one does it jump to the newest row. */
  jumpKey(key: KeyName, hasDraft: boolean): boolean {
    if (this.o.split || actionFor('global', key) !== 'timeline-bottom' || (key === 'end' && hasDraft))
      return false
    this.toBottom()
    return true
  }

  /** The keys of the entries that fold open (tool cards and groups of them), in display order. */
  cardKeys(): string[] {
    return this.ordered.filter((entry) => entry.view.clickHead).map((entry) => (entry.nodes[0] as UINode).id)
  }

  /** Marks the rows of one card (`undefined` clears it); the next frame scrolls it into view when `reveal` is set. */
  setFocus(focus: { key: string; mark(row: string): string } | undefined, reveal = true): void {
    this.focus = focus
    this.reveal = reveal && focus !== undefined
  }

  /** Opens or folds the card under `key`. */
  toggleCard(key: string): void {
    this.entries.get(key)?.view.clickHead?.()
  }

  /** Where the viewport is, so a visit elsewhere can put it back. */
  position(): { offset: number; leftAt: number | undefined } {
    return { offset: this.offset, leftAt: this.leftAt }
  }

  restore(position: { offset: number; leftAt: number | undefined }): void {
    this.offset = position.offset
    this.leftAt = position.leftAt
  }

  private toBottom(): void {
    this.offset = 0
    this.leftAt = undefined
  }

  private get size(): number {
    return this.ordered.length + this.local.length
  }

  scroll(delta: number): boolean {
    if (this.o.split) return false
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

  /** Every entry in display order, connection-local ones placed by the projection seq they follow. */
  private items(): Item[] {
    const items: Item[] = []
    let localIndex = 0
    const pushLocal = () => {
      items.push({
        key: `local:${localIndex}`,
        view: (this.local[localIndex] as LocalEntry).view,
        settled: true,
      })
      localIndex++
    }
    // A trailing run of read-only calls may still grow into a group, so it is not final while the turn runs.
    const open = this.idle ? -1 : this.ordered.findLastIndex((e) => !e.nodes.every(silentKind))
    this.ordered.forEach((entry, i) => {
      const seq = entry.nodes[0]?.seq ?? Number.POSITIVE_INFINITY
      while ((this.local[localIndex]?.afterSeq ?? Number.POSITIVE_INFINITY) < seq) pushLocal()
      const growing = i === open && entry.nodes.every(groupable)
      items.push({
        key: (entry.nodes[0] as UINode).id,
        view: entry.view,
        settled: !growing && entry.nodes.every(isSettled),
        nodes: entry.nodes,
        effectId: entry.nodes[0]?.kind === 'assistant' ? entry.nodes[0].effectId : undefined,
      })
    })
    while (localIndex < this.local.length) pushLocal()
    return items
  }

  private content(width: number, plain: boolean): string[] {
    const content: string[] = []
    const rows = (view: Component) => (plain ? view.transcript?.(width) : undefined) ?? view.render(width)
    if (!plain) {
      this.heads = []
      this.focusAt = undefined
    }
    const clickable = new Set(this.ordered.map((entry) => entry.view))
    for (const item of this.items()) {
      if (!plain && item.view.clickHead && clickable.has(item.view))
        this.heads.push({ row: content.length, view: item.view })
      const shown = rows(item.view)
      if (!plain && this.focus?.key === item.key) {
        this.focusAt = { start: content.length, length: shown.length }
        content.push(...shown.map(this.focus.mark))
      } else content.push(...shown)
    }
    return content
  }

  /**
   * Split footer: the plain text of every entry that became final since the last call, in display
   * order. An entry is final once it and everything before it is settled, so what is returned
   * continues what was returned before. An entry that shows up behind one already handed out (the
   * projection inserted it late) is dropped: scrollback is never rewritten. `all` also takes entries
   * still in flight, for the exit.
   */
  takeSettled(width: number, all = false): string[] {
    const lead = this.divider
      ? ['', `── ${tt('timeline.session', this.o.locale ?? 'en', { id: this.divider })} ──`]
      : []
    this.divider = undefined
    const items = this.items()
    const last = items.findLastIndex((item) => this.written.has(item.key))
    const out: string[] = []
    for (const [index, item] of items.entries()) {
      if (this.written.has(item.key)) continue
      if (index > last && !all && !item.settled) {
        out.push(...this.commitBlocks(item, width))
        break
      }
      this.written.add(item.key)
      if (index < last) continue
      out.push(...this.finalRows(item, width, !item.settled))
    }
    if (this.omitted && out.length > 0) lead.push('', tt('timeline.omitted', this.o.locale ?? 'en'))
    if (out.length > 0) this.omitted = false
    return [...lead, ...out]
  }

  /** A running reply, first in line: the blocks of its streamed text that are finished go out now, once. */
  private commitBlocks(item: Item, width: number): string[] {
    const text = item.effectId === undefined ? undefined : this.o.stream?.text(item.effectId)
    if (item.effectId === undefined || text === undefined || !this.o.stream) return []
    const before = this.committed.get(item.effectId) ?? ''
    const end = completeBlocks(text)
    if (end <= before.length || !text.startsWith(before)) return []
    this.committed.set(item.effectId, text.slice(0, end))
    const rows = this.o.stream.markdown(text.slice(before.length, end), width)
    return rows.length > 0 && before === '' ? ['', ...rows] : rows
  }

  /** What is left of an entry to write: all of it, or what follows the blocks of its reply already out. */
  private finalRows(item: Item, width: number, inFlight: boolean): string[] {
    const done = item.effectId === undefined ? undefined : this.committed.get(item.effectId)
    if (item.effectId !== undefined) this.committed.delete(item.effectId)
    const streamed = inFlight && item.effectId !== undefined ? this.o.stream?.text(item.effectId) : undefined
    const rows =
      streamed !== undefined
        ? this.o.stream?.markdown(
            streamed.startsWith(done ?? '') ? streamed.slice(done?.length ?? 0) : streamed,
            width,
          )
        : done !== undefined && item.view.transcriptAfter
          ? item.view.transcriptAfter(done, width)
          : (item.view.transcript?.(width) ?? item.view.render(width))
    if (!rows || rows.length === 0) return []
    return done === undefined ? ['', ...rows] : rows
  }

  /** The part of a running reply's streamed text the footer still has to show: what went out is not shown twice. */
  pending(effectId: string, text: string): string {
    const done = this.committed.get(effectId)
    return done !== undefined && text.startsWith(done) ? text.slice(done.length) : text
  }

  private splitRows(width: number): string[] {
    const pending = this.items().filter((item) => !this.written.has(item.key))
    const rows = pending.flatMap((item) => item.view.render(width))
    const window = Math.max(1, this.o.rows() - (this.o.reservedRows?.() ?? TIMELINE_RESERVED_ROWS))
    const shown = this.written.size === 0 && pending.length === 0 ? (this.o.top?.render(width) ?? []) : rows
    return shown.slice(-window)
  }

  /** Whether older history than the loaded window exists (the pager reads it a page at a time). */
  get earlier(): boolean {
    return this.hasEarlier
  }

  /** The loaded conversation entry by entry, plain like `transcript`, for the full-screen pager. */
  blocks(width: number): PagerBlock[] {
    return this.items().flatMap((item) => {
      const rows = item.view.transcript?.(width) ?? item.view.render(width)
      const text = item.nodes
        ?.map((n) => (n.kind === 'user' ? nodeText(n).slice(5) : nodeText(n)))
        .filter(Boolean)
        .join('\n')
      return rows.length === 0 ? [] : [{ rows, text: text || rows.join('\n').replace(ANSI_RE, '') }]
    })
  }

  /** Current loaded conversation only: no new history read, UI chrome or row-archive side effects. */
  transcript(width: number): string[] {
    return this.content(width, true)
  }

  /** Scrolls so rows `start`..+`length` are on screen, or at least their first `window` rows when they are more. */
  private revealRows(start: number, length: number, total: number, window: number): void {
    const end = total - this.offset
    const wanted = start < end - window ? start + window : Math.min(start + length, start + window)
    if (start >= end - window && start + length <= end) return
    const before = this.offset
    this.offset = Math.max(0, Math.min(this.maxOffset, total - wanted))
    if (before === 0 && this.offset > 0) this.leftAt = this.size
    else if (this.offset === 0) this.leftAt = undefined
  }

  render(width: number): string[] {
    if (this.o.split) return this.splitRows(width)
    const content = this.content(width, false)
    const showWelcome = content.length === 0 && !this.hasEarlier
    const rows = [
      ...(this.hasEarlier ? [tt('timeline.earlierHistory', this.o.locale ?? 'en')] : []),
      ...(showWelcome ? (this.o.top?.render(width) ?? []) : []),
      ...content,
    ]
    const window = Math.max(1, this.o.rows() - (this.o.reservedRows?.() ?? TIMELINE_RESERVED_ROWS))
    this.maxOffset = Math.max(0, rows.length - window)
    const prefix = rows.length - content.length
    if (this.reveal && this.focusAt)
      this.revealRows(prefix + this.focusAt.start, this.focusAt.length, rows.length, window)
    this.reveal = false
    this.offset = Math.min(this.offset, this.maxOffset)
    const end = rows.length - this.offset
    this.shownFrom = Math.max(0, end - window)
    for (const head of this.heads) head.row += prefix
    return rows.slice(this.shownFrom, end)
  }
}
