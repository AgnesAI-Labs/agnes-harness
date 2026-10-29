import type { CallContext, LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import type { Host } from '@agnes/host'
import { rpcError } from '@agnes/protocol'

/** Read-only: the descriptor is produced by the Host's generation and composition management. */
export function registerSessionRuntime(
  endpoint: LocalEndpoint,
  host: Pick<Host, 'kernel' | 'sessionGeneration' | 'sessionRuntime' | 'resolveAgent'>,
  requireOwner: (method: string, sessionId: string, context: CallContext) => void,
  integrity?: (
    key: string,
  ) =>
    | import('@agnes/protocol').SessionIntegrityStatus
    | Promise<import('@agnes/protocol').SessionIntegrityStatus>
    | undefined,
): void {
  endpoint.register('_agnes/v1/agents.resolve', async (params) => {
    if (!host.resolveAgent) throw rpcError('CAPABILITY_DENIED', { reason: 'agent resolution unavailable' })
    return host.resolveAgent((params as { ref: string }).ref)
  })
  endpoint.register('_agnes/v1/session.runtime', async (params, context) => {
    const { sessionId } = params as { sessionId: string }
    requireOwner('session.runtime', sessionId, context)
    if (
      !host.sessionRuntime ||
      (!host.kernel.get(sessionId) && host.sessionGeneration?.(sessionId) === undefined)
    )
      throw rpcError('SESSION_NOT_FOUND', { sessionId })
    const value = await host.sessionRuntime(sessionId)
    const status = await integrity?.(sessionId)
    return { ...value, ...(status ? { integrity: status } : {}) }
  })
}
