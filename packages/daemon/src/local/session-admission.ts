import type { Host, WorkspaceBinding } from '@agnes/host'
import type { SessionPrincipalOwnership } from '../storage/session-ownership.js'
import type { WorkspaceBindingEnvelope, WorkspaceCatalog } from '../storage/workspaces.js'

export class SessionAdmissionDenied extends Error {
  readonly reason = 'session owner unavailable' as const
  constructor(readonly sessionId: string) {
    super('session owner unavailable')
    this.name = 'SessionAdmissionDenied'
  }
}

export type SessionAdmissionPort = {
  reserve(sessionKey: string, cwd: string): Promise<{ binding: WorkspaceBinding; reservedNew: boolean }>
  activate(sessionKey: string, reservedNew: boolean): void
}

/**
 * The durable half of session/new: claim the key for this principal and bind the workspace.
 * Opening the ledger and activateNew stay with the caller, because import must not activate until
 * the body has landed (and F01 has rolled back a failed body).
 */
export async function reserveOwnedSession(input: {
  ownership: SessionPrincipalOwnership
  workspaces: WorkspaceCatalog
  principalId: string
  sessionKey: string
  canonicalRoot: string
  hasSessionFact: boolean
}): Promise<{ envelope: WorkspaceBindingEnvelope; reservedNew: boolean }> {
  let reservedNew = false
  if (input.hasSessionFact) {
    try {
      const active = input.ownership.resolve(input.sessionKey)
      if (active?.principalId === input.principalId) {
        // An already active session is idempotent for its authenticated owner.
      } else if (input.ownership.ownsNewReservation(input.sessionKey, input.principalId)) {
        reservedNew = true
      } else throw new SessionAdmissionDenied(input.sessionKey)
    } catch (error) {
      if (error instanceof SessionAdmissionDenied) throw error
      throw new SessionAdmissionDenied(input.sessionKey)
    }
  } else {
    try {
      if (!input.ownership.bindNew(input.sessionKey, input.principalId))
        throw new SessionAdmissionDenied(input.sessionKey)
      reservedNew = true
    } catch (error) {
      if (error instanceof SessionAdmissionDenied) throw error
      throw new SessionAdmissionDenied(input.sessionKey)
    }
  }
  const envelope = await input.workspaces.authorizeAndBind(input.sessionKey, input.canonicalRoot)
  return { envelope, reservedNew }
}

export function createSessionAdmissionPort(input: {
  ownership: SessionPrincipalOwnership
  workspaces: WorkspaceCatalog
  host: {
    acceptWorkspaceBinding: Host['acceptWorkspaceBinding']
    kernel: Pick<Host['kernel'], 'get'>
  }
  principalId: string
}): SessionAdmissionPort {
  return {
    async reserve(sessionKey, cwd) {
      const directory = await input.workspaces.validate(cwd)
      const hasSessionFact =
        input.workspaces.sessionPath(sessionKey) !== undefined ||
        input.host.kernel.get(sessionKey) !== undefined
      const { envelope, reservedNew } = await reserveOwnedSession({
        ownership: input.ownership,
        workspaces: input.workspaces,
        principalId: input.principalId,
        sessionKey,
        canonicalRoot: directory.path,
        hasSessionFact,
      })
      return {
        binding: input.host.acceptWorkspaceBinding(envelope, sessionKey),
        reservedNew,
      }
    },
    activate(sessionKey, reservedNew) {
      if (reservedNew && !input.ownership.activateNew(sessionKey, input.principalId))
        throw new SessionAdmissionDenied(sessionKey)
    },
  }
}
