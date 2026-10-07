import type { UINode } from '@agnes/protocol'
import type { ToolCardInlinePayload } from '@agnes/protocol/gen/slots'

type ToolNode = Extract<UINode, { kind: 'tool' }>
/** Identifies existing presentation surfaces; does not infer job or child lifecycle state. */
export function conversationToolCardKind(node: ToolNode): 'background-job' | 'child-agent' | undefined {
  if (['job_list', 'job_output', 'job_kill'].includes(node.name)) return 'background-job'
  if (node.name === 'shell' && node.resultPreview?.startsWith('background job ')) return 'background-job'
  if (node.name.startsWith('subagent_')) return 'child-agent'
  return undefined
}
export function keepConversationCardVisible(node: UINode): boolean {
  if (node.kind !== 'tool') return false
  if (conversationToolCardKind(node)) return true
  return (
    node.slots?.some((fill) => {
      if (fill.slot !== 'tool.card.inline') return false
      const payload = fill.payload as ToolCardInlinePayload
      return !!payload.question || !!payload.deliverables?.length
    }) ?? false
  )
}
