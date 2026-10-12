import type { OpStateObj } from '@agnes/core-common/step/op-state'
import type { EventInput } from '@agnes/core-common/types'
import { domainDecisionSource, requestDomainDecision } from '../../step/domain-decision.js'
import type { SessionImpl } from '../../step/session.js'

/** Shared human reconciliation, before the unknown result and settlement commit together. */
export async function unknownOutcomeRows(
  s: SessionImpl,
  toolUseId: string,
  name: string,
): Promise<EventInput[]> {
  const stopped = () =>
    s.op()?.control.status === 'cancel_requested' || s.ac.signal.aborted || s.decisions.scopeRevoked
  const stoppedRows = async () => {
    const value = [...s.state.registers.decisionStates.values()].find(
      ({ value }) =>
        value.request.owner === 'core/unknown-outcome' && value.request.operationId === toolUseId,
    )?.value
    if (value)
      await s.decisions.withdraw(
        value.handle,
        domainDecisionSource(s, 'unknown-outcome', toolUseId),
        'stopped',
      )
    return [s.ev('x/core/unknown-outcome', { toolUseId, waitEndedBy: 'stopped' }, { ignorable: true })]
  }
  if (stopped()) return stoppedRows()
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
  const decision = await requestDomainDecision(
    s,
    'unknown-outcome',
    toolUseId,
    { toolUseId, name, turn: op.meta.turn, step: op.step, risk: finalAsked.risk },
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
  ).catch(async (error) => {
    if (stopped()) return undefined
    throw error
  })
  if (!decision) return stoppedRows()
  return [
    s.ev('x/core/unknown-outcome', { handle: decision.snapshot.handle, toolUseId }, { ignorable: true }),
    ...(decision.park ? [decision.park] : []),
  ]
}

/** Delivery markers can already be recorded beside an uncertain result. */
export function unrecordedParkEvents(s: SessionImpl, events: EventInput[]): EventInput[] {
  return events.filter(
    (event) =>
      event.type !== 'x/core/unknown-outcome' &&
      (event.type !== 'x/core/decision-delivery' ||
        s.state.registers.decisionStates.get((event.data as { handle: { id: string } }).handle.id)?.value
          .request.spec.purpose !== 'unknown-outcome'),
  )
}
