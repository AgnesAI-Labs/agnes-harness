import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import type * as W from '@agnes/protocol/runtime'
import type { RefFacts, RefPorts } from './supervisor-ports.js'
import { refuse, sessionOf, until } from './supervisor-wire.js'

const sessionOk = (context: CallContext, sessionId: string) =>
  [null, sessionId].includes(sessionOf(context.scope))

export async function referenceActionReceipt(
  ports: RefPorts,
  input: unknown,
  context: CallContext,
): Promise<Outcome<W.SupervisorActionReceiptResult>> {
  if (!ports.read) return refuse('incompatible', 'supervisor_port_unavailable')
  const { scope } = context
  if (scope.kind !== 'run' && scope.kind !== 'action') return refuse('denied', 'supervisor_scope_run')
  const parentActionId = scope.kind === 'action' ? scope.actionId : null
  const reply = await until(
    ports.read.receipt(
      context,
      { runId: scope.runId, parentActionId },
      (input as W.SupervisorActionReceiptRequest).action,
      null,
    ),
    context,
    ports.clock,
  )
  if (!reply.ok) return reply
  const { actionId, receipt, visibility } = reply.value.result
  const consistent = {
    absent: actionId === null && receipt === null,
    pending: actionId !== null && receipt === null,
    ready: actionId !== null && receipt !== null && receipt.actionId === actionId,
  }[visibility]
  return consistent ? { ok: true, value: reply.value.result } : refuse('internal', 'supervisor_peer_mismatch')
}

function referencesOf(facts: RefFacts, runRef: W.RunRef): W.PublicRef[] {
  const byKey = new Map(facts.actions.map((row) => [row.key, row.actionId] as const))
  const out = new Map<string, W.PublicRef>()
  for (const clause of facts.wait?.anyOf ?? []) {
    const found: W.PublicRef[] =
      clause.kind === 'interaction'
        ? [{ kind: 'interaction', value: { interactionId: clause.interactionId } }]
        : clause.kind === 'actions'
          ? clause.actions.flatMap((ref) => {
              const actionId = 'existingActionId' in ref ? ref.existingActionId : byKey.get(ref.localKey)
              return actionId === undefined ? [] : [{ kind: 'action' as const, run: runRef, actionId }]
            })
          : []
    for (const ref of found) out.set(JSON.stringify(ref), ref)
  }
  return [...out.values()]
}

export async function referenceInspect(
  ports: RefPorts,
  input: unknown,
  context: CallContext,
): Promise<Outcome<W.SupervisorInspectResult>> {
  if (!ports.read) return refuse('incompatible', 'supervisor_port_unavailable')
  const { runRef } = input as W.SupervisorInspectRequest
  if (!sessionOk(context, runRef.session.sessionId)) return refuse('denied', 'supervisor_scope_session')
  const reply = await until(ports.read.run(context, runRef.runId, null), context, ports.clock)
  if (!reply.ok) return reply
  const facts = reply.value
  if (facts === null) return refuse('invalid_input', 'not_found')
  if (facts.runId !== runRef.runId || facts.sessionId !== runRef.session.sessionId)
    return refuse('internal', 'supervisor_peer_mismatch')
  const parked = ['blocked_incompatible', 'blocked_integrity', 'frozen', 'migrating'].includes(facts.state)
  const draining = ['failing', 'cancelling', 'draining'].includes(facts.state)
  const unresolved = facts.actions.some((row) => ['unknown', 'reconciling'].includes(row.state))
  return {
    ok: true,
    value: {
      status: facts.state,
      revision: facts.revision,
      waitingRefs: referencesOf(facts, runRef),
      blockedReason: parked ? facts.state : draining && unresolved ? 'unknown_effect' : null,
    },
  }
}

export async function referenceSessionParameters(
  ports: RefPorts,
  input: unknown,
  context: CallContext,
): Promise<Outcome<W.SupervisorSessionParametersResult>> {
  if (!ports.read) return refuse('incompatible', 'supervisor_port_unavailable')
  const { runRef } = input as W.SupervisorSessionParametersRequest
  if (!sessionOk(context, runRef.session.sessionId)) return refuse('denied', 'supervisor_scope_session')
  const reply = await until(ports.read.parameters(context, runRef.runId), context, ports.clock)
  if (!reply.ok) return reply
  return reply.value.value.sessionId === runRef.session.sessionId
    ? reply
    : refuse('internal', 'supervisor_peer_mismatch')
}
