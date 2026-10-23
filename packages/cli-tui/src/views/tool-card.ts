import type { UINode } from '@agnes/protocol'
import { createAnsi } from '../ansi.js'
import { type Component, escapeControl, padLine, wrapText } from '../component.js'
import { columns, fitLine } from '../components/line.js'
import { tt } from '../locale-extended.js'
import type { Tone } from '../palette.js'
import { displayWidth } from '../terminal.js'
import { paintsColour, type ThemedAnsi, TuiTheme } from '../theme.js'
import type { ToolDetailState } from '../tool-detail.js'
import { type DiffInput, diffFromArgsText, renderDiff, statsMark } from './diff.js'
import { type CardFacts, type CardKind, cardHead, cardKind, planSteps, STEP_MARK } from './special-card.js'

type ToolNode = Extract<UINode, { kind: 'tool' }>

// Inline extension slots carry titles, charts and numbered actions; tables use surfaces.
type InlinePayload = {
  title: string
  chart?: { kind: 'bar' | 'line'; series: Array<{ name: string; points: Array<{ x: string; y: number }> }> }
  actions?: Array<{ id: string; label: string }>
}

/**
 * ASCII bar chart over categorical points. A single series shows each point's bare `x` label; two
 * or more series prefix every bar with its series name so labels that repeat across series (the
 * same `x` in each) stay distinguishable. `line` charts fall back to the tool card's plain table
 * (or are omitted if there is none) -- an ASCII line-plot renderer is not part of this delivery.
 */
export function renderBarChart(
  series: Array<{ name: string; points: Array<{ x: string; y: number }> }>,
  width: number,
): string[] {
  const multi = series.length > 1
  const bars = series.flatMap((s) =>
    s.points.map((p) => ({ label: escapeControl(multi ? `${s.name}/${p.x}` : p.x), value: p.y })),
  )
  if (bars.length === 0) return []
  const max = Math.max(1, ...bars.map((b) => Math.abs(b.value)))
  const labelWidth = Math.max(...bars.map((b) => displayWidth(b.label)))
  const barWidth = Math.max(1, width - labelWidth - 8)
  return bars.map((b) => {
    const fill = Math.max(1, Math.round((Math.abs(b.value) / max) * barWidth))
    const pad = ' '.repeat(labelWidth - displayWidth(b.label))
    return padLine(`${b.label}${pad} ${'█'.repeat(fill)} ${b.value}`, width)
  })
}

/** Presentation of the core projection; no event reduction or direct tool access. */
// State is carried by one diamond and, only while non-terminal, one word; the rest stays quiet.
const STATUS_TONE: Record<string, Tone> = {
  completed: 'success',
  running: 'accent',
  failed: 'danger',
  error: 'danger',
  planned: 'faint',
  waiting: 'accent',
  cancelled: 'warning',
  budget_stopped: 'warning',
}
const STATUS_GLYPH: Record<string, string> = {
  completed: '◆',
  running: '◆',
  failed: '◆',
  error: '◆',
  planned: '◇',
}
// Without colour the running and failed diamonds would be indistinguishable from a finished one.
const COLOURLESS_GLYPH: Record<string, string> = { running: '◈', failed: '✗', error: '✗' }
const LABEL_WIDTH = 'Enforcement:'.length
// A collapsed plan card shows this many steps; Ctrl-O shows them all.
const COLLAPSED_STEPS = 10
// A collapsed card previews this many screen rows of its result.
const PREVIEW_ROWS = 3
const STATUS_KEYS: Record<
  string,
  | 'tool.status.completed'
  | 'tool.status.running'
  | 'tool.status.failed'
  | 'tool.status.error'
  | 'tool.status.planned'
> = {
  completed: 'tool.status.completed',
  running: 'tool.status.running',
  failed: 'tool.status.failed',
  error: 'tool.status.error',
  planned: 'tool.status.planned',
}
const TOOL_KEYS: Record<string, 'tool.name.read' | 'tool.name.write' | 'tool.name.edit' | 'tool.name.shell'> =
  {
    read: 'tool.name.read',
    write: 'tool.name.write',
    edit: 'tool.name.edit',
    shell: 'tool.name.shell',
  }

/** `wrapText` per line, keeping each line's leading indentation (pretty-printed arguments, code). */
function wrapIndented(text: string, width: number): string[] {
  return text.split('\n').flatMap((line) => {
    const indent = ' '.repeat(Math.min(line.length - line.trimStart().length, Math.max(0, width - 8)))
    return wrapText(line.trimStart(), width - indent.length).map((row) => `${indent}${row}`)
  })
}

/** A left part clipped to leave room for a right-aligned one, or both run together when narrow. */
function spread(left: string, right: string, width: number): string {
  if (!right) return fitLine(left, width)
  const room = width - displayWidth(right) - 2
  return room >= 4 ? `${fitLine(left, room)}  ${right}` : fitLine(`${left}  ${right}`, width)
}

type Look = { glyph: string; status: string; paint: (s: string) => string; closing: string }

export class ToolCard implements Component {
  private readonly name: string
  private readonly summary: string
  private readonly kind: CardKind | undefined
  private readonly look: () => Look
  private readonly raw: () => boolean
  private readonly right: (expanded: boolean) => string
  /** A plan card's steps, painted, one per row. */
  private readonly stepRows: string[] = []
  /** Rail contents, laid out for the width inside the rail. */
  private readonly rail: Array<(width: number) => string[]> = []
  private collapsedState: boolean
  private readonly actions: Array<{ id: string; label: string }> = []
  private readonly onAction: (actionId: string) => void
  private readonly onExpand: () => void
  private readonly more: string
  /** `+a -b` after the title of an edit or write whose change is known. */
  private stats: () => string = () => ''
  /** The result preview of a collapsed card, painted and fitted to the width. */
  private preview: (width: number) => string[] = () => []

  constructor(
    node: ToolNode,
    options: {
      collapsed?: boolean
      ansi?: ThemedAnsi
      onAction?(actionId: string): void
      /** The full record fetched for this tool, read when drawn so a late answer needs no new card. */
      detail?(): ToolDetailState | undefined
      /** Called each time the card opens. */
      onExpand?(): void
      /** What the timeline knows beyond this node (a subagent's status and time), read when drawn. */
      facts?(): CardFacts | undefined
      locale?: string
    } = {},
  ) {
    const ansi = options.ansi ?? new TuiTheme('mono').ansi(createAnsi('none'))
    this.raw = () => ansi.raw === true
    this.onAction = options.onAction ?? (() => {})
    this.onExpand = options.onExpand ?? (() => {})
    const locale = options.locale ?? 'en'
    const kind = cardKind(node)
    this.kind = kind
    const special = kind ? cardHead(node, kind, locale) : undefined
    const toolKey = TOOL_KEYS[node.name]
    this.name = special
      ? `${ansi.bold(special.label)}${special.subject ? ` ${ansi.bold(escapeControl(special.subject))}` : ''}`
      : ansi.bold(toolKey ? tt(toolKey, locale) : escapeControl(node.name))
    // A subagent's real state is the child's, which the spawning call's own status does not follow.
    const state = () => options.facts?.()?.status ?? node.delegatedTask?.status ?? node.status
    let looked: { status: string; look: Look } | undefined
    this.look = () => {
      const status = state()
      if (looked?.status === status) return looked.look
      const statusKey = STATUS_KEYS[status]
      const tone = STATUS_TONE[status]
      const paint = tone === undefined ? (text: string) => text : (text: string) => ansi.fg(tone, text)
      const look = {
        glyph: paint(
          (paintsColour(ansi) ? undefined : COLOURLESS_GLYPH[status]) ?? STATUS_GLYPH[status] ?? '·',
        ),
        status: paint(statusKey ? tt(statusKey, locale) : escapeControl(status)),
        paint,
        closing: ` ${paint('╰─')} ${ansi.fg('faint', 'ctrl+o')}`,
      }
      looked = { status, look }
      return look
    }
    // Right of the headline: the state (a finished plain card says nothing) and a known run time.
    this.right = (expanded) => {
      const seconds = options.facts?.()?.durationMs
      return [
        expanded || state() !== 'completed' || (kind !== undefined && kind !== 'plan')
          ? this.look().status
          : '',
        seconds === undefined ? '' : ansi.dim(`${(seconds / 1000).toFixed(1)}s`),
      ]
        .filter(Boolean)
        .join(' · ')
    }
    const steps = kind === 'plan' ? planSteps(node) : undefined
    const headline = steps
      ? tt('card.planProgress', locale, {
          done: steps.filter((st) => st.status === 'done').length,
          total: steps.length,
        })
      : (special?.summary ?? node.summary)
    const summary = escapeControl(headline.replace(/\s+/g, ' ').trim())
    this.summary = summary ? `  ${ansi.dim(summary)}` : ''
    this.collapsedState = options.collapsed ?? true
    for (const step of steps ?? []) {
      const [mark, tone] = STEP_MARK[step.status]
      this.stepRows.push(`${ansi.fg(tone, mark)} ${escapeControl(step.text.replace(/\s+/g, ' ').trim())}`)
    }
    this.more = ansi.dim(
      tt('card.more', locale, { count: Math.max(0, this.stepRows.length - COLLAPSED_STEPS) }),
    )

    if (node.summary) this.rail.push((width) => wrapText(escapeControl(node.summary), width))
    this.rail.push(() => this.stepRows)
    // The fetched record replaces the previews; until it arrives, and when it cannot, the previews stay.
    const fetched = () => {
      const detail = options.detail?.()
      return detail?.state === 'ready' ? detail : undefined
    }
    // An edit or write shows what it changes instead of raw arguments: from the fetched record, or from
    // the argument preview while that still parses.
    const changes = node.name === 'edit' || node.name === 'write'
    let parsed: { text: string | undefined; input: DiffInput | undefined } | undefined
    const diff = (): DiffInput | undefined => {
      if (!changes) return undefined
      const text = fetched()?.args ?? node.argsPreview
      if (parsed?.text !== text) parsed = { text, input: diffFromArgsText(node.name, text) }
      return parsed?.input
    }
    this.stats = () => {
      const input = diff()
      return input ? ` ${statsMark(input, ansi)}` : ''
    }
    let shown: { width: number; rows: string[] } | undefined
    this.preview = (width) => {
      const text = changes ? undefined : node.resultPreview
      if (!text || kind !== undefined) return []
      if (shown?.width !== width) {
        const rows = wrapIndented(escapeControl(text), width - 4).filter((row) => row.trim() !== '')
        shown = {
          width,
          rows: [
            ...rows.slice(0, PREVIEW_ROWS),
            ...(rows.length > PREVIEW_ROWS
              ? [tt('card.moreLines', locale, { n: rows.length - PREVIEW_ROWS })]
              : []),
          ],
        }
      }
      return shown.rows.map((row) => fitLine(`    ${ansi.dim(row)}`, width))
    }
    let drawn: { input: DiffInput; width: number; rows: string[] } | undefined
    this.rail.push((width) => {
      const input = diff()
      if (!input) return []
      if (drawn?.input !== input || drawn.width !== width)
        drawn = { input, width, rows: renderDiff(input, width, ansi, locale) }
      return drawn.rows
    })
    this.rail.push((width) => {
      const detail = options.detail?.()
      if (detail?.state === 'loading') return [ansi.dim(tt('tool.detail.loading', locale))]
      return detail?.state === 'failed'
        ? wrapText(tt('tool.detail.failed', locale, { reason: detail.reason }), width).map((line) =>
            ansi.fg('warning', line),
          )
        : []
    })
    const fields: Array<[string, () => string | undefined]> = [
      ['Task', () => node.delegatedTask?.task],
      ['Child', () => node.delegatedTask?.childKey],
      ['Arguments', () => (diff() ? undefined : (fetched()?.args ?? node.argsPreview))],
      ['Result', () => fetched()?.result ?? node.resultPreview],
      [
        'Enforcement',
        () => node.enforcement && `${node.enforcement.level} (${node.enforcement.scope.join(', ')})`,
      ],
    ]
    for (const [label, read] of fields) {
      const head = ansi.dim(`${label}:`.padStart(LABEL_WIDTH))
      const indent = ' '.repeat(LABEL_WIDTH + 1)
      // A fetched record can be long and the card draws on every frame: wrap it once per width.
      let wrapped: { value: string; width: number; lines: string[] } | undefined
      this.rail.push((width) => {
        const value = read()
        if (value === undefined) return []
        if (wrapped?.value !== value || wrapped.width !== width)
          wrapped = { value, width, lines: wrapIndented(escapeControl(value), width - LABEL_WIDTH - 1) }
        return wrapped.lines.map((line, i) => `${i === 0 ? `${head} ` : indent}${line}`)
      })
    }
    // `tool.card.inline` has `multi` cardinality, so a tool result can carry several fills; every
    // one of them contributes its own title/chart/actions block, in the order they arrive.
    for (const fill of node.slots ?? []) {
      if (fill.slot !== 'tool.card.inline') continue
      const payload = fill.payload as InlinePayload
      const title = ansi.bold(escapeControl(payload.title))
      this.rail.push(() => [title])
      if (payload.chart?.kind === 'bar') {
        const series = payload.chart.series
        this.rail.push((width) => renderBarChart(series, width))
      }
      for (const action of payload.actions ?? []) this.actions.push({ id: action.id, label: action.label })
    }
    if (this.actions.length > 0) {
      const keys = this.actions.map((a, i) => `[${i + 1}] ${escapeControl(a.label)}`).join('  ')
      this.rail.push(() => [keys])
    }
  }
  get collapsed(): boolean {
    return this.collapsedState
  }
  toggle(): void {
    this.collapsedState = !this.collapsedState
    if (!this.collapsedState) this.onExpand()
  }
  /** Opens (`true`) or folds it; asking for the state it already has does nothing. */
  setOpen(open: boolean): void {
    if (open === this.collapsedState) this.toggle()
  }
  clickHead(): void {
    this.toggle()
  }
  invalidate(): void {}
  // Numbered actions only fire while the card is expanded, so a collapsed card is inert to
  // digits and the same keystroke reaches whatever else wants it (the editor, most likely).
  // The digit is only ever an index into *this card's* action list -- it never becomes, and
  // never carries, a requestSeq: that is minted by the caller at the moment it actually calls
  // out, never read off any field already sitting on the projected node.
  handleInput(data: string): boolean {
    if (this.collapsedState || !/^[1-9]$/.test(data)) return false
    const action = this.actions[Number(data) - 1]
    if (!action) return false
    this.onAction(action.id)
    return true
  }
  render(width: number): string[] {
    width = columns(width)
    const look = this.look()
    const head = ` ${look.glyph} ${this.name}`
    if (this.collapsedState) {
      const hidden = this.stepRows.length - COLLAPSED_STEPS
      return [
        spread(`${head}${this.stats()}${this.summary}`, this.right(false), width),
        ...this.preview(width),
        ...this.stepRows.slice(0, COLLAPSED_STEPS).map((row) => fitLine(`    ${row}`, width)),
        ...(hidden > 0 ? [fitLine(`    ${this.more}`, width)] : []),
      ]
    }
    // Raw view: the body without the rail, and no closing line.
    const raw = this.raw()
    const inner = Math.max(1, width - (raw ? 0 : 3))
    const rail = look.paint('│')
    return [
      spread(`${head}${this.stats()}`, this.right(true), width),
      ...this.rail
        .flatMap((rows) => rows(inner))
        .map((line) => fitLine(raw ? line : ` ${rail} ${line}`, width)),
      ...(raw ? [] : [fitLine(look.closing, width)]),
    ]
  }
}
