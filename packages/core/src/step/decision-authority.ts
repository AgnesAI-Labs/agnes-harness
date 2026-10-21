import type { DecisionSpec } from '@agnes/extension-api'
import { isPermissionPurpose, validateActor } from '@agnes/protocol'
import type { DecisionAnswerContext, DecisionAuthority, DecisionSource } from './decisions.js'

/** A role may ask a person through Core's tool gate; plugin permission and signature gates stay refused. */
export function delegatedDecisionRefused(
  s: DecisionAuthority,
  source: DecisionSource,
  spec: DecisionSpec,
): boolean {
  return Boolean(
    s.refuseApprovals &&
      (source.permission || isPermissionPurpose(spec.purpose) || spec.purpose === 'business.confirm') &&
      !(
        s.delegatedToolApprovals !== false &&
        source.permission === true &&
        source.owner === 'core/tool-permission' &&
        source.sourcePackage === '@agnes/core' &&
        spec.purpose === 'tool.permission'
      ),
  )
}

export function humanDecisionActorAllowed(s: DecisionAuthority, context: DecisionAnswerContext): boolean {
  return (
    validateActor(context.actor).ok &&
    context.category === 'human' &&
    context.actor.role !== 'agent' &&
    !(s.refuseApprovals && context.actor.role === 'system')
  )
}
