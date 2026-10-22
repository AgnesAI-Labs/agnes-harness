import type { UINode } from '@agnes/protocol'

// Tool statuses before the call has an outcome; completed, failed and cancelled are final.
const OPEN_TOOL = new Set(['planned', 'awaiting_approval', 'running'])

/**
 * Whether the projection will no longer change what this node says. The split footer writes a node
 * into native scrollback once, so only these are written: an assistant reply that stopped streaming
 * (its final text rides on the node), a tool call with an outcome, an approval that is not pending.
 * Everything else, user messages included, arrives complete.
 */
export function isSettled(node: UINode): boolean {
  switch (node.kind) {
    case 'assistant':
      return node.streaming !== true
    case 'tool':
      return !OPEN_TOOL.has(node.status)
    case 'approval':
      return node.state !== 'pending'
    default:
      return true
  }
}
