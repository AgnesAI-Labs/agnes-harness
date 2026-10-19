import { sha256Hex } from '@agnes/core-common/request/hash'
import { isApprovalReason } from '@agnes/core-effects/effects/approval-answer'
import type { MemoryApprovalResult, MemoryProposal, ToolMeta } from '@agnes/extension-api'
import { domainDecisionSource, requestDomainDecision } from '../../step/domain-decision.js'
import type { SessionImpl } from '../../step/session.js'
import { memoryAdmission } from './memory-admission.js'

/** A file candidate has its own one-shot binding; session grants cannot approve it; the central full-access rule can. */
export async function approveMemoryFile(
  session: SessionImpl,
  proposal: MemoryProposal,
  tool: { name: string; meta: ToolMeta },
  step: number,
  signal: AbortSignal,
): Promise<MemoryApprovalResult> {
  const asked = {
    requestId: session.d.ids.requestId(),
    kind: 'tool' as const,
    ...(proposal.source.toolUseId ? { toolUseId: proposal.source.toolUseId } : {}),
    summary: 'Review memory file change',
    risk: 'always' as const,
    bindingHash: proposal.newHash,
    scope: `memory:${proposal.baseHash}:${proposal.newHash}`,
    approval: {
      reviewerRequirement: 'human' as const,
      grantConstraints: 'once' as const,
      subjectRevision: sha256Hex(`${proposal.baseHash}:${proposal.newHash}`),
    },
    options: ['allowed-once', 'rejected'] as Array<'allowed-once' | 'rejected'>,
    deadline: new Date(session.d.clock() + session.preset.approval.timeoutMs).toISOString(),
  }
  const operationId = `${proposal.source.toolUseId ?? proposal.source.turn}:${step}:${asked.approval.subjectRevision}`
  const decision = await requestDomainDecision(
    session,
    'memory',
    operationId,
    {
      path: proposal.path,
      baseHash: proposal.baseHash,
      newHash: proposal.newHash,
      source: { ...proposal.source },
      risk: 'always',
    },
    {
      ...asked,
      sessionKey: session.key,
      stepId: `${proposal.source.turn}/${step}`,
      tool: { ...tool, args: proposal },
      actor: session.d.actor,
      taint: true,
      context: proposal.diff,
    },
    signal,
  ).catch(async (error) => {
    if (signal.aborted) {
      const pending = [...session.state.registers.decisionStates.values()].find(
        ({ value }) => value.request.owner === 'core/memory' && value.request.operationId === operationId,
      )?.value
      if (pending)
        await session.decisions.withdraw(
          pending.handle,
          domainDecisionSource(session, 'memory', operationId),
          'stopped',
        )
      return undefined
    }
    throw error
  })
  if (!decision) return { status: 'unanswered', reason: 'stopped' }
  // A detached candidate cannot be committed later: another invocation reviews a fresh base.
  const result = decision.snapshot.result
  if (signal.aborted) {
    await session.decisions.withdraw(decision.snapshot.handle, decision.source, 'stopped')
    return { status: 'unanswered', reason: 'stopped' }
  }
  if (result?.reason === 'answered' && !decision.snapshot.invalidation) {
    const admission = memoryAdmission(session, proposal, decision.snapshot, asked.deadline, signal)
    await session.locked(async () => {
      await session.d.log.append(
        [
          ...session.decisions.consumptionEvents([decision.snapshot.handle], decision.source, null),
          session.ev(
            'x/core/decision-checkpoint',
            { handle: decision.snapshot.handle, operationId },
            { ignorable: true },
          ),
        ],
        {
          beforeCommit: () =>
            void session.decisions.consumptionEvents([decision.snapshot.handle], decision.source, null),
        },
      )
    })
    await admission?.verify()
    return result.response.option === 'allowed-once'
      ? { status: 'approved', ...(admission ? { admission } : {}) }
      : { status: 'rejected' }
  }
  const deliveryReason = (decision.park?.data as { waitEndedBy?: string } | undefined)?.waitEndedBy
  const code =
    result && result.reason !== 'answered'
      ? result.code
      : deliveryReason === 'detached'
        ? 'invalid-answer'
        : (deliveryReason ?? 'invalid-answer')
  await session.decisions.withdraw(decision.snapshot.handle, decision.source, code)
  return { status: 'unanswered', reason: isApprovalReason(code) ? code : 'invalid-answer' }
}
