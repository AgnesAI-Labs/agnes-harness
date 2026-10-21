import { requireChildControl } from '@agnes/core-child-control/child/store'
import { CoreError } from '@agnes/core-common/types'
import type { ApprovalRequest } from '@agnes/core-effects/effects/seams'
import type { DecisionSnapshot } from '@agnes/extension-api'
import type { SessionImpl } from '../step/session.js'

/** Delivery metadata never moves the decision, its consumption or the effect out of the child. */
export async function delegatedApprovalRequest(
  child: SessionImpl,
  decision: DecisionSnapshot,
  offered: ApprovalRequest,
): Promise<ApprovalRequest> {
  const role = child.roleAuthority
  if (
    !role ||
    decision.request.owner !== 'core/tool-permission' ||
    decision.request.sourcePackage !== '@agnes/core' ||
    decision.request.spec.purpose !== 'tool.permission'
  )
    return offered
  const store = requireChildControl(child.d.log.storage)
  let record = await store.lookupByKey(child.key)
  if (!record || record.parentKey !== role.parentKey)
    throw new CoreError('E_RELATION', 'Delegated approval parent binding is unavailable')
  const delegation = child.state.session?.delegation
  if (
    !delegation ||
    delegation.rootTaskId !== record.rootTaskId ||
    delegation.creationId !== record.creationId ||
    delegation.generationDepth !== record.generationDepth
  )
    throw new CoreError('E_RELATION', 'Delegated approval creation binding is invalid')
  const root = record.rootTaskId
  let parentKey = record.parentKey
  for (;;) {
    const ancestor = await store.lookupByKey(parentKey)
    if (!ancestor) break
    if (ancestor.rootTaskId !== root || ancestor.generationDepth >= record.generationDepth)
      throw new CoreError('E_RELATION', 'Delegated approval ancestry is invalid')
    record = ancestor
    parentKey = ancestor.parentKey
  }
  const reason =
    role.parentTainted !== false || offered.taint
      ? 'Untrusted evidence (taint)'
      : (offered.context ?? offered.summary)
  return {
    ...offered,
    sessionKey: parentKey,
    delegation: { role: role.role.ref, childSessionKey: child.key, parentSessionKey: role.parentKey, reason },
    summary: `Role ${role.role.ref} · child ${child.key} · ${offered.summary} · ${reason}`,
    options: ['allowed-once', 'rejected'],
  }
}
