import { AsyncLocalStorage } from 'node:async_hooks'
import { automaticPermissionDecision, type PermissionContext } from '@agnes/protocol'
import type { ApprovalRequest } from './prompter.js'

export type AutomaticPermissionEvidence = {
  requestId: string
  sessionKey: string
  toolUseId?: string
  scope: string
  summary: string
  bindingHash: string
  verdict: 'allowed-once'
  reason: 'full-access'
  answeredBy: import('@agnes/protocol').Actor
}
const scope = new AsyncLocalStorage<{
  context: PermissionContext
  record(evidence: AutomaticPermissionEvidence): unknown
}>()
export const currentPermissionContext = () => scope.getStore()?.context

/** Only authenticated worker dispatch installs this scope; public RPC and tool bodies cannot. */
export function withPermissionContext<T>(
  context: PermissionContext,
  record: (evidence: AutomaticPermissionEvidence) => unknown,
  work: () => T,
): T {
  return scope.run({ context, record }, work)
}
export async function automaticRequestDecision(req: ApprovalRequest) {
  const current = scope.getStore()
  const answer = automaticPermissionDecision(
    current?.context,
    req.tool?.name === 'exit_plan_mode'
      ? 'plan.exit'
      : req.kind === 'unknown-outcome'
        ? 'unknown-outcome'
        : 'permission',
    req.options,
  )
  if (!answer) return undefined
  await current?.record({
    requestId: req.requestId,
    sessionKey: req.sessionKey,
    ...(req.toolUseId ? { toolUseId: req.toolUseId } : {}),
    scope: req.scope,
    summary: req.summary,
    bindingHash: req.bindingHash,
    ...answer,
  })
  return answer
}
