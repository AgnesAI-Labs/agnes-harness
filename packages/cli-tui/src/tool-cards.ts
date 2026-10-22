import type { UINode, UITimeline } from '@agnes/protocol'
import type { Session } from '@agnes/sdk'
import { formatTuiErrorNotice } from './error-notice.js'
import { oneLine } from './session-commands.js'
import type { ThemedAnsi } from './theme.js'
import { type ToolDetailState, toolDetailText } from './tool-detail.js'
import { ToolGroupCard } from './tool-groups.js'
import { type CardFacts, childFacts } from './views/special-card.js'
import { ToolCard } from './views/tool-card.js'

type ToolNode = Extract<UINode, { kind: 'tool' }>

/**
 * The tool cards of the projected timeline and what outlives a card: the Timeline rebuilds a node's
 * view whenever its projection changes, so open/closed state is kept here, by node id, and handed to
 * each new card.
 */
export class ToolCards {
  private readonly cards = new Map<string, ToolCard>()
  /** Full records fetched on expand; `key` names the call/result pair they were fetched for. */
  private readonly details = new Map<string, { key: string; view: ToolDetailState }>()
  /** Subagent status and run time by child key; they change without their spawning node changing. */
  private children = new Map<string, CardFacts>()
  /** Runs of read-only calls drawn as one card, by the id of their first call; open/closed outlives a rebuild. */
  private readonly groups = new Map<string, ToolGroupCard>()
  private latest: string | undefined

  constructor(
    private readonly o: {
      ansi: ThemedAnsi
      locale: string
      session(): Pick<Session, 'id' | 'readToolDetail'>
      /** After 'closed' nothing may call the daemon any more. */
      closed(): boolean
      /** A fetch settled: the screen has to be drawn again. */
      changed(): void
      /** Numbered inline actions of an expanded card. */
      onAction(actionId: string): void
    },
  ) {}

  view(node: ToolNode): ToolCard {
    const card = new ToolCard(node, {
      collapsed: this.cards.get(node.id)?.collapsed ?? true,
      ansi: this.o.ansi,
      locale: this.o.locale,
      onAction: this.o.onAction,
      detail: () => this.details.get(node.id)?.view,
      onExpand: () => this.load(node),
      facts: () => this.children.get(node.delegatedTask?.childKey ?? ''),
    })
    this.cards.set(node.id, card)
    // A node that changed under an open card (its result arrived) needs its record fetched again.
    if (!card.collapsed) this.load(node)
    return card
  }

  group(nodes: UINode[]): ToolGroupCard {
    const tools = nodes.filter((node) => node.kind === 'tool')
    const id = tools[0]?.id ?? ''
    const group = new ToolGroupCard(
      tools,
      tools.map((node) => this.view(node)),
      { ansi: this.o.ansi, locale: this.o.locale, collapsed: this.groups.get(id)?.collapsed ?? true },
    )
    this.groups.set(id, group)
    return group
  }

  /** Asks the daemon for the whole record once per call/result pair; a failure is retried on the next expand. */
  private load(node: ToolNode): void {
    if (this.o.closed()) return
    const session = this.o.session()
    const key = `${session.id}:${node.seq}:${node.resultSeq ?? ''}`
    const known = this.details.get(node.id)
    if (known?.key === key && known.view.state !== 'failed') return
    this.details.set(node.id, { key, view: { state: 'loading' } })
    void session
      .readToolDetail(node.seq, node.resultSeq)
      .then((detail): ToolDetailState => ({ state: 'ready', ...toolDetailText(detail) }))
      .catch(
        (error): ToolDetailState => ({
          state: 'failed',
          reason: oneLine(formatTuiErrorNotice(error, this.o.locale)),
        }),
      )
      .then((view) => {
        if (this.details.get(node.id)?.key !== key) return
        this.details.set(node.id, { key, view })
        this.o.changed()
      })
  }

  /** Forgets cards whose node left the projection and remembers which tool came last. */
  sync(value: UITimeline): void {
    const tools = value.nodes.filter((node) => node.kind === 'tool')
    const ids = new Set(tools.map((node) => node.id))
    for (const id of this.cards.keys()) if (!ids.has(id)) this.cards.delete(id)
    for (const id of this.details.keys()) if (!ids.has(id)) this.details.delete(id)
    for (const id of this.groups.keys()) if (!ids.has(id)) this.groups.delete(id)
    this.latest = tools.at(-1)?.id
    this.children = childFacts(value)
  }

  /** Numbered actions inside the most recent card; a collapsed card (or no match) declines. */
  handleInput(data: string): boolean {
    return (this.latest !== undefined && this.cards.get(this.latest)?.handleInput(data)) === true
  }

  /** Ctrl-O: the latest card, or the group it sits in, which is what the screen shows. */
  toggleLatest(): void {
    if (this.latest === undefined) return
    const latest = this.latest
    const group = [...this.groups.values()].find((g) => g.has(latest))
    if (group) group.toggle()
    else this.cards.get(latest)?.toggle()
  }
}
