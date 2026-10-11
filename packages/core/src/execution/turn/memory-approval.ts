import { sha256Hex } from '@agnes/core-common/request/hash'
import { isPending } from '@agnes/core-effects/effects/approval-answer'
import type { MemoryApprovalResult, MemoryProposal, ToolMeta } from '@agnes/extension-api'
import { validateActor } from '@agnes/protocol'
import type { SessionImpl } from '../../step/session.js'

/** A file candidate has its own one-shot binding; full access and session grants cannot approve it. */
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
  const answer = await session.askApprovalAnswer(
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
  )
  // Pending leaves the request unanswered here rather than parking a mutation: the candidate was not committed and a later
  // tool invocation must review a fresh base. Do not resurrect a lost approval after restart.
  const human =
    !isPending(answer) &&
    answer.answeredBy &&
    validateActor(answer.answeredBy).ok &&
    answer.answeredBy.role !== 'agent'
  const validChoice = human && !isPending(answer) && ['allowed-once', 'rejected'].includes(answer.verdict)
  const verdict = validChoice ? answer.verdict : 'unavailable'
  const reason = isPending(answer)
    ? ('invalid-answer' as const)
    : answer.verdict === 'unavailable' || answer.verdict === 'cancelled'
      ? (answer.reason ?? (answer.verdict === 'cancelled' ? ('stopped' as const) : ('no-approver' as const)))
      : !validChoice &&
          answer.verdict === 'rejected' &&
          (answer.reason === 'policy_denied' || answer.reason === 'subagent_scope')
        ? answer.reason
        : ('invalid-answer' as const)
  await session.d.log.append([
    session.ev('approval/asked', asked),
    session.ev('approval/decided', {
      requestId: asked.requestId,
      verdict,
      via: 'sync',
      scope: asked.scope,
      ...(validChoice ? { answeredBy: answer.answeredBy } : {}),
      ...(!validChoice ? { reason } : {}),
    }),
  ])
  if (signal.aborted) return { status: 'unanswered', reason: 'stopped' }
  if (verdict === 'allowed-once') return { status: 'approved' }
  if (verdict === 'rejected') return { status: 'rejected' }
  return { status: 'unanswered', reason }
}
