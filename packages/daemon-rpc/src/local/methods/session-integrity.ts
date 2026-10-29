import type { LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import { rpcError, type SessionIntegrityParams, type SessionIntegrityStatus } from '@agnes/protocol'
import type { LocalContext } from './acp.js'

/** Owner-only audit and status. Verification lives in Core, never in the client or RPC projection. */
export function registerSessionIntegrity(
  ep: LocalEndpoint,
  cx: LocalContext,
  requireOwner: (method: string, sessionId: string) => void,
): void {
  ep.register('_agnes/v1/session.integrity', async (params, context): Promise<SessionIntegrityStatus> => {
    const { sessionId, verify } = params as SessionIntegrityParams
    requireOwner('session.integrity', sessionId)
    let entry = cx.registry.get(sessionId)
    if (!entry) {
      if (!verify)
        throw rpcError('CAPABILITY_DENIED', {
          reason: 'Open the session or request a full audit before reading its verification status',
        })
      const binding = await cx.workspaces.restoreBinding(sessionId)
      entry = await cx.registry.open({ key: sessionId, cwd: binding.canonicalRoot, binding })
    }
    if (verify) {
      try {
        return await entry.session.auditHistory(context.signal)
      } catch (error) {
        // An audit reports proven corruption with its sequence. Transport/cancellation/I/O errors remain errors.
        const code = (error as { code?: string; data?: { code?: string } }).code
        const workerCode = (error as { data?: { code?: string } }).data?.code
        if (code !== 'E_LEDGER_INTEGRITY' && workerCode !== 'E_LEDGER_INTEGRITY') throw error
      }
    }
    return await entry.session.integrityStatus()
  })
}

/** An audit view never assembles an executable session as a side effect of reading evidence. */
export async function requireSessionHistory(cx: LocalContext, sessionId: string): Promise<void> {
  const entry = cx.registry.get(sessionId)
  if (!entry)
    throw rpcError('CAPABILITY_DENIED', {
      reason: 'Open the session to verify history before viewing audited evidence',
    })
  await entry.session.requireVerifiedHistory()
}
