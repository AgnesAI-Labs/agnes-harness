import type { Event, Seq } from '@agnes/core-common/types'
import type {
  Billing,
  ModelRecord,
  ModelSettings,
  SessionStart,
  ThinkingLevel,
  UsageView,
} from '@agnes/protocol'
import { contextAnchorOf } from '../reduce/anchor.js'
import type { CostLedger } from '../reduce/shapes.js'
import { applyCacheHealthEvent, cacheHealthView, initialCacheHealthState } from './cache-health.js'
import { computeSurface } from './surface.js'

export type UsageProjectionInput = {
  events: Iterable<Event>
  upto: Seq
  lane: string
  /** Further lanes whose spend counts toward the session, such as background maintenance. */
  lanes?: readonly string[]
  route: string
  model: Pick<ModelRecord, 'id' | 'contextWindow'> & Partial<Pick<ModelRecord, 'maxTokens'>>
  thinking: ThinkingLevel
  settings?: ModelSettings
  contextTokens: number
  autoCompact: boolean
  compactAt?: number
}

/** Estimates context at the same bounded cut as a UI projection, without mutable session state. */
export function contextTokensAtCut(events: Iterable<Event>, lane: string, upto: Seq): number {
  const prefix = [...events].filter((event) => event.seq <= upto)
  let last: { seq: Seq; total: number } | undefined
  for (const event of prefix) {
    if ((event.lane ?? 'main') !== lane) continue
    const start = event.type === 'session/start' ? (event.data as unknown as SessionStart) : undefined
    if (start?.parent && start.delegation?.kind === 'spawn') last = undefined
    last = contextAnchorOf(event) ?? last
  }
  let total = last?.total ?? 0
  for (const node of computeSurface(prefix, { lane })) {
    if (last && node.seq <= last.seq) continue
    const content = (node.event.data as { content?: Array<{ text?: string }> } | null)?.content ?? []
    for (const block of content) total += Math.ceil((block.text ?? '').length / 4)
  }
  return total
}

const emptyTotals = (): UsageView['totals'] => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
})

/** One lane's share of the session's spend: its tokens, and its credits when any row named them. */
export type UsageTotals = UsageView['totals'] & { credits?: number }

/** Adds one first-seen cost row to its lane's share; an adjustment moves only the credits. */
export function addLaneShare(
  byLane: Map<string, UsageTotals>,
  lane: string,
  row: Pick<CostLedger, 'tokens' | 'credits' | 'adjustment'>,
): void {
  const share: UsageTotals = byLane.get(lane) ?? emptyTotals()
  byLane.set(lane, share)
  if (row.adjustment) {
    if (share.credits !== undefined) share.credits += row.adjustment.delta
    return
  }
  if (row.credits !== undefined) share.credits = (share.credits ?? 0) + row.credits
  share.input += row.tokens.input
  share.output += row.tokens.output
  share.cacheRead += row.tokens.cacheRead
  share.cacheWrite += row.tokens.cacheWrite
  share.reasoning += row.tokens.reasoning ?? 0
}

/** The per-lane breakdown of a view, given only once a lane other than `lane` has spent anything. */
export function laneShares(
  byLane: ReadonlyMap<string, UsageTotals>,
  lane: string,
): Pick<UsageView, 'byLane'> {
  if (![...byLane.keys()].some((other) => other !== lane)) return {}
  return {
    byLane: Object.fromEntries(
      [...byLane].map(([name, share]) => [
        name,
        share.credits === undefined ? { ...share } : { ...share, credits: Math.max(0, share.credits) },
      ]),
    ),
  }
}

/**
 * Projects one bounded lane without consulting a provider or mutable session state. Credits and
 * dollars remain separate dimensions: only an explicit billing record can create a dollar total.
 * The spend of `lanes` counts toward the totals too, and once one of them has spent anything the
 * view breaks the totals down by lane; the context, the model and the cache stay the main lane's.
 */
export function projectUsage(input: UsageProjectionInput): UsageView {
  const counted = new Set([input.lane, ...(input.lanes ?? [])])
  const byLane = new Map<string, UsageTotals>()
  const totals = emptyTotals()
  const seen = new Set<string>()
  let usdMicros = 0
  let credits = 0
  let hasCredits = false
  let creditsComplete = true
  let creditsGateway = true
  let hasBilling = false
  let reasoningComplete = true
  let incompleteBilling = false
  let allGateway = true
  let allSubscription = true
  let forkBoundary: Seq | undefined
  let cacheHealth = initialCacheHealthState()

  for (const event of input.events) {
    if (event.seq > input.upto) continue
    cacheHealth = applyCacheHealthEvent(cacheHealth, event, input.lane)
    if (event.type === 'session/start' && (event.data as { parent?: { boundarySeq?: Seq } } | null)?.parent) {
      forkBoundary = (event.data as { parent: { boundarySeq: Seq } }).parent.boundarySeq
      Object.assign(totals, emptyTotals())
      byLane.clear()
      seen.clear()
      usdMicros = 0
      credits = 0
      hasCredits = false
      creditsComplete = true
      creditsGateway = true
      hasBilling = false
      reasoningComplete = true
      incompleteBilling = false
      allGateway = true
      allSubscription = true
      continue
    }
    const lane = event.lane ?? 'main'
    if (!counted.has(lane)) continue
    if (event.type !== 'cost/ledger') continue
    const row = event.data as CostLedger
    if (seen.has(row.effectId)) continue
    seen.add(row.effectId)
    if (!row.adjustment || forkBoundary === undefined || row.adjustment.of > forkBoundary)
      addLaneShare(byLane, lane, row)
    if (row.adjustment) {
      if (forkBoundary !== undefined && row.adjustment.of <= forkBoundary) continue
      if (hasCredits) credits += row.adjustment.delta
      if (hasBilling && row.adjustment.usdMicrosDelta !== undefined)
        usdMicros += row.adjustment.usdMicrosDelta
      continue
    }
    if (row.credits !== undefined) {
      hasCredits = true
      credits += row.credits
      creditsGateway &&= row.creditSource === 'gateway'
    } else creditsComplete = false
    totals.input += row.tokens.input
    totals.output += row.tokens.output
    totals.cacheRead += row.tokens.cacheRead
    totals.cacheWrite += row.tokens.cacheWrite
    totals.reasoning += row.tokens.reasoning ?? 0
    reasoningComplete &&= row.tokens.reasoning !== undefined
    if (row.billing) {
      hasBilling = true
      usdMicros += row.billing.usdMicros
      allGateway &&= row.billing.source === 'gateway'
      allSubscription &&= row.billing.subscription
    } else incompleteBilling = true
  }

  const cost: Billing | undefined = hasBilling
    ? {
        usdMicros: Math.max(0, usdMicros),
        source: allGateway && !incompleteBilling ? 'gateway' : 'estimated',
        subscription: allSubscription,
      }
    : undefined
  return {
    totals,
    ...(hasCredits
      ? {
          credits: {
            amount: Math.max(0, credits),
            source: creditsGateway && creditsComplete ? ('gateway' as const) : ('estimated' as const),
            complete: creditsComplete,
          },
        }
      : {}),
    reasoningComplete: seen.size > 0 && reasoningComplete,
    billingComplete: hasBilling && !incompleteBilling,
    ...(cost ? { cost } : {}),
    context: {
      source: 'estimated',
      tokens: input.contextTokens,
      window: input.model.contextWindow,
      autoCompact: input.autoCompact,
      ...(input.compactAt === undefined ? {} : { compactAt: input.compactAt }),
    },
    model: {
      route: input.route,
      id: input.model.id,
      thinking: input.thinking,
      ...(input.settings ? { settings: input.settings } : {}),
      ...(input.model.maxTokens ? { maxTokens: input.model.maxTokens } : {}),
    },
    ...(Object.keys(cacheHealthView(cacheHealth)).length > 0 ? { cache: cacheHealthView(cacheHealth) } : {}),
    ...laneShares(byLane, input.lane),
  }
}
