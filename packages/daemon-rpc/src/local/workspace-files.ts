import type { CallContext, LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import type { HostSession } from '@agnes/host'
import { sessionWorkspaceChanges, sessionWorkspaceFiles } from '@agnes/worker-runtime'
import { callReferences } from './references.js'

export {
  compileIgnore,
  ignoredBy,
  MAX_READ_BYTES,
  normalizeWorkspacePath,
  parseGitPorcelain,
} from '@agnes/worker-runtime'

type SessionSource = { registry: { require(sessionId: string): { session: HostSession } } }
export function registerWorkspaceFiles(
  ep: LocalEndpoint,
  cx: SessionSource,
  requireOwner: (method: string, sessionId: string, call: CallContext) => void,
): void {
  const active = new WeakMap<object, Map<string, AbortController>>()
  for (const cancellable of [false, true]) {
    ep.register(
      cancellable ? '_agnes/v1/session.references.searchCancelable' : '_agnes/v1/session.references.search',
      async (params, call) => {
        const p = params as { sessionId: string; query: string; requestId?: string }
        requireOwner(
          cancellable ? 'session.references.searchCancelable' : 'session.references.search',
          p.sessionId,
          call,
        )
        const session = cx.registry.require(p.sessionId).session
        if (!cancellable) return callReferences(session, 'search', p.query, call.signal)
        let requests = active.get(call.conn)
        if (!requests) {
          requests = new Map()
          active.set(call.conn, requests)
        }
        const key = `${p.sessionId}\0${p.requestId}`
        if (requests.has(key)) throw new Error('Duplicate reference request id')
        const controller = new AbortController()
        requests.set(key, controller)
        try {
          return await callReferences(
            session,
            'search',
            p.query,
            AbortSignal.any([call.signal, controller.signal]),
          )
        } finally {
          requests.delete(key)
        }
      },
    )
  }
  ep.register('_agnes/v1/session.references.cancel', async (params, call) => {
    const p = params as { sessionId: string; requestId: string }
    requireOwner('session.references.cancel', p.sessionId, call)
    active.get(call.conn)?.get(`${p.sessionId}\0${p.requestId}`)?.abort()
    return {}
  })
  ep.register('_agnes/v1/session.workspace.changes', async (params, call) => {
    const p = params as {
      sessionId: string
      scope?: 'session' | 'turn'
      path?: string
      expectedRevision?: string
    }
    requireOwner('session.workspace.changes', p.sessionId, call)
    const session = cx.registry.require(p.sessionId).session
    const { sessionId, ...input } = p
    const remote = session as unknown as { workspaceChanges?: (request: typeof input) => Promise<unknown> }
    return remote.workspaceChanges ? remote.workspaceChanges(input) : sessionWorkspaceChanges(session, input)
  })
  for (const operation of ['list', 'browse', 'read'] as const) {
    ep.register(`_agnes/v1/session.workspace.${operation}`, async (params, call) => {
      const p = params as { sessionId: string; path?: string }
      requireOwner(`session.workspace.${operation}`, p.sessionId, call)
      const session = cx.registry.require(p.sessionId).session
      const filesOperation = operation === 'browse' ? 'list' : operation
      const remote = session as unknown as {
        workspaceFiles?: (operation: 'list' | 'read', path: string, browse?: boolean) => Promise<unknown>
      }
      return remote.workspaceFiles
        ? remote.workspaceFiles(filesOperation, p.path ?? '', operation === 'browse')
        : sessionWorkspaceFiles(session, filesOperation, p.path ?? '', operation === 'browse')
    })
  }
}
