import type { ConnectionState, LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import { currentPermissionContext } from '@agnes/daemon-rpc/local/prompter'
import { automaticPermissionDecision, rpcError } from '@agnes/protocol'

type Connections = {
  current(key: string): ConnectionState | undefined
  connections?(): ConnectionState[]
  endpoint(conn: ConnectionState): LocalEndpoint | undefined
  owner(key: string): { principalId: string; active: boolean } | undefined
}
/** Transient offer lookup until durable decision delivery owns re-offer. */
export function managementConnection(
  options: Connections,
  sessionKey: string,
  code: string,
  errors?: { permission?: string; attachment?: string },
) {
  const owner = options.owner(sessionKey)
  if (!owner?.active) throw rpcError('CAPABILITY_DENIED', { code })
  const principalId = owner.principalId
  const automatic = automaticPermissionDecision(currentPermissionContext())
  // A session's pre-authorized tool operation needs no attached approval-capable client.
  const unattended: ConnectionState | undefined = automatic
    ? {
        principalId,
        clientId: `session:${sessionKey}`,
        initialized: true,
        clientModuleNotices: false,
        capabilities: { permission: false },
        attached: new Map(),
        authKind: 'local',
        credentialKind: 'local',
      }
    : undefined
  const eligible = (conn: ConnectionState | undefined): conn is ConnectionState =>
    !!conn &&
    conn.authKind === 'local' &&
    conn.credentialKind === 'local' &&
    (automatic !== undefined || conn.capabilities.permission) &&
    conn.principalId === principalId &&
    (automatic !== undefined || (conn.attached.has(sessionKey) && !!options.endpoint(conn)))
  const candidates = () => [options.current(sessionKey), ...(options.connections?.() ?? [])].filter(eligible)
  const get = () => {
    const currentOwner = options.owner(sessionKey)
    const conn = candidates()[0] ?? unattended
    const candidate = options.current(sessionKey)
    if (
      !conn &&
      candidate?.principalId === principalId &&
      candidate.authKind === 'local' &&
      candidate.credentialKind === 'local'
    ) {
      if (!candidate.capabilities.permission && errors?.permission)
        throw rpcError('CAPABILITY_DENIED', { code: errors.permission })
      if (!candidate.attached.has(sessionKey) && errors?.attachment) throw new Error(errors.attachment)
    }
    if (!currentOwner?.active || currentOwner.principalId !== principalId || !conn)
      throw rpcError('CAPABILITY_DENIED', { code })
    return conn
  }
  get()
  return { get, candidates, principalId }
}
