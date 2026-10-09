import type { UINode, UITurn } from '@agnes/protocol'
import type { ConversationMarkdownState } from './context.js'

export function markdownState(node: UINode, turnStatus?: UITurn['status']): ConversationMarkdownState {
  return {
    nodeId: node.id,
    streaming:
      node.kind === 'assistant' &&
      node.streaming === true &&
      (turnStatus === undefined || turnStatus === 'running' || turnStatus === 'waiting'),
    ...(turnStatus ? { turnStatus } : {}),
  }
}
