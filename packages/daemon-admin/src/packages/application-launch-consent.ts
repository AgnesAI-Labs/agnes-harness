import { createHash } from 'node:crypto'
import { type AgentPlan, type ApplicationState, jcs } from '@agnes/protocol'

/** A conservative coverage check, never a replacement for Host launch admission. */
export function applicationLaunchConsent(state: ApplicationState | undefined, plan: AgentPlan) {
  const selection = state?.selection
  const snapshot = selection?.consentSnapshot
  if (!selection || !snapshot) return 'unavailable'
  const { consentDigest, ...body } = snapshot
  if (
    consentDigest !== selection.consentDigest ||
    createHash('sha256').update(jcs(body)).digest('hex') !== consentDigest ||
    snapshot.packageId !== selection.packageId ||
    snapshot.integrity !== selection.integrity ||
    snapshot.declarationDigest !== selection.declarationDigest
  )
    return 'unavailable'
  const refs = new Set([
    ...(snapshot.declaration.agents ?? []),
    ...(snapshot.declaration.defaultAgent ? [snapshot.declaration.defaultAgent] : []),
    ...(snapshot.declaration.workbench?.actions ?? []).flatMap((action) =>
      action.agent ? [action.agent] : [],
    ),
  ])
  if (!refs.has(plan.ref)) return 'unavailable'
  if (state?.status !== 'active') return 'changed'
  const previous = snapshot.agentLaunches?.find(
    (value) => value !== null && typeof value === 'object' && !Array.isArray(value) && value.ref === plan.ref,
  )
  if (!previous) return 'unavailable'
  return jcs(previous) === jcs(plan) ? 'covered' : 'changed'
}

/** Explain the reason without exposing internal routes, hashes or export identifiers. */
export function applicationLaunchChanges(state: ApplicationState | undefined, plan: AgentPlan): string[] {
  if (state?.status !== 'active') return ['application']
  const previous = state.selection?.consentSnapshot?.agentLaunches?.find(
    (value) => value !== null && typeof value === 'object' && !Array.isArray(value) && value.ref === plan.ref,
  )
  if (!previous || typeof previous !== 'object' || Array.isArray(previous)) return ['application']
  const changes: string[] = []
  if (jcs(previous.sources) !== jcs(plan.sources)) changes.push('sources')
  if (jcs(previous.permission) !== jcs(plan.permission)) changes.push('permissions')
  if (!changes.length) changes.push('configuration')
  return changes
}
