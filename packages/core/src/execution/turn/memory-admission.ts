import { CoreError } from '@agnes/core-common/types'
import type { DecisionSnapshot, MemoryProposal } from '@agnes/extension-api'
import { type PermissionEffectAdmission, samePermissionContext } from '@agnes/protocol'
import type { SessionImpl } from '../../step/session.js'

/** One exact consumed answer may admit only its frozen file candidate during the live session epoch. */
export function memoryAdmission(
  s: SessionImpl,
  proposal: MemoryProposal,
  decision: DecisionSnapshot,
  deadline: string,
  signal: AbortSignal,
): PermissionEffectAdmission | undefined {
  const result = decision.result
  if (result?.reason !== 'answered' || result.code !== 'full-access') return undefined
  const context = s.permissionContext
  const binding = structuredClone(proposal)
  let revoked = false
  const assertActive = () => {
    const current = s.state.registers.decisionStates.get(decision.handle.id)?.value
    const subject = current?.request.spec.subject as Partial<MemoryProposal> | undefined
    if (
      revoked ||
      signal.aborted ||
      s.ac.signal.aborted ||
      s.closingOrClosed ||
      context.policy !== 'full-access' ||
      !samePermissionContext(context, s.permissionContext) ||
      result.authorization?.sessionId !== context.sessionId ||
      result.authorization.epoch !== context.epoch ||
      !Number.isFinite(Date.parse(deadline)) ||
      s.d.clock() >= Date.parse(deadline) ||
      !current?.consumption ||
      current.invalidation ||
      subject?.path !== binding.path ||
      subject.baseHash !== binding.baseHash ||
      subject.newHash !== binding.newHash ||
      subject.source?.sessionKey !== binding.source.sessionKey ||
      subject.source?.turn !== binding.source.turn ||
      subject.source?.toolUseId !== binding.source.toolUseId
    ) {
      revoked = true
      throw new CoreError('E_RELATION', 'MEMORY_AUTHORITY_REVOKED')
    }
  }
  return Object.freeze({ assertActive, verify: async () => assertActive() })
}
