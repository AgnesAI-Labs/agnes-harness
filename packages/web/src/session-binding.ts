import type { Session } from '@agnes/sdk/browser'

type PermissionHandler = Parameters<Session['onPermissionRequest']>[0]
type LoadSession = (
  id: string,
  options: {
    cwd?: string
    onPermissionRequest?: PermissionHandler
    onPermissionRequestRegistered?: (off: () => void) => void
  },
) => Promise<Session>

export type WebSessionBinding = {
  session: Session
  offPermission?: () => void
}

/**
 * Loads with the handler installed before the RPC, while retaining its disposer for
 * selection changes that race the load response. Do not register again after await:
 * PermissionGate deliberately aborts the previous handler when a new one is installed.
 */
export async function loadWebSession(
  load: LoadSession,
  id: string,
  permission: PermissionHandler,
): Promise<WebSessionBinding> {
  let offPermission: (() => void) | undefined
  const session = await load(id, {
    onPermissionRequest: permission,
    onPermissionRequestRegistered: (off) => {
      offPermission = off
    },
  })
  return offPermission ? { session, offPermission } : { session }
}

export function bindWebSession(session: Session, permission: PermissionHandler): WebSessionBinding {
  return { session, offPermission: session.onPermissionRequest(permission) }
}
