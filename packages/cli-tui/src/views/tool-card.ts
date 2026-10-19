import type { UINode } from '@agnes/protocol'
import { createAnsi } from '../ansi.js'
import { type Component, escapeControl, padLine, wrapText } from '../component.js'
import { columns, fitLine } from '../components/line.js'
import { tt } from '../locale-extended.js'
import type { Tone } from '../palette.js'
import { displayWidth } from '../terminal.js'
import { paintsColour, type ThemedAnsi, TuiTheme } from '../theme.js'

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

/** A left part clipped to leave room for a right-aligned one, or both run together when narrow. */
function spread(left: string, right: string, width: number): string {
  if (!right) return fitLine(left, width)
  const room = width - displayWidth(right) - 2
  return room >= 4 ? `${fitLine(left, room)}  ${right}` : fitLine(`${left}  ${right}`, width)
}

export class ToolCard implements Component {
  private readonly glyph: string
  private readonly name: string
  private readonly summary: string
  private readonly status: string
  private readonly showStatus: boolean
  private readonly paint: (s: string) => string
  private readonly closing: string
  /** Rail contents, laid out for the width inside the rail. */
  private readonly rail: Array<(width: number) => string[]> = []
  private collapsedState: boolean
  private readonly actions: Array<{ id: string; label: string }> = []
  private readonly onAction: (actionId: string) => void

  constructor(
    node: ToolNode,
    options: {
      collapsed?: boolean
      ansi?: ThemedAnsi
      onAction?(actionId: string): void
      locale?: string
    } = {},
  ) {
    const ansi = options.ansi ?? new TuiTheme('mono').ansi(createAnsi('none'))
    this.onAction = options.onAction ?? (() => {})
    const locale = options.locale ?? 'en'
    const toolKey = TOOL_KEYS[node.name]
    this.name = ansi.bold(toolKey ? tt(toolKey, locale) : escapeControl(node.name))
    const statusKey = STATUS_KEYS[node.status]
    const tone = STATUS_TONE[node.status]
    this.paint = tone === undefined ? (s: string) => s : (s: string) => ansi.fg(tone, s)
    this.closing = ` ${this.paint('╰─')} ${ansi.fg('faint', 'ctrl+o')}`
    this.glyph = this.paint(
      (paintsColour(ansi) ? undefined : COLOURLESS_GLYPH[node.status]) ?? STATUS_GLYPH[node.status] ?? '·',
    )
    this.status = this.paint(statusKey ? tt(statusKey, locale) : escapeControl(node.status))
    this.showStatus = node.status !== 'completed'
    const summary = escapeControl(node.summary.replace(/\s+/g, ' ').trim())
    this.summary = summary ? `  ${ansi.dim(summary)}` : ''
    this.collapsedState = options.collapsed ?? true

    if (node.summary) this.rail.push((width) => wrapText(escapeControl(node.summary), width))
    const fields: Array<[string, string | undefined]> = [
      ['Arguments', node.argsPreview],
      ['Result', node.resultPreview],
      ['Enforcement', node.enforcement && `${node.enforcement.level} (${node.enforcement.scope.join(', ')})`],
    ]
    for (const [label, value] of fields) {
      if (value === undefined) continue
      const head = ansi.dim(`${label}:`.padStart(LABEL_WIDTH))
      const indent = ' '.repeat(LABEL_WIDTH + 1)
      this.rail.push((width) =>
        wrapText(escapeControl(value), width - LABEL_WIDTH - 1).map(
          (line, i) => `${i === 0 ? `${head} ` : indent}${line}`,
        ),
      )
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
    const head = ` ${this.glyph} ${this.name}`
    if (this.collapsedState)
      return [spread(`${head}${this.summary}`, this.showStatus ? this.status : '', width)]
    const inner = Math.max(1, width - 3)
    const rail = this.paint('│')
    return [
      spread(head, this.status, width),
      ...this.rail.flatMap((rows) => rows(inner)).map((line) => fitLine(` ${rail} ${line}`, width)),
      fitLine(this.closing, width),
    ]
  }
}
