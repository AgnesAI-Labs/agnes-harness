import type { CallContext, LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import type { HostSession } from '@agnes/host'
import { type FileUploadRequest, rpcError } from '@agnes/protocol'
import { sessionFileUpload } from '@agnes/worker-runtime'

export function registerFileUpload(
  ep: LocalEndpoint,
  cx: { registry: { require(sessionId: string): { session: HostSession } } },
  requireOwner: (method: string, sessionId: string, call: CallContext) => void,
): void {
  ep.register('_agnes/v1/session.fileUpload', async (params, call) => {
    const input = params as FileUploadRequest
    if (
      !input ||
      typeof input.sessionId !== 'string' ||
      !['limits', 'start', 'status', 'chunk', 'finish', 'cancel'].includes(input.operation)
    )
      throw rpcError('INVALID_PARAMS', { reason: 'UPLOAD_INVALID' })
    requireOwner('session.fileUpload', input.sessionId, call)
    const session = cx.registry.require(input.sessionId).session
    const remote = session as unknown as { fileUpload?: (input: FileUploadRequest) => Promise<unknown> }
    return remote.fileUpload ? remote.fileUpload(input) : sessionFileUpload(session, input)
  })
}
