import { MAINTENANCE_LANE } from '@agnes/core-ledger/reduce/state'
import { isChildSession } from '../step/child-session.js'
import type { SessionImpl } from '../step/session.js'
import { MAINTENANCE_BUDGET_TOKENS, maintenanceBudgetAvailable } from './budget.js'
import {
  invokeMaintenance,
  type MaintenanceReason,
  type MaintenanceRequest,
  type MaintenanceResult,
} from './execute.js'

export type {
  MaintenanceMessage,
  MaintenanceReason,
  MaintenanceRequest,
  MaintenanceResult,
  MaintenanceUsage,
} from './execute.js'
export { MAINTENANCE_LANE }

/**
 * Core's background model call for session maintenance such as refinement planning. Internal to
 * Core: the host and plugins reach it only through the managed facade, never as an extension API.
 */
export type MaintenancePort = Readonly<{
  /**
   * Sends one call for the run `runId` on the refinement lane: an intent, the call through the
   * model adapter, then one commit of cost, settlement and result. It needs no open turn and runs
   * while the session is paused. A run sends at most one call; a retry is a new run id.
   */
  invoke(req: MaintenanceRequest, signal: AbortSignal): Promise<MaintenanceResult>
}>

/**
 * Why the session cannot start maintenance at all, or undefined when it can. A child session never
 * starts maintenance: a delegated child, a role child, or a fork. A storage without durable budget
 * reservations cannot hold the maintenance root, so it is unavailable for every priced call, automatic
 * or manual; the one call that still runs there is an unpriced manual call the user agreed to leave
 * unbudgeted (`allowUnpriced`), which is never held anyway.
 */
export function maintenanceUnavailable(s: SessionImpl): 'child-session' | 'unavailable' | undefined {
  if (isChildSession(s)) return 'child-session'
  if (!maintenanceBudgetAvailable(s)) return 'unavailable'
  return undefined
}

export function createMaintenancePort(s: SessionImpl, opts: { budgetTokens?: number } = {}): MaintenancePort {
  const budgetTokens = opts.budgetTokens ?? MAINTENANCE_BUDGET_TOKENS
  const unavailable = (req: MaintenanceRequest): MaintenanceReason | undefined => {
    const why = maintenanceUnavailable(s)
    return why === 'unavailable' && req.allowUnpriced === true ? undefined : why
  }
  return Object.freeze({
    invoke: (req: MaintenanceRequest, signal: AbortSignal) =>
      invokeMaintenance(s, req, signal, budgetTokens, () => unavailable(req)),
  })
}
