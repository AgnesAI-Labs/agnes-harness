import { isPending } from '@agnes/core-effects/effects/approval-answer'
import type { MemoryProposal, ToolMeta } from '@agnes/extension-api'
import type { SessionImpl } from '../../step/session.js'

/** A file candidate has its own one-shot binding; full access and session grants cannot approve it. */
export async function approveMemoryFile(
  session: SessionImpl,
  proposal: MemoryProposal,
  tool: { name: string; meta: ToolMeta },
  step: number,
  signal: AbortSignal,
): Promise<boolean> {
  const asked = {
    requestId: session.d.ids.requestId(),
    kind: 'tool' as const,
    ...(proposal.source.toolUseId ? { toolUseId: proposal.source.toolUseId } : {}),
    summary: 'Review memory file change',
    risk: 'always' as const,
    bindingHash: proposal.newHash,
    scope: `memory:${proposal.baseHash}:${proposal.newHash}`,
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
  const verdict = isPending(answer) ? 'unavailable' : answer.verdict
  await session.d.log.append([
    session.ev('approval/asked', asked),
    session.ev('approval/decided', {
      requestId: asked.requestId,
      verdict,
      via: 'sync',
      scope: asked.scope,
      ...(!isPending(answer) && answer.answeredBy ? { answeredBy: answer.answeredBy } : {}),
      ...(isPending(answer)
        ? { reason: 'invalid-answer' as const }
        : answer.reason
          ? { reason: answer.reason }
          : {}),
    }),
  ])
  return !signal.aborted && verdict === 'allowed-once'
}
