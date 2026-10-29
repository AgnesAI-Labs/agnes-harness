import { canonicalJson } from '@agnes/core-common/request/hash'
import type { ToolCall, UINode } from '@agnes/protocol'
import { clipUtf16 } from './clip.js'

/** Both live and rebuilt timelines use the presentation saved with this exact call. */
export function initialToolNode(id: string, seq: number, call: ToolCall): Extract<UINode, { kind: 'tool' }> {
  return {
    kind: 'tool',
    id,
    seq,
    toolUseId: call.toolUseId,
    name: call.name,
    status: 'planned',
    ...(call.presentation ? { presentation: structuredClone(call.presentation) } : {}),
    summary: clipUtf16(call.name, 512),
    argsPreview: clipUtf16(canonicalJson(call.args), 2048),
  }
}
