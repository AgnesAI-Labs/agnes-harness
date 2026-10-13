import type { CallContext, LocalEndpoint } from '../endpoint.js'
import { ledgerIntegrityRpcError } from './acp.js'

type ExportRawPage = { seq: number; base64: string; nextOffset: number | null }
type Exportable = { exportRaw?(input: { seq: number; offset: number }): Promise<ExportRawPage> }

/** Full stored rows for `export --raw`: a lean replay names what it left out, this serves it back. */
export function registerExportRaw(
  ep: LocalEndpoint,
  cx: { registry: { require(id: string): { session: unknown } } },
  requireOwner: (method: string, sessionId: string, call: CallContext) => void,
  local: (session: never, seq: number, offset: number) => Promise<ExportRawPage>,
): void {
  ep.register('_agnes/v1/session.exportRaw', async (params, call) => {
    const p = params as { sessionId: string; seq: number; offset: number }
    requireOwner('session.exportRaw', p.sessionId, call)
    const session = cx.registry.require(p.sessionId).session as Exportable
    // A worker-backed session reads in its worker; an in-process one reads here. Both wait for the
    // whole history to be verified first, and a history that failed is refused like `verifyHistory`.
    try {
      return await (session.exportRaw
        ? session.exportRaw({ seq: p.seq, offset: p.offset })
        : local(session as never, p.seq, p.offset))
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === 'E_LEDGER_INTEGRITY') throw ledgerIntegrityRpcError()
      throw error
    }
  })
}
