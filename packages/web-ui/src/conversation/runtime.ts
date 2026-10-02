import type { UINode, UITurn } from '@agnes/protocol'
import type { DomainTimelineEntry, DomainView, RuntimeConversationWindow } from '@agnes/protocol/runtime'
import {
  ExportedMessageRepository,
  type ThreadMessage,
  type ThreadMessageLike,
  useExternalStoreRuntime,
} from '@assistant-ui/react'
import { useMemo, useSyncExternalStore } from 'react'

/** One already-projected Web window. The caller owns session and history loading. */
export type ConversationProjection = Readonly<{
  sessionId: string
  nodes: readonly UINode[]
  turns?: readonly UITurn[]
  /**
   * When accepted, the window alone supplies native nodes, turns, domain cards and their order.
   * A window with a repeated id across its native nodes and domain entries is ignored whole: the
   * projection renders `nodes` and `turns` as if no window were sent, so no ambiguous id or domain
   * card from it reaches the runtime.
   */
  window?: RuntimeConversationWindow
  meta?: Readonly<{ hasEarlier: boolean; loadEarlier?: () => void }>
}>

export type ConversationMessage = ThreadMessageLike &
  Readonly<{
    id: string
    metadata: {
      custom:
        | {
            kind: UINode['kind']
            node: UINode
            turnId?: string
            turnStatus?: UITurn['status']
            turnReason?: UITurn['reason']
            isFinal: boolean
          }
        | { kind: 'domain'; entry: DomainTimelineEntry }
    }
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

function userText(node: Extract<UINode, { kind: 'user' }>): string {
  return node.content
    .filter(
      (block): block is Extract<(typeof node.content)[number], { type: 'text' }> => block.type === 'text',
    )
    .map((block) => block.text)
    .join('\n')
}

function displayText(node: Exclude<UINode, { kind: 'context' | 'context-sections' }>): string {
  switch (node.kind) {
    case 'user':
      return userText(node)
    case 'assistant':
      return node.text || (node.lostChars === undefined ? '' : `输出中断，至少 ${node.lostChars} 字未保存`)
    case 'tool':
      return `${node.name}: ${node.summary}`
    case 'approval':
      return `${node.state}: ${node.summary}`
    case 'cost':
      return `${node.source}: ${node.credits ?? '费用未提供'}`
    case 'artifact':
      return node.name
    case 'compaction':
      return node.summary ?? `已整理上下文 ${node.range.join('–')}`
    case 'slot':
      return `${node.fill.slot}: ${node.fill.extId}`
    case 'contribute-conflict':
      return `${node.key}: ${node.ops.join(',')}`
  }
}

function isConversationNode(node: UINode): node is Exclude<UINode, { kind: 'context' | 'context-sections' }> {
  if (node.kind === 'context' || node.kind === 'context-sections') return false
  if (node.kind === 'assistant')
    return Boolean(
      node.streaming || node.text.trim() || node.thinking?.trim() || node.lostChars !== undefined,
    )
  return true
}

function messageStatus(node: UINode, owner?: UITurn): ThreadMessageLike['status'] {
  if (node.kind === 'user') return undefined
  if (owner?.status === 'cancelled') return { type: 'incomplete', reason: 'cancelled' }
  if (owner?.status === 'failed') return { type: 'incomplete', reason: 'error' }
  if (node.kind === 'assistant' && node.streaming && owner?.status !== 'completed') return { type: 'running' }
  return { type: 'complete', reason: 'stop' }
}

// A failed or cancelled turn shows its provisional card as interrupted; `view.phase` stays as sent.
function domainStatus(view: DomainView, owner?: UITurn): ThreadMessageLike['status'] {
  if (view.phase === 'finalized') return { type: 'complete', reason: 'stop' }
  if (owner?.status === 'cancelled') return { type: 'incomplete', reason: 'cancelled' }
  if (view.phase === 'interrupted' || owner?.status === 'failed')
    return { type: 'incomplete', reason: 'error' }
  return { type: 'running' }
}

function acceptedWindow(candidate?: RuntimeConversationWindow): RuntimeConversationWindow | undefined {
  if (!candidate) return undefined
  const ids = new Set(candidate.native.timeline.nodes.map((node) => node.id))
  for (const entry of candidate.domains) {
    if (ids.has(entry.id)) return undefined
    ids.add(entry.id)
  }
  return candidate
}

/** Keep source IDs and projection order. Business detail remains on the source node. */
export function projectConversationMessages(
  projection: ConversationProjection,
): readonly ConversationMessage[] {
  const accepted = acceptedWindow(projection.window)
  const { nodes, turns } = accepted ? accepted.native.timeline : projection
  const ownerByNodeId = new Map(turns?.flatMap((turn) => turn.nodeIds.map((id) => [id, turn] as const)))
  const messages = new Map<string, ConversationMessage>()
  for (const node of nodes) {
    if (!isConversationNode(node)) continue
    const owner = ownerByNodeId.get(node.id)
    const text = displayText(node)
    const status = messageStatus(node, owner)
    messages.set(node.id, {
      id: node.id,
      role: node.kind === 'user' ? 'user' : 'assistant',
      content:
        node.kind === 'assistant' && node.thinking
          ? [
              { type: 'reasoning', text: node.thinking },
              { type: 'text', text },
            ]
          : text,
      ...(status ? { status } : {}),
      metadata: {
        custom: {
          kind: node.kind,
          node,
          ...(owner ? { turnId: owner.id, turnStatus: owner.status } : {}),
          ...(owner?.reason ? { turnReason: owner.reason } : {}),
          isFinal: owner?.finalAssistantId === node.id,
        },
      },
    })
  }
  if (!accepted) return [...messages.values()]
  // Window order is authoritative: unlisted entries stay hidden and unknown references are skipped.
  const domains = new Map(accepted.domains.map((entry) => [entry.id, entry]))
  const turnById = new Map(accepted.native.timeline.turns.map((turn) => [turn.id, turn]))
  const ordered = new Map<string, ConversationMessage>()
  for (const { kind, id } of accepted.order) {
    const native = kind === 'native' ? messages.get(id) : undefined
    if (native) ordered.set(id, native)
    const entry = kind === 'domain' ? domains.get(id) : undefined
    if (!entry) continue
    ordered.set(id, {
      id,
      role: 'assistant',
      content: entry.view.fallbackText,
      // A card with `turnId: null` never takes a turn's terminal state.
      status: domainStatus(entry.view, entry.turnId === null ? undefined : turnById.get(entry.turnId)),
      metadata: { custom: { kind: 'domain', entry } },
    })
  }
  return [...ordered.values()]
}

export function useConversationRuntime(store: ConversationProjectionStore) {
  const projection = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const messages = useMemo(() => projectConversationMessages(projection), [projection])
  const messageRepository = useMemo(() => ExportedMessageRepository.fromArray(messages), [messages])
  const lastMessage = messages.at(-1)
  return useExternalStoreRuntime<ThreadMessage>({
    messageRepository,
    isDisabled: true,
    isRunning: lastMessage?.role === 'assistant' && lastMessage.status?.type === 'running',
    onNew: async () => {
      throw new Error('The conversation projection cannot submit a request')
    },
  })
}
