import { type Host, type HostSession, revokeSessionApprovalGrant, sessionApprovalGrants } from '@agnes/host'

/** The session commands answered here rather than in the main command switch. */
export const GRANT_COMMANDS = { approvalGrants: true, revokeApprovalGrant: true } as const

/** The worker holds the session and the grant store, so it alone can say what is in force. */
export async function grantCommand(
  host: Pick<Host, 'approvalGrants'>,
  session: HostSession,
  cmd: { method: string; params: unknown },
): Promise<unknown> {
  if (cmd.method === 'approvalGrants') return { grants: sessionApprovalGrants(host.approvalGrants, session) }
  const { grantId, revokedAt } = cmd.params as { grantId: string; revokedAt: string }
  return revokeSessionApprovalGrant(host.approvalGrants, session, grantId, revokedAt)
}
