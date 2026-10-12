import type { ApprovalRequest } from '@agnes/core-effects/effects/seams'
import type { JsonValue } from '@agnes/protocol'
import { deliverDecision } from './decision-delivery.js'
import type { DecisionSource } from './decisions.js'
import type { SessionImpl } from './session.js'

export function domainDecisionSource(s: SessionImpl, purpose: string, operationId: string): DecisionSource {
  return s.decisions.bindSource({
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
    responseSchema: { type: 'null' },
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
