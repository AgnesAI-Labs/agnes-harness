import type { UINode, UITurn } from '@agnes/protocol'
import type { ReactNode } from 'react'
import type { Translate } from '../../locales/index.js'

export type AssistantNode = Extract<UINode, { kind: 'assistant' }>

export type ToolNode = Extract<UINode, { kind: 'tool' }>

export type CostNode = Extract<UINode, { kind: 'cost' }>

export type ApprovalNode = Extract<UINode, { kind: 'approval' }>

/** 组件未拿到宿主注入时的兜底：显示 key 本身，让漏接线在界面上可见。 */
export const fallbackT: Translate = (key) => key

export interface ConversationMarkdownState {
  nodeId: string
  streaming: boolean
  turnStatus?: UITurn['status'] | undefined
}

export interface ConversationMessagesProps {
  /** Locale-bound translate injected by the host; called during render, never cached. */
  t: Translate
  /** The controller-owned projection window, in source order. */
  nodes: readonly UINode[]
  turns?: readonly UITurn[]
  /** Optional snapshot gate when a host supplies turns and messages through separate subscriptions. */
  visibleNodeIds?: readonly string[]
  renderTurnActions?: (turn: UITurn, finalText: string, settled: boolean) => ReactNode
  renderMarkdown?: (text: string, part: 'thinking' | 'body', state?: ConversationMarkdownState) => ReactNode
  renderTool?: (node: ToolNode) => ReactNode
  renderCost?: (node: CostNode) => ReactNode
  renderSlot?: (node: Extract<UINode, { kind: 'slot' }>) => ReactNode
  /** The upper Web layer owns DSH registration, claims, and fallback visibility. */
  renderNode?: (node: UINode, native: ReactNode) => ReactNode
  /** Host-owned interactive cards and deliverables can stay outside collapsed process history. */
  keepNodeVisible?: (node: UINode) => boolean
}
