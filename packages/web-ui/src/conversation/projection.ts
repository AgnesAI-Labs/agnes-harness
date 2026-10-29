import type { UINode, UITurn } from '@agnes/protocol'
import { useSyncExternalStore } from 'react'

/** One already-projected Web window. The caller owns session and history loading. */
export type ConversationProjection = Readonly<{
  sessionId: string
  nodes: readonly UINode[]
  turns?: readonly UITurn[]
  meta?: Readonly<{
    hasEarlier: boolean
    loadEarlier?: () => void
    bookmarks?: readonly string[]
    setBookmarks?: (next: readonly string[]) => Promise<void>
  }>
}>

export type ConversationProjectionStore = Readonly<{
  getSnapshot: () => ConversationProjection
  subscribe: (listener: () => void) => () => void
  update: (projection: ConversationProjection) => void
}>

export function createConversationProjectionStore(
  initial: ConversationProjection,
): ConversationProjectionStore {
  let snapshot = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    update: (projection) => {
      snapshot = projection
      for (const listener of listeners) listener()
    },
  }
}

export type ConversationNode = Exclude<UINode, { kind: 'context' | 'context-sections' }>

function isConversationNode(node: UINode): node is ConversationNode {
  if (node.kind === 'context' || node.kind === 'context-sections') return false
  // A side call (voice, /btw) is outside the conversation: the usage views count its cost row.
  if (node.kind === 'cost' && node.purpose === 'side-call') return false
  if (node.kind === 'assistant')
    return Boolean(
      node.streaming || node.text.trim() || node.thinking?.trim() || node.lostChars !== undefined,
    )
  return true
}

/** Keep source IDs and projection order; a repeated ID keeps its first position and last value. */
export function conversationNodes(nodes: readonly UINode[]): Map<string, ConversationNode> {
  const shown = new Map<string, ConversationNode>()
  for (const node of nodes) if (isConversationNode(node)) shown.set(node.id, node)
  return shown
}

/** Subscribe a component to the controller-owned projection; the store stays the only source. */
export function useConversationProjection(store: ConversationProjectionStore): ConversationProjection {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}
