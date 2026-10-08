import type { CallContext, LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import type { HostSession } from '@agnes/host'
import { sessionWorkspaceFiles } from '@agnes/worker-runtime'

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
  for (const operation of ['list', 'read'] as const) {
    ep.register(`_agnes/v1/session.workspace.${operation}`, async (params, call) => {
      const p = params as { sessionId: string; path?: string }
      requireOwner(`session.workspace.${operation}`, p.sessionId, call)
      const session = cx.registry.require(p.sessionId).session
      const remote = session as unknown as {
        workspaceFiles?: (operation: 'list' | 'read', path: string) => Promise<unknown>
      }
      return remote.workspaceFiles
        ? remote.workspaceFiles(operation, p.path ?? '')
        : sessionWorkspaceFiles(session, operation, p.path ?? '')
    })
  }
}
