import { macDesktopAvailable, revealWorkspaceDirectory } from '@agnes/daemon-foundation/desktop'
import type { CallContext, LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import type { WorkspaceCatalog } from '@agnes/daemon-foundation/storage/workspaces'
import { rpcError, type SessionRevealWorkspaceParams, type WorkspaceRevealParams } from '@agnes/protocol'
import { throwWorkspaceRpcError } from './workspaces.js'

type DesktopEnvironment = {
  DISPLAY?: string | undefined
  WAYLAND_DISPLAY?: string | undefined
  SSH_CONNECTION?: string | undefined
  SSH_TTY?: string | undefined
  SESSIONNAME?: string | undefined
  CI?: string | undefined
}

/** Server facts only: never infer a desktop or authorize a path from request metadata. */
export function desktopAvailable(platform: string, env: DesktopEnvironment): boolean {
  if (env.SSH_CONNECTION || env.SSH_TTY || (env.CI && env.CI !== 'false')) return false
  if (platform === 'linux') return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY)
  if (platform === 'win32') return Boolean(env.SESSIONNAME && env.SESSIONNAME !== 'Services')
  return platform === 'darwin'
}

export function registerWorkspaceReveal(
  endpoint: LocalEndpoint,
  workspaces: Pick<WorkspaceCatalog, 'bind'>,
  options: { local: boolean; platform?: string; environment?: DesktopEnvironment },
): void {
  registerReveal(endpoint, '_agnes/v1/workspace.reveal', options, async (params) => {
    const request = params as WorkspaceRevealParams
    return (
      await workspaces.bind(
        'workspaceId' in request ? request.workspaceId : undefined,
        'path' in request ? request.path : '',
      )
    ).path
  })
}

export function registerSessionWorkspaceReveal(
  endpoint: LocalEndpoint,
  workspaces: Pick<WorkspaceCatalog, 'restoreBinding'>,
  requireOwner: (method: string, sessionId: string, context: CallContext) => void,
  options: { local: boolean; platform?: string; environment?: DesktopEnvironment },
): void {
  registerReveal(
    endpoint,
    '_agnes/v1/session.revealWorkspace',
    options,
    async (params) =>
      (await workspaces.restoreBinding((params as SessionRevealWorkspaceParams).sessionId)).canonicalRoot,
    (params, context) =>
      requireOwner('session.revealWorkspace', (params as SessionRevealWorkspaceParams).sessionId, context),
  )
}

function registerReveal(
  endpoint: LocalEndpoint,
  method: '_agnes/v1/session.revealWorkspace' | '_agnes/v1/workspace.reveal',
  options: { local: boolean; platform?: string; environment?: DesktopEnvironment },
  root: (params: unknown, context: CallContext) => Promise<string>,
  authorize?: (params: unknown, context: CallContext) => void,
): void {
  const platform = options.platform ?? process.platform // guards-allow-platform: desktop opener selection belongs to the daemon.
  const environment = options.environment ?? {
    DISPLAY: process.env.DISPLAY,
    WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY,
    SSH_CONNECTION: process.env.SSH_CONNECTION,
    SSH_TTY: process.env.SSH_TTY,
    SESSIONNAME: process.env.SESSIONNAME,
    CI: process.env.CI,
  }
  endpoint.register(method, async (params, context) => {
    if (!options.local || context.conn.authKind !== 'local' || context.conn.credentialKind !== 'local')
      throw rpcError('CAPABILITY_DENIED', { reason: 'local desktop owner required' })
    authorize?.(params, context)
    if (!desktopAvailable(platform, environment))
      throw rpcError('SEMANTIC_REJECTED', { code: 'DESKTOP_UNAVAILABLE' })
    try {
      if (platform === 'darwin' && !(await macDesktopAvailable(context.signal)))
        throw rpcError('SEMANTIC_REJECTED', { code: 'DESKTOP_UNAVAILABLE' })
      // Revalidation rejects missing directories, stale registrations and changed canonical roots.
      const path = await root(params, context)
      if (context.signal.aborted) throw rpcError('REQUEST_TIMEOUT')
      await revealWorkspaceDirectory(platform, path)
      return { opened: true }
    } catch (error) {
      throwWorkspaceRpcError(error)
    }
  })
}
