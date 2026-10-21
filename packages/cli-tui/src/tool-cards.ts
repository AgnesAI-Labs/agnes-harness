import type { UINode, UITimeline } from '@agnes/protocol'
import type { ThemedAnsi } from './theme.js'
import { ToolCard } from './views/tool-card.js'

type ToolNode = Extract<UINode, { kind: 'tool' }>

/**
 * The tool cards of the projected timeline and what outlives a card: the Timeline rebuilds a node's
 * view whenever its projection changes, so open/closed state is kept here, by node id, and handed to
 * each new card.
 */
export class ToolCards {
  private readonly cards = new Map<string, ToolCard>()
  private latest: string | undefined

  constructor(
    private readonly o: {
      ansi: ThemedAnsi
      locale: string
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
    })
    this.cards.set(node.id, card)
    return card
  }

  /** Forgets cards whose node left the projection and remembers which tool came last. */
  sync(value: UITimeline): void {
    const tools = value.nodes.filter((node) => node.kind === 'tool')
    const ids = new Set(tools.map((node) => node.id))
    for (const id of this.cards.keys()) if (!ids.has(id)) this.cards.delete(id)
    this.latest = tools.at(-1)?.id
  }

  /** Numbered actions inside the most recent card; a collapsed card (or no match) declines. */
  handleInput(data: string): boolean {
    return (this.latest !== undefined && this.cards.get(this.latest)?.handleInput(data)) === true
  }

  toggleLatest(): void {
    if (this.latest !== undefined) this.cards.get(this.latest)?.toggle()
  }
}
