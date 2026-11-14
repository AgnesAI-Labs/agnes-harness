import type { InboxItem } from '../reduce/shapes.js'

/**
 * The command that delivered a still-pending input, so a client can tell which of its own
 * submissions is queued without replaying the ledger. Absent when the input carried none.
 */
export function pendingCommandId(item: Pick<InboxItem, 'commandId'>): { commandId?: string } {
  return item.commandId ? { commandId: item.commandId } : {}
}
