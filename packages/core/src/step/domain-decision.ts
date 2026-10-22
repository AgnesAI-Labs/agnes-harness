import { CoreError } from '@agnes/core-common/types'
import { APPROVAL_RESPONSE_SCHEMA } from '@agnes/core-effects/effects/approval-answer'
import type { ApprovalRequest } from '@agnes/core-effects/effects/seams'
import type { DecisionSnapshot } from '@agnes/extension-api'
import type { JsonValue } from '@agnes/protocol'
import { deliverDecision } from './decision-delivery.js'
import type { DecisionSource } from './decisions.js'
import type { SessionImpl } from './session.js'

export function domainDecisionSource(s: SessionImpl, purpose: string, operationId: string): DecisionSource {
  return s.decisions.bindSource({
    permission: true,
    owner: `core/${purpose}`,
    operationId,
    sourcePackage: '@agnes/core',
    packageVersion: s.d.agnesVersion ?? '0.0.0',
    alive() {
      s.ac.signal.throwIfAborted()
    },
  })
}

/** Domain subjects are immutable facts; approval delivery never owns their durable state. */
export async function requestDomainDecision(
  s: SessionImpl,
  purpose: string,
  operationId: string,
  subject: JsonValue,
  offered: ApprovalRequest,
  signal: AbortSignal = s.ac.signal,
) {
  const source = domainDecisionSource(s, purpose, operationId)
  const handle = await s.decisions.port(source).request({
    key: operationId,
    purpose,
    subject,
    prompt: offered.summary,
    options: offered.options ?? ['allowed-once', 'allowed-session', 'rejected'],
    responseSchema: APPROVAL_RESPONSE_SCHEMA,
  })
  const delivered = await deliverDecision(
    s,
    await s.decisions.get(handle, source),
    offered,
    signal,
    source.alive,
  )
  return { ...delivered, source }
}

/** The caller appends this acknowledgement beside the domain's own phase edge. */
export function domainDecisionEvents(s: SessionImpl, snapshot: DecisionSnapshot, source: DecisionSource) {
  if (snapshot.result?.reason !== 'answered' || snapshot.invalidation || snapshot.consumption) return []
  return [
    ...s.decisions.consumptionEvents([snapshot.handle], source, null),
    s.ev(
      'x/core/decision-checkpoint',
      { handle: snapshot.handle, operationId: source.operationId },
      { ignorable: true },
    ),
  ]
}

/** Retired verifier decisions cannot be restored as current authorization or rewritten on resume. */
export function assertCurrentDomainDecisions(s: SessionImpl): void {
  for (const { value } of s.state.registers.decisionStates.values())
    if (value.request.owner === 'core/gate' && value.request.sourcePackage === '@agnes/core')
      throw new CoreError(
        'E_RELATION',
        'Retired verifier manual-approval format; select a new, empty AGH_HOME (clean home).',
        { reason: 'clean-home-required' },
      )
}
