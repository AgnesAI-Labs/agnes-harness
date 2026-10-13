import type { CallContext, LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import type { Host } from '@agnes/host'
import type { SessionViewParams } from '@agnes/protocol'
import { rpcError } from '@agnes/protocol'

/**
 * Read-only: serves a session's recorded conversation from its ledger rows without registry.open,
 * so a session this build cannot resume (version, provider or snapshot changed) stays viewable.
 * It never restores a generation or pin, takes a lock, or writes.
 */
export function registerSessionView(
  endpoint: LocalEndpoint,
  host: Pick<Host, 'readSessionView'>,
  requireOwner: (method: string, sessionId: string, context: CallContext) => void,
): void {
  endpoint.register('_agnes/v1/session.view', async (params, context) => {
    const { sessionId, maxNodes } = params as SessionViewParams
    requireOwner('session.view', sessionId, context)
    try {
      return await host.readSessionView(sessionId, {
        ...(maxNodes === undefined ? {} : { maxNodes }),
        signal: context.signal,
      })
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === 'E_SESSION_NOT_FOUND')
        throw rpcError('SESSION_NOT_FOUND', { sessionId })
      throw error
    }
  })
}
