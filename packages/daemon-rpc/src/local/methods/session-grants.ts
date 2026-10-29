import type { CallContext, LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import { type Host, type HostSession, revokeSessionApprovalGrant, sessionApprovalGrants } from '@agnes/host'
import {
  type ApprovalGrantSessionResult,
  type ApprovalGrantSessionRevokeParams,
  rpcError,
  type SessionApprovalGrant,
} from '@agnes/protocol'

/** A worker-backed session answers for itself; an in-process one is read beside its Host. */
type WorkerSession = {
  approvalGrants(): Promise<ApprovalGrantSessionResult>
  revokeApprovalGrant(grantId: string, revokedAt: string): Promise<SessionApprovalGrant | null>
}
const worker = (session: unknown): WorkerSession | undefined =>
  typeof (session as Partial<WorkerSession>).approvalGrants === 'function'
    ? (session as WorkerSession)
    : undefined

/**
 * The grants in force for one session, for its owner. Unlike the fully-bound list, the caller names
 * no tool: the session's own actor and policy decide what is listed, so nothing is probed.
 */
export function registerSessionGrants(
  ep: LocalEndpoint,
  cx: { host: Pick<Host, 'approvalGrants'>; registry: { require(key: string): { session: unknown } } },
  requireOwner: (method: string, sessionId: string, context: CallContext) => void,
): void {
  ep.register('_agnes/v1/approvalGrants.forSession', async (params, c) => {
    const { sessionId } = params as { sessionId: string }
    requireOwner('approvalGrants.forSession', sessionId, c)
    const { session } = cx.registry.require(sessionId)
    return (
      (await worker(session)?.approvalGrants()) ?? {
        grants: sessionApprovalGrants(cx.host.approvalGrants, session as HostSession),
      }
    )
  })
  ep.register('_agnes/v1/approvalGrants.revokeForSession', async (params, c) => {
    const { sessionId, grantId } = params as ApprovalGrantSessionRevokeParams
    requireOwner('approvalGrants.revokeForSession', sessionId, c)
    const { session } = cx.registry.require(sessionId)
    const revokedAt = new Date(c.clock()).toISOString()
    const remote = worker(session)
    const grant = remote
      ? await remote.revokeApprovalGrant(grantId, revokedAt)
      : await revokeSessionApprovalGrant(cx.host.approvalGrants, session as HostSession, grantId, revokedAt)
    if (!grant) throw rpcError('APPROVAL_REJECTED', { reason: 'grant unavailable' })
    return grant
  })
}
