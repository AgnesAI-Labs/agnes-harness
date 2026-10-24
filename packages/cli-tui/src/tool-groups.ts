import type { UINode } from '@agnes/protocol'
import { type Component, escapeControl } from './component.js'
import { columns, fitLine } from './components/line.js'
import { tt } from './locale-extended.js'
import type { ToolsKey } from './locale-tools.js'
import type { ThemedAnsi } from './theme.js'
import type { ToolCard } from './views/tool-card.js'

type ToolNode = Extract<UINode, { kind: 'tool' }>

// Calls that only look: a run of them is one line of "what the agent went through" rather than a card each.
const READ_ONLY = new Set(['read', 'grep', 'find', 'ls'])
// Nodes that draw nothing, so a read-only call on either side of them is still consecutive.
const SILENT = new Set(['cost', 'context', 'slot', 'context-sections', 'contribute-conflict'])

/** A read-only call that a following read-only call would fold into one group with it. */
export function groupable(node: UINode): boolean {
  return node.kind === 'tool' && READ_ONLY.has(node.name) && !node.delegatedTask
}

/** Nodes that draw nothing: a run of grouped calls stays open across them. */
export function silentKind(node: UINode): boolean {
  return SILENT.has(node.kind)
}

/**
 * `nodes` cut into entries: each run of two or more read-only calls is one entry, every other node
 * stands alone. Silent nodes between two calls of a run draw nothing, so they do not end it.
 */
export function groupRuns(nodes: readonly UINode[]): UINode[][] {
  const out: UINode[][] = []
  let run: UINode[] = []
  let silent: UINode[] = []
  const flush = () => {
    if (run.length > 1) out.push(run)
    else for (const node of run) out.push([node])
    for (const node of silent) out.push([node])
    run = []
    silent = []
  }
  for (const node of nodes) {
    if (node.kind === 'tool' && READ_ONLY.has(node.name) && !node.delegatedTask) {
      run.push(node)
      silent = []
    } else if (run.length > 0 && SILENT.has(node.kind)) silent.push(node)
    else {
      flush()
      out.push([node])
    }
  }
  flush()
  return out
}

const KIND = { read: ['read'], search: ['grep', 'find'], list: ['ls'] } as const

/** `Read 4 files · Searched 2 times`: one clause per kind of call that occurs in the group. */
export function groupTitle(nodes: readonly ToolNode[], locale: string): string {
  return (Object.keys(KIND) as Array<keyof typeof KIND>)
    .flatMap((kind) => {
      const n = nodes.filter((node) => (KIND[kind] as readonly string[]).includes(node.name)).length
      return n === 0 ? [] : [tt(`group.${kind}.${n === 1 ? 'one' : 'other'}` as ToolsKey, locale, { n })]
    })
    .join(' · ')
}

/** One card standing for a run of read-only calls; opening it lists each call's head row. */
export class ToolGroupCard implements Component {
  private collapsedState: boolean

  constructor(
    private readonly nodes: readonly ToolNode[],
    private readonly cards: readonly ToolCard[],
    private readonly o: { ansi: ThemedAnsi; locale: string; collapsed?: boolean },
  ) {
    this.collapsedState = o.collapsed ?? true
  }

  get collapsed(): boolean {
    return this.collapsedState
  }

  has(id: string): boolean {
    return this.nodes.some((node) => node.id === id)
  }

  toggle(): void {
    this.collapsedState = !this.collapsedState
  }

  setOpen(open: boolean): void {
    this.collapsedState = !open
  }

  clickHead(): void {
    this.toggle()
  }

  invalidate(): void {}

  render(width: number): string[] {
    width = columns(width)
    const { ansi } = this.o
    const failed = this.nodes.some((node) => node.status === 'failed')
    const running = this.nodes.some((node) => node.status === 'running')
    const glyph = failed ? ansi.fg('danger', '◆') : running ? ansi.fg('accent', '◆') : ansi.fg('success', '◆')
    const head = fitLine(
      ` ${glyph} ${ansi.bold(escapeControl(groupTitle(this.nodes, this.o.locale)))}${this.collapsedState ? '' : ` ${ansi.fg('faint', 'ctrl+o')}`}`,
      width,
    )
    if (this.collapsedState) return [head]
    return [head, ...this.cards.map((card) => fitLine(` ${card.render(width - 1)[0] ?? ''}`, width))]
  }
}
