import type { OpStateObj } from '@agnes/core-common/step/op-state'
import type { EventInput } from '@agnes/core-common/types'
import { decidedFields, isPending } from '@agnes/core-effects/effects/approval-answer'
import type { SessionImpl } from '../../step/session.js'

/** Shared human reconciliation, before the unknown result and settlement commit together. */
export async function unknownOutcomeRows(
  s: SessionImpl,
  toolUseId: string,
  name: string,
): Promise<EventInput[]> {
  const op = s.op() as OpStateObj
  const requestId = s.d.ids.requestId()
  const asked = {
    requestId,
    kind: 'unknown-outcome' as const,
    toolUseId,
    summary: `did ${name} happen? allowed = it happened, rejected = it did not`,
    risk: 'unknown' as const,
    bindingHash: '',
    deadline: new Date(s.d.clock() + s.preset.approval.timeoutMs).toISOString(),
  }
  // Same hook as the tool-approval path in tools.ts and the park path in gate.ts: the payload
  // describes "any request for human approval", not "only a tool approval" — this ask has no tool
  // call behind it either, so `tool` names the approval's own kind and `argv` carries nothing.
  // extension-api's ApprovalRequest risk enum has no 'unknown' member (the value this call site's
  // `asked.risk` actually carries), so it maps to 'always', exactly as gate.ts's park path does.
  const overridden = s.hooks.approvalRequest
    ? (
        await s.hooks.approvalRequest({
          request: {
            tool: asked.kind,
            argv: null,
            risk: 'always',
            actor: s.d.actor,
            summary: asked.summary,
          },
        })
      ).request
    : undefined
  const finalAsked = overridden
    ? {
        ...asked,
        risk: overridden.risk ?? asked.risk,
        ...(overridden.summary !== undefined ? { summary: overridden.summary } : {}),
      }
    : asked
  const answer = await s.askApprovalAnswer(
    {
      ...finalAsked,
      sessionKey: s.key,
      stepId: `${op.meta.turn}/${op.step}`,
      actor: s.d.actor,
      taint: op.taint || s.laneTaint(),
      scope: s.key,
      ...(overridden?.context !== undefined ? { context: overridden.context } : {}),
    },
    s.ac.signal,
  )
  const rows = isPending(answer)
    ? [s.ev('approval/asked', { ...finalAsked, pending: answer })]
    : [
        s.ev('approval/asked', finalAsked),
        s.ev('approval/decided', { requestId, ...decidedFields(answer), via: 'sync' }),
      ]
  return rows
}

/** Pending reconciliation was already recorded atomically with its uncertain result. */
export function unrecordedParkEvents(s: SessionImpl, events: EventInput[]): EventInput[] {
  return events.filter((event) => {
    if (event.type !== 'approval/asked') return true
    const requestId = (event.data as { requestId: string }).requestId
    return !s.state.pendingApprovals.has(requestId) && !s.state.decisions.get(requestId)?.askedSeq
  })
}
