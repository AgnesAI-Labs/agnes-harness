import { createElement as h } from 'react'
/** Recorded tool facts only; this card never submits an action or evaluates model text. */
export function ResultCard({ card }) {
  return h('pre', { 'aria-label': 'Tool result / 工具结果' }, JSON.stringify(card.data, null, 2))
}
export function apply(ctx) {
  return ctx.conversationCards.register({
    id: 'example-tool-result',
    order: 0,
    matches: (card) =>
      card.kind === 'conversation.node' && card.data?.kind === 'tool' && card.data.name === 'ui_example_ack',
    component: ResultCard,
  })
}
