import type { OpStateObj } from '@agnes/core-common/step/op-state'
import type { EventInput } from '@agnes/core-common/types'
import { hookedAsk } from '../../step/approval-ask.js'
import {
  domainDecisionEvents,
  domainDecisionSource,
  requestDomainDecision,
} from '../../step/domain-decision.js'
import type { SessionImpl } from '../../step/session.js'

/**
 * What a reconciliation produced. `rows` commit with the unknown result and its settlement. `park`
 * is present only while the question is still open, so the turn stops on it. An answer that arrived
 * while the call was waiting is consumed in `rows` and named in `answer`, and the turn goes on.
 */
export type UnknownOutcomeReconciliation = Readonly<{
  rows: EventInput[]
  park?: EventInput
  answer?: 'happened' | 'not-happened'
}>

/** Shared human reconciliation, before the unknown result and settlement commit together. */
export async function unknownOutcomeRows(
  s: SessionImpl,
  toolUseId: string,
  name: string,
): Promise<UnknownOutcomeReconciliation> {
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
    const marker = s.ev('x/core/unknown-outcome', { toolUseId, waitEndedBy: 'stopped' }, { ignorable: true })
    return { rows: [marker], park: marker }
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
  // The payload describes "any request for human approval": this ask has no tool call behind it,
  // so `tool` names the approval's own kind and `argv` carries nothing.
  const { asked: finalAsked, rewrite } = await hookedAsk(s, asked.kind, null, asked)
  const decision = await requestDomainDecision(
    s,
    'unknown-outcome',
    toolUseId,
    {
      toolUseId,
      name,
      turn: op.meta.turn,
      step: op.step,
      risk: finalAsked.risk,
      ...(rewrite ? { rewrite } : {}),
    },
    {
      ...finalAsked,
      sessionKey: s.key,
      stepId: `${op.meta.turn}/${op.step}`,
      actor: s.d.actor,
      taint: op.taint || s.laneTaint(),
      scope: s.key,
    },
    s.ac.signal,
  ).catch(async (error) => {
    if (stopped()) return undefined
    throw error
  })
  if (!decision) return stoppedRows()
  const marker = s.ev(
    'x/core/unknown-outcome',
    { handle: decision.snapshot.handle, toolUseId },
    { ignorable: true },
  )
  const { snapshot } = decision
  if (snapshot.result?.reason === 'answered' && !snapshot.invalidation)
    return {
      rows: [marker, ...domainDecisionEvents(s, snapshot, decision.source)],
      answer: snapshot.result.response.option.startsWith('allowed') ? 'happened' : 'not-happened',
    }
  // Still open, or closed without an answer (deadline, no approver): the turn stops on the question.
  return { rows: [marker, ...(decision.park ? [decision.park] : [])], park: marker }
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

/**
 * Model-facing text for a mutation call whose outcome stays unknown. A deadline or a cancel is ours
 * and is named as such, so it is not mistaken for a lost transport and retried blindly.
 */
export function unknownOutcomeMessage(
  name: string,
  cause: 'timeout' | 'cancelled' | undefined,
  ms: number,
): string {
  if (!cause) return `the outcome of ${name} is unknown after dispatch`
  const why =
    cause === 'timeout'
      ? `exceeded the ${ms} ms limit for one call and was aborted`
      : 'was cancelled while running'
  return (
    `the outcome of ${name} is unknown: it ${why}, so it may have taken partial effect. ` +
    'Inspect the current state before retrying; do not rerun it unchanged.' +
    (cause === 'timeout'
      ? ' Split it into shorter steps, or run it in the background if the tool offers that.'
      : '')
  )
}

/** The person's answer to "did it happen?", for the model reading the unknown result. */
export function reconciledMessage(answer: 'happened' | 'not-happened' | undefined): string {
  if (answer === 'happened') return '. The user confirmed that it happened; do not run it again.'
  if (answer === 'not-happened')
    return '. The user confirmed that it did not happen; check the current state before trying again.'
  return ''
}

/**
 * Results for calls that never started, so none is left planned without an answer: by default the
 * calls a parked batch did not reach. `text` says why, for the model reading the result.
 */
export function notStartedResults(
  s: SessionImpl,
  calls: readonly { toolUseId: string; name: string; argsSeq: number }[],
  text = (name: string) =>
    `${name} was not run: the turn paused for a decision on an earlier call in the same batch`,
): EventInput[] {
  return calls.map((call) =>
    s.ev(
      'tool/result',
      {
        toolUseId: call.toolUseId,
        content: [{ type: 'text', text: text(call.name) }],
        isError: true,
        code: 'TOOL_NOT_STARTED',
        enforcement: s.d.runtime.enforcement(),
        authz: { decisionId: 'n/a' },
      },
      { sourceEventSeqs: [call.argsSeq] },
    ),
  )
}
