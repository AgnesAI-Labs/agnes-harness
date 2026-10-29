import { listSessionGrants, revokeSessionGrant } from '@agnes/core'
import type { SessionApprovalGrant } from '@agnes/protocol'
import type { HostSession } from '../lifecycle/host.js'
import type { ApprovalGrantStore } from './grants.js'

const holderOf = (session: HostSession) => {
  const policyDigest = session.d.policyDigest
  return typeof policyDigest === 'string' && /^sha256-[a-f0-9]{64}$/.test(policyDigest)
    ? { policyDigest, actorId: session.d.actor.id, actorOrg: session.d.actor.org }
    : undefined
}

/**
 * Every allowance that lets this session's tools run without asking: the "this session" answers
 * still in force, then the "always" grants its actor holds under its policy. The actor and policy
 * are the session's own, which is what Core matches a grant against.
 */
export function sessionApprovalGrants(
  store: ApprovalGrantStore,
  session: HostSession,
): SessionApprovalGrant[] {
  const holder = holderOf(session)
  return [
    ...listSessionGrants(session).map((grant) => ({ ...grant, lifetime: 'session' as const })),
    ...(holder ? store.listHolder(holder) : []).map((grant) => ({
      grantId: grant.grantId,
      lifetime: 'always' as const,
      toolId: grant.toolId,
      scope: grant.scope,
      policyVersion: grant.policyVersion,
      createdAt: grant.createdAt,
      issuer: grant.issuer,
    })),
  ]
}

/** Revokes one of the grants listed above; null when it is not one of them or is already gone. */
export async function revokeSessionApprovalGrant(
  store: ApprovalGrantStore,
  session: HostSession,
  grantId: string,
  revokedAt: string,
): Promise<SessionApprovalGrant | null> {
  const target = sessionApprovalGrants(store, session).find((grant) => grant.grantId === grantId)
  const holder = holderOf(session)
  if (!target) return null
  if (target.lifetime === 'session') {
    if (!(await revokeSessionGrant(session, grantId))) return null
  } else if (
    !holder ||
    !target.policyVersion ||
    !store.revoke(
      { ...holder, toolId: target.toolId, scope: target.scope, policyVersion: target.policyVersion },
      grantId,
      revokedAt,
    )
  )
    return null
  return { ...target, revokedAt }
}
