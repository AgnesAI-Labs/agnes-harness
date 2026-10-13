import type { CallContext, LocalEndpoint } from '../endpoint.js'
import { ledgerIntegrityRpcError } from './acp.js'

type AttachmentPage = { mimeType: string; totalBytes: number; base64: string; sha256?: string }
type AttachmentInput = {
  seq: number
  kind: 'image' | 'file'
  index: number
  offset: number
  length: number
  thumbnail?: boolean
}
type Readable = { attachmentRead?(input: AttachmentInput): Promise<AttachmentPage> }

/**
 * User attachment bytes for the session's owner, one window (at most 1 MiB) at a time. The bytes go
 * to the client through this session-owner check, not through the artifact read authority.
 */
export function registerAttachmentRead(
  ep: LocalEndpoint,
  cx: { registry: { require(id: string): { session: unknown } } },
  requireOwner: (method: string, sessionId: string, call: CallContext) => void,
  local: (session: never, input: AttachmentInput) => Promise<AttachmentPage>,
): void {
  ep.register('_agnes/v1/session.attachmentRead', async (params, call) => {
    const { sessionId, ...input } = params as { sessionId: string } & AttachmentInput
    requireOwner('session.attachmentRead', sessionId, call)
    const session = cx.registry.require(sessionId).session as Readable
    // A worker-backed session reads in its worker; an in-process one reads here. Both wait for the
    // whole history to be verified first, and a history that failed is refused like `verifyHistory`.
    try {
      return await (session.attachmentRead ? session.attachmentRead(input) : local(session as never, input))
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === 'E_LEDGER_INTEGRITY') throw ledgerIntegrityRpcError()
      throw error
    }
  })
}
