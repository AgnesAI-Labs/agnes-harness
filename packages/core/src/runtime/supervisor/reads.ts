import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import type * as W from '@agnes/protocol/runtime'
import { sessionIdOf } from './keys.js'
import type { MethodEntry, RunFacts, SupervisorDeployment } from './ports.js'
import { fail, race } from './wire.js'

const outside = () => fail('denied', 'supervisor_scope_session')
const mismatch = () => fail('internal', 'supervisor_peer_mismatch')
const sameSession = (context: CallContext, sessionId: string) => {
  const own = sessionIdOf(context.scope)
  return own === null || own === sessionId
}

/** The caller's identity, not the request, names the namespace a localKey lives in. */
export async function actionReceipt(
  deployment: SupervisorDeployment,
  input: unknown,
  context: CallContext,
): Promise<Outcome<W.SupervisorActionReceiptResult>> {
  const read = deployment.read
  if (!read) return fail('incompatible', 'supervisor_port_unavailable')
  const request = input as W.SupervisorActionReceiptRequest
  const scope = context.scope
  if (scope.kind !== 'run' && scope.kind !== 'action') return fail('denied', 'supervisor_scope_run')
  const namespace = { runId: scope.runId, parentActionId: scope.kind === 'action' ? scope.actionId : null }
  const reply = await race(read.receipt(context, namespace, request.action, null), context, deployment.clock)
  if (!reply.ok) return reply
  const { actionId, receipt, visibility } = reply.value.result
  const shaped =
    visibility === 'absent'
      ? actionId === null && receipt === null
      : visibility === 'pending'
        ? actionId !== null && receipt === null
        : actionId !== null && receipt !== null && receipt.actionId === actionId
  return shaped ? { ok: true, value: reply.value.result } : mismatch()
}

function waitingRefs(facts: RunFacts, runRef: W.RunRef): W.PublicRef[] {
  if (!facts.wait) return []
  const idByKey = new Map(facts.actions.map((row) => [row.key, row.actionId] as const))
  const refs: W.PublicRef[] = []
  const seen = new Set<string>()
  const push = (ref: W.PublicRef) => {
    const id = JSON.stringify(ref)
    if (!seen.has(id)) {
      seen.add(id)
      refs.push(ref)
    }
  }
  for (const clause of facts.wait.anyOf) {
    if (clause.kind === 'actions')
      for (const ref of clause.actions) {
        const actionId = 'existingActionId' in ref ? ref.existingActionId : idByKey.get(ref.localKey)
        if (actionId !== undefined) push({ kind: 'action', run: runRef, actionId })
      }
    else if (clause.kind === 'interaction')
      push({ kind: 'interaction', value: { interactionId: clause.interactionId } })
  }
  return refs
}

/** A private vocabulary: the contract only says `string | null`. Never a guess about a healthy run. */
function blockedReason(facts: RunFacts): string | null {
  if (['blocked_incompatible', 'blocked_integrity', 'frozen', 'migrating'].includes(facts.state))
    return facts.state
  const draining = ['failing', 'cancelling', 'draining'].includes(facts.state)
  return draining && facts.actions.some((row) => row.state === 'unknown' || row.state === 'reconciling')
    ? 'unknown_effect'
    : null
}

export async function inspect(
  deployment: SupervisorDeployment,
  input: unknown,
  context: CallContext,
): Promise<Outcome<W.SupervisorInspectResult>> {
  const read = deployment.read
  if (!read) return fail('incompatible', 'supervisor_port_unavailable')
  const { runRef } = input as W.SupervisorInspectRequest
  if (!sameSession(context, runRef.session.sessionId)) return outside()
  const reply = await race(read.run(context, runRef.runId, null), context, deployment.clock)
  if (!reply.ok) return reply
  const facts = reply.value
  // Absent and outside-the-window look the same on purpose.
  if (!facts) return fail('invalid_input', 'not_found')
  if (facts.runId !== runRef.runId || facts.sessionId !== runRef.session.sessionId) return mismatch()
  return {
    ok: true,
    value: {
      status: facts.state,
      revision: facts.revision,
      waitingRefs: waitingRefs(facts, runRef),
      blockedReason: blockedReason(facts),
    },
  }
}

export async function sessionParameters(
  deployment: SupervisorDeployment,
  input: unknown,
  context: CallContext,
): Promise<Outcome<W.SupervisorSessionParametersResult>> {
  const read = deployment.read
  if (!read) return fail('incompatible', 'supervisor_port_unavailable')
  const { runRef } = input as W.SupervisorSessionParametersRequest
  if (!sameSession(context, runRef.session.sessionId)) return outside()
  const reply = await race(read.parameters(context, runRef.runId), context, deployment.clock)
  if (!reply.ok) return reply
  return reply.value.value.sessionId === runRef.session.sessionId ? reply : mismatch()
}

/** sessionParameters is not served yet: State exposes no parameters(runId) read, so it refuses by name until it does. */
export const readMethods = {
  actionReceipt: { needs: ['read'], run: actionReceipt },
  inspect: { needs: ['read'], run: inspect },
} satisfies Record<string, MethodEntry>
