import { hasDurableReservations } from '@agnes/core-child-control/child/store'
import type { Seq } from '@agnes/core-common/types'
import type { ModelRecord } from '@agnes/protocol'
import {
  reconcileTreeReservationHandle,
  releaseTreeReservationHandle,
  reserveTreeBudgetHandle,
  settleTreeSpendHandle,
  type TreeReservationHandle,
} from '../child/runtime-budget.js'
import type { SessionImpl } from '../step/session.js'

/** The input and output tokens all of a session's maintenance calls may spend together. */
export const MAINTENANCE_BUDGET_TOKENS = 65_536

/** The budget root every maintenance call of a session is held against, apart from any turn's. */
export const maintenanceRoot = (s: SessionImpl): string => `rsi:${s.key}`

/** Whether the storage can hold a durable reservation, which the maintenance root needs. */
export const maintenanceBudgetAvailable = (s: SessionImpl): boolean => hasDurableReservations(s.d.log.storage)

/**
 * Credits per token at the cheapest rate a call is billed at, from catalogue prices in credits per
 * million tokens: input and output, the two kinds every call spends. Undefined for a model with no
 * usable price; one priced at zero for either kind has no rate that bounds its tokens, so it counts
 * as unpriced. Cache reads are left out: a one-shot planner request does not read a cache.
 */
function cheapestRate(cost: ModelRecord['cost']): number | undefined {
  const { input, output } = cost
  if (![input, output].every((price) => Number.isFinite(price) && price >= 0)) return undefined
  const rate = Math.min(input, output) / 1_000_000
  return Number.isFinite(rate) && rate > 0 ? rate : undefined
}

/**
 * The cap of the maintenance root in credits: the token budget at the model's cheapest rate. Every
 * token costs at least that rate, so whatever the mix of input and output, the cap is spent before
 * the budget's token count is exceeded; a dear mix stops sooner. Undefined for an unpriced model, and
 * for a cap that rounds down to no microcredit, which the root could not hold.
 */
export function maintenanceCapCredits(
  record: ModelRecord,
  budgetTokens = MAINTENANCE_BUDGET_TOKENS,
): number | undefined {
  const rate = cheapestRate(record.cost)
  if (rate === undefined) return undefined
  const credits = budgetTokens * rate
  // Rounded down, the way the root's cap is: a cap that floors to zero cannot be created.
  return Number.isFinite(credits) && Math.floor(credits * 1_000_000) > 0 ? credits : undefined
}

export type MaintenanceHold =
  | { status: 'held'; handle: TreeReservationHandle }
  | { status: 'unbudgeted' }
  | { status: 'refused'; reason: 'budget' | 'unpriced' | 'unavailable' }

/**
 * Holds the call's conservative cost against the maintenance root. A priced model is always held,
 * whatever the session's own tree budget, so maintenance never draws on a turn's reservation. An
 * unpriced model is refused unless the caller already has the user's consent to an unknown price;
 * that call is recorded but not held.
 */
export async function holdMaintenance(
  s: SessionImpl,
  input: {
    record: ModelRecord
    effectId: string
    requestHash: string
    inputTokens: number
    maxOutputTokens: number
    projectedCredits: number | undefined
    budgetTokens: number
    allowUnpriced: boolean
  },
): Promise<MaintenanceHold> {
  const rootCredits = maintenanceCapCredits(input.record, input.budgetTokens)
  if (rootCredits === undefined || input.projectedCredits === undefined)
    return input.allowUnpriced ? { status: 'unbudgeted' } : { status: 'refused', reason: 'unpriced' }
  if (!maintenanceBudgetAvailable(s)) return { status: 'refused', reason: 'unavailable' }
  const reserved = await reserveTreeBudgetHandle(
    s,
    input.projectedCredits,
    { route: input.record.route, model: input.record.id },
    { effectId: input.effectId, requestHash: input.requestHash },
    input.inputTokens,
    { rootTaskId: maintenanceRoot(s), rootCredits, maxOutputTokens: input.maxOutputTokens },
  )
  return reserved.status === 'reserved'
    ? { status: 'held', handle: reserved.handle }
    : { status: 'refused', reason: 'budget' }
}

/** Gives a hold back for a call that was never sent. */
export async function releaseMaintenance(s: SessionImpl, hold: MaintenanceHold): Promise<void> {
  if (hold.status === 'held') await releaseTreeReservationHandle(s, hold.handle)
}

/**
 * Settles a hold against the cost row that recorded the spend. The row is already committed, so a
 * settlement that still fails after reconciling is logged, not thrown: the hold stays counted.
 */
export async function settleMaintenance(
  s: SessionImpl,
  hold: MaintenanceHold,
  credits: number | undefined,
  costSeq: Seq,
  source: 'gateway' | 'estimated',
): Promise<void> {
  if (hold.status !== 'held') return
  const creditSource = credits === undefined ? 'unknown' : source
  const settle = () => settleTreeSpendHandle(s, hold.handle, credits, costSeq, creditSource)
  try {
    await settle().catch(async (error: unknown) => {
      const reconciled = await reconcileTreeReservationHandle(s, hold.handle)
      if (reconciled.status === 'held') return settle()
      if (reconciled.status !== 'settled' && reconciled.status !== 'unknown') throw error
    })
  } catch (error) {
    s.d.logger.warn('maintenance budget settlement failed', { sessionKey: s.key, error: String(error) })
  }
}
