import { CoreError } from '@agnes/core-common/types'
import type { SurfaceNode } from '@agnes/core-ledger/project/surface'
import type { RequestBody } from '@agnes/protocol'
import { validateUserMessageImages } from '../request/user-message-images.js'
import type { SessionImpl } from '../step/session.js'

/** Custom history still enters Core derivation, validation and untrusted envelopes. */
export function loopRequestSurface(s: SessionImpl, messages: RequestBody['messages']): SurfaceNode[] {
  return messages.map((message, i) => {
    if (message.role === 'user') validateUserMessageImages(message.content)
    if (message.role === 'assistant' && message.toolCalls?.length)
      throw new CoreError('E_ENVELOPE', 'Custom tool-call history must use the visible turn history')
    const tool = message.role === 'tool_result'
    const data = tool
      ? { content: message.content, toolUseId: message.toolUseId, isError: message.isError ?? false }
      : { content: message.content, ...(message.role === 'assistant' ? { stopReason: 'end_turn' } : {}) }
    return {
      seq: -(messages.length - i),
      kind: tool ? 'tool_result' : message.role,
      pinned: false,
      event: {
        ...s.ev(tool ? 'tool/result' : message.role + '/message', data, { trust: 'untrusted' }),
        seq: -(messages.length - i),
        ts: new Date(s.d.clock()).toISOString(),
        id: 'loop-message-' + i,
      },
    }
  })
}
