import type { CallContext, LocalEndpoint } from '../endpoint.js'

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
    // A worker-backed session reads in its worker; an in-process one reads here.
    return session.exportRaw
      ? session.exportRaw({ seq: p.seq, offset: p.offset })
      : local(session as never, p.seq, p.offset)
  })
}
