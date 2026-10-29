import type { DecisionSpec } from '@agnes/extension-api'
import { automaticPermissionDecision, isPermissionPurpose, validateActor } from '@agnes/protocol'
import type { DecisionAnswerContext, DecisionAuthority, DecisionSource } from './decisions.js'

/** Core's own tool gate: the only request a declaring role answers automatically under full access. */
export function coreToolPermission(
  permission: boolean,
  origin: { readonly owner: string; readonly sourcePackage: string },
  spec: DecisionSpec,
): boolean {
  return (
    permission &&
    origin.owner === 'core/tool-permission' &&
    origin.sourcePackage === '@agnes/core' &&
    spec.purpose === 'tool.permission'
  )
}

/** The automatic full-access answer, if any: open to a main session, and to a declaring role for core tool gates only. */
export function automaticAnswer(
  s: DecisionAuthority,
  spec: DecisionSpec,
  permission: boolean,
  origin: { readonly owner: string; readonly sourcePackage: string },
) {
  if (s.refuseApprovals && !(s.delegatedFullAccess === true && coreToolPermission(permission, origin, spec)))
    return undefined
  return automaticPermissionDecision(
    s.permissionContext,
    spec.purpose,
    spec.options,
    permission ? 'permission' : 'question',
    spec.presentation,
  )
}

/** A role may ask a person through Core's tool gate; plugin permission and signature gates stay refused. */
export function delegatedDecisionRefused(
  s: DecisionAuthority,
  source: DecisionSource,
  spec: DecisionSpec,
): boolean {
  return Boolean(
    s.refuseApprovals &&
      (source.permission || isPermissionPurpose(spec.purpose) || spec.purpose === 'business.confirm') &&
      !(s.delegatedToolApprovals !== false && coreToolPermission(source.permission === true, source, spec)),
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
