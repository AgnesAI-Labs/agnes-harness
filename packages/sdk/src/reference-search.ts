import type { ReferenceSearchResult, SessionWorkspaceListResult } from '@agnes/protocol'
import type { Client } from './client.js'

/** Browse opts into strict ignore checks and skips Git status on a single directory. */
export function listSessionWorkspace(
  client: Client,
  sessionId: string,
  path: string,
  browse: boolean,
  signal?: AbortSignal,
): Promise<SessionWorkspaceListResult> {
  return client.call<SessionWorkspaceListResult>(
    browse ? '_agnes/v1/session.workspace.browse' : '_agnes/v1/session.workspace.list',
    {
      sessionId,
      ...(path ? { path } : {}),
    },
    signal ? { signal } : {},
  )
}

/** A transport abort also sends a scoped backend cancellation for an already-dispatched search. */
export async function searchSessionReferences(
  client: Client,
  sessionId: string,
  query: string,
  signal?: AbortSignal,
): Promise<ReferenceSearchResult> {
  const requestId = signal ? crypto.randomUUID() : undefined
  const abort = () => {
    if (requestId)
      void client.call('_agnes/v1/session.references.cancel', { sessionId, requestId }).catch(() => {})
  }
  signal?.addEventListener('abort', abort, { once: true })
  try {
    signal?.throwIfAborted()
    return await client.call<ReferenceSearchResult>(
      requestId ? '_agnes/v1/session.references.searchCancelable' : '_agnes/v1/session.references.search',
      {
        sessionId,
        query,
        ...(requestId ? { requestId } : {}),
      },
      signal ? { signal } : {},
    )
  } finally {
    signal?.removeEventListener('abort', abort)
  }
}
