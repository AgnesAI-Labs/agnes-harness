import { rpcError, type SessionArchiveParams, type SessionRenameParams } from '@agnes/protocol'
import type { SessionPreferencesStore } from '../../storage/session-preferences.js'
import type { CallContext, LocalEndpoint } from '../endpoint.js'
import type { SessionLister } from '../ports.js'

export function registerSessionPreferences(
  endpoint: LocalEndpoint,
  lister: SessionLister,
  store: SessionPreferencesStore,
): void {
  const requireSession = async (sessionId: string, context: CallContext) => {
    // A remote authenticated identity is not automatically the local workspace owner.
    if (context.conn.authKind !== 'local' || context.conn.credentialKind !== 'local')
      throw rpcError('CAPABILITY_DENIED', { reason: 'local owner required' })
    let cursor: string | undefined
    do {
      const page = await lister.list({ q: sessionId, limit: 500, ...(cursor ? { cursor } : {}) })
      if (page.items.some((row) => row.sessionId === sessionId)) return
      if (page.cursor === cursor) break
      cursor = page.cursor
    } while (cursor !== undefined)
    throw rpcError('SESSION_NOT_FOUND', { sessionId })
  }
  endpoint.register('_agnes/v1/session.rename', async (params, context) => {
    const request = params as SessionRenameParams
    await requireSession(request.sessionId, context)
    return store.rename(request.sessionId, request.title)
  })
  endpoint.register('_agnes/v1/session.archive', async (params, context) => {
    const request = params as SessionArchiveParams
    await requireSession(request.sessionId, context)
    return store.archive(request.sessionId, request.archived)
  })
}
