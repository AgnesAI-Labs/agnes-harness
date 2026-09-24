import { WorkspaceDirectoryError } from '@agnes/host'
import {
  rpcError,
  type WorkspaceAddParams,
  type WorkspaceAddResult,
  type WorkspaceListResult,
} from '@agnes/protocol'
import { SessionWorkspaceConflictError, type WorkspaceCatalog } from '../../storage/workspaces.js'
import type { CallContext, LocalEndpoint } from '../endpoint.js'

export function throwWorkspaceRpcError(error: unknown): never {
  if (error instanceof WorkspaceDirectoryError)
    throw rpcError('SEMANTIC_REJECTED', { code: 'WORKSPACE_INVALID', reason: error.reason })
  if (error instanceof SessionWorkspaceConflictError)
    throw rpcError('SEMANTIC_REJECTED', {
      code: 'ID_CONFLICT',
      sessionId: error.sessionKey,
      reason: 'session workspace differs from the original request',
    })
  throw error
}

const workspaceCall = async <T>(_context: CallContext, action: () => Promise<T>): Promise<T> => {
  try {
    return await action()
  } catch (error) {
    throwWorkspaceRpcError(error)
  }
}

/** Registers the workspace control surface; LocalEndpoint enforces initialize/auth first. */
export function registerWorkspaces(endpoint: LocalEndpoint, catalog: WorkspaceCatalog): void {
  endpoint.register('_agnes/v1/workspace.list', (_params, context) =>
    workspaceCall<WorkspaceListResult>(context, () => catalog.list()),
  )
  endpoint.register('_agnes/v1/workspace.add', (params, context) =>
    workspaceCall<WorkspaceAddResult>(context, async () => ({
      workspace: await catalog.add((params as WorkspaceAddParams).path),
    })),
  )
}
