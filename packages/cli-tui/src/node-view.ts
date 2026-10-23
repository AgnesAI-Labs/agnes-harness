import type { UINode } from '@agnes/protocol'
import type { Session } from '@agnes/sdk'
import { type Component, escapeControl, Text, VStack } from './component.js'
import type { Locale } from './locale.js'
import { nodeText } from './node-text.js'
import type { brandColour, ThemedAnsi, TuiTheme } from './theme.js'
import { assistantView } from './thinking.js'
import type { ToolCards } from './tool-cards.js'
import { ApprovalCard } from './views/approval-card.js'
import { UserMessage } from './views/message.js'

export interface NodeViewHost {
  ansi: ThemedAnsi
  locale: Locale
  theme: TuiTheme
  /** The brand accent colour of the user's own messages. */
  accent: ReturnType<typeof brandColour>
  cards: ToolCards
  /** Every projected approval card by node id; the root input and the terminal signals read it. */
  approvalCards: Map<string, ApprovalCard>
  session: () => Session
  settled: () => boolean
  letters: () => boolean
  refuseClosed: () => boolean
  repaint: () => void
}

/** The view of one projected timeline node; approvals are registered so keystrokes can reach them. */
export function nodeView(host: NodeViewHost): (node: UINode) => Component {
  const { ansi, locale } = host
  return (node) => {
    if (node.kind === 'tool') return host.cards.view(node)
    if (node.kind === 'approval') {
      const card = new ApprovalCard(node, {
        ansi,
        locale,
        settled: host.settled,
        letters: host.letters,
        onDecide: async (ref, verdict, reason) => {
          if (host.refuseClosed()) return
          const value =
            reason ?? (node.presentation?.[locale] ?? node.presentation?.en)?.responseValue ?? null
          await host.session().client.approval.decide({
            ...ref,
            commandId: `${ref.id}:${ref.revision}:${verdict}`,
            response: { option: verdict, value },
          })
        },
        // The decide call's settlement (a rejection adds no ledger event for TuiProjection)
        // must ask for its own repaint: nothing else in the render loop watches that promise.
        changed: host.repaint,
      })
      host.approvalCards.set(node.id, card)
      return card
    }
    if (node.kind === 'assistant') return assistantView(node, ansi, locale)
    if (node.kind === 'user') {
      const text = nodeText(node)
      return new UserMessage(
        text.startsWith('you: ') ? text.slice('you: '.length) : text,
        ansi,
        host.theme,
        host.accent,
      )
    }
    const text = nodeText(node)
    return text ? new Text(escapeControl(text)) : new VStack()
  }
}
