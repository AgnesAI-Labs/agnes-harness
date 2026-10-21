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
  const details = result.structured
  if (
    node.name === 'subagent_spawn' &&
    !result.isError &&
    details &&
    typeof details === 'object' &&
    !Array.isArray(details)
  ) {
    const role = details.role
    if (
      role &&
      typeof role === 'object' &&
      !Array.isArray(role) &&
      typeof role.ref === 'string' &&
      role.title &&
      typeof role.title === 'object' &&
      !Array.isArray(role.title) &&
      typeof role.title.en === 'string'
    )
      node.delegatedRole = {
        ref: role.ref,
        title: {
          en: role.title.en,
          ...(typeof role.title['zh-CN'] === 'string' ? { 'zh-CN': role.title['zh-CN'] } : {}),
        },
      }
  }
  node.resultSeq = event.seq
  node.enforcement = structuredClone(result.enforcement)
  completed.push({ seq: event.seq, toolUseId: node.toolUseId })
  changed.add(node.id)
}
