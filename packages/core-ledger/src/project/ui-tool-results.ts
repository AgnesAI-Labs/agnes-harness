import type { Event, Seq } from '@agnes/core-common/types'
import type { ToolResult, UINode } from '@agnes/protocol'
import { clipUtf16 } from './clip.js'

type ToolNode = Extract<UINode, { kind: 'tool' }>
/** Apply tool outcomes and trusted argument refusals without changing the underlying audit rows. */
export function applyToolResultEvent(
  event: Event,
  tools: ReadonlyMap<string, ToolNode>,
  completed: Array<{ seq: Seq; toolUseId: string }>,
  changed: Set<string>,
): void {
  const value = event.data as {
    toolUseId?: string
    failures?: number
    disabled?: boolean
    presentational?: boolean
  }
  const node = value.toolUseId ? tools.get(value.toolUseId) : undefined
  if (!node) return
  if (event.type === 'x/core/tool-argument-recovery') {
    if (
      event.origin === 'system' &&
      event.trust === 'trusted' &&
      value.failures &&
      typeof value.disabled === 'boolean' &&
      typeof value.presentational === 'boolean'
    ) {
      node.argumentRecovery = { disabled: value.disabled, presentational: value.presentational }
      changed.add(node.id)
    }
    return
  }
  const result = event.data as ToolResult
  node.status =
    result.code === 'CANCELLED' || result.code === 'ABORTED' || result.cancelledBy
      ? 'cancelled'
      : result.isError
        ? 'failed'
        : 'completed'
  node.resultPreview = clipUtf16(
    result.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join(''),
    4096,
  )
  node.resultSeq = event.seq
  node.enforcement = structuredClone(result.enforcement)
  completed.push({ seq: event.seq, toolUseId: node.toolUseId })
  changed.add(node.id)
}
