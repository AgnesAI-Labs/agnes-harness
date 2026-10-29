import type { CallContext, LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import type { SessionLister } from '@agnes/daemon-foundation/local/ports'
import type { SessionPreferencesStore } from '@agnes/daemon-foundation/storage/session-preferences'
import {
  rpcError,
  type SessionArchiveParams,
  type SessionBookmarksSetParams,
  type SessionPinParams,
  type SessionRenameParams,
} from '@agnes/protocol'

/** One page of a session's ledger, oldest first; the fork copy reads only user prompts. */
export type ForkPromptScan = (query: {
  type: string
  order: 'asc'
  fromSeq: number
  toSeq: number
  limit: number
}) => Promise<readonly { id: string; seq: number }[]>

/**
 * A fork inherits the parent's ledger up to `at` with the same event ids, so a bookmark whose user
 * prompt lies inside that history names the same prompt in the child. The rest stay with the parent.
 * Called after the fork is committed, so a failure here costs only the child's bookmarks and is not
 * reported as a failed fork.
 */
export async function copyForkBookmarks(
  store: SessionPreferencesStore,
  scan: ForkPromptScan,
  parent: string,
  at: number,
  child: string,
): Promise<void> {
  try {
    const wanted = new Set(store.get(parent).bookmarks)
    if (!wanted.size) return
    const inside = new Set<string>()
    for (let fromSeq = 1; fromSeq <= at && inside.size < wanted.size; ) {
      const page = await scan({ type: 'user/message', order: 'asc', fromSeq, toSeq: at, limit: 500 })
      for (const event of page) if (wanted.has(event.id)) inside.add(event.id)
      if (page.length < 500) break
      fromSeq = (page.at(-1)?.seq ?? at) + 1
    }
    if (inside.size)
      store.setBookmarks(
        child,
        [...wanted].filter((id) => inside.has(id)),
      )
  } catch {
    // The child starts without bookmarks; the fork itself stands.
  }
}

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
  endpoint.register('_agnes/v1/session.pin', async (params, context) => {
    const request = params as SessionPinParams
    await requireSession(request.sessionId, context)
    return store.pin(request.sessionId, request.pinned)
  })
  endpoint.register('_agnes/v1/session.bookmarks.set', async (params, context) => {
    const request = params as SessionBookmarksSetParams
    await requireSession(request.sessionId, context)
    return store.setBookmarks(request.sessionId, request.bookmarks)
  })
}
