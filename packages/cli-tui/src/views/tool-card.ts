import type { UINode } from '@agnes/protocol'
import { type Ansi, createAnsi } from '../ansi.js'
import { type Component, escapeControl, padLine, Text, VStack } from '../component.js'
import { Box } from '../components/box.js'
import { fitLine } from '../components/line.js'
import { tt } from '../locale-extended.js'
import { displayWidth } from '../terminal.js'

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
const STATUS_COLOR: Record<string, number> = { completed: 78, running: 178, failed: 203, error: 203 }
const STATUS_GLYPH: Record<string, string> = {
  completed: '◆',
  running: '◆',
  failed: '◆',
  error: '◆',
  planned: '◇',
}
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

export class ToolCard implements Component {
  private readonly box: Box
  private readonly headline: string
  private collapsedState: boolean
  private readonly actions: Array<{ id: string; label: string }> = []
  private readonly onAction: (actionId: string) => void

  constructor(
    node: ToolNode,
    options: { collapsed?: boolean; ansi?: Ansi; onAction?(actionId: string): void; locale?: string } = {},
  ) {
    const ansi = options.ansi ?? createAnsi('none')
    this.onAction = options.onAction ?? (() => {})
    const locale = options.locale ?? 'en'
    const summary = node.summary.replace(/\s+/g, ' ').trim()
    const toolKey = TOOL_KEYS[node.name]
    const name = toolKey ? tt(toolKey, locale) : escapeControl(node.name)
    const statusKey = STATUS_KEYS[node.status]
    const status = statusKey ? tt(statusKey, locale) : escapeControl(node.status)
    const colour = STATUS_COLOR[node.status]
    const paint = colour === undefined ? (s: string) => s : ansi.fg.bind(ansi, colour)
    const glyph = paint(STATUS_GLYPH[node.status] ?? '·')
    this.headline = ` ${glyph} ${ansi.bold(name)}${summary ? `  ${ansi.dim(escapeControl(summary))}` : ''}${
      node.status === 'completed' ? '' : `  ${paint(status)}`
    }`
    this.collapsedState = options.collapsed ?? true
    const body: Component[] = [new Text(escapeControl(node.summary))]
    if (node.argsPreview !== undefined) body.push(new Text(escapeControl(`Arguments: ${node.argsPreview}`)))
    if (node.resultPreview !== undefined) body.push(new Text(escapeControl(`Result: ${node.resultPreview}`)))
    if (node.enforcement)
      body.push(
        new Text(
          escapeControl(`Enforcement: ${node.enforcement.level} (${node.enforcement.scope.join(', ')})`),
        ),
      )
    // `tool.card.inline` has `multi` cardinality, so a tool result can carry several fills; every
    // one of them contributes its own title/chart/actions block, in the order they arrive.
    for (const fill of node.slots ?? []) {
      if (fill.slot !== 'tool.card.inline') continue
      const payload = fill.payload as InlinePayload
      body.push(new Text(ansi.bold(escapeControl(payload.title))))
      if (payload.chart?.kind === 'bar') {
        const series = payload.chart.series
        body.push({ render: (width: number) => renderBarChart(series, width), invalidate() {} })
      }
      for (const action of payload.actions ?? []) this.actions.push({ id: action.id, label: action.label })
    }
    if (this.actions.length > 0)
      body.push(new Text(this.actions.map((a, i) => `[${i + 1}] ${escapeControl(a.label)}`).join('  ')))
    this.box = new Box(new VStack(body), {
      title: `${name} · ${status}`,
      rounded: true,
      border: ansi.dim,
      titleStyle: (line: string) => ansi.bold(line.replace(status, paint(status))),
    })
  }
  get collapsed(): boolean {
    return this.collapsedState
  }
  toggle(): void {
    this.collapsedState = !this.collapsedState
  }
  invalidate(): void {
    this.box.invalidate()
  }
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
    return this.collapsedState ? [fitLine(this.headline, width)] : this.box.render(width)
  }
}
