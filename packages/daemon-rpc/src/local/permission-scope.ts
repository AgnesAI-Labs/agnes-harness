import { AsyncLocalStorage } from 'node:async_hooks'
import {
  automaticPermissionDecision,
  type PermissionContext,
  permissionEffectAdmission,
  samePermissionContext,
} from '@agnes/protocol'
import type { ApprovalRequest } from './prompter.js'

export type AutomaticPermissionEvidence = {
  requestId: string
  stepId: string
  policyBinding?: string
  profileHash?: string
  sessionKey: string
  sessionId: string
  epoch: number
  toolUseId?: string
  scope: string
  summary: string
  bindingHash: string
  deadline: string
  at: string
  consumption: 'authorized' | 'consumed' | 'revoked'
  verdict: 'allowed-once'
  reason: 'full-access'
  answeredBy: import('@agnes/protocol').Actor
}
type PermissionScope = {
  context: PermissionContext
  record(evidence: AutomaticPermissionEvidence): unknown
  verify(): Promise<PermissionContext | undefined>
  current?: (() => PermissionContext | undefined) | undefined
  grants: Map<string, AutomaticPermissionEvidence>
}
const scope = new AsyncLocalStorage<PermissionScope>()
export const currentPermissionContext = () => {
  const context = scope.getStore()?.context
  return context ? structuredClone(context) : undefined
}

/** Installed only by backend composition. Missing identity is never an automatic grant. */
export function withPermissionContext<T>(
  context: PermissionContext,
  record: (evidence: AutomaticPermissionEvidence) => unknown,
  work: () => T,
  verify: () => Promise<PermissionContext | undefined>,
  current?: () => PermissionContext | undefined,
): T {
  const owned = structuredClone(context)
  return scope.run({ context: owned, record, verify, current, grants: new Map() }, work)
}
export async function assertCurrentPermission(): Promise<void> {
  const current = scope.getStore()
  if (!current || current.context.policy !== 'full-access') return
  const context = current.context
  if (
    !context.sessionId ||
    !context.sessionKey ||
    !Number.isSafeInteger(context.epoch) ||
    !samePermissionContext(context, await current.verify())
  )
    throw Object.assign(new Error('Permission authority revoked'), { code: 'E_PERMISSION_REVOKED' })
}
export async function assertPermissionBinding(
  binding: { scope: string; bindingHash: string; sessionKey: string },
  clock: () => number = Date.now,
  consumption: AutomaticPermissionEvidence['consumption'] = 'consumed',
) {
  const current = scope.getStore()
  await assertCurrentPermission()
  const grant = [...(current?.grants.values() ?? [])].find(
    (row) =>
      row.consumption === consumption &&
      row.scope === binding.scope &&
      row.bindingHash === binding.bindingHash &&
      row.sessionKey === binding.sessionKey,
  )
  if (!grant || clock() >= Date.parse(grant.deadline))
    throw new PermissionGrantUnavailable('Permission grant unavailable or expired')
}

export class PermissionGrantUnavailable extends Error {
  readonly code = 'E_PERMISSION_GRANT_UNAVAILABLE'
}

/** A backend-owned consumed grant retained across a background task's entire lifetime. */
export async function acquirePermissionLease(
  binding: { scope: string; bindingHash: string; sessionKey: string },
  signal: AbortSignal,
) {
  const current = scope.getStore()
  if (!current || current.context.policy !== 'full-access') return undefined
  const grant = [...current.grants.values()].find(
    (row) =>
      row.consumption === 'consumed' &&
      row.scope === binding.scope &&
      row.bindingHash === binding.bindingHash &&
      row.sessionKey === binding.sessionKey,
  )
  const admission = permissionEffectAdmission({
    signals: [signal],
    expiresAt: Date.parse(grant?.deadline ?? ''),
    unavailable: () => new PermissionGrantUnavailable('Permission grant unavailable or expired'),
    assertBound: () => {
      if (
        !grant ||
        !samePermissionContext(current.context, current.current?.()) ||
        current.grants.get(grant.requestId) !== grant ||
        grant.sessionId !== current.context.sessionId ||
        grant.epoch !== current.context.epoch
      )
        throw new PermissionGrantUnavailable('Permission grant unavailable or expired')
    },
    verify: async () => {
      try {
        if (!samePermissionContext(current.context, await current.verify()))
          throw new PermissionGrantUnavailable('Permission authority revoked')
      } catch (error) {
        throw error instanceof PermissionGrantUnavailable
          ? error
          : new PermissionGrantUnavailable('Permission authority unavailable')
      }
    },
  })
  await admission.verify()
  return admission
}
export async function automaticRequestDecision(req: ApprovalRequest) {
  const current = scope.getStore()
  if (!current || req.sessionKey !== current.context.sessionKey || !current.context.sessionId)
    return undefined
  // The private Prompter entry owns kind; unknown-outcome and mode choices are questions.
  const purpose =
    req.tool?.name === 'exit_plan_mode' ? 'plan.exit' : req.kind === 'tool' ? 'permission' : req.kind
  const answer = automaticPermissionDecision(current.context, purpose, req.options)
  if (!answer) return undefined
  await assertCurrentPermission()
  if (current.grants.has(req.requestId))
    throw new PermissionGrantUnavailable('Permission grant already issued')
  const evidence: AutomaticPermissionEvidence = {
    requestId: req.requestId,
    stepId: req.stepId,
    ...(req.policyBinding ? { policyBinding: req.policyBinding } : {}),
    ...(req.profileHash ? { profileHash: req.profileHash } : {}),
    sessionKey: req.sessionKey,
    sessionId: current.context.sessionId,
    epoch: current.context.epoch,
    ...(req.toolUseId ? { toolUseId: req.toolUseId } : {}),
    scope: req.scope,
    summary: 'Permission auto-allowed',
    bindingHash: req.bindingHash,
    deadline: req.deadline,
    at: new Date().toISOString(),
    consumption: 'authorized',
    ...answer,
  }
  await current.record(evidence)
  try {
    await assertCurrentPermission()
  } catch (error) {
    await current.record({ ...evidence, at: new Date().toISOString(), consumption: 'revoked' })
    throw error
  }
  current.grants.set(req.requestId, evidence)
  return answer
}
/** Consumption means releasing this exact once-only answer to its effect admission site. */
export async function completeAutomaticDecision(req: ApprovalRequest, clock: () => number): Promise<void> {
  const current = scope.getStore(),
    grant = current?.grants.get(req.requestId)
  if (!current || !grant) throw new PermissionGrantUnavailable('Permission grant unavailable')
  await assertPermissionBinding(req, clock, 'authorized')
  const consumed = { ...grant, at: new Date().toISOString(), consumption: 'consumed' as const }
  await current.record(consumed)
  try {
    await assertCurrentPermission()
  } catch (error) {
    const revoked = { ...grant, at: new Date().toISOString(), consumption: 'revoked' as const }
    current.grants.set(req.requestId, revoked)
    await current.record(revoked)
    throw error
  }
  current.grants.set(req.requestId, consumed)
}
