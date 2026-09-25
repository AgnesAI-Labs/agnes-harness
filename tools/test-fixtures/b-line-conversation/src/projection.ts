import type { ThreadMessageLike } from '@assistant-ui/react'
import type { UINode, UITurn } from '../../../../packages/protocol/src/index.js'
import { isConversationNode } from '../../../../packages/web/src/conversation-visibility.js'

/** A deliberately small spike converter, not a production adapter. */
export type SpikeProjection = Readonly<{
  sessionId: string
  nodes: readonly UINode[]
  turns?: readonly UITurn[]
}>

export type SpikeMessage = ThreadMessageLike & {
  readonly id: string
  readonly metadata: {
    readonly custom: {
      readonly kind: UINode['kind']
      readonly node: UINode
      readonly turnId?: string
      readonly isFinal: boolean
    }
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

function nodeText(node: UINode): string {
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
    case 'context':
      return node.text
    case 'context-sections':
      return `${node.sections.length} sections`
  }
}

export function projectVisible(projection: SpikeProjection): readonly SpikeMessage[] {
  const owners = new Map(projection.turns?.flatMap((turn) => turn.nodeIds.map((id) => [id, turn] as const)))
  return projection.nodes.filter(isConversationNode).map((node) => {
    const owner = owners.get(node.id)
    return {
      id: node.id,
      role: node.kind === 'user' ? 'user' : 'assistant',
      content:
        node.kind === 'assistant' && node.thinking
          ? ([
              { type: 'reasoning', text: node.thinking },
              { type: 'text', text: nodeText(node) },
            ] as const)
          : nodeText(node),
      ...(node.kind === 'assistant' && node.streaming
        ? { status: { type: 'running' } as const }
        : node.kind !== 'user'
          ? { status: { type: 'complete', reason: 'stop' } as const }
          : {}),
      metadata: {
        custom: {
          kind: node.kind,
          node,
          ...(owner ? { turnId: owner.id } : {}),
          isFinal: owner?.finalAssistantId === node.id,
        },
      },
    }
  })
}
